/**
 * Environment-backed configuration (Model layer: app settings).
 */

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function csv(v) {
  return String(v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function loadWorkerSettings() {
  const mongoUri = (process.env.MONGO_URI || "").trim();
  if (!mongoUri) {
    throw new Error(
      "MONGO_URI is required (e.g. mongodb://user:pass@host:27017/?authSource=admin)"
    );
  }

  const dbName =
    (process.env.MONGO_DB || "test_telegram_db").trim() || "test_telegram_db";
  const collectionName =
    (process.env.MONGO_COLLECTION || "message").trim() || "message";

  let sleepS = num(process.env.SLEEP_SECONDS, 60);
  if (sleepS < 0) sleepS = 0;

  let idleSleepS = num(process.env.IDLE_SLEEP_SECONDS, 2);
  if (idleSleepS < 0.2) idleSleepS = 0.2;

  let idleLogIntervalS = num(process.env.IDLE_LOG_INTERVAL_SECONDS, 30);
  if (idleLogIntervalS < 0) idleLogIntervalS = 0;

  let batchSize = Math.floor(num(process.env.BATCH_SIZE, 25));
  if (batchSize < 1) batchSize = 1;
  if (batchSize > 100) batchSize = 100;

  return {
    mongoUri,
    dbName,
    collectionName,
    batchSize,
    sleepS,
    idleSleepS,
    idleLogIntervalS,
  };
}

export function loadOpenRouterSettings() {
  const baseUrl = (
    process.env.OPENROUTER_BASE_URL ||
    "https://openrouter.ai/api/v1/chat/completions"
  ).trim();
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey && /openrouter\.ai/i.test(baseUrl)) {
    throw new Error("OPENROUTER_API_KEY is required");
  }
  let model = (
    process.env.OPENROUTER_MODEL || "google/gemma-4-26b-a4b-it:free"
  ).trim();
  if (!model) model = "google/gemma-4-26b-a4b-it:free";
  const fallbackModels = csv(process.env.OPENROUTER_FALLBACK_MODELS).filter(
    (fallbackModel) => fallbackModel !== model
  );

  /** @type {{ enabled: boolean } | null} */
  let reasoning = null;
  const reasoningRaw = (process.env.OPENROUTER_REASONING || "").trim().toLowerCase();
  if (reasoningRaw === "true" || reasoningRaw === "1" || reasoningRaw === "on") {
    reasoning = { enabled: true };
  } else if (
    reasoningRaw === "false" ||
    reasoningRaw === "0" ||
    reasoningRaw === "off"
  ) {
    reasoning = { enabled: false };
  }
  // Models like openai/gpt-oss-20b reject `reasoning.enabled: false`; they require reasoning on.
  if (reasoning === null && /gpt-oss/i.test(model)) {
    reasoning = { enabled: true };
  }

  return {
    baseUrl,
    apiKey,
    model,
    fallbackModels,
    reasoning,
    timeoutS: Math.max(1, Math.floor(num(process.env.OPENROUTER_TIMEOUT_SECONDS, 60))),
    maxRetries: Math.max(1, Math.floor(num(process.env.OPENROUTER_MAX_RETRIES, 6))),
    backoffS: Math.max(0, num(process.env.OPENROUTER_BACKOFF_SECONDS, 2)),
    /** Base seconds for HTTP 429 when `Retry-After` is missing (free tiers hit upstream limits often). */
    rateLimitBackoffS: Math.max(
      5,
      num(process.env.OPENROUTER_RATE_LIMIT_BACKOFF_SECONDS, 45)
    ),
    /** Worker-level pause when OpenRouter reports quota exhaustion/free-model daily limits. */
    quotaCooldownS: Math.max(
      5,
      num(process.env.OPENROUTER_QUOTA_COOLDOWN_SECONDS, 5)
    ),
  };
}
