import type { SQLiteDatabase } from 'expo-sqlite';

import { BillingCycle, Category, NewSubscription } from '@/model/Subscription';
import { logDebug } from '@/util/log';
import { LocalSubscription, SubscriptionDao, SyncState } from './SubscriptionDao';

/** The part of expo-sqlite's database used here (lets the tests pass a fake). */
export type SqlDatabase = Pick<
  SQLiteDatabase,
  'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync' | 'withTransactionAsync'
>;

/** A row of the `subscriptions` table. Amounts are stored in cents to avoid floating point errors. */
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

const LAST_SYNCED_AT = 'last_synced_at';

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
];

export function toRowValues(s: NewSubscription, serverId: number | null, syncState: SyncState) {
  return [
    s.name,
    Math.round(s.amount * 100),
    s.currency,
    s.billingCycle,
    s.nextPaymentDate,
    s.category,
    s.isActive ? 1 : 0,
    s.notes,
    serverId,
    syncState,
  ];
}

export function fromRow(row: SubscriptionRow): LocalSubscription {
  return {
    id: row.id,
    name: row.name,
    amount: row.amount_cents / 100,
    currency: row.currency,
    billingCycle: row.billing_cycle as BillingCycle,
    nextPaymentDate: row.next_payment_date,
    category: row.category as Category,
    isActive: row.is_active !== 0,
    notes: row.notes,
    // Not stored in the legacy table; the replica state (7.2) keeps them.
    tags: [],
    payments: [],
    sharedWith: 0,
    serverId: row.server_id,
    syncState: row.sync_state as SyncState,
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

/** [SubscriptionDao] on a local SQLite database (expo-sqlite). */
export class SqliteSubscriptionDao implements SubscriptionDao {
  constructor(private readonly openDb: () => Promise<SqlDatabase>) {}

  async getAll(): Promise<LocalSubscription[]> {
    const db = await this.openDb();
    const rows = await db.getAllAsync<SubscriptionRow>(
      `SELECT id, ${COLUMNS} FROM subscriptions ORDER BY next_payment_date, name COLLATE NOCASE`,
    );
    logDebug('DB', `read ${rows.length} row(s)`);
    return rows.map(fromRow);
  }

  async insert(subscription: NewSubscription, serverId: number | null, syncState: SyncState): Promise<number> {
    const db = await this.openDb();
    const result = await db.runAsync(
      `INSERT INTO subscriptions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      toRowValues(subscription, serverId, syncState),
    );
    logDebug('DB', `inserted row ${result.lastInsertRowId} (server id ${serverId}, ${syncState})`);
    return result.lastInsertRowId;
  }

  async update(subscription: LocalSubscription): Promise<boolean> {
    const db = await this.openDb();
    const result = await db.runAsync(
      `UPDATE subscriptions
          SET name = ?, amount_cents = ?, currency = ?, billing_cycle = ?,
              next_payment_date = ?, category = ?, is_active = ?, notes = ?,
              server_id = ?, sync_state = ?
        WHERE id = ?`,
      [...toRowValues(subscription, subscription.serverId, subscription.syncState), subscription.id],
    );
    logDebug('DB', `updated row ${subscription.id} (${subscription.syncState}): ${result.changes} change(s)`);
    return result.changes > 0;
  }

  async delete(id: number, queueServerDelete?: number): Promise<boolean> {
    const db = await this.openDb();
    let changes = 0;
    const run = async () => {
      changes = (await db.runAsync('DELETE FROM subscriptions WHERE id = ?', [id])).changes;
      if (changes > 0 && queueServerDelete !== undefined) {
        await db.runAsync('INSERT OR IGNORE INTO pending_deletes (server_id) VALUES (?)', [queueServerDelete]);
      }
    };
    if (queueServerDelete === undefined) await run();
    else await db.withTransactionAsync(run);
    logDebug('DB', `deleted row ${id}${queueServerDelete !== undefined ? `, queued server delete ${queueServerDelete}` : ''}`);
    return changes > 0;
  }

  async getPendingDeletes(): Promise<number[]> {
    const db = await this.openDb();
    const rows = await db.getAllAsync<{ server_id: number }>(
      'SELECT server_id FROM pending_deletes ORDER BY queued_at, server_id',
    );
    return rows.map((r) => r.server_id);
  }

  async removePendingDelete(serverId: number): Promise<void> {
    const db = await this.openDb();
    await db.runAsync('DELETE FROM pending_deletes WHERE server_id = ?', [serverId]);
  }

  async getLastSyncedAt(): Promise<string | null> {
    const db = await this.openDb();
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [LAST_SYNCED_AT]);
    return row?.value ?? null;
  }

  async setLastSyncedAt(timestamp: string): Promise<void> {
    const db = await this.openDb();
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [LAST_SYNCED_AT, timestamp]);
  }
}
