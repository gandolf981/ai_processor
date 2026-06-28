/**
 * OpenRouter integration + normalization (Service layer — business logic, no HTTP framework).
 */

import { setTimeout as delay } from "node:timers/promises";

export class OpenRouterRateLimitError extends Error {
  /**
   * @param {string} message
   * @param {{ retryAfterS?: number | null, quotaExhausted?: boolean, status?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "OpenRouterRateLimitError";
    this.retryAfterS = options.retryAfterS ?? null;
    this.quotaExhausted = Boolean(options.quotaExhausted);
    this.status = options.status ?? 429;
  }
}

/**
 * @param {Headers} headers
 * @returns {number | null} seconds, capped
 */
function parseRetryAfterSeconds(headers) {
  const raw = headers.get("retry-after");
  if (!raw || typeof raw !== "string") return null;
  const sec = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(sec) || sec < 0) return null;
  return Math.min(sec, 7200);
}

function jitterSeconds(maxExtra = 3) {
  return Math.random() * maxExtra;
}

function looksLikeQuotaExhausted(errText) {
  const s = String(errText).toLowerCase();
  return (
    s.includes("free-models-per-day") ||
    s.includes("add 10 credits") ||
    s.includes("accumulate your rate limits")
  );
}

function buildPrompt(text) {
  return (
    "You are a classifier+extractor for Telegram messages.\n" +
    "Given the input text, do ALL of the following:\n" +
    "1) Decide the message type: News | Analysis | Signal | Signal-live | Other\n" +
    "2) Provide type_confidence (0..1)\n" +
    "3) Build a JSON 'structure' appropriate to the type, and provide structure_confidence (0..1)\n" +
    "4) Provide 'result' as a short plain-text summary of the message (NO reasoning, NO markdown, no extra formatting)\n\n" +
    "SIGNAL RULE (very important):\n" +
    "- Only output type=Signal if the message clearly contains a tradable signal with enough fields to fill the Signal schema.\n" +
    "- If the message is clearly signal-like (e.g. a live call to buy/sell an asset) but you CANNOT reliably fill the Signal schema " +
    "(too short/vague: unclear symbol formatting, missing entry/SL/TP, ambiguous instrument — e.g. \"Gold Sell now\"), " +
    "use type=Signal-live (NOT Signal, NOT Other).\n" +
    "- Signal-live: structure MUST be {} ; structure_confidence should reflect that structure is intentionally empty.\n" +
    "- If it is NOT signal-like at all, classify as Other.\n\n" +
    "STRUCTURE SCHEMAS (use ONLY the schema for the selected type):\n" +
    "- If type=News, structure must be an object with keys:\n" +
    '  {"topic": string, "industry": string|null, "tags": string[], "news_summary": string, "news_analysis": string|null, ' +
    '   "market_impact": "Bullish"|"Bearish"|"Neutral"|"Unknown"}\n' +
    "- If type=Analysis, structure must be an object with keys:\n" +
    '  {"topic": string, "industry": string|null, "tags": string[], "analysis_summary": string, ' +
    '   "expected_market_impact": "Bullish"|"Bearish"|"Neutral"|"Unknown"}\n' +
    "- If type=Signal, structure must be an object with keys:\n" +
    '  {"symbol": string, "action": "BUY"|"SELL", "entry": string|null, "stop_loss": number|null, ' +
    '   "take_profits": (number|string)[]|null, "note": string|null}\n' +
    "- If type=Other, structure must be an empty object: {}\n" +
    "- If type=Signal-live, structure must be an empty object: {} (short/live signal text only; no forced fields).\n\n" +
    "OUTPUT REQUIREMENTS:\n" +
    "- Output MUST be a single JSON object and NOTHING ELSE.\n" +
    "- JSON keys MUST be exactly: result, type, type_confidence, structure_confidence, structure\n" +
    "- type must be exactly one of: News, Analysis, Signal, Signal-live, Other\n" +
    "- type_confidence and structure_confidence must be numbers between 0 and 1.\n\n" +
    "Input text:\n" +
    `${text}\n`
  );
}

function extractJsonObject(s) {
  let t = String(s).trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }

  const start = t.indexOf("{");
  if (start === -1) {
    throw new Error("No JSON object found in model output");
  }

  let depth = 0;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = t.slice(start, i + 1);
        return JSON.parse(candidate);
      }
    }
  }

  throw new Error("Unbalanced JSON object in model output");
}

