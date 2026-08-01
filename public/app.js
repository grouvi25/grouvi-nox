const $ = (id) => document.getElementById(id);

/* palette mirrors style.css */
const C = {
  accent: '#F4EDE4', blue: '#3b82f6', green: '#22c55e',
  red: '#ef4444', amber: '#f59e0b', purple: '#a855f7',
  grid: 'rgba(255,255,255,.045)', axis: '#666',
};

/* ----------------------------- utils ----------------------------- */
const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
function bytes(n, digits = 1) {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}
const rate = (n) => `${bytes(n, 1)}/с`;
function dur(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}
function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)} с назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн назад`;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lvl = (v, w, c) => (v >= c ? 'crit' : v >= w ? 'warn' : 'ok');
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setBar(el, pct, level) {
  if (!el) return;
  el.style.width = `${clamp(pct, 0, 100)}%`;
  el.className = level === 'ok' ? '' : level;
}

/* ---------------------------- charts ----------------------------- */
function prep(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function spark(canvas, series, color, maxOverride) {
  if (!canvas) return;
  const { ctx, w, h } = prep(canvas);
  if (!series || series.length < 2) return;
  const max = maxOverride ?? Math.max(1, ...series);
  const pad = 2;
  const step = w / (series.length - 1);
  const y = (v) => h - pad - (clamp(v, 0, max) / max) * (h - pad * 2);

  const line = new Path2D();
  line.moveTo(0, y(series[0]));
  for (let i = 1; i < series.length; i += 1) line.lineTo(i * step, y(series[i]));

  const area = new Path2D(line);
  area.lineTo(w, h); area.lineTo(0, h); area.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `${color}2e`);
  g.addColorStop(1, `${color}00`);
  ctx.fillStyle = g; ctx.fill(area);

  ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
  ctx.stroke(line);
}

function multiChart(canvas, sets, { max, unit = '' } = {}) {
  if (!canvas) return;
  const { ctx, w, h } = prep(canvas);
  const padL = 44; const padR = 8; const padT = 9; const padB = 14;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const all = sets.flatMap(s => s.data || []);
  const peak = max ?? Math.max(1, ...all);
  const top = peak <= 1 ? 1 : peak * 1.14;

  ctx.strokeStyle = C.grid;
  ctx.fillStyle = C.axis;
  ctx.font = '10px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const yy = Math.round(padT + (plotH / 4) * i) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    const val = top * (1 - i / 4);
    const label = unit === 'KB' ? bytes(val * 1024, 0) : `${val.toFixed(top > 10 ? 0 : 1)}${unit}`;
    ctx.fillText(label, 4, yy + 3);
  }

  for (const s of sets) {
    const d = s.data || [];
    if (d.length < 2) continue;
    const step = plotW / (d.length - 1);
    const y = (v) => padT + plotH - (clamp(v, 0, top) / top) * plotH;

    const p = new Path2D();
    p.moveTo(padL, y(d[0]));
    for (let i = 1; i < d.length; i += 1) p.lineTo(padL + i * step, y(d[i]));

    if (s.fill !== false) {
      const area = new Path2D(p);
      area.lineTo(padL + plotW, padT + plotH);
      area.lineTo(padL, padT + plotH);
      area.closePath();
      const g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      g.addColorStop(0, `${s.color}26`);
      g.addColorStop(1, `${s.color}00`);
      ctx.fillStyle = g; ctx.fill(area);
    }
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    ctx.stroke(p);
  }
}

/* ----------------------------- icons ----------------------------- */
const ICON_CRIT = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24"><path d="M10.3 4.3L2.6 18a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 4.3a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>';

/* ----------------------------- render ---------------------------- */
let latest = null;

function renderAlerts(a) {
  const box = $('alerts');
  const nb = $('nbAlerts');
  if (!a || a.length === 0) {
    box.innerHTML = `<div class="all-clear">${ICON_OK}<span>Всё в норме, проблем не обнаружено</span></div>`;
    nb.textContent = '0';
    nb.className = 'n-badge';
    return;
  }
  const crit = a.filter(x => x.level === 'critical').length;
  nb.textContent = String(a.length);
  nb.className = `n-badge ${crit ? 'alert' : 'warn'}`;
  box.innerHTML = a.slice(0, 8).map(x => `
    <div class="alert ${x.level}">
      ${x.level === 'critical' ? ICON_CRIT : ICON_WARN}
      <span>${esc(x.message)}</span>
      ${x.hint ? `<span class="hint">${esc(x.hint)}</span>` : ''}
    </div>`).join('');
}

function renderKpis(d) {
  const cpu = d.cpu || {}; const mem = d.memory || {};
  const ld = d.load || {}; const net = d.network || {}; const io = d.diskIo || {};
  const h = d.history || {};

  const cl = lvl(cpu.usage || 0, 85, 95);
  $('kCpu').className = `kpi ${cl === 'ok' ? '' : cl}`;
  $('cpuVal').textContent = (cpu.usage || 0).toFixed(1);
  $('cpuFoot').textContent = `${cpu.count || 0} ядра · iowait ${(cpu.iowait || 0).toFixed(1)}% · steal ${(cpu.steal || 0).toFixed(1)}%`;
  spark($('spCpu'), h.cpu, C.accent, 100);
  $('gCpu').textContent = `${(cpu.usage || 0).toFixed(0)}%`;
  setBar($('gCpuBar'), cpu.usage || 0, cl);

  const ml = lvl(mem.usedPct || 0, 85, 94);
  $('kMem').className = `kpi ${ml === 'ok' ? '' : ml}`;
  $('memVal').textContent = (mem.usedPct || 0).toFixed(1);
  $('memFoot').textContent = `${bytes(mem.used)} из ${bytes(mem.total)} · доступно ${bytes(mem.available)}`;
  spark($('spMem'), h.mem, C.blue, 100);
  $('gMem').textContent = `${(mem.usedPct || 0).toFixed(0)}%`;
  setBar($('gMemBar'), mem.usedPct || 0, ml);

  const root = (d.filesystems || []).find(f => f.mount === '/') || (d.filesystems || [])[0];
  if (root) {
    const dl = lvl(root.usedPct, 80, 90);
    $('kDisk').className = `kpi ${dl === 'ok' ? '' : dl}`;
    $('diskVal').textContent = root.usedPct.toFixed(1);
    $('diskFoot').textContent = `${bytes(root.used)} из ${bytes(root.size)} · свободно ${bytes(root.avail)}`;
    setBar($('diskBar'), root.usedPct, dl);
    $('gDisk').textContent = `${root.usedPct.toFixed(0)}%`;
    setBar($('gDiskBar'), root.usedPct, dl);
  }
  $('ioFoot').textContent = `чтение ${rate(io.readRate || 0)} · запись ${rate(io.writeRate || 0)}`;

  const perCore = cpu.count ? (ld.five || 0) / cpu.count : 0;
  const ll = lvl(perCore, 1.5, 3);
  $('kLoad').className = `kpi ${ll === 'ok' ? '' : ll}`;
  $('loadVal').textContent = (ld.one || 0).toFixed(2);
  $('loadFoot').textContent = `5м ${(ld.five || 0).toFixed(2)} · 15м ${(ld.fifteen || 0).toFixed(2)} · ${ld.processes || 0} процессов`;
  spark($('spLoad'), h.load, C.purple);

  $('netVal').textContent = `${bytes(net.rxRate || 0, 0)} ↓  ${bytes(net.txRate || 0, 0)} ↑`;
  $('netFoot').textContent = `всего ${bytes(net.rxTotal || 0)} / ${bytes(net.txTotal || 0)} · ошибок ${net.errors || 0}`;
  spark($('spNet'), h.rx, C.green);

  const sl = lvl(mem.swapPct || 0, 40, 75);
  $('kSwap').className = `kpi ${sl === 'ok' ? '' : sl}`;
  $('swapVal').textContent = (mem.swapPct || 0).toFixed(1);
  $('swapFoot').textContent = `${bytes(mem.swapUsed || 0)} из ${bytes(mem.swapTotal || 0)}`;
  setBar($('swapBar'), mem.swapPct || 0, sl);
  $('procFoot').textContent = `выполняется ${cpu.procsRunning || 0} · заблокировано ${cpu.procsBlocked || 0}`;
}

function renderCharts(d) {
  const h = d.history || {};
  multiChart($('chCpu'), [
    { data: h.cpu, color: C.accent },
    { data: h.mem, color: C.blue },
    { data: h.swap, color: C.purple, fill: false },
  ], { max: 100, unit: '%' });

  multiChart($('chNet'), [
    { data: h.rx, color: C.green },
    { data: h.tx, color: C.blue },
    { data: h.ioR, color: C.amber, fill: false },
    { data: h.ioW, color: C.red, fill: false },
  ], { unit: 'KB' });
}

function renderCores(d) {
  const cores = d.cpu?.cores || [];
  $('coreCount').textContent = cores.length;
  $('cores').innerHTML = cores.map((v, i) => `
    <div class="core">
      <div class="c-top"><span>CPU ${i}</span><b>${v.toFixed(0)}%</b></div>
      <div class="track"><i class="${lvl(v, 75, 90) === 'ok' ? '' : lvl(v, 75, 90)}" style="width:${clamp(v, 0, 100)}%"></i></div>
    </div>`).join('');
}

function renderFs(d) {
  const rows = d.filesystems || [];
  $('fsBody').innerHTML = rows.length ? rows.map(f => {
    const l = lvl(f.usedPct, 80, 90);
    return `<tr>
      <td class="nm">${esc(f.mount)}</td>
      <td>${esc(f.device)}</td>
      <td class="num">${bytes(f.size)}</td>
      <td class="num">${bytes(f.avail)}</td>
      <td class="num"><span class="pill ${l}">${f.usedPct.toFixed(0)}%</span></td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">нет данных</td></tr>';
}

