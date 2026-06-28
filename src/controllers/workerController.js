/**
 * Orchestrates polling, AI calls, and persistence (Controller).
 */

import { setTimeout as delay } from "node:timers/promises";
import { MongoClient, MongoError } from "mongodb";

import { loadOpenRouterSettings, loadWorkerSettings } from "../config/settings.js";
import { MessageRepository } from "../models/messageRepository.js";
import {
  analyzeText,
  defaultProcessorForEmptyText,
} from "../services/aiService.js";

/**
 * @param {{ info: (msg: string) => void, warn: (msg: string) => void, error: (msg: string, err?: unknown) => void, debug: (msg: string) => void, safeRepr: (s: string) => string }} view
 */
export async function runWorkerForever(view) {
  const settings = loadWorkerSettings();
  const openRouter = loadOpenRouterSettings();

  view.info(
    `startup: MongoDB database="${settings.dbName}" collection="${settings.collectionName}"`
  );

  const client = new MongoClient(settings.mongoUri);
  await client.connect();

  const collection = client.db(settings.dbName).collection(settings.collectionName);
  const repo = new MessageRepository(collection);

  const aiLog = {
    info: (m) => view.info(m),
    warn: (m) => view.warn(m),
    error: (m) => view.error(m),
  };

  view.info(
    `Mongo connected; worker running model=${openRouter.model} ` +
      `sleep_s=${settings.sleepS} idle_sleep_s=${settings.idleSleepS}`
  );

  let processed = 0;
  let lastId = null;
  let lastIdleLogAt = null;

  for (;;) {
    try {
      view.info(`poll: fetching next unprocessed after _id=${lastId}`);

      const { doc, lastId: newLastId } = await repo.findNextUnprocessed(lastId);
      lastId = newLastId;

      if (!doc) {
        const now = Date.now() / 1000;
        const interval = settings.idleLogIntervalS;
        if (
          lastIdleLogAt == null ||
          interval === 0 ||
          now - lastIdleLogAt >= interval
        ) {
          view.info(
            `idle: no unprocessed document; sleeping ${settings.idleSleepS}s before next poll`
          );
          lastIdleLogAt = now;
        }
        await delay(settings.idleSleepS * 1000);
        continue;
      }

      lastIdleLogAt = null;

      const _id = doc._id;
      const text = doc.text != null ? String(doc.text) : "";
      const channel = doc.channel;
      const messageId = doc.message_id;

      view.info(
        `picked document _id=${_id} channel=${channel} message_id=${messageId}`
      );

      const empty = typeof text !== "string" || !text.trim();
      if (empty) {
        const normalized = defaultProcessorForEmptyText();
        view.info(`empty text: applying default processor _id=${_id} (no AI call)`);
        view.debug(`processor payload _id=${_id} payload=${JSON.stringify(normalized)}`);

        const w = await repo.writeProcessor(_id, normalized);
        if (w === "missing") view.warn(`mongo skip write: document gone _id=${_id}`);
        else if (w === "already") {
          view.info(`mongo skip write: processor already set _id=${_id}`);
        } else view.info(`mongo updated processor _id=${_id}`);

        processed += 1;
        view.info(`done document _id=${_id} processed_total=${processed}`);
        view.info(`cooldown: sleeping ${settings.sleepS}s before next job`);
        await delay(settings.sleepS * 1000);
        continue;
      }

      view.info(
        `AI request _id=${_id} text_len=${text.length} preview=${JSON.stringify(view.safeRepr(text))}`
      );
      view.info(`calling OpenRouter _id=${_id} model=${openRouter.model}`);

      try {
        const { normalized } = await analyzeText(text, openRouter, aiLog);
        view.info(`OpenRouter ok _id=${_id} result=${JSON.stringify(normalized)}`);

        const w = await repo.writeProcessor(_id, normalized);
        if (w === "missing") view.warn(`mongo skip write: document gone _id=${_id}`);
        else if (w === "already") {
          view.info(`mongo skip write: processor already set _id=${_id}`);
        } else view.info(`mongo updated processor _id=${_id}`);

        processed += 1;
        view.info(`done document _id=${_id} processed_total=${processed}`);
      } catch (e) {
        view.error(`OpenRouter failed _id=${_id} (will retry later)`, e);
      }

      view.info(`cooldown: sleeping ${settings.sleepS}s before next job`);
      await delay(settings.sleepS * 1000);
    } catch (e) {
      if (e instanceof MongoError) {
        view.error("MongoDB error (sleep 5s)", e);
        await delay(5000);
        continue;
      }
      throw e;
    }
  }
}
