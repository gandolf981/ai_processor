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

export class MessageRepository {
  /**
   * @param {import('mongodb').Collection} collection
   */
  constructor(collection) {
    this.collection = collection;
  }

  /**
   * Scan forward from lastId; skip docs that already have `processor`.
   * @param {unknown} lastId
   * @returns {Promise<{ doc: import('mongodb').WithId<import('mongodb').Document> | null, lastId: unknown }>}
   */
  async findNextUnprocessed(lastId) {
    let cursorLastId = lastId;

    for (;;) {
      const filter =
        cursorLastId != null ? { _id: { $gt: cursorLastId } } : {};

      const doc = await this.collection.findOne(filter, {
        projection,
        sort: { _id: 1 },
      });

      if (!doc) {
        return { doc: null, lastId: null };
      }

      cursorLastId = doc._id;
      if (Object.prototype.hasOwnProperty.call(doc, "processor")) {
        continue;
      }

      return { doc, lastId: cursorLastId };
    }
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
    if (Object.prototype.hasOwnProperty.call(current, "processor")) {
      return "already";
    }

    await this.collection.updateOne(
      { _id },
      { $set: { confidence: 0, processor: { ...processorPayload } } }
    );
    return "written";
  }
}