function renderContainers(d) {
  const c = d.containers;
  const box = $('containers');
  if (!c || !c.available) {
    box.innerHTML = '<div class="empty">Docker недоступен</div>';
    return;
  }
  $('ctnCount').textContent = c.items.length;
  $('nbDocker').textContent = String(c.items.length);
  $('nbDocker').className = `n-badge${c.unhealthy ? ' alert' : c.stopped ? ' warn' : ''}`;
  $('ctnSummary').textContent = `${c.running} работает · ${c.stopped} остановлено`;

  const groups = {};
  for (const it of c.items) (groups[it.project || 'без проекта'] ??= []).push(it);

  box.innerHTML = Object.entries(groups).map(([proj, items]) => `
    <div class="proj">
      <div class="p-head">${esc(proj)}<span class="count">${items.length}</span></div>
      ${items.map(i => {
    const sd = i.state !== 'running' ? 'idle'
      : i.health === 'unhealthy' ? 'crit'
        : i.health === 'health: starting' ? 'warn' : 'ok';
    return `<div class="ctn">
          <span class="sd ${sd}"></span>
          <span class="nm">${esc(i.name)}</span>
          <span class="im">${esc(i.image)}</span>
          <span class="st">${esc(i.status)}</span>
        </div>`;
  }).join('')}
    </div>`).join('');
}

