import type { StrategyName } from '@sync-core/strategy';
import type { SQLiteDatabase } from 'expo-sqlite';

import { BillingCycle, Category, NewSubscription } from '@/model/Subscription';
import { logDebug } from '@/util/log';
import { MetaKey, ReplicaStore } from './ReplicaStore';

/** The part of expo-sqlite's database used here (lets the tests pass a fake). */
export type SqlDatabase = Pick<
  SQLiteDatabase,
  'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync' | 'withTransactionAsync'
>;

/** A row of the previous schema's `subscriptions` table (amounts in cents). */
export interface SubscriptionRow {
  id: number;
  name: string;
  amount_cents: number;
  currency: string;
  billing_cycle: string;
  next_payment_date: string;
  category: string;
  is_active: number;
  notes: string;
  server_id: number | null;
  sync_state: string;
}

const COLUMNS =
  'name, amount_cents, currency, billing_cycle, next_payment_date, category, is_active, notes, server_id, sync_state';
/** Set once the schema-2 rows were turned into replica ops (they are then left unused). */
const LEGACY_MIGRATED = 'legacy_migrated';

/** Schema versions, applied in order; `PRAGMA user_version` stores how many already ran. */
export const MIGRATIONS: readonly string[] = [
  // 1 – local database assignment
  `CREATE TABLE IF NOT EXISTS subscriptions (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     name              TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
     amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
     currency          TEXT    NOT NULL DEFAULT 'RON',
     billing_cycle     TEXT    NOT NULL CHECK (billing_cycle IN ('WEEKLY', 'MONTHLY', 'YEARLY')),
     next_payment_date TEXT    NOT NULL,
     category          TEXT    NOT NULL DEFAULT 'OTHER',
     is_active         INTEGER NOT NULL DEFAULT 1,
     notes             TEXT    NOT NULL DEFAULT ''
   );
   CREATE INDEX IF NOT EXISTS idx_subscriptions_next_payment ON subscriptions (next_payment_date);`,
  // 2 – server sync: rows kept from version 1 were never on the server, so they are uploaded as new.
  `ALTER TABLE subscriptions ADD COLUMN server_id INTEGER;
   ALTER TABLE subscriptions ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'PENDING_CREATE'
     CHECK (sync_state IN ('SYNCED', 'PENDING_CREATE', 'PENDING_UPDATE'));
   CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_server_id ON subscriptions (server_id);
   CREATE TABLE IF NOT EXISTS pending_deletes (
     server_id INTEGER PRIMARY KEY,
     queued_at TEXT    NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // 3 – strategy-based sync: the replica's saved state per strategy. The list is read from the replica;
  //     `subscriptions` and `pending_deletes` are read once more to migrate their rows, then unused.
  `CREATE TABLE IF NOT EXISTS replica_state (
     strategy TEXT PRIMARY KEY CHECK (strategy IN ('lww', 'vv', 'automerge', 'yjs', 'hybrid')),
     state    BLOB NOT NULL,
     saved_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
];

/** A row of the previous schema, as a new subscription (its ids and sync state are not kept). */
export function fromRow(row: SubscriptionRow): NewSubscription {
  return {
    name: row.name,
    amount: row.amount_cents / 100,
    currency: row.currency,
    billingCycle: row.billing_cycle as BillingCycle,
    nextPaymentDate: row.next_payment_date,
    category: row.category as Category,
    isActive: row.is_active !== 0,
    notes: row.notes,
    tags: [],
    payments: [],
    sharedWith: 0,
  };
}

/**
 * Brings the schema to the latest version. A new install starts empty: its data comes from the
 * server on the first sync. Later schema changes are added as new entries of [MIGRATIONS].
 */
export async function migrate(db: SqlDatabase): Promise<void> {
  const version = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
  if (version >= MIGRATIONS.length) return;
  logDebug('DB', `migrating schema from version ${version} to ${MIGRATIONS.length}`);
  // One transaction, so a failure half-way never leaves a partly migrated database behind.
  await db.withTransactionAsync(async () => {
    for (let v = version; v < MIGRATIONS.length; v++) {
      await db.execAsync(MIGRATIONS[v]);
    }
    await db.execAsync(`PRAGMA user_version = ${MIGRATIONS.length}`);
  });
}

/**
 * [ReplicaStore] on the local SQLite database (expo-sqlite). The `subscriptions` table of the previous
 * schema is only read, once, to migrate its rows into the replica.
 */
export class SqliteSubscriptionDao implements ReplicaStore {
  constructor(private readonly openDb: () => Promise<SqlDatabase>) {}

  async loadReplica(strategy: StrategyName): Promise<Uint8Array | null> {
    const db = await this.openDb();
    const row = await db.getFirstAsync<{ state: Uint8Array }>('SELECT state FROM replica_state WHERE strategy = ?', [strategy]);
    logDebug('DB', `replica ${strategy}: ${row ? `${row.state.length} byte(s)` : 'none saved'}`);
    return row ? new Uint8Array(row.state) : null;
  }

  async saveReplica(strategy: StrategyName, state: Uint8Array): Promise<void> {
    const db = await this.openDb();
    await db.runAsync(
      `INSERT INTO replica_state (strategy, state, saved_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (strategy) DO UPDATE SET state = excluded.state, saved_at = excluded.saved_at`,
      [strategy, state],
    );
  }

  async deleteReplicas(): Promise<void> {
    const db = await this.openDb();
    await db.runAsync('DELETE FROM replica_state', []);
    logDebug('DB', 'deleted every saved replica');
  }

  async getMeta(key: MetaKey): Promise<string | null> {
    const db = await this.openDb();
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  async setMeta(key: MetaKey, value: string): Promise<void> {
    const db = await this.openDb();
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, value]);
  }

  async getLegacySubscriptions(): Promise<NewSubscription[]> {
    const db = await this.openDb();
    const done = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [LEGACY_MIGRATED]);
    if (done) return [];
    const rows = await db.getAllAsync<SubscriptionRow>(`SELECT id, ${COLUMNS} FROM subscriptions ORDER BY id`);
    logDebug('DB', `${rows.length} row(s) of the previous schema to migrate`);
    return rows.map(fromRow);
  }

  async saveMigratedReplica(strategy: StrategyName, state: Uint8Array): Promise<void> {
    const db = await this.openDb();
    await db.withTransactionAsync(async () => {
      await this.saveReplica(strategy, state);
      await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [LEGACY_MIGRATED, '1']);
    });
    logDebug('DB', `previous rows migrated into the ${strategy} replica`);
  }
}
