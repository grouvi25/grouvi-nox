const $ = (id) => document.getElementById(id);

/* ----------------------------- utils ----------------------------- */
const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
function bytes(n, digits = 1) {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}
function rate(n) { return `${bytes(n, 1)}/с`; }
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
function level(v, warn, crit) { return v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok'; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  ctx.beginPath();
  ctx.moveTo(0, y(series[0]));
  for (let i = 1; i < series.length; i += 1) ctx.lineTo(i * step, y(series[i]));

  const line = new Path2D();
  line.moveTo(0, y(series[0]));
  for (let i = 1; i < series.length; i += 1) line.lineTo(i * step, y(series[i]));

  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `${color}44`);
  g.addColorStop(1, `${color}00`);
  ctx.fillStyle = g; ctx.fill();

  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
  ctx.stroke(line);
}

function multiChart(canvas, sets, { max, unit = '' } = {}) {
  if (!canvas) return;
  const { ctx, w, h } = prep(canvas);
  const padL = 42; const padR = 8; const padT = 10; const padB = 16;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const all = sets.flatMap(s => s.data || []);
  const peak = max ?? Math.max(1, ...all);
  const top = peak <= 1 ? 1 : peak * 1.12;

  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.fillStyle = '#5b6478';
  ctx.font = '10px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const yy = padT + (plotH / 4) * i;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    const val = top * (1 - i / 4);
    const lbl = unit === 'KB' ? bytes(val * 1024, 0) : `${val.toFixed(top > 10 ? 0 : 1)}${unit}`;
    ctx.fillText(lbl, 4, yy + 3);
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
      g.addColorStop(0, `${s.color}33`);
      g.addColorStop(1, `${s.color}00`);
      ctx.fillStyle = g; ctx.fill(area);
    }
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.7; ctx.lineJoin = 'round';
    ctx.stroke(p);
  }
}

/* ---------------------------- render ----------------------------- */
let latest = null;

function renderAlerts(a) {
  const box = $('alerts');
  if (!a || a.length === 0) {
    box.innerHTML = '<div class="all-clear">✓ Всё в норме — критичных проблем не обнаружено</div>';
    return;
  }
  box.innerHTML = a.slice(0, 8).map(x => `
    <div class="alert ${x.level}">
      <span class="badge">${x.level === 'critical' ? 'критично' : 'внимание'}</span>
      <span>${esc(x.message)}</span>
      ${x.hint ? `<span class="hint">${esc(x.hint)}</span>` : ''}
    </div>`).join('');
}

function renderKpis(d) {
  const cpu = d.cpu || {};
  const mem = d.memory || {};
  const ld = d.load || {};
  const net = d.network || {};
  const io = d.diskIo || {};
  const h = d.history || {};

  const cpuLvl = level(cpu.usage || 0, 85, 95);
  $('k-cpu').className = `kpi ${cpuLvl === 'ok' ? '' : cpuLvl}`;
  $('cpuVal').textContent = (cpu.usage || 0).toFixed(1);
  $('cpuFoot').textContent = `${cpu.count || 0} ядра · iowait ${(cpu.iowait || 0).toFixed(1)}% · steal ${(cpu.steal || 0).toFixed(1)}%`;
  spark($('sparkCpu'), h.cpu, '#35d6a4', 100);

  const memLvl = level(mem.usedPct || 0, 85, 94);
  $('k-mem').className = `kpi ${memLvl === 'ok' ? '' : memLvl}`;
  $('memVal').textContent = (mem.usedPct || 0).toFixed(1);
  $('memFoot').textContent = `${bytes(mem.used)} из ${bytes(mem.total)} · доступно ${bytes(mem.available)}`;
  spark($('sparkMem'), h.mem, '#3fa9ff', 100);

  const root = (d.filesystems || []).find(f => f.mount === '/') || (d.filesystems || [])[0];
  if (root) {
    const lvl = level(root.usedPct, 80, 90);
    $('k-disk').className = `kpi ${lvl === 'ok' ? '' : lvl}`;
    $('diskVal').textContent = root.usedPct.toFixed(1);
    $('diskFoot').textContent = `${bytes(root.used)} из ${bytes(root.size)} · свободно ${bytes(root.avail)}`;
    const bar = $('diskBar');
    bar.style.width = `${clamp(root.usedPct, 0, 100)}%`;
    bar.className = lvl === 'ok' ? '' : lvl;
  }
  $('diskIoFoot').textContent = `чтение ${rate(io.readRate || 0)} · запись ${rate(io.writeRate || 0)}`;

  const perCore = cpu.count ? (ld.five || 0) / cpu.count : 0;
  const ldLvl = level(perCore, 1.5, 3);
  $('k-load').className = `kpi ${ldLvl === 'ok' ? '' : ldLvl}`;
  $('loadVal').textContent = (ld.one || 0).toFixed(2);
  $('loadFoot').textContent = `5м ${(ld.five || 0).toFixed(2)} · 15м ${(ld.fifteen || 0).toFixed(2)} · ${ld.processes || 0} процессов`;
  spark($('sparkLoad'), h.load, '#a074ff');

  $('netVal').textContent = `${bytes(net.rxRate || 0, 0)} ↓ ${bytes(net.txRate || 0, 0)} ↑`;
  $('netFoot').textContent = `всего ${bytes(net.rxTotal || 0)} / ${bytes(net.txTotal || 0)} · ошибок ${net.errors || 0}`;
  spark($('sparkNet'), h.rx, '#3fa9ff');

  const swapLvl = level(mem.swapPct || 0, 40, 75);
  $('k-swap').className = `kpi ${swapLvl === 'ok' ? '' : swapLvl}`;
  $('swapVal').textContent = (mem.swapPct || 0).toFixed(1);
  $('swapFoot').textContent = `${bytes(mem.swapUsed || 0)} из ${bytes(mem.swapTotal || 0)}`;
  const sb = $('swapBar');
  sb.style.width = `${clamp(mem.swapPct || 0, 0, 100)}%`;
  sb.className = swapLvl === 'ok' ? '' : swapLvl;
  $('procFoot').textContent = `выполняется ${cpu.procsRunning || 0} · заблокировано ${cpu.procsBlocked || 0}`;
}