function renderPm2(d) {
  const p = d.pm2;
  const body = $('pm2Body');
  if (!p || !p.available) {
    body.innerHTML = '<tr><td colspan="6" class="empty">PM2 недоступен</td></tr>';
    return;
  }
  $('pm2Count').textContent = p.items.length;
  $('nbPm2').textContent = String(p.items.length);
  $('nbPm2').className = `n-badge${p.down ? ' alert' : ''}`;
  body.innerHTML = p.items.map(i => `<tr>
    <td class="nm">${esc(i.name)}</td>
    <td><span class="pill ${i.status === 'online' ? 'ok' : 'crit'}">${esc(i.status)}</span></td>
    <td class="num">${i.cpu}%</td>
    <td class="num">${bytes(i.memory)}</td>
    <td class="num">${i.restarts}${i.unstableRestarts ? ` <span class="pill warn">${i.unstableRestarts}!</span>` : ''}</td>
    <td class="num">${dur(i.uptimeMs / 1000)}</td>
  </tr>`).join('');
}

const kv = (k, v, sub) =>
  `<div class="kv"><span class="k">${k}${sub ? `<span class="sub">${sub}</span>` : ''}</span><span class="v">${v}</span></div>`;

function renderSecurity(d) {
  const f = d.fail2ban || {}; const s = d.ssh || {};
  let html = kv('Вход по паролю', '<span class="pill ok">отключён</span>')
    + kv('Забанено сейчас', f.available ? f.currentlyBanned : '—')
    + kv('Забанено всего', f.available ? f.totalBanned : '—')
    + kv('Неудачных паролей', s.available ? s.failedPassword : '—', 'в текущем окне лога')
    + kv('Несуществующие юзеры', s.available ? s.invalidUser : '—');
  if (s.topAttackers?.length) {
    html += `<div class="kv" style="padding-top:12px"><span class="k">Топ источников</span><span class="v"></span></div>`;
    html += s.topAttackers.map(a =>
      kv(`<span style="font-family:var(--mono)">${esc(a.ip)}</span>`, a.count)).join('');
  }
  $('security').innerHTML = html;
}

