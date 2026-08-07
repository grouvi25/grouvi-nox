import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config, databasePath } from '../config.js';
import { migrateDatabase } from './migrations.js';
let db;

export function initDatabase() {
  if (db) return db;
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);

  // Prevent unbounded growth. WAL checkpoint keeps the file compact over time.
  const cutoff = Date.now() - config.historyRetentionDays * 86400_000;
  db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
  db.pragma('wal_checkpoint(PASSIVE)');
  return db;
}
