const migrations = [
  {
    version: 1,
    name: 'initial schema',
    apply(db) { db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (ts INTEGER PRIMARY KEY,cpu REAL NOT NULL DEFAULT 0,memory REAL NOT NULL DEFAULT 0,swap REAL NOT NULL DEFAULT 0,load1 REAL NOT NULL DEFAULT 0,network_rx REAL NOT NULL DEFAULT 0,network_tx REAL NOT NULL DEFAULT 0,disk_read REAL NOT NULL DEFAULT 0,disk_write REAL NOT NULL DEFAULT 0,disk_used REAL NOT NULL DEFAULT 0,containers_down INTEGER NOT NULL DEFAULT 0,pm2_down INTEGER NOT NULL DEFAULT 0,alert_count INTEGER NOT NULL DEFAULT 0,critical_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT,incident_key TEXT NOT NULL,severity TEXT NOT NULL CHECK(severity IN ('warning','critical')),title TEXT NOT NULL,detail TEXT,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),source TEXT,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,acknowledged_at INTEGER,acknowledged_by TEXT,resolved_at INTEGER,resolution TEXT,occurrences INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status,last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_key ON incidents(incident_key,status);
      CREATE TABLE IF NOT EXISTS incident_events (id INTEGER PRIMARY KEY AUTOINCREMENT,incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,ts INTEGER NOT NULL,event_type TEXT NOT NULL,actor TEXT,note TEXT);
      CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events(incident_id,ts DESC);
      CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT,incident_id INTEGER,ts INTEGER NOT NULL,channel TEXT NOT NULL,event_type TEXT NOT NULL,success INTEGER NOT NULL,detail TEXT);
      CREATE TABLE IF NOT EXISTS notification_settings (id INTEGER PRIMARY KEY CHECK(id=1),settings_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
    `); },
  },
  {
    version: 2,
    name: 'incident investigations',
    apply(db) {
      const columns = new Set(db.prepare('PRAGMA table_info(incidents)').all().map(column => column.name));
      if (!columns.has('investigation')) db.exec('ALTER TABLE incidents ADD COLUMN investigation TEXT');
      if (!columns.has('investigated_at')) db.exec('ALTER TABLE incidents ADD COLUMN investigated_at INTEGER');
    },
  },
];
export function migrateDatabase(db) {
  const current = Number(db.pragma('user_version', { simple: true }) || 0);
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.transaction(() => { migration.apply(db); db.pragma(`user_version = ${migration.version}`); })();
  }
  return Number(db.pragma('user_version', { simple: true }));
}
export const latestSchemaVersion = migrations.at(-1).version;