function clamp01(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function normalizePayload(payload) {
  let result = payload.result;
  if (typeof result !== "string") {
    result = result == null ? "" : String(result);
  }

  const allowed = new Set(["News", "Analysis", "Signal", "Signal-live", "Other"]);
  let msgType = payload.type;
  if (!allowed.has(msgType)) msgType = "Other";

  let structure =
    payload.structure && typeof payload.structure === "object" && !Array.isArray(payload.structure)
      ? payload.structure
      : {};

  if (msgType === "Signal-live") {
    structure = {};
  }

  return {
    result: result.trim(),
    type: msgType,
    type_confidence: clamp01(payload.type_confidence),
    structure_confidence: clamp01(payload.structure_confidence),
    structure,
  };
}

/**
 * @param {object} log - { info, warn, error } from View or shared logger
 */
export async function analyzeText(text, options, log = console) {
  const {
    baseUrl = "https://openrouter.ai/api/v1/chat/completions",
    apiKey,
    model,
    fallbackModels = [],
    timeoutS,
    maxRetries,
    backoffS,
    rateLimitBackoffS = 45,
    reasoning = null,
  } = options;
  const models = [...new Set([model, ...fallbackModels].filter(Boolean))];

  const headers = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let lastErr = /** @type {unknown} */ (null);

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const currentModel = models[modelIndex];
    const body = {
      model: currentModel,
      messages: [{ role: "user", content: buildPrompt(text) }],
      ...(reasoning != null ? { reasoning } : {}),
    };

    if (modelIndex > 0) {
      log.warn(`OpenRouter trying fallback model=${currentModel}`);
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log.info(
          `OpenRouter POST attempt ${attempt}/${maxRetries} model=${currentModel} timeout_s=${timeoutS}`
        );

        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutS * 1000);

        let resp;
        try {
          resp = await fetch(baseUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(t);
        }

        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          const retryAfterS = parseRetryAfterSeconds(resp.headers);
          if (resp.status === 429 && looksLikeQuotaExhausted(errText)) {
            throw new OpenRouterRateLimitError(
              `HTTP 429 quota/rate limit: ${errText.slice(0, 500)}`,
              { retryAfterS, quotaExhausted: true, status: resp.status }
            );
          }

          const err = new Error(`HTTP ${resp.status}: ${errText.slice(0, 500)}`);
          /** @type {Error & { httpStatus?: number, retryAfterS?: number | null }} */
          const tagged = err;
          tagged.httpStatus = resp.status;
          tagged.retryAfterS = retryAfterS;
          throw tagged;
        }

        const raw = await resp.json();
        const content =
          raw?.choices?.[0]?.message?.content != null
            ? String(raw.choices[0].message.content)
            : "";

        const parsed = extractJsonObject(content);
        log.info(`OpenRouter parse ok (attempt ${attempt}/${maxRetries}) model=${currentModel}`);
        return { normalized: normalizePayload(parsed), raw };
      } catch (e) {
        lastErr = e;
        if (e instanceof OpenRouterRateLimitError && e.quotaExhausted) {
          if (modelIndex < models.length - 1) {
            log.warn(
              `OpenRouter quota/rate limit exhausted for model=${currentModel}; trying next model`
            );
            break;
          }
          log.error(`OpenRouter quota/rate limit exhausted: ${String(e)}`);
          throw e;
        }

        if (attempt < maxRetries) {
          const tagged = /** @type {Error & { httpStatus?: number, retryAfterS?: number | null }} */ (
            e
          );
          const is429 = tagged.httpStatus === 429 || /HTTP 429\b/.test(String(e));

          let waitS;
          if (is429) {
            const fromHeader =
              tagged.retryAfterS != null && tagged.retryAfterS > 0
                ? tagged.retryAfterS
                : null;
            waitS =
              fromHeader != null
                ? fromHeader
                : Math.max(rateLimitBackoffS * attempt, 15);
            waitS += jitterSeconds(4);
            log.warn(
              `OpenRouter rate limited (429), attempt ${attempt}/${maxRetries}; waiting ${Math.round(waitS)}s (free models are often throttled; consider a paid model or BYOK)`
            );
          } else {
            waitS = backoffS * attempt;
            log.warn(
              `OpenRouter attempt ${attempt}/${maxRetries} failed: ${String(e)}; retry in ${waitS}s`
            );
          }

          await delay(waitS * 1000);
          continue;
        }
        log.error(`OpenRouter giving up after ${maxRetries} attempts: ${String(e)}`);
        throw new Error(
          `OpenRouter call failed after ${maxRetries} attempts: ${String(lastErr)}`
        );
      }
    }
  }

  throw new Error(`OpenRouter call failed: ${String(lastErr)}`);
}

export function defaultProcessorForEmptyText() {
  return {
    result: "",
    type: "Other",
    type_confidence: 0,
    structure_confidence: 0,
    structure: {},
  };
}
