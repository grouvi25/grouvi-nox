import path from 'node:path';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(env.PORT, 3999),
  host: env.HOST || '127.0.0.1',
  stateDir: env.STATE_DIR || '/var/lib/vps-sentinel',
  adminSocket:env.ADMIN_SOCKET||'/run/vps-sentinel/admin.sock',
  aiBridgeSocket:env.SENTINEL_AI_BRIDGE_SOCKET||'/run/sentinel-ai/bridge.sock',

  // WebAuthn relying party
  rpID: env.RP_ID || 'vps.grouvi.online',
  rpName: env.RP_NAME || 'VPS Sentinel',
  origin: env.ORIGIN || 'https://vps.grouvi.online',

  sessionTtlMs: num(env.SESSION_TTL_MIN, 720) * 60_000,
  challengeTtlMs: 120_000,
  enrollTokenTtlMs: num(env.ENROLL_TTL_MIN, 20) * 60_000,

  // collector tiers
  fastIntervalMs: num(env.FAST_INTERVAL_MS, 2000),
  slowIntervalMs: num(env.SLOW_INTERVAL_MS, 15000),
  rareIntervalMs: num(env.RARE_INTERVAL_MS, 300_000),
  certIntervalMs: num(env.CERT_INTERVAL_MS, 6 * 3600 * 1000),

  historyPoints: num(env.HISTORY_POINTS, 180),
  historyPersistIntervalMs: num(env.HISTORY_PERSIST_INTERVAL_MS, 10_000),
  historyRetentionDays: num(env.HISTORY_RETENTION_DAYS, 30),
  incidentResolveGraceMs: num(env.INCIDENT_RESOLVE_GRACE_MS, 45_000),

  releaseRepo: env.SENTINEL_RELEASE_REPO || 'grouvi25/vps-sentinel',
  updateCheckIntervalMs: num(env.UPDATE_CHECK_INTERVAL_MS, 30 * 60_000),

  fleet: {
    role: env.SENTINEL_ROLE || 'standalone',
    nodeId: env.FLEET_NODE_ID || '',
    nodeName: env.FLEET_NODE_NAME || env.FLEET_NODE_ID || '',
    hubUrl: env.FLEET_HUB_URL || '',
    secret: env.FLEET_SHARED_SECRET || '',
    pushIntervalMs: num(env.FLEET_PUSH_INTERVAL_MS, 10_000),
    offlineAfterMs: num(env.FLEET_OFFLINE_AFTER_MS, 45_000),
    maxSnapshotBytes: num(env.FLEET_MAX_SNAPSHOT_BYTES, 512 * 1024),
    ingestPerMinute: num(env.FLEET_INGEST_PER_MINUTE, 30),
    allowedIps: (env.FLEET_ALLOWED_IPS || '').split(',').map(x => x.trim()).filter(Boolean),
    nodes: (() => {
      try { return JSON.parse(env.FLEET_NODES_JSON || '{}'); } catch { return {}; }
    })(),
  },

  telegram: {
    botToken: env.SENTINEL_TELEGRAM_BOT_TOKEN || '',
    chatId: env.SENTINEL_TELEGRAM_CHAT_ID || '',
    enabled: Boolean(env.SENTINEL_TELEGRAM_BOT_TOKEN && env.SENTINEL_TELEGRAM_CHAT_ID),
    cooldownMs: num(env.TELEGRAM_COOLDOWN_MIN, 30) * 60_000,
  },

  paths: {
    dockerSocket: env.DOCKER_SOCKET || '/var/run/docker.sock',
    dockerBroker: env.DOCKER_BROKER_SOCKET || path.join(env.STATE_DIR || '/var/lib/vps-sentinel', 'docker-read.sock'),
    authLog: env.AUTH_LOG || '/var/log/auth.log',
    nginxSitesEnabled: env.NGINX_SITES || '/etc/nginx/sites-enabled',
    pm2: env.PM2_BIN || '/usr/bin/pm2',
    fail2ban: env.FAIL2BAN_BIN || '/usr/bin/fail2ban-client',
  },

  backupDirs: (env.BACKUP_DIRS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  thresholds: {
    diskWarn: num(env.DISK_WARN, 80),
    diskCrit: num(env.DISK_CRIT, 90),
    memWarn: num(env.MEM_WARN, 85),
    memCrit: num(env.MEM_CRIT, 94),
    cpuWarn: num(env.CPU_WARN, 85),
    cpuCrit: num(env.CPU_CRIT, 95),
    loadPerCoreWarn: 1.5,
    loadPerCoreCrit: 3,
    swapWarnPct: num(env.SWAP_WARN, 40),
    certWarnDays: num(env.CERT_WARN_DAYS, 21),
    certCritDays: num(env.CERT_CRIT_DAYS, 7),
    backupStaleHours: num(env.BACKUP_STALE_HOURS, 36),
  },
};

export const statePath = path.join(config.stateDir, 'state.json');
export const databasePath = path.join(config.stateDir, 'sentinel.db');
