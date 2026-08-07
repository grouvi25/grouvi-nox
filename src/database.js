import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config, databasePath } from './config.js';

let db;

const RANGE = {
  '1h': { ms: 3600_000, bucket: 30 },
  '24h': { ms: 24 * 3600_000, bucket: 300 },
  '7d': { ms: 7 * 86400_000, bucket: 1800 },
  '30d': { ms: 30 * 86400_000, bucket: 7200 },
};

export function initDatabase() {
  if (db) return db;
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      ts INTEGER PRIMARY KEY,
      cpu REAL NOT NULL DEFAULT 0,
      memory REAL NOT NULL DEFAULT 0,
      swap REAL NOT NULL DEFAULT 0,
      load1 REAL NOT NULL DEFAULT 0,
      network_rx REAL NOT NULL DEFAULT 0,
      network_tx REAL NOT NULL DEFAULT 0,
      disk_read REAL NOT NULL DEFAULT 0,
      disk_write REAL NOT NULL DEFAULT 0,
      disk_used REAL NOT NULL DEFAULT 0,
      containers_down INTEGER NOT NULL DEFAULT 0,
      pm2_down INTEGER NOT NULL DEFAULT 0,
      alert_count INTEGER NOT NULL DEFAULT 0,
      critical_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_key TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('warning','critical')),
      title TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
      source TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      acknowledged_at INTEGER,
      acknowledged_by TEXT,
      resolved_at INTEGER,
      resolution TEXT,
      occurrences INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status, last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_incidents_key ON incidents(incident_key, status);

    CREATE TABLE IF NOT EXISTS incident_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events(incident_id, ts DESC);

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER,
      ts INTEGER NOT NULL,
      channel TEXT NOT NULL,
      event_type TEXT NOT NULL,
      success INTEGER NOT NULL,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS notification_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);

  const incidentColumns = new Set(db.prepare('PRAGMA table_info(incidents)').all().map((c) => c.name));
  if (!incidentColumns.has('investigation')) db.exec('ALTER TABLE incidents ADD COLUMN investigation TEXT');
  if (!incidentColumns.has('investigated_at')) db.exec('ALTER TABLE incidents ADD COLUMN investigated_at INTEGER');

  // Prevent unbounded growth. WAL checkpoint keeps the file compact over time.
  const cutoff = Date.now() - config.historyRetentionDays * 86400_000;
  db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
  db.pragma('wal_checkpoint(PASSIVE)');
  return db;
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function recordMetric(snap) {
  const database = initDatabase();
  const root = (snap.filesystems || []).find(f => f.mount === '/') || snap.filesystems?.[0];
  const alerts = snap.alerts || [];
  database.prepare(`
    INSERT OR REPLACE INTO metrics (
      ts,cpu,memory,swap,load1,network_rx,network_tx,disk_read,disk_write,
      disk_used,containers_down,pm2_down,alert_count,critical_count
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    Date.now(), n(snap.cpu?.usage), n(snap.memory?.usedPct), n(snap.memory?.swapPct),
    n(snap.load?.one), n(snap.network?.rxRate), n(snap.network?.txRate),
    n(snap.diskIo?.readRate), n(snap.diskIo?.writeRate), n(root?.usedPct),
    n(snap.containers?.stopped) + n(snap.containers?.unhealthy), n(snap.pm2?.down),
    alerts.length, alerts.filter(a => a.level === 'critical').length,
  );
}

export function getHistory(rangeName = '24h') {
  const database = initDatabase();
  const range = RANGE[rangeName] || RANGE['24h'];
  const from = Date.now() - range.ms;
  const bucketMs = range.bucket * 1000;
  const rows = database.prepare(`
    SELECT
      CAST(ts / ? AS INTEGER) * ? AS ts,
      ROUND(AVG(cpu),2) cpu,
      ROUND(AVG(memory),2) memory,
      ROUND(AVG(swap),2) swap,
      ROUND(AVG(load1),2) load1,
      ROUND(AVG(network_rx),2) network_rx,
      ROUND(AVG(network_tx),2) network_tx,
      ROUND(AVG(disk_read),2) disk_read,
      ROUND(AVG(disk_write),2) disk_write,
      ROUND(MAX(disk_used),2) disk_used,
      MAX(containers_down) containers_down,
      MAX(pm2_down) pm2_down,
      MAX(alert_count) alert_count,
      MAX(critical_count) critical_count
    FROM metrics
    WHERE ts >= ?
    GROUP BY CAST(ts / ? AS INTEGER)
    ORDER BY ts
  `).all(bucketMs, bucketMs, from, bucketMs);
  return { range: rangeName in RANGE ? rangeName : '24h', bucketSeconds: range.bucket, from, to: Date.now(), rows };
}

function incidentSource(key) {
  return String(key || '').split(':', 1)[0] || 'system';
}

export function syncIncidents(alerts = []) {
  const database = initDatabase();
  const now = Date.now();
  const activeKeys = new Set(alerts.map(a => a.key));
  const events = [];

  const apply = database.transaction(() => {
    for (const alert of alerts) {
      const existing = database.prepare(`
        SELECT * FROM incidents
        WHERE incident_key = ? AND status != 'resolved'
        ORDER BY id DESC LIMIT 1
      `).get(alert.key);

      if (!existing) {
        const result = database.prepare(`
          INSERT INTO incidents
            (incident_key,severity,title,detail,status,source,first_seen,last_seen,occurrences)
          VALUES (?,?,?,?, 'open', ?,?,?,1)
        `).run(alert.key, alert.level, alert.message, alert.hint || '', incidentSource(alert.key), now, now);
        const id = Number(result.lastInsertRowid);
        database.prepare(`INSERT INTO incident_events (incident_id,ts,event_type,note) VALUES (?,?,'opened',?)`)
          .run(id, now, alert.message);
        events.push({ type: 'opened', incident: database.prepare('SELECT * FROM incidents WHERE id=?').get(id) });
      } else {
        const escalated = existing.severity !== 'critical' && alert.level === 'critical';
        database.prepare(`
          UPDATE incidents SET severity=?, title=?, detail=?, last_seen=?, occurrences=occurrences+1
          WHERE id=?
        `).run(alert.level, alert.message, alert.hint || '', now, existing.id);
        if (escalated) {
          database.prepare(`INSERT INTO incident_events (incident_id,ts,event_type,note) VALUES (?,?,'escalated',?)`)
            .run(existing.id, now, alert.message);
          events.push({ type: 'escalated', incident: database.prepare('SELECT * FROM incidents WHERE id=?').get(existing.id) });
        }
      }
    }

    const unresolved = database.prepare(`SELECT * FROM incidents WHERE status != 'resolved'`).all();
    for (const incident of unresolved) {
      if (activeKeys.has(incident.incident_key)) continue;
      if (now - incident.last_seen < config.incidentResolveGraceMs) continue;
      database.prepare(`
        UPDATE incidents SET status='resolved', resolved_at=?, resolution='Recovered automatically'
        WHERE id=?
      `).run(now, incident.id);
      database.prepare(`INSERT INTO incident_events (incident_id,ts,event_type,actor,note) VALUES (?,?,'resolved','system','Recovered automatically')`)
        .run(incident.id, now);
      events.push({ type: 'resolved', incident: database.prepare('SELECT * FROM incidents WHERE id=?').get(incident.id) });
    }
  });
  apply();
  return events;
}

export function listIncidents({ status = 'active', limit = 6, offset = 0 } = {}) {
  const database = initDatabase();
  const max = Math.min(50, Math.max(1, Number(limit) || 6));
  const skip = Math.max(0, Number(offset) || 0);
  const rows = status === 'all'
    ? database.prepare('SELECT * FROM incidents ORDER BY first_seen DESC LIMIT ? OFFSET ?').all(max, skip)
    : status === 'active'
      ? database.prepare("SELECT * FROM incidents WHERE status!='resolved' ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, first_seen DESC LIMIT ? OFFSET ?").all(max, skip)
      : database.prepare('SELECT * FROM incidents WHERE status=? ORDER BY first_seen DESC LIMIT ? OFFSET ?').all(status, max, skip);
  const events = database.prepare('SELECT * FROM incident_events WHERE incident_id=? ORDER BY ts DESC LIMIT 30');
  return rows.map(row => ({ ...row, events: events.all(row.id) }));
}

export function acknowledgeIncident(id, actor = 'admin', note = '') {
  const database = initDatabase();
  const now = Date.now();
  const row = database.prepare('SELECT * FROM incidents WHERE id=?').get(id);
  if (!row) return null;
  if (row.status === 'resolved') return row;
  database.prepare(`UPDATE incidents SET status='acknowledged', acknowledged_at=?, acknowledged_by=? WHERE id=?`)
    .run(now, actor, id);
  database.prepare(`INSERT INTO incident_events (incident_id,ts,event_type,actor,note) VALUES (?,?,'acknowledged',?,?)`)
    .run(id, now, actor, String(note).slice(0, 500));
  return database.prepare('SELECT * FROM incidents WHERE id=?').get(id);
}

export function resolveIncident(id, actor = 'admin', note = 'Closed manually') {
  const database = initDatabase();
  const now = Date.now();
  const row = database.prepare('SELECT * FROM incidents WHERE id=?').get(id);
  if (!row) return null;
  database.prepare(`UPDATE incidents SET status='resolved', resolved_at=?, resolution=? WHERE id=?`)
    .run(now, String(note).slice(0, 500), id);
  database.prepare(`INSERT INTO incident_events (incident_id,ts,event_type,actor,note) VALUES (?,?,'resolved',?,?)`)
    .run(id, now, actor, String(note).slice(0, 500));
  return database.prepare('SELECT * FROM incidents WHERE id=?').get(id);
}

export function recordNotification({ incidentId, eventType, success, detail = '' }) {
  initDatabase().prepare(`
    INSERT INTO notifications (incident_id,ts,channel,event_type,success,detail)
    VALUES (?,?,'telegram',?,?,?)
  `).run(incidentId || null, Date.now(), eventType, success ? 1 : 0, String(detail).slice(0, 1000));
}


const NOTIFICATION_DEFAULTS = Object.freeze({ enabled:true,warning:true,critical:true,opened:true,escalated:true,resolved:true,dailyDigest:true,quietEnabled:false,quietStart:23,quietEnd:8,criticalDuringQuiet:true,cooldownMin:30 });
export function getNotificationSettings(){
  const row=initDatabase().prepare('SELECT settings_json FROM notification_settings WHERE id=1').get();
  if(!row) return {...NOTIFICATION_DEFAULTS};
  try{return {...NOTIFICATION_DEFAULTS,...JSON.parse(row.settings_json)}}catch{return {...NOTIFICATION_DEFAULTS}}
}
export function updateNotificationSettings(input={}){
  const next={...getNotificationSettings()};
  for(const key of ['enabled','warning','critical','opened','escalated','resolved','dailyDigest','quietEnabled','criticalDuringQuiet']) if(typeof input[key]==='boolean') next[key]=input[key];
  for(const key of ['quietStart','quietEnd']){const value=Number(input[key]);if(Number.isInteger(value)&&value>=0&&value<=23)next[key]=value}
  const cooldown=Number(input.cooldownMin);if([5,15,30,60,120].includes(cooldown))next.cooldownMin=cooldown;
  initDatabase().prepare(`INSERT INTO notification_settings (id,settings_json,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at`).run(JSON.stringify(next),Date.now());return next;
}
export function incidentCounts(){
  const row=initDatabase().prepare(`SELECT COUNT(*) total,SUM(status='open') open,SUM(status='acknowledged') acknowledged,SUM(status='resolved') resolved,SUM(status!='resolved') active,SUM(status!='resolved' AND severity='critical') critical FROM incidents`).get();
  return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v||0)]));
}

export function notificationStatus() {
  const database = initDatabase();
  return database.prepare(`SELECT * FROM notifications ORDER BY ts DESC LIMIT 20`).all();
}


export function updateIncidentInvestigation(id, report) {
  const database = initDatabase();
  database.prepare('UPDATE incidents SET investigation=?, investigated_at=? WHERE id=?')
    .run(String(report || '').slice(0, 12000), Date.now(), Number(id));
  return database.prepare('SELECT * FROM incidents WHERE id=?').get(Number(id));
}

export function getIncident(id) {
  return initDatabase().prepare('SELECT * FROM incidents WHERE id=?').get(Number(id));
}

export function incidentDigest(hours = 24) {
  const database = initDatabase();
  const since = Date.now() - Math.max(1, Number(hours) || 24) * 3600_000;
  const opened = database.prepare('SELECT COUNT(*) n FROM incidents WHERE first_seen>=?').get(since).n;
  const critical = database.prepare("SELECT COUNT(*) n FROM incidents WHERE first_seen>=? AND severity='critical'").get(since).n;
  const resolved = database.prepare("SELECT COUNT(*) n FROM incidents WHERE resolved_at>=?").get(since).n;
  const active = database.prepare("SELECT COUNT(*) n FROM incidents WHERE status!='resolved'").get().n;
  const top = database.prepare('SELECT severity,title,first_seen FROM incidents WHERE first_seen>=? ORDER BY severity ASC, first_seen DESC LIMIT 5').all(since);
  return { opened, critical, resolved, active, top };
}

export function setIncidentStatus(id, status, actor = 'admin', note = '') {
  const database = initDatabase();
  const allowed = new Set(['open', 'acknowledged', 'resolved']);
  if (!allowed.has(status)) return null;
  const row = database.prepare('SELECT * FROM incidents WHERE id=?').get(Number(id));
  if (!row) return null;
  const now = Date.now();
  if (status === 'open') database.prepare(`UPDATE incidents SET status='open', acknowledged_at=NULL, acknowledged_by=NULL, resolved_at=NULL, resolution=NULL WHERE id=?`).run(row.id);
  if (status === 'acknowledged') database.prepare(`UPDATE incidents SET status='acknowledged', acknowledged_at=?, acknowledged_by=?, resolved_at=NULL, resolution=NULL WHERE id=?`).run(now, actor, row.id);
  if (status === 'resolved') database.prepare(`UPDATE incidents SET status='resolved', resolved_at=?, resolution=? WHERE id=?`).run(now, String(note || 'Closed manually').slice(0,500), row.id);
  database.prepare(`INSERT INTO incident_events (incident_id,ts,event_type,actor,note) VALUES (?,?,?,?,?)`).run(row.id, now, status === 'open' ? 'reopened' : status, actor, String(note).slice(0,500));
  return database.prepare('SELECT * FROM incidents WHERE id=?').get(row.id);
}
