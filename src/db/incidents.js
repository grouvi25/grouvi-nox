import { config } from '../config.js';
import { initDatabase } from './connection.js';

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

export function incidentCounts(){
  const row=initDatabase().prepare(`SELECT COUNT(*) total,SUM(status='open') open,SUM(status='acknowledged') acknowledged,SUM(status='resolved') resolved,SUM(status!='resolved') active,SUM(status!='resolved' AND severity='critical') critical FROM incidents`).get();
  return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v||0)]));
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