function renderCerts(d) {
  const list = (d.certificates || []).filter(c => c.ok);
  $('certCount').textContent = list.length;
  $('certBody').innerHTML = list.length ? list.map(c => {
    const l = c.daysLeft <= 7 ? 'crit' : c.daysLeft <= 21 ? 'warn' : 'ok';
    return `<tr><td class="nm">${esc(c.domain)}</td><td class="num"><span class="pill ${l}">${c.daysLeft} дн.</span></td></tr>`;
  }).join('') : '<tr><td colspan="2" class="empty">нет данных</td></tr>';
}

function renderBackups(d) {
  const list = d.backups || [];
  $('backups').innerHTML = list.length ? list.map(b => {
    const name = b.dir.split('/').filter(Boolean).slice(-2).join('/');
    if (!b.exists) return kv(esc(name), '<span class="pill idle">нет папки</span>');
    if (!b.newest) return kv(esc(name), '<span class="pill warn">пусто</span>');
    const l = b.ageHours > 36 ? 'warn' : 'ok';
    return `<div class="kv">
      <span class="k">${esc(name)}<span class="sub">${b.count} файлов · ${bytes(b.bytes)}</span></span>
      <span class="v"><span class="pill ${l}">${ago(b.newest.at)}</span><span class="sub">${bytes(b.newest.size)}</span></span>
    </div>`;
  }).join('') : '<div class="empty">нет данных</div>';
}

function renderServices(d) {
  const s = d.systemd || {};
  const pill = (v) => `<span class="pill ${v === 'active' ? 'ok' : 'crit'}">${esc(v || '—')}</span>`;
  const failed = s.failedUnits || [];
  let html = kv('nginx', pill(s.nginx)) + kv('docker', pill(s.docker)) + kv('ssh', pill(s.ssh));
  html += kv('Упавших юнитов', failed.length
    ? `<span class="pill crit">${failed.length}</span>`
    : '<span class="pill ok">0</span>');
  for (const u of failed) html += kv(`<span style="color:var(--red)">${esc(u)}</span>`, '');
  if (d.os) {
    html += kv('Ядро', esc(d.os.kernelRunning));
    if (d.os.rebootRequired) {
      html += kv('Перезагрузка', `<span class="pill warn">нужна</span>`, `установлено ${esc(d.os.kernelInstalled)}`);
    }
  }
  $('services').innerHTML = html;
}