function renderCharts(d) {
  const h = d.history || {};
  multiChart($('chartCpu'), [
    { data: h.cpu, color: '#35d6a4' },
    { data: h.mem, color: '#3fa9ff' },
    { data: h.swap, color: '#a074ff', fill: false },
  ], { max: 100, unit: '%' });

  multiChart($('chartNet'), [
    { data: h.rx, color: '#35d6a4' },
    { data: h.tx, color: '#3fa9ff' },
    { data: h.ioR, color: '#f5b544', fill: false },
    { data: h.ioW, color: '#ff5c6c', fill: false },
  ], { unit: 'KB' });
}

function renderCores(d) {
  const cores = d.cpu?.cores || [];
  $('coreCount').textContent = cores.length;
  $('cores').innerHTML = cores.map((v, i) => {
    const lvl = level(v, 75, 90);
    return `<div class="core">
      <div class="top"><span>CPU ${i}</span><span>${v.toFixed(0)}%</span></div>
      <div class="bar"><i class="${lvl === 'ok' ? '' : lvl}" style="width:${clamp(v, 0, 100)}%"></i></div>
    </div>`;
  }).join('');
}

function renderFs(d) {
  const rows = d.filesystems || [];
  $('fsBody').innerHTML = rows.length ? rows.map(f => {
    const lvl = level(f.usedPct, 80, 90);
    return `<tr>
      <td class="name">${esc(f.mount)}</td>
      <td>${esc(f.device)}</td>
      <td class="num">${bytes(f.size)}</td>
      <td class="num">${bytes(f.avail)}</td>
      <td class="num"><span class="pill ${lvl}">${f.usedPct.toFixed(0)}%</span></td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">нет данных</td></tr>';
}

function renderContainers(d) {
  const c = d.containers;
  const box = $('containers');
  if (!c || !c.available) { box.innerHTML = '<div class="empty">Docker недоступен</div>'; return; }
  $('ctnCount').textContent = c.items.length;
  $('ctnSummary').textContent = `${c.running} работает · ${c.stopped} остановлено`;

  const groups = {};
  for (const it of c.items) {
    const k = it.project || 'без проекта';
    (groups[k] = groups[k] || []).push(it);
  }
  box.innerHTML = Object.entries(groups).map(([proj, items]) => `
    <div class="proj">
      <div class="head">${esc(proj)}<span class="count">${items.length}</span></div>
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
  body.innerHTML = p.items.map(i => `<tr>
    <td class="name">${esc(i.name)}</td>
    <td><span class="pill ${i.status === 'online' ? 'ok' : 'crit'}">${esc(i.status)}</span></td>
    <td class="num">${i.cpu}%</td>
    <td class="num">${bytes(i.memory)}</td>
    <td class="num">${i.restarts}${i.unstableRestarts ? ` <span class="pill warn">${i.unstableRestarts}!</span>` : ''}</td>
    <td class="num">${dur(i.uptimeMs / 1000)}</td>
  </tr>`).join('');
}

function renderSecurity(d) {
  const f2b = d.fail2ban || {};
  const ssh = d.ssh || {};
  const rows = [
    ['SSH: вход по паролю', '<span class="pill ok">отключён</span>'],
    ['Забанено сейчас', f2b.available ? f2b.currentlyBanned : '—'],
    ['Забанено всего', f2b.available ? f2b.totalBanned : '—'],
    ['Неудачных паролей (в окне лога)', ssh.available ? ssh.failedPassword : '—'],
    ['Попыток с несуществующим юзером', ssh.available ? ssh.invalidUser : '—'],
  ];
  let html = rows.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  if (ssh.topAttackers?.length) {
    html += `<div class="kv" style="border:none;padding-top:12px"><span class="k">Топ источников атак</span><span class="v"></span></div>`;
    html += ssh.topAttackers.map(a => `<div class="kv"><span class="k" style="font-family:var(--mono)">${esc(a.ip)}</span><span class="v">${a.count}</span></div>`).join('');
  }
  $('security').innerHTML = html;
}

function renderCerts(d) {
  const list = (d.certificates || []).filter(c => c.ok);
  $('certCount').textContent = list.length;
  $('certBody').innerHTML = list.length ? list.map(c => {
    const lvl = c.daysLeft <= 7 ? 'crit' : c.daysLeft <= 21 ? 'warn' : 'ok';
    return `<tr><td class="name">${esc(c.domain)}</td><td class="num"><span class="pill ${lvl}">${c.daysLeft} дн.</span></td></tr>`;
  }).join('') : '<tr><td colspan="2" class="empty">нет данных</td></tr>';
}

function renderBackups(d) {
  const list = d.backups || [];
  $('backups').innerHTML = list.length ? list.map(b => {
    const name = b.dir.split('/').filter(Boolean).slice(-2).join('/');
    if (!b.exists) return `<div class="kv"><span class="k">${esc(name)}</span><span class="v"><span class="pill idle">нет папки</span></span></div>`;
    if (!b.newest) return `<div class="kv"><span class="k">${esc(name)}</span><span class="v"><span class="pill warn">пусто</span></span></div>`;
    const lvl = b.ageHours > 36 ? 'warn' : 'ok';
    return `<div class="kv">
      <span class="k">${esc(name)}<br><span style="font-size:11px;color:var(--text-faint)">${b.count} файлов · ${bytes(b.bytes)}</span></span>
      <span class="v"><span class="pill ${lvl}">${ago(b.newest.at)}</span><br><span style="font-size:11px;color:var(--text-faint)">${bytes(b.newest.size)}</span></span>
    </div>`;
  }).join('') : '<div class="empty">нет данных</div>';
}

function renderServices(d) {
  const s = d.systemd || {};
  const pill = (v) => `<span class="pill ${v === 'active' ? 'ok' : 'crit'}">${esc(v || '—')}</span>`;
  let html = `
    <div class="kv"><span class="k">nginx</span><span class="v">${pill(s.nginx)}</span></div>
    <div class="kv"><span class="k">docker</span><span class="v">${pill(s.docker)}</span></div>
    <div class="kv"><span class="k">ssh</span><span class="v">${pill(s.ssh)}</span></div>`;
  const failed = s.failedUnits || [];
  html += `<div class="kv"><span class="k">Упавших юнитов</span><span class="v">${
    failed.length ? `<span class="pill crit">${failed.length}</span>` : '<span class="pill ok">0</span>'}</span></div>`;
  for (const u of failed) html += `<div class="kv"><span class="k" style="color:var(--crit)">${esc(u)}</span><span class="v"></span></div>`;
  $('services').innerHTML = html;
}

function renderDockerDisk(d) {
  const dd = d.dockerDisk;
  if (!dd) { $('dockerDisk').innerHTML = '<div class="empty">нет данных</div>'; return; }
  $('dockerDisk').innerHTML = `
    <div class="kv"><span class="k">Образы (${dd.images.count})</span><span class="v">${bytes(dd.images.size)}</span></div>
    <div class="kv"><span class="k">Контейнеры (${dd.containers.count})</span><span class="v">${bytes(dd.containers.size)}</span></div>
    <div class="kv"><span class="k">Тома (${dd.volumes.count})</span><span class="v">${bytes(dd.volumes.size)}</span></div>
    <div class="kv"><span class="k">Кэш сборки</span><span class="v">${bytes(dd.buildCache.size)}</span></div>
    <div class="kv"><span class="k">Можно освободить</span><span class="v"><span class="pill ${dd.buildCache.reclaimable > 2e9 ? 'warn' : 'ok'}">${bytes(dd.buildCache.reclaimable)}</span></span></div>`;
}

function renderLogins(d) {
  const list = d.ssh?.recentLogins || [];
  $('logins').innerHTML = list.length
    ? `<table><tbody>${list.map(l => `<tr>
        <td class="name">${esc(l.user)}</td>
        <td>${esc(l.ip)}</td>
        <td><span class="pill ${l.method === 'publickey' ? 'ok' : 'warn'}">${esc(l.method)}</span></td>
        <td class="num">${esc(String(l.at).replace('T', ' ').slice(5, 16))}</td>
      </tr>`).join('')}</tbody></table>`
    : '<div class="empty">нет данных</div>';
}

function renderHeader(d) {
  $('hostname').textContent = d.kernel?.hostname || '—';
  $('os').textContent = d.os?.pretty || '—';
  $('kernel').textContent = d.os?.kernelRunning || d.kernel?.release || '—';
  $('uptime').textContent = dur(d.uptime);
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
    renderFs(d);
    renderContainers(d);
    renderPm2(d);
    renderSecurity(d);
    renderCerts(d);
    renderBackups(d);
    renderServices(d);
    renderDockerDisk(d);
    renderLogins(d);
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

  ws.onopen = () => { retry = 0; setConn('live', 'в реальном времени'); };

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

$('logout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/login';
});

window.addEventListener('resize', () => { if (latest) { renderCharts(latest); renderKpis(latest); } });

bootstrap();
