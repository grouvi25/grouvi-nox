import { initDatabase } from './connection.js';

const RANGE = {
  '1h': { ms: 3600_000, bucket: 30 },
  '24h': { ms: 24 * 3600_000, bucket: 300 },
  '7d': { ms: 7 * 86400_000, bucket: 1800 },
  '30d': { ms: 30 * 86400_000, bucket: 7200 },
};

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
