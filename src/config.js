import path from 'node:path';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(env.PORT, 3999),
  host: env.HOST || '127.0.0.1',
  stateDir: env.STATE_DIR || '/var/lib/vps-sentinel',

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

  paths: {
    dockerSocket: env.DOCKER_SOCKET || '/var/run/docker.sock',
    authLog: env.AUTH_LOG || '/var/log/auth.log',
    nginxSitesEnabled: env.NGINX_SITES || '/etc/nginx/sites-enabled',
    pm2: env.PM2_BIN || '/usr/bin/pm2',
    fail2ban: env.FAIL2BAN_BIN || '/usr/bin/fail2ban-client',
  },

  backupDirs: (env.BACKUP_DIRS ||
    '/opt/coursebot/backups,/opt/mmo90s/backups,/opt/reip/backups,/root/backups')
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
