import { openDatabaseAsync } from 'expo-sqlite';

import { migrate, SqlDatabase } from './SqliteSubscriptionDao';

const DATABASE_NAME = 'subtrack.db';

let opening: Promise<SqlDatabase> | undefined;

/**
 * Opens the app's SQLite database once and migrates it to the current schema.
 * A failed attempt is forgotten, so the next call (e.g. the list's Retry button) tries again.
 */
export function openSubTrackDatabase(): Promise<SqlDatabase> {
  opening ??= (async () => {
    const db = await openDatabaseAsync(DATABASE_NAME);
    await db.execAsync('PRAGMA journal_mode = WAL;');
    await migrate(db);
    return db;
  })().catch((error) => {
    opening = undefined;
    throw error;
  });
  return opening;
}
