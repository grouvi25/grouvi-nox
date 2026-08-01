import { config } from '../config.js';

const T = config.thresholds;

const mk = (level, key, message, hint) => ({ level, key, message, hint: hint || null });

export function evaluate(snap) {
  const out = [];
  if (!snap) return out;

  /* disk */
  for (const fsx of snap.filesystems || []) {
    if (fsx.usedPct >= T.diskCrit) {
      out.push(mk('critical', `disk:${fsx.mount}`,
        `Диск ${fsx.mount} заполнен на ${fsx.usedPct.toFixed(0)}%`,
        'Меньше 10% свободно: сервисы могут начать падать'));
    } else if (fsx.usedPct >= T.diskWarn) {
      out.push(mk('warning', `disk:${fsx.mount}`,
        `Диск ${fsx.mount} заполнен на ${fsx.usedPct.toFixed(0)}%`));
    }
    if ((fsx.inodePct || 0) >= 85) {
      out.push(mk('warning', `inode:${fsx.mount}`, `Inodes ${fsx.mount}: ${fsx.inodePct}%`));
    }
  }

  /* memory */
  if (snap.memory) {
    if (snap.memory.usedPct >= T.memCrit) {
      out.push(mk('critical', 'mem', `Память занята на ${snap.memory.usedPct.toFixed(0)}%`, 'Риск OOM-killer'));
    } else if (snap.memory.usedPct >= T.memWarn) {
      out.push(mk('warning', 'mem', `Память занята на ${snap.memory.usedPct.toFixed(0)}%`));
    }
    if (snap.memory.swapPct >= T.swapWarnPct) {
      out.push(mk('warning', 'swap', `Своп использован на ${snap.memory.swapPct.toFixed(0)}%`,
        'Система активно свопит, это бьёт по скорости'));
    }
  }

  /* cpu / load */
  if (snap.cpu && snap.cpu.usage >= T.cpuCrit) {
    out.push(mk('warning', 'cpu', `CPU ${snap.cpu.usage.toFixed(0)}%`));
  }
  if (snap.load && snap.cpu?.count) {
    const perCore = snap.load.five / snap.cpu.count;
    if (perCore >= T.loadPerCoreCrit) {
      out.push(mk('critical', 'load', `Load average ${snap.load.five.toFixed(2)} на ${snap.cpu.count} ядра`));
    } else if (perCore >= T.loadPerCoreWarn) {
      out.push(mk('warning', 'load', `Load average ${snap.load.five.toFixed(2)} на ${snap.cpu.count} ядра`));
    }
  }
  if (snap.cpu && snap.cpu.steal >= 15) {
    out.push(mk('warning', 'steal', `CPU steal ${snap.cpu.steal.toFixed(0)}%`, 'Гипервизор отбирает такты у вашей VM'));
  }

  /* containers */
  for (const c of snap.containers?.items || []) {
    if (c.health === 'unhealthy') {
      out.push(mk('critical', `docker:${c.name}`, `Контейнер ${c.name}: unhealthy`));
    } else if (c.state !== 'running') {
      out.push(mk('warning', `docker:${c.name}`, `Контейнер ${c.name}: ${c.state}`, c.status));
    }
  }

  /* pm2 */
  for (const p of snap.pm2?.items || []) {
    if (p.status !== 'online') {
      out.push(mk('critical', `pm2:${p.name}`, `PM2 процесс ${p.name}: ${p.status}`));
    } else if (p.unstableRestarts > 0) {
      out.push(mk('warning', `pm2u:${p.name}`, `PM2 ${p.name}: ${p.unstableRestarts} нестабильных рестартов`));
    }
  }

  /* systemd */
  for (const u of snap.systemd?.failedUnits || []) {
    out.push(mk('critical', `unit:${u}`, `systemd юнит упал: ${u}`));
  }
  if (snap.systemd && snap.systemd.nginx !== 'active') {
    out.push(mk('critical', 'nginx', `nginx: ${snap.systemd.nginx}`));
  }

  /* certificates */
  for (const c of snap.certificates || []) {
    if (!c.ok) continue;
    if (c.daysLeft <= T.certCritDays) {
      out.push(mk('critical', `cert:${c.domain}`, `Сертификат ${c.domain} истекает через ${c.daysLeft} дн.`));
    } else if (c.daysLeft <= T.certWarnDays) {
      out.push(mk('warning', `cert:${c.domain}`, `Сертификат ${c.domain} истекает через ${c.daysLeft} дн.`));
    }
  }

  /* backups */
  for (const b of snap.backups || []) {
    if (!b.exists || !b.newest) continue;
    if (b.ageHours > T.backupStaleHours) {
      out.push(mk('warning', `backup:${b.dir}`,
        `Бэкап ${b.dir} не обновлялся ${Math.floor(b.ageHours)} ч.`));
    }
  }

  /* os */
  if (snap.os?.rebootRequired) {
    out.push(mk('warning', 'reboot',
      `Требуется перезагрузка: работает ${snap.os.kernelRunning}, установлено ${snap.os.kernelInstalled}`));
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level] || a.key.localeCompare(b.key));
  return out;
}