function renderDockerDisk(d) {
  const dd = d.dockerDisk;
  if (!dd) { $('dockerDisk').innerHTML = '<div class="empty">нет данных</div>'; return; }
  $('dockerDisk').innerHTML =
    kv(`Образы (${dd.images.count})`, bytes(dd.images.size))
    + kv(`Контейнеры (${dd.containers.count})`, bytes(dd.containers.size))
    + kv(`Тома (${dd.volumes.count})`, bytes(dd.volumes.size))
    + kv('Кэш сборки', bytes(dd.buildCache.size))
    + kv('Можно освободить', `<span class="pill ${dd.buildCache.reclaimable > 2e9 ? 'warn' : 'ok'}">${bytes(dd.buildCache.reclaimable)}</span>`);
}

function renderLogins(d) {
  const list = d.ssh?.recentLogins || [];
  $('logins').innerHTML = list.length
    ? `<table><tbody>${list.map(l => `<tr>
        <td class="nm">${esc(l.user)}</td>
        <td>${esc(l.ip)}</td>
        <td><span class="pill ${l.method === 'publickey' ? 'ok' : 'warn'}">${esc(l.method)}</span></td>
        <td class="num">${esc(String(l.at).replace('T', ' ').slice(5, 16))}</td>
      </tr>`).join('')}</tbody></table>`
    : '<div class="empty">нет данных</div>';
}

function renderHeader(d) {
  const host = d.kernel?.hostname || '—';
  $('sideHost').textContent = host;
  $('tbTitle').textContent = host;
  $('tbSub').textContent = `${d.os?.pretty || '—'} · аптайм ${dur(d.uptime)}`;
  $('sideUpdated').textContent = `обновлено ${new Date().toLocaleTimeString('ru-RU')}`;
  $('tickInfo').textContent = `${d.cpu?.count || 0} vCPU · ${bytes(d.memory?.total || 0)} RAM`;
}

let lastFull = 0;
function render(d) {
  latest = d;
  renderHeader(d);
  renderAlerts(d.alerts);
  renderKpis(d);
  renderCharts(d);
  renderCores(d);

  const now = Date.now();
  if (now - lastFull > 4000) {
    lastFull = now;
    renderFs(d); renderContainers(d); renderPm2(d);
    renderSecurity(d); renderCerts(d); renderBackups(d);
    renderServices(d); renderDockerDisk(d); renderLogins(d);
  }
}

/* -------------------------- connection --------------------------- */
let ws = null;
let retry = 0;

function setConn(state, text) {
  $('dot').className = `dot ${state}`;
  $('connText').textContent = text;
}

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`;
  ws = new WebSocket(url);

  ws.onopen = () => { retry = 0; setConn('live', 'live'); };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot' || msg.type === 'tick') render(msg.data);
  };

  ws.onclose = (ev) => {
    if (ev.code === 4001 || ev.code === 1008) { location.href = '/login'; return; }
    setConn('down', 'переподключение…');
    retry += 1;
    setTimeout(connect, Math.min(15000, 800 * retry));
  };

  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}

async function bootstrap() {
  try {
    const r = await fetch('/api/snapshot', { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login'; return; }
    render(await r.json());
  } catch { /* websocket will fill in */ }
  connect();
}

/* ------------------------------ ui ------------------------------- */
$('logout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/login';
});

const sidebar = $('sidebar');
$('burger').addEventListener('click', () => sidebar.classList.toggle('open'));

/* scroll spy */
const navItems = [...document.querySelectorAll('.nav-item')];
const sections = navItems
  .map(a => document.querySelector(a.getAttribute('href')))
  .filter(Boolean);

$('content').addEventListener('scroll', () => {
  const top = $('content').scrollTop + 90;
  let active = 0;
  sections.forEach((s, i) => { if (s.offsetTop <= top) active = i; });
  navItems.forEach((a, i) => a.classList.toggle('active', i === active));
}, { passive: true });

navItems.forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  const target = document.querySelector(a.getAttribute('href'));
  if (target) $('content').scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' });
  sidebar.classList.remove('open');
}));
navItems[0]?.classList.add('active');

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (latest) { renderCharts(latest); renderKpis(latest); } }, 120);
});

bootstrap();
