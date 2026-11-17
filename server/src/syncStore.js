import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * SQLite storage for the sync endpoint (better-sqlite3, synchronous):
 *
 *   replica_state  the server replica of each strategy, as returned by Replica.save()
 *   sync_log       one row per POST /sync request: bytes in and out, messages carried, CPU time
 *
 * The legacy REST routes keep using the JSON file store (store.js). `file` may be ':memory:' for tests.
 */
export class SyncStore {
  #db;
  #statements;

  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.#db = new Database(file);
    if (file !== ':memory:') this.#db.pragma('journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS replica_state (
        strategy   TEXT PRIMARY KEY,
        state      BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_log (
        id        INTEGER PRIMARY KEY,
        at        TEXT NOT NULL,
        strategy  TEXT NOT NULL,
        peer      TEXT NOT NULL,
        bytes_in  INTEGER NOT NULL,
        bytes_out INTEGER NOT NULL,
        rounds    INTEGER NOT NULL,
        cpu_ms    REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sync_log_strategy ON sync_log (strategy, id);
    `);
    this.#statements = {
      load: this.#db.prepare('SELECT state FROM replica_state WHERE strategy = ?').pluck(),
      save: this.#db.prepare(`
        INSERT INTO replica_state (strategy, state, updated_at) VALUES (@strategy, @state, @at)
        ON CONFLICT (strategy) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`),
      deleteState: this.#db.prepare('DELETE FROM replica_state WHERE strategy = ?'),
      log: this.#db.prepare(`
        INSERT INTO sync_log (at, strategy, peer, bytes_in, bytes_out, rounds, cpu_ms)
        VALUES (@at, @strategy, @peer, @bytesIn, @bytesOut, @rounds, @cpuMs)`),
      readLog: this.#db.prepare(`
        SELECT id, at, strategy, peer, bytes_in AS bytesIn, bytes_out AS bytesOut, rounds, cpu_ms AS cpuMs
        FROM sync_log WHERE strategy = ? ORDER BY id`),
      clearLog: this.#db.prepare('DELETE FROM sync_log WHERE strategy = ?'),
    };
  }

  /** The saved replica of `strategy`, or null when there is none yet. */
  loadState(strategy) {
    const state = this.#statements.load.get(strategy);
    return state === undefined ? null : new Uint8Array(state.buffer, state.byteOffset, state.byteLength);
  }

  saveState(strategy, bytes, at = new Date()) {
    this.#statements.save.run({ strategy, state: Buffer.from(bytes), at: at.toISOString() });
  }

  /** Records one sync request. `rounds` is the number of messages it carried (0, 1 or 2). */
  logSync({ strategy, peer, bytesIn, bytesOut, rounds, cpuMs, at = new Date() }) {
    this.#statements.log.run({ strategy, peer, bytesIn, bytesOut, rounds, cpuMs, at: at.toISOString() });
  }

  /** Every logged request of `strategy`, oldest first. */
  syncLog(strategy) {
    return this.#statements.readLog.all(strategy);
  }

  /** Removes the replica and the sync log of `strategy`, in one transaction. */
  reset(strategy) {
    this.#db.transaction(() => {
      this.#statements.deleteState.run(strategy);
      this.#statements.clearLog.run(strategy);
    })();
  }

  close() {
    this.#db.close();
  }
}
