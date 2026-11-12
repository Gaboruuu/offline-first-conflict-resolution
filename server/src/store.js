import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Subscriptions kept in memory and persisted to a JSON file after every write (written to a
 * temporary file first, then renamed, so a crash never leaves half a file behind).
 * Ids are generated here and never reused, even after a delete.
 */
export class SubscriptionStore {
  #file;
  #items = new Map();
  #nextId = 1;
  #writing = Promise.resolve();

  constructor(file) {
    this.#file = file;
  }

  /** Loads the file; when there is none yet, starts with [seed]. Returns true if seeded. */
  async open(seed = []) {
    if (!this.#file) {
      seed.forEach((s) => this.#insert(s));
      return seed.length > 0;
    }
    try {
      const data = JSON.parse(await readFile(this.#file, 'utf8'));
      this.#nextId = data.nextId;
      data.items.forEach((item) => this.#items.set(item.id, item));
      return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      seed.forEach((s) => this.#insert(s));
      await this.#save();
      return true;
    }
  }

  all() {
    return [...this.#items.values()].sort(
      (a, b) => a.nextPaymentDate.localeCompare(b.nextPaymentDate) || a.name.localeCompare(b.name),
    );
  }

  get(id) {
    return this.#items.get(id);
  }

  async create(fields) {
    const item = this.#insert(fields);
    await this.#save();
    return item;
  }

  /** Replaces the fields of the existing element; its id never changes. Undefined if missing. */
  async update(id, fields) {
    if (!this.#items.has(id)) return undefined;
    const item = { id, ...fields, updatedAt: new Date().toISOString() };
    this.#items.set(id, item);
    await this.#save();
    return item;
  }

  async delete(id) {
    if (!this.#items.delete(id)) return false;
    await this.#save();
    return true;
  }

  #insert(fields) {
    const item = { id: this.#nextId++, ...fields, updatedAt: new Date().toISOString() };
    this.#items.set(item.id, item);
    return item;
  }

  #save() {
    if (!this.#file) return Promise.resolve();
    const file = this.#file;
    const snapshot = JSON.stringify({ nextId: this.#nextId, items: [...this.#items.values()] }, null, 2);
    // Writes are chained so two requests never write the file at the same time.
    this.#writing = this.#writing
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, snapshot);
        await rename(`${file}.tmp`, file);
      });
    return this.#writing;
  }
}
