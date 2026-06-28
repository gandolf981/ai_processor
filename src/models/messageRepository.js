/**
 * Mongo persistence for messages (Model / data access).
 * No logging here — Controller + View handle user-visible output.
 */

const projection = {
  _id: 1,
  text: 1,
  channel: 1,
  message_id: 1,
  date: 1,
  processor: 1,
};

/** @param {import('mongodb').Document | null | undefined} doc */
function isProcessorComplete(doc) {
  const p = doc?.processor;
  if (p == null || typeof p !== "object" || Array.isArray(p)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(p, "result") &&
    Object.prototype.hasOwnProperty.call(p, "type")
  );
}

/** Docs missing processor or lacking result/type (see README idempotency rules). */
const unprocessedFilter = {
  $or: [
    { processor: { $exists: false } },
    { "processor.result": { $exists: false } },
    { "processor.type": { $exists: false } },
  ],
};

export class MessageRepository {
  /**
   * @param {import('mongodb').Collection} collection
   */
  constructor(collection) {
    this.collection = collection;
  }

  /**
   * Next document after lastId that still needs processing (no/incomplete processor).
   * @param {unknown} lastId
   * @returns {Promise<{ doc: import('mongodb').WithId<import('mongodb').Document> | null, lastId: unknown }>}
   */
  async findNextUnprocessed(lastId) {
    const filter =
      lastId != null
        ? { _id: { $gt: lastId }, ...unprocessedFilter }
        : unprocessedFilter;

    const doc = await this.collection.findOne(filter, {
      projection,
      sort: { _id: 1 },
    });

    if (!doc) {
      return { doc: null, lastId: null };
    }

    return { doc, lastId: doc._id };
  }

  /**
   * @param {unknown} _id
   * @param {Record<string, unknown>} processorPayload
   * @returns {Promise<'written' | 'missing' | 'already'>}
   */
  async writeProcessor(_id, processorPayload) {
    const current = await this.collection.findOne(
      { _id },
      { projection: { _id: 1, processor: 1 } }
    );
    if (!current) return "missing";
    if (isProcessorComplete(current)) {
      return "already";
    }

    await this.collection.updateOne(
      { _id },
      { $set: { confidence: 0, processor: { ...processorPayload } } }
    );
    return "written";
  }
}
