import { fromRow, migrate, MIGRATIONS, SqlDatabase, SqliteSubscriptionDao } from '@/data/SqliteSubscriptionDao';
import { NewSubscription } from '@/model/Subscription';

const netflix: NewSubscription = {
  name: 'Netflix',
  amount: 49.99,
  currency: 'RON',
  billingCycle: 'MONTHLY',
  nextPaymentDate: '2026-11-04',
  category: 'ENTERTAINMENT',
  isActive: true,
  notes: 'Shared',
  tags: [],
  payments: [],
  sharedWith: 0,
};

const netflixRow = {
  id: 3, name: 'Netflix', amount_cents: 4999, currency: 'RON', billing_cycle: 'MONTHLY',
  next_payment_date: '2026-11-04', category: 'ENTERTAINMENT', is_active: 1, notes: 'Shared',
  server_id: 12, sync_state: 'SYNCED',
};

/** Records every statement and answers with the configured results. */
function fakeDb({ userVersion = 0, changes = 1, lastInsertRowId = 7, rows = [] as unknown[], first = null as unknown } = {}) {
  const statements: { sql: string; params?: unknown }[] = [];
  const db = {
    execAsync: jest.fn(async (sql: string) => {
      statements.push({ sql });
    }),
    runAsync: jest.fn(async (sql: string, params: unknown) => {
      statements.push({ sql, params });
      return { changes, lastInsertRowId };
    }),
    getAllAsync: jest.fn(async (sql: string) => {
      statements.push({ sql });
      return rows;
    }),
    getFirstAsync: jest.fn(async (sql: string) => (sql.startsWith('PRAGMA') ? { user_version: userVersion } : first)),
    withTransactionAsync: jest.fn(async (task: () => Promise<void>) => task()),
  };
  return { db: db as unknown as SqlDatabase, statements };
}

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

describe('legacy rows', () => {
  it('maps a row of the previous schema to a new subscription (amount from cents, ids dropped)', () => {
    expect(fromRow(netflixRow)).toEqual(netflix);
    expect(fromRow({ ...netflixRow, is_active: 0, amount_cents: 29 })).toMatchObject({ isActive: false, amount: 0.29 });
  });
});

describe('SqliteSubscriptionDao as replica store', () => {
  it('saves the replica state as a blob, replacing the previous one of the same strategy', async () => {
    const { db, statements } = fakeDb();
    const dao = new SqliteSubscriptionDao(async () => db);
    const state = new Uint8Array([1, 2, 3]);
    await dao.saveReplica('hybrid', state);
    expect(squash(statements[0].sql)).toMatch(/^INSERT INTO replica_state .* ON CONFLICT \(strategy\) DO UPDATE/);
    expect(statements[0].params).toEqual(['hybrid', state]);
  });

  it('loads the saved state, or null when there is none', async () => {
    const saved = fakeDb({ first: { state: new Uint8Array([9, 8]) } });
    expect(await new SqliteSubscriptionDao(async () => saved.db).loadReplica('lww')).toEqual(new Uint8Array([9, 8]));
    const empty = fakeDb({ first: null });
    expect(await new SqliteSubscriptionDao(async () => empty.db).loadReplica('lww')).toBeNull();
  });

  it('reads and writes settings in sync_meta', async () => {
    const { db, statements } = fakeDb({ first: { value: 'vv' } });
    const dao = new SqliteSubscriptionDao(async () => db);
    expect(await dao.getMeta('strategy')).toBe('vv');
    await dao.setMeta('replica_id', 'app-1');
    expect(statements).toEqual([{ sql: 'INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', params: ['replica_id', 'app-1'] }]);
  });

  it('returns the previous rows as new subscriptions until they are migrated', async () => {
    const pending = fakeDb({ rows: [netflixRow], first: null });
    expect(await new SqliteSubscriptionDao(async () => pending.db).getLegacySubscriptions()).toEqual([netflix]);
    const done = fakeDb({ rows: [netflixRow], first: { value: '1' } });
    expect(await new SqliteSubscriptionDao(async () => done.db).getLegacySubscriptions()).toEqual([]);
  });

  it('propagates database errors to the caller', async () => {
    const { db } = fakeDb();
    (db.runAsync as jest.Mock).mockRejectedValueOnce(new Error('SQLITE_FULL'));
    const dao = new SqliteSubscriptionDao(async () => db);
    await expect(dao.saveReplica('lww', new Uint8Array([1]))).rejects.toThrow('SQLITE_FULL');
  });

  it('saves the migrated replica and the migration flag in one transaction', async () => {
    const { db, statements } = fakeDb();
    const dao = new SqliteSubscriptionDao(async () => db);
    await dao.saveMigratedReplica('lww', new Uint8Array([1]));
    expect(db.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(statements.map((s) => s.params)).toEqual([['lww', new Uint8Array([1])], ['legacy_migrated', '1']]);
  });
});

describe('migrate', () => {
  it('creates the whole schema on a new database, in one transaction, without demo rows', async () => {
    const { db, statements } = fakeDb({ userVersion: 0 });
    await migrate(db);
    expect(db.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(statements[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS subscriptions/);
    expect(statements[1].sql).toMatch(/ADD COLUMN server_id/);
    expect(statements[1].sql).toMatch(/CREATE TABLE IF NOT EXISTS pending_deletes/);
    expect(statements.filter((s) => s.sql.startsWith('INSERT'))).toHaveLength(0);
    expect(statements[statements.length - 1].sql).toBe(`PRAGMA user_version = ${MIGRATIONS.length}`);
  });

  it('upgrades a local-only database: only the sync columns and tables are added', async () => {
    const { db, statements } = fakeDb({ userVersion: 1 });
    await migrate(db);
    expect(statements).toHaveLength(3);
    expect(statements[0].sql).not.toMatch(/CREATE TABLE IF NOT EXISTS subscriptions/);
    // Rows from the local-only version were never on the server, so they will be uploaded.
    expect(statements[0].sql).toMatch(/sync_state TEXT NOT NULL DEFAULT 'PENDING_CREATE'/);
  });

  it('adds the replica table to a schema-2 database and keeps the old tables', async () => {
    const { db, statements } = fakeDb({ userVersion: 2 });
    await migrate(db);
    expect(statements).toHaveLength(2);
    expect(squash(statements[0].sql)).toMatch(/^CREATE TABLE IF NOT EXISTS replica_state \( strategy TEXT PRIMARY KEY/);
    expect(statements[0].sql).not.toMatch(/DROP/);
    expect(statements[1].sql).toBe('PRAGMA user_version = 3');
  });

  it('does nothing on an up-to-date database', async () => {
    const { db, statements } = fakeDb({ userVersion: MIGRATIONS.length });
    await migrate(db);
    expect(statements).toHaveLength(0);
    expect(db.withTransactionAsync).not.toHaveBeenCalled();
  });
});
