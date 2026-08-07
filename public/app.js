import { $, C, bytes, rate, dur, ago, clamp, lvl, esc, setBar } from './js/utils.js';
import { spark, multiChart } from './js/charts.js';
import { renderMarkdown } from './js/markdown.js';
import { initPaneResizers, setWorkspacePane } from './js/panes.js';
import { createNotificationController } from './js/notifications.js';

/* ----------------------------- icons ----------------------------- */
const ICON_CRIT = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24"><path d="M10.3 4.3L2.6 18a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 4.3a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>';

/* ----------------------------- render ---------------------------- */
let latest = null;
let persistedHistory = null;
let incidentFilter = 'active';
let incidentPage = 1;
const INCIDENT_PAGE_SIZE = 6;
let filesystemPath = '/';
let filesystemTimer = null;
let filesystemOverview = { largest: [], risks: [] };

function renderAlerts(a) {
  const nb = $('nbAlerts');
  const list = a || [];
  const crit = list.filter(x => x.level === 'critical').length;
  nb.textContent = String(list.length);
  nb.className = `n-badge${crit ? ' alert' : list.length ? ' warn' : ''}`;
}

function renderKpis(d) {
  const cpu = d.cpu || {}; const mem = d.memory || {};
  const ld = d.load || {}; const net = d.network || {}; const io = d.diskIo || {};
  const h = d.history || {};

  const cl = lvl(cpu.usage || 0, 85, 95);
  $('kCpu').className = `kpi expandable ${cl === 'ok' ? '' : cl}`;
  $('cpuVal').textContent = (cpu.usage || 0).toFixed(1);
  $('cpuFoot').textContent = `${cpu.count || 0} ядра · iowait ${(cpu.iowait || 0).toFixed(1)}% · steal ${(cpu.steal || 0).toFixed(1)}%`;
  spark($('spCpu'), h.cpu, C.accent, 100);
  $('gCpu').textContent = `${(cpu.usage || 0).toFixed(0)}%`;
  setBar($('gCpuBar'), cpu.usage || 0, cl);

  const ml = lvl(mem.usedPct || 0, 85, 94);
  $('kMem').className = `kpi expandable ${ml === 'ok' ? '' : ml}`;
  $('memVal').textContent = (mem.usedPct || 0).toFixed(1);
  $('memFoot').textContent = `${bytes(mem.used)} из ${bytes(mem.total)} · доступно ${bytes(mem.available)}`;
  spark($('spMem'), h.mem, C.blue, 100);
  $('gMem').textContent = `${(mem.usedPct || 0).toFixed(0)}%`;
  setBar($('gMemBar'), mem.usedPct || 0, ml);

  const root = (d.filesystems || []).find(f => f.mount === '/') || (d.filesystems || [])[0];
  if (root) {
    const dl = lvl(root.usedPct, 80, 90);
    $('kDisk').className = `kpi expandable ${dl === 'ok' ? '' : dl}`;
    $('diskVal').textContent = root.usedPct.toFixed(1);
    $('diskFoot').textContent = `${bytes(root.used)} из ${bytes(root.size)} · свободно ${bytes(root.avail)}`;
    setBar($('diskBar'), root.usedPct, dl);
    $('gDisk').textContent = `${root.usedPct.toFixed(0)}%`;
    setBar($('gDiskBar'), root.usedPct, dl);
  }
  $('ioFoot').textContent = `чтение ${rate(io.readRate || 0)} · запись ${rate(io.writeRate || 0)}`;

  const perCore = cpu.count ? (ld.five || 0) / cpu.count : 0;
  const ll = lvl(perCore, 1.5, 3);
  $('kLoad').className = `kpi expandable ${ll === 'ok' ? '' : ll}`;
  $('loadVal').textContent = (ld.one || 0).toFixed(2);
  $('loadFoot').textContent = `5м ${(ld.five || 0).toFixed(2)} · 15м ${(ld.fifteen || 0).toFixed(2)} · ${ld.processes || 0} процессов`;
  spark($('spLoad'), h.load, C.purple);

  $('netVal').textContent = `${bytes(net.rxRate || 0, 0)} ↓  ${bytes(net.txRate || 0, 0)} ↑`;
  $('netFoot').textContent = `всего ${bytes(net.rxTotal || 0)} / ${bytes(net.txTotal || 0)} · ошибок ${net.errors || 0}`;
  spark($('spNet'), h.rx, C.green);

  const sl = lvl(mem.swapPct || 0, 40, 75);
  $('kSwap').className = `kpi expandable ${sl === 'ok' ? '' : sl}`;
  $('swapVal').textContent = (mem.swapPct || 0).toFixed(1);
  $('swapFoot').textContent = `${bytes(mem.swapUsed || 0)} из ${bytes(mem.swapTotal || 0)}`;
  setBar($('swapBar'), mem.swapPct || 0, sl);
  $('procFoot').textContent = `выполняется ${cpu.procsRunning || 0} · заблокировано ${cpu.procsBlocked || 0}`;
}

function renderCharts(d) {
  const live = d.history || {};
  const rows = persistedHistory?.rows || [];
  const h = rows.length ? {
    cpu: rows.map(r => r.cpu), mem: rows.map(r => r.memory), swap: rows.map(r => r.swap),
    rx: rows.map(r => r.network_rx / 1024), tx: rows.map(r => r.network_tx / 1024),
    ioR: rows.map(r => r.disk_read / 1024), ioW: rows.map(r => r.disk_write / 1024),
  } : live;
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

function renderAnalytics() {
  const rows = persistedHistory?.rows || [];
  if (!rows.length) {
    for (const id of ['avgCpu','peakCpu','avgMem','netRatio','ioRatio','alertPoints']) $(id).textContent = '—';
    return;
  }
  const avg = (key) => rows.reduce((sum, r) => sum + Number(r[key] || 0), 0) / rows.length;
  const sum = (key) => rows.reduce((total, r) => total + Number(r[key] || 0), 0);
  const peak = (key) => Math.max(...rows.map(r => Number(r[key] || 0)));
  const rx = sum('network_rx'); const tx = sum('network_tx');
  const rd = sum('disk_read'); const wr = sum('disk_write');
  $('avgCpu').textContent = `${avg('cpu').toFixed(1)}%`;
  $('peakCpu').textContent = `${peak('cpu').toFixed(1)}%`;
  $('avgMem').textContent = `${avg('memory').toFixed(1)}%`;
  $('netRatio').textContent = tx ? `${(rx / tx).toFixed(2)} : 1` : 'только вход';
  $('ioRatio').textContent = wr ? `${(rd / wr).toFixed(2)} : 1` : 'только чтение';
  $('alertPoints').textContent = String(rows.filter(r => Number(r.alert_count) > 0).length);
}

function renderCores(d) {
  const cores = d.cpu?.cores || [];
  const box = $('cores');
  $('coreCount').textContent = cores.length;

  // Rebuild only when the core count changes; afterwards just move the bars.
  if (box.childElementCount !== cores.length) {
    box.innerHTML = cores.map((v, i) => `
      <div class="core">
        <div class="c-top"><span>CPU ${i}</span><b>0%</b></div>
        <div class="track"><i></i></div>
      </div>`).join('');
  }
  const nodes = box.children;
  cores.forEach((v, i) => {
    const node = nodes[i];
    if (!node) return;
    node.querySelector('b').textContent = `${v.toFixed(0)}%`;
    setBar(node.querySelector('.track > i'), v, lvl(v, 75, 90));
  });
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
    return `<div class="ctn" role="button" tabindex="0" data-service-type="container" data-service-name="${esc(i.name)}">
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
  body.innerHTML = p.items.map(i => `<tr class="pm2-click" tabindex="0" data-service-type="pm2" data-service-name="${esc(i.name)}">
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
    html += '<div class="kv kv-head"><span class="k">Топ источников</span><span class="v"></span></div>';
    html += s.topAttackers.map(a =>
      kv(`<span class="txt-mono">${esc(a.ip)}</span>`, a.count)).join('');
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
  for (const u of failed) html += kv(`<span class="txt-crit">${esc(u)}</span>`, '');
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

async function api(url, options) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function formatWhen(ts) {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

const { hourOptions, syncNotificationFooter, loadNotificationState, openNotifications, closeNotifications, saveNotifications, testNotification } = createNotificationController({ api, formatWhen, setWorkspacePane });

async function loadHistory(range = '24h') {
  $('historyMeta').textContent = 'SQLite: загрузка…';
  try {
    persistedHistory = await api(`/api/history?range=${encodeURIComponent(range)}`);
    const points = persistedHistory.rows?.length || 0;
    const collected = persistedHistory.rows?.length
      ? ` · данные с ${formatWhen(persistedHistory.rows[0].ts)}` : ' · история ещё накапливается';
    $('historyMeta').textContent = `${points} точек · шаг ${Math.round(persistedHistory.bucketSeconds / 60) || '<1'} мин.${collected}`;
    if (latest) renderCharts(latest);
    renderAnalytics();
  } catch (e) { $('historyMeta').textContent = `Ошибка: ${e.message}`; }
}

function incidentStatusPill(status) {
  if (status === 'resolved') return '<span class="pill ok">закрыт</span>';
  if (status === 'acknowledged') return '<span class="pill info">принят</span>';
  return '<span class="pill warn">открыт</span>';
}

function renderIncidents(items,counts={},pagination={}){
  $('incidentCount').textContent=counts.total??items.length;$('icAll').textContent=counts.total||0;$('icActive').textContent=counts.active||0;$('icOpen').textContent=counts.open||0;$('icAck').textContent=counts.acknowledged||0;$('icResolved').textContent=counts.resolved||0;
  $('incidentActive').textContent=counts.active||0;$('incidentCritical').textContent=counts.critical||0;$('incidentResolved').textContent=counts.resolved||0;$('incidentHint').textContent=counts.active?`${counts.active} требуют внимания, архив разбит на страницы`:'Всё спокойно, активных инцидентов нет';
  $('nbIncidents').textContent=counts.active||0;$('nbIncidents').className=`n-badge${counts.critical?' alert':counts.active?' warn':''}`;
  if(!items.length){$('incidentList').innerHTML='<div class="empty incident-empty">В этом фильтре всё чисто.</div>'}else{
    $('incidentList').innerHTML=items.map(i=>`<article class="incident-row" data-incident-id="${i.id}"><span class="incident-mark ${i.severity}"></span><div class="incident-main"><div class="incident-title">${esc(i.title)}</div><div class="incident-detail">${esc(i.detail||i.incident_key)}</div><div class="incident-mobile-meta">${formatWhen(i.first_seen)} · ${i.occurrences} срабатываний</div></div><div class="incident-meta">${incidentStatusPill(i.status)}<span>${formatWhen(i.first_seen)}</span><span>${i.occurrences} срабатываний</span></div><div class="incident-actions">${i.severity==='critical'&&!i.investigation?`<button class="action-sm investigate" data-incident-action="investigate" data-id="${i.id}">AI-разбор</button>`:''}${i.investigation?`<button class="action-sm" data-incident-expand="${i.id}">Разбор готов</button>`:''}<label class="incident-status-control"><span>Статус</span><select data-incident-status data-id="${i.id}" data-previous="${i.status}"><option value="open" ${i.status==='open'?'selected':''}>Открыт</option><option value="acknowledged" ${i.status==='acknowledged'?'selected':''}>Принят</option><option value="resolved" ${i.status==='resolved'?'selected':''}>Закрыт</option></select></label></div>${i.investigation?`<div class="incident-ai" id="incidentAi${i.id}" hidden><div class="incident-ai-head"><span>Sentinel Forge</span><time>${formatWhen(i.investigated_at)}</time></div><pre>${esc(i.investigation)}</pre></div>`:''}</article>`).join('')
  }
  const total=Number(pagination.total||0),pages=Math.max(1,Math.ceil(total/INCIDENT_PAGE_SIZE));
  $('incidentPager').hidden=total<=INCIDENT_PAGE_SIZE;
  $('incidentPageMeta').textContent=`${Math.min(incidentPage,pages)} / ${pages}`;
  $('incidentPrev').disabled=incidentPage<=1;$('incidentNext').disabled=incidentPage>=pages;
}
async function loadIncidents(status=incidentFilter,page=incidentPage){try{const offset=(page-1)*INCIDENT_PAGE_SIZE;const data=await api(`/api/incidents?status=${encodeURIComponent(status)}&limit=${INCIDENT_PAGE_SIZE}&offset=${offset}`);const pages=Math.max(1,Math.ceil(Number(data.pagination?.total||0)/INCIDENT_PAGE_SIZE));if(page>pages){incidentPage=pages;return loadIncidents(status,pages)}renderIncidents(data.incidents||[],data.counts||{},data.pagination||{})}catch(e){$('incidentList').innerHTML=`<div class="empty">Ошибка загрузки: ${esc(e.message)}</div>`}}


async function incidentAction(id, action, button) {
  button.disabled = true;
  button.textContent = 'Сохраняю…';
  try {
    await api(`/api/incidents/${id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    await loadIncidents();
  } catch (e) { button.disabled = false; button.textContent = 'Ошибка'; }
}

async function changeIncidentStatus(id, status, select) {
  const previous = select.dataset.previous || select.querySelector('option[selected]')?.value || '';
  select.disabled = true;
  try {
    await api(`/api/incidents/${id}/status`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ status }) });
    select.dataset.previous = status;
    await loadIncidents(incidentFilter);
  } catch (e) { if (previous) select.value = previous; select.disabled = false; }
}


function renderDeployments(projects) {
  const rows = [];
  for (const project of projects || []) {
    for (const c of (project.commits || []).slice(0, 3)) rows.push({ ...c, project: project.project, dirty: project.dirty });
  }
  rows.sort((a, b) => new Date(b.at) - new Date(a.at));
  $('deployMeta').textContent = `${projects?.length || 0} проектов`;
  $('deployments').innerHTML = rows.length ? rows.slice(0, 14).map(c => `
    <div class="deploy-row">
      <span class="deploy-project">${esc(c.project)}${c.dirty ? '*' : ''}</span>
      <span class="deploy-sha">${esc(c.short)}</span>
      <span class="deploy-subject">${esc(c.subject)}</span>
      <span class="deploy-time">${formatWhen(new Date(c.at).getTime())}</span>
    </div>`).join('') : '<div class="empty">Git-репозитории не найдены.</div>';
}

async function loadDeployments() {
  try { renderDeployments((await api('/api/deployments')).projects); }
  catch (e) { $('deployments').innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}

function detailStats(entries) {
  return `<div class="detail-grid">${entries.map(([k, v]) => `<div class="detail-stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
}

function openDetailShell(type, name) {
  $('detailType').textContent = type === 'container' ? 'Docker container' : 'PM2 process';
  $('detailTitle').textContent = name;
  $('detailStatus').textContent = 'загрузка';
  $('detailStatus').className = 'pill idle';
  $('detailBody').innerHTML = '<div class="detail-skeleton"></div>';
  setWorkspacePane('detailPane');
}

function renderContainerDetail(d) {
  const running = d.state?.Running;
  $('detailStatus').textContent = d.state?.Health?.Status || (running ? 'running' : d.state?.Status || 'stopped');
  $('detailStatus').className = `pill ${running ? (d.state?.Health?.Status === 'unhealthy' ? 'crit' : 'ok') : 'warn'}`;
  const networks = Object.entries(d.network || {}).map(([name, x]) => `${name}: ↓${rate(x.rx_bytes || 0)} ↑${rate(x.tx_bytes || 0)}`).join(' · ') || '—';
  $('detailBody').innerHTML = `
    <section class="detail-section"><h3>Состояние</h3>${detailStats([
      ['Image', d.image], ['CPU', `${d.cpuPct}%`], ['Memory', `${bytes(d.memory)} (${d.memoryPct}%)`],
      ['PIDs', String(d.pids)], ['Restart policy', d.restartPolicy], ['Started', d.state?.StartedAt ? formatWhen(new Date(d.state.StartedAt).getTime()) : '—'],
      ['Network', networks], ['Root FS', d.readonlyRootfs ? 'read-only' : 'writable'],
    ])}</section>
    <section class="detail-section"><h3>Последние логи · секреты редактируются</h3><pre class="log-view">${esc(d.logs || 'Логи пусты.')}</pre></section>`;
}

function renderPm2Detail(d) {
  $('detailStatus').textContent = d.status;
  $('detailStatus').className = `pill ${d.status === 'online' ? 'ok' : 'crit'}`;
  $('detailBody').innerHTML = `
    <section class="detail-section"><h3>Состояние</h3>${detailStats([
      ['PID', String(d.pid || '—')], ['CPU', `${d.cpu}%`], ['Memory', bytes(d.memory)],
      ['Uptime', dur(d.uptimeMs / 1000)], ['Restarts', String(d.restarts)], ['Node', d.nodeVersion || '—'],
      ['CWD', d.cwd || '—'], ['Script', d.script || '—'],
    ])}</section>
    <section class="detail-section"><h3>stdout · секреты редактируются</h3><pre class="log-view">${esc(d.outLog || 'stdout пуст.')}</pre></section>
    <section class="detail-section"><h3>stderr</h3><pre class="log-view">${esc(d.errorLog || 'stderr пуст.')}</pre></section>`;
}

async function openServiceDetail(type, name) {
  openDetailShell(type, name);
  try {
    const data = await api(`/api/services/${type}/${encodeURIComponent(name)}`);
    if (type === 'container') renderContainerDetail(data.detail); else renderPm2Detail(data.detail);
  } catch (e) {
    $('detailStatus').textContent = 'ошибка'; $('detailStatus').className = 'pill crit';
    $('detailBody').innerHTML = `<div class="empty">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
}

function closeDetail() { setWorkspacePane(); }

function fsIcon(type, excluded) {
  if (excluded) return '<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>';
  if (type === 'directory') return '<svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 012-2h5l2 2h7a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';
  if (type === 'symlink') return '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.5.5l2-2a5 5 0 00-7-7l-1.1 1.1M14 11a5 5 0 00-7.5-.5l-2 2a5 5 0 007 7l1.1-1.1"/></svg>';
  return '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>';
}

function breadcrumb(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  let built = '';
  const items = [{ name: '/', path: '/' }];
  for (const part of parts) { built += `/${part}`; items.push({ name: part, path: built }); }
  $('fsBreadcrumb').innerHTML = items.map((item, i) => `${i ? '<span class="crumb-sep">/</span>' : ''}<button class="crumb" data-fs-path="${esc(item.path)}">${esc(item.name)}</button>`).join('');
}

function renderFilesystem(data) {
  filesystemPath = data.path || '/';
  breadcrumb(filesystemPath);
  const totals = data.totals || {};
  $('fsIndexCount').textContent = `${(totals.files || 0).toLocaleString('ru-RU')} файлов`;
  $('fsIndexMeta').textContent = `${formatWhen(data.at)} · ${totals.truncated ? 'индекс ограничен' : 'полный индекс'} · содержимое файлов скрыто`;
  $('fsEntries').innerHTML = data.children?.length ? data.children.map(item => {
    const critical = item.risk?.some(x => ['world-writable','setuid','setgid'].includes(x));
    return `<div class="fs-row ${item.type} ${item.excluded ? 'fs-excluded' : ''}" ${item.type === 'directory' && !item.excluded ? `role="button" tabindex="0" data-fs-path="${esc(item.path)}"` : ''}>
      <span class="fs-name">${fsIcon(item.type,item.excluded)}<span class="fs-label" title="${esc(item.path)}">${esc(item.name)}</span>${item.risk?.length ? `<span class="fs-flags"><i class="risk-dot ${critical ? 'critical' : ''}" title="${esc(item.risk.join(', '))}"></i></span>` : ''}</span>
      <span>${item.type === 'file' ? bytes(item.size) : item.excluded ? 'скрыто' : '—'}</span>
      <span>${esc(item.mode || '—')}</span>
      <span>${formatWhen(item.mtime)}</span>
    </div>`;
  }).join('') : '<div class="empty">Папка пуста или не вошла в безопасный индекс.</div>';
  $('fsSummary').innerHTML = kv('Директорий', (totals.directories || 0).toLocaleString('ru-RU'))
    + kv('Файлов', (totals.files || 0).toLocaleString('ru-RU'))
    + kv('Симлинков', (totals.symlinks || 0).toLocaleString('ru-RU'))
    + kv('Известный объём', bytes(totals.bytes || 0))
    + kv('Исключено зон', String(totals.excluded || 0), 'секреты и тяжёлые технические деревья');
  if (data.largest?.length) filesystemOverview.largest = data.largest;
  if (data.risks?.length) filesystemOverview.risks = data.risks;
  $('fsLargest').innerHTML = filesystemOverview.largest.slice(0, 12).map(x => `<div class="fs-mini-row"><span title="${esc(x.path)}">${esc(x.path)}</span><b>${bytes(x.size)}</b></div>`).join('') || '<div class="empty">Нет файлов крупнее 10 МБ.</div>';
  $('fsRisks').innerHTML = filesystemOverview.risks.slice(0, 12).map(x => `<div class="fs-mini-row"><span title="${esc(x.path)}">${esc(x.path)}</span><b>${esc(x.risk.filter(r => r !== 'recent' && r !== 'privileged-area').join(', ') || x.risk.join(', '))}</b></div>`).join('') || '<div class="empty">Явных рисков прав не найдено.</div>';
}

async function loadFilesystem(pathname = filesystemPath, query = '') {
  $('fsEntries').innerHTML = '<div class="empty">Загружаю metadata index…</div>';
  try {
    const q = query ? `&q=${encodeURIComponent(query)}` : '';
    const data = await api(`/api/filesystem?path=${encodeURIComponent(pathname)}${q}`);
    renderFilesystem(data);
  } catch (e) { $('fsEntries').innerHTML = `<div class="empty">Ошибка индекса: ${esc(e.message)}</div>`; }
}

function fsParent(pathname) {
  if (pathname === '/') return '/';
  const parts = pathname.split('/').filter(Boolean); parts.pop();
  return `/${parts.join('/')}` || '/';
}

function inspectChart(kind, event) {
  const rows = persistedHistory?.rows || [];
  if (!rows.length) return;
  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const index = Math.min(rows.length - 1, Math.round(ratio * (rows.length - 1)));
  const r = rows[index];
  const snapped = Math.round(ratio * 20) * 5;
  const cross = kind === 'cpu' ? $('cpuCrosshair') : $('netCrosshair');
  cross.className = `chart-crosshair x${snapped}`;
  if (kind === 'cpu') {
    $('cpuInspect').textContent = `${formatWhen(r.ts)} · CPU ${r.cpu}% · RAM ${r.memory}% · swap ${r.swap}% · load ${r.load1}`;
  } else {
    $('netInspect').textContent = `${formatWhen(r.ts)} · ↓ ${rate(r.network_rx)} · ↑ ${rate(r.network_tx)} · disk R ${rate(r.disk_read)} · W ${rate(r.disk_write)}`;
  }
}

function resetChartInspect(kind) {
  const cross = kind === 'cpu' ? $('cpuCrosshair') : $('netCrosshair');
  cross.className = 'chart-crosshair';
  $(kind === 'cpu' ? 'cpuInspect' : 'netInspect').textContent = 'Наведи на график';
}

let activeMetricDetail=null;
const METRICS = {
  cpu: { title: 'Процессор', keys: [['cpu','CPU',C.accent]], unit: '%', max: 100 },
  memory: { title: 'Оперативная память', keys: [['memory','RAM',C.blue]], unit: '%', max: 100 },
  swap: { title: 'Своп', keys: [['swap','Swap',C.purple]], unit: '%', max: 100 },
  load: { title: 'Load average', keys: [['load1','Load 1m',C.purple]], unit: '' },
  network: { title: 'Сетевой трафик', keys: [['network_rx','Входящий',C.green],['network_tx','Исходящий',C.blue]], unit: 'bytes' },
  disk: { title: 'Диск и I/O', keys: [['disk_read','Чтение',C.amber],['disk_write','Запись',C.red]], unit: 'bytes' },
};

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))];
}

function metricValue(value, unit) {
  if (unit === 'bytes') return rate(value);
  if (unit === '%') return `${Number(value).toFixed(1)}%`;
  return Number(value).toFixed(2);
}

function drawMetricDetail(){
  const metric=activeMetricDetail,spec=METRICS[metric],canvas=$('metricDetailCanvas');
  if(!spec||!canvas||!$('detailPane').classList.contains('open'))return;
  const rows=persistedHistory?.rows||[];
  const rect=canvas.getBoundingClientRect();
  if(rect.width<40||rect.height<40)return;
  const sets=spec.keys.map(([key,,color])=>({data:rows.map(r=>spec.unit==='bytes'?Number(r[key]||0)/1024:Number(r[key]||0)),color}));
  multiChart(canvas,sets,{max:spec.max,unit:spec.unit==='bytes'?'KB':spec.unit});
}
function scheduleMetricDetailDraw(){requestAnimationFrame(drawMetricDetail);setTimeout(drawMetricDetail,180);setTimeout(drawMetricDetail,360)}

function openMetricDetail(metric) {
  const spec = METRICS[metric];
  if (!spec) return;
  activeMetricDetail=metric;
  openDetailShell('metric', spec.title);
  $('detailType').textContent = 'Историческая метрика';
  $('detailStatus').textContent = persistedHistory?.range || '24h';
  $('detailStatus').className = 'pill info';
  const rows = persistedHistory?.rows || [];
  const primary = rows.map(r => Number(r[spec.keys[0][0]] || 0));
  const stats = [
    ['Текущее', metricValue(primary.at(-1) || 0, spec.unit)],
    ['Среднее', metricValue(primary.reduce((a,b)=>a+b,0)/(primary.length||1), spec.unit)],
    ['Минимум', metricValue(primary.length ? Math.min(...primary) : 0, spec.unit)],
    ['Максимум', metricValue(primary.length ? Math.max(...primary) : 0, spec.unit)],
    ['P95', metricValue(percentile(primary,.95), spec.unit)],
    ['Точек', String(rows.length)],
  ];
  $('detailBody').innerHTML = `
    <section class="detail-section"><h3>${esc(persistedHistory?.range || '24h')} · статистика</h3>${detailStats(stats)}</section>
    <section class="detail-section"><h3>Детальный график</h3><div class="metric-detail-chart"><canvas id="metricDetailCanvas"></canvas></div><div class="metric-detail-inspect" id="metricDetailInspect">Период: ${formatWhen(persistedHistory?.from)} → ${formatWhen(persistedHistory?.to)}</div></section>
    <section class="detail-section"><h3>Ряды</h3><div class="metric-series-list">${spec.keys.map(([,label])=>`<span>${esc(label)}</span>`).join('')}</div></section>`;
  const canvas = $('metricDetailCanvas');
  scheduleMetricDetailDraw();
  canvas.addEventListener('mousemove', (e) => {
    if (!rows.length) return;
    const rect=canvas.getBoundingClientRect(); const i=Math.min(rows.length-1,Math.round(clamp((e.clientX-rect.left)/rect.width,0,1)*(rows.length-1))); const row=rows[i];
    $('metricDetailInspect').textContent=`${formatWhen(row.ts)} · ${spec.keys.map(([k,l])=>`${l}: ${metricValue(row[k]||0,spec.unit)}`).join(' · ')}`;
  });
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
  renderCores(d);

  const now = Date.now();
  if (now - lastFull > 15_000) {
    lastFull = now;
    renderFs(d); renderContainers(d); renderPm2(d);
    renderSecurity(d); renderCerts(d); renderBackups(d);
    renderServices(d); renderDockerDisk(d); renderLogins(d);
  }
}

/* ------------------------- Sentinel Forge ------------------------ */
const forgeMessages = [];
const FORGE_CHATS_KEY='sentinelForgeChats:v1';
let forgeChatId=crypto.randomUUID?.()||String(Date.now());
let forgeChatStarted=Date.now();
let forgeBusy = false;
let forgeModel = localStorage.getItem('forgeModel') || 'Qwen3.6-35B-A3B';
if (!['DeepSeek-V4-Pro','Qwen3.6-35B-A3B'].includes(forgeModel)) { forgeModel = 'DeepSeek-V4-Pro'; localStorage.setItem('forgeModel', forgeModel); }
let forgeScope = localStorage.getItem('forgeScope') || 'vps';
let forgeProjects = [{ id:'vps', name:'Весь VPS', detail:'Система и все сервисы' }];
const forgeModels = [
  { id:'DeepSeek-V4-Pro', name:'DeepSeek V4 Pro', detail:'Проверен с полным набором инструментов' },
  { id:'Qwen3.6-35B-A3B', name:'Qwen 3.6', detail:'Проверен с полным набором инструментов' },
];

function readForgeChats(){try{const value=JSON.parse(localStorage.getItem(FORGE_CHATS_KEY)||'[]');return Array.isArray(value)?value.slice(0,20):[]}catch{return []}}
function forgeChatTitle(messages){const first=messages.find(x=>x.role==='user')?.content||'Новый чат';return first.replace(/\s+/g,' ').trim().slice(0,54)}
function saveForgeChat(){if(!forgeMessages.length)return;const chats=readForgeChats().filter(x=>x.id!==forgeChatId);chats.unshift({id:forgeChatId,title:forgeChatTitle(forgeMessages),updatedAt:Date.now(),startedAt:forgeChatStarted,model:forgeModel,scope:forgeScope,messages:forgeMessages.slice(-14)});localStorage.setItem(FORGE_CHATS_KEY,JSON.stringify(chats.slice(0,20)));renderForgeHistory()}
function renderForgeConversation(){const transcript=$('forgeTranscript');transcript.innerHTML=forgeMessages.length?'':forgeWelcomeMarkup();for(const message of forgeMessages)appendForgeMessage(message.role,message.content,false,{model:message.model||''})}
function renderForgeHistory(){const chats=readForgeChats();$('forgeHistoryList').innerHTML=chats.length?chats.map(chat=>`<button type="button" class="forge-history-item ${chat.id===forgeChatId?'active':''}" data-forge-chat="${esc(chat.id)}"><b>${esc(chat.title)}</b><span>${formatWhen(chat.updatedAt)} · ${esc(forgeProjects.find(x=>x.id===chat.scope)?.name||chat.scope||'VPS')}</span></button>`).join(''):'<div class="forge-history-empty">История появится после первого ответа.</div>'}
function toggleForgeHistory(force){const panel=$('forgeHistory'),show=typeof force==='boolean'?force:panel.hidden;panel.hidden=!show;$('forgeHistoryToggle').setAttribute('aria-expanded',String(show));if(show)renderForgeHistory()}
function loadForgeChat(id){const chat=readForgeChats().find(x=>x.id===id);if(!chat||forgeBusy)return;saveForgeChat();forgeChatId=chat.id;forgeChatStarted=chat.startedAt||chat.updatedAt;forgeMessages.splice(0,forgeMessages.length,...(chat.messages||[]));if(['DeepSeek-V4-Pro','Qwen3.6-35B-A3B'].includes(chat.model))forgeModel=chat.model;if(chat.scope)forgeScope=chat.scope;renderForgeMenus();renderForgeConversation();toggleForgeHistory(false)}

function forgeTime() {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date());
}

function appendForgeMessage(role, text, loading = false, meta = {}) {
  $('forgeWelcome')?.remove();
  const article = document.createElement('article');
  article.className = `forge-chat-message ${role}${loading ? ' loading' : ''}`;
  const wrap = document.createElement('div'); wrap.className = 'forge-chat-content';
  const top = document.createElement('div'); top.className = 'forge-chat-meta';
  const name = document.createElement('b'); name.textContent = role === 'assistant' ? 'Sentinel Forge' : 'Вы';
  const details = document.createElement('span'); details.textContent = meta.model ? `${meta.model} · ${forgeTime()}` : forgeTime();
  top.append(name, details);
  const content = document.createElement('div');
  content.className = loading ? 'forge-thinking-v2' : 'forge-markdown';
  if (loading) content.innerHTML = '<span></span><span></span><span></span><b>думает и проверяет</b>';
  else if (role === 'assistant') content.innerHTML = renderMarkdown(text);
  else content.textContent = text;
  wrap.append(top, content); article.append(wrap); $('forgeTranscript').append(article);
  $('forgeTranscript').scrollTo({ top: $('forgeTranscript').scrollHeight, behavior: 'smooth' });
  return article;
}

function setForgeBusy(value) {
  forgeBusy = value;
  $('forgeSend').disabled = value; $('forgeInput').disabled = value;
  $('forgeModelTrigger').disabled = value; $('forgeScopeTrigger').disabled = value;
  $('forgePresence').textContent = value ? 'работает' : 'готов';
  $('forgePane').classList.toggle('busy', value);
}

async function sendForge(text) {
  if (forgeBusy) return;
  const prompt = String(text || '').trim(); if (!prompt) return;
  const model = forgeModel; const scope = forgeScope;
  setForgeBusy(true); appendForgeMessage('user', prompt); forgeMessages.push({ role: 'user', content: prompt });
  const pending = appendForgeMessage('assistant', '', true, { model });
  $('forgeInput').value = ''; autoSizeForgeInput();
  try {
    const started = await api('/api/agent/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: forgeMessages.slice(-14), model, scope }),
    });
    let data = started;
    const deadline = Date.now() + 170_000;
    while (data.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      data = await api(`/api/agent/chat/${encodeURIComponent(started.jobId)}`);
    }
    if (data.status === 'running') throw new Error('agent_timeout');
    pending.remove(); appendForgeMessage('assistant', data.answer || 'Ответ пуст.', false, { model: data.model || model });
    forgeMessages.push({ role: 'assistant', content: data.answer || '', model: data.model || model });
    if (forgeMessages.length > 14) forgeMessages.splice(0, forgeMessages.length - 14);
    saveForgeChat();
  } catch (e) {
    pending.remove();
    const message = e.message === 'agent_busy' ? '**Агент занят.** Дождитесь завершения текущей задачи.'
      : e.message === 'agent_timeout' ? '**Время вышло.** Разбейте задачу на более короткие шаги.'
        : `**Связь с агентом прервалась.**\n\nОшибка: \`${e.message}\``;
    appendForgeMessage('assistant', message, false, { model });
  } finally { setForgeBusy(false); $('forgeInput').focus(); }
}

function forgeWelcomeMarkup() {
  return `<div class="forge-welcome" id="forgeWelcome"><h3>Чем помочь?</h3><p>Диагностика VPS, расследование инцидентов и работа с кодом.</p><div class="forge-starters" id="forgeSuggestions"><button type="button" data-forge-prompt="Проверь состояние VPS и назови главный риск.">Проверить VPS</button><button type="button" data-forge-prompt="Разбери открытые инциденты и найди причины.">Инциденты</button><button type="button" data-forge-prompt="Проверь выбранный проект, git status и тесты.">Код и тесты</button></div></div>`;
}

function resetForge() { if (forgeBusy) return; saveForgeChat(); forgeChatId=crypto.randomUUID?.()||String(Date.now()); forgeChatStarted=Date.now(); forgeMessages.splice(0); $('forgeTranscript').innerHTML=forgeWelcomeMarkup(); toggleForgeHistory(false); renderForgeHistory(); }
function openForge() { setWorkspacePane('forgePane'); sidebar.classList.remove('open'); setTimeout(() => $('forgeInput').focus(), 180); }
function closeForge() { setWorkspacePane(); }
function autoSizeForgeInput() { const el=$('forgeInput'); el.style.height='auto'; el.style.height=`${Math.min(el.scrollHeight,180)}px`; }
function menuMarkup(items, selected, type) {
  return items.map(item => `<button type="button" class="forge-menu-item ${item.id===selected?'selected':''}" role="option" aria-selected="${item.id===selected}" data-forge-choice="${esc(item.id)}" data-forge-type="${type}"><span class="forge-choice-mark">${item.id===selected?'✓':''}</span><span><b>${esc(item.name)}</b><small>${esc(item.detail || '')}</small></span></button>`).join('');
}
function closeForgeMenus() {
  document.querySelectorAll('.forge-menu.open').forEach(x => x.classList.remove('open'));
  $('forgeScopeTrigger').setAttribute('aria-expanded','false'); $('forgeModelTrigger').setAttribute('aria-expanded','false');
}
function renderForgeMenus() {
  $('forgeScopeMenu').innerHTML = menuMarkup(forgeProjects, forgeScope, 'scope');
  $('forgeModelMenu').innerHTML = menuMarkup(forgeModels, forgeModel, 'model');
  $('forgeScopeLabel').textContent = forgeProjects.find(x=>x.id===forgeScope)?.name || 'Весь VPS';
  $('forgeModelLabel').textContent = forgeModels.find(x=>x.id===forgeModel)?.name || 'GLM 5.2';
}
function toggleForgeMenu(name) {
  const menu=$(name==='scope'?'forgeScopeMenu':'forgeModelMenu'); const trigger=$(name==='scope'?'forgeScopeTrigger':'forgeModelTrigger'); const opening=!menu.classList.contains('open');
  closeForgeMenus(); if(opening){menu.classList.add('open');trigger.setAttribute('aria-expanded','true');}
}
function chooseForge(type, value) {
  if(type==='scope'){forgeScope=value;localStorage.setItem('forgeScope',value);} else {forgeModel=value;localStorage.setItem('forgeModel',value);}
  renderForgeMenus(); closeForgeMenus(); $('forgeInput').focus();
}
async function loadForgeProjects() {
  try { const data=await api('/api/agent/projects'); if(Array.isArray(data.projects)&&data.projects.length) forgeProjects=data.projects; } catch { /* keep VPS context */ }
  if(!forgeProjects.some(x=>x.id===forgeScope)) forgeScope='vps'; renderForgeMenus();
}

/* -------------------------- connection --------------------------- */let ws = null;
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
    if (msg.type === 'incidents') loadIncidents();
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
  await Promise.allSettled([loadHistory('24h'), loadIncidents('all'), loadDeployments(), loadNotificationState(), loadFilesystem('/')]);
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
const navItems = [...document.querySelectorAll('a.nav-item')];
const sections = navItems
  .map(a => document.querySelector(a.getAttribute('href')))
  .filter(Boolean);

const content = $('content');
let spyFrame = 0;
let navLockUntil = 0;
let navLockTarget = null;
content.addEventListener('scroll', () => {
  if (spyFrame) return;
  spyFrame = requestAnimationFrame(() => {
    spyFrame = 0;
    if (Date.now() < navLockUntil) { if (navLockTarget) navItems.forEach(a=>a.classList.toggle('active',a===navLockTarget)); return; }
    const contentTop = content.getBoundingClientRect().top;
    let active = 0;
    let best = Infinity;
    sections.forEach((section, i) => {
      const distance = Math.abs(section.getBoundingClientRect().top - contentTop - 4);
      if (section.getBoundingClientRect().top <= contentTop + 96) active = i;
      if (distance < best && content.scrollTop < 20) { best = distance; active = i; }
    });
    navItems.forEach((a, i) => a.classList.toggle('active', i === active));
  });
}, { passive: true });

navItems.forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  const target = document.querySelector(a.getAttribute('href'));
  if (target) {
    navLockTarget = a; navLockUntil = Date.now() + 700;
    const top = content.scrollTop + target.getBoundingClientRect().top - content.getBoundingClientRect().top - 4;
    content.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    navItems.forEach(x => x.classList.toggle('active', x === a));
    history.replaceState(null, '', a.getAttribute('href'));
    setTimeout(()=>{if(navLockTarget===a){navLockTarget=null;navLockUntil=0;content.dispatchEvent(new Event('scroll'))}},720);
  }
  sidebar.classList.remove('open');
}));
navItems[0]?.classList.add('active');

$('historyRange').addEventListener('click', (e) => {
  const button = e.target.closest('[data-range]');
  if (!button) return;
  $('historyRange').querySelectorAll('.seg').forEach(x => x.classList.toggle('active', x === button));
  loadHistory(button.dataset.range);
});

$('incidentFilters').addEventListener('click', (e) => {
  const button = e.target.closest('[data-status]');
  if (!button) return;
  incidentFilter = button.dataset.status;
  incidentPage = 1;
  $('incidentFilters').querySelectorAll('.seg').forEach(x => x.classList.toggle('active', x === button));
  loadIncidents(incidentFilter, incidentPage);
});

$('content').addEventListener('click', (e) => {
  const action = e.target.closest('[data-incident-action]');
  if (action) { incidentAction(action.dataset.id, action.dataset.incidentAction, action); return; }
  const expand=e.target.closest('[data-incident-expand]');
  if(expand){const box=$(`incidentAi${expand.dataset.incidentExpand}`),show=box.hidden;box.hidden=!show;expand.textContent=show?'Скрыть разбор':'Разбор готов';return}
  const metric = e.target.closest('[data-metric]');
  if (metric) { openMetricDetail(metric.dataset.metric); return; }
  const service = e.target.closest('[data-service-type]');
  if (service) openServiceDetail(service.dataset.serviceType, service.dataset.serviceName);
});

$('content').addEventListener('change', (e) => { const select=e.target.closest('[data-incident-status]'); if(select) changeIncidentStatus(select.dataset.id, select.value, select); });

$('content').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const metric = e.target.closest('[data-metric]');
  if (metric) { e.preventDefault(); openMetricDetail(metric.dataset.metric); return; }
  const service = e.target.closest('[data-service-type]');
  if (!service) return;
  e.preventDefault(); openServiceDetail(service.dataset.serviceType, service.dataset.serviceName);
});

$('chCpu').addEventListener('mousemove', (e) => inspectChart('cpu', e));
$('chCpu').addEventListener('mouseleave', () => resetChartInspect('cpu'));
$('chNet').addEventListener('mousemove', (e) => inspectChart('net', e));
$('chNet').addEventListener('mouseleave', () => resetChartInspect('net'));
$('detailClose').addEventListener('click', closeDetail);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDetail(); closeForge(); closeNotifications(); } });
$('fsEntries').addEventListener('click', (e) => { const row = e.target.closest('[data-fs-path]'); if (row) loadFilesystem(row.dataset.fsPath); });
$('fsEntries').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const row=e.target.closest('[data-fs-path]'); if(row) loadFilesystem(row.dataset.fsPath); } });
$('fsBreadcrumb').addEventListener('click', (e) => { const c=e.target.closest('[data-fs-path]'); if(c) loadFilesystem(c.dataset.fsPath); });
$('fsUp').addEventListener('click', () => loadFilesystem(fsParent(filesystemPath)));
$('fsSearch').addEventListener('input', (e) => {
  clearTimeout(filesystemTimer);
  const value=e.target.value.trim();
  filesystemTimer=setTimeout(() => loadFilesystem(value ? '/' : filesystemPath, value), 280);
});
$('incidentPrev').addEventListener('click',()=>{if(incidentPage>1){incidentPage-=1;loadIncidents(incidentFilter,incidentPage)}});
$('incidentNext').addEventListener('click',()=>{incidentPage+=1;loadIncidents(incidentFilter,incidentPage)});
$('notifyOpen').addEventListener('click',openNotifications);
$('notifyClose').addEventListener('click',closeNotifications);
$('notifyForm').addEventListener('submit',saveNotifications);
$('notifyForm').addEventListener('input',syncNotificationFooter);
$('notifyForm').addEventListener('change',syncNotificationFooter);
$('notifyTest').addEventListener('click',testNotification);
$('notifyForm').elements.quietStart.innerHTML=hourOptions();$('notifyForm').elements.quietEnd.innerHTML=hourOptions();
$('forgeOpen').addEventListener('click', openForge);
$('forgeClose').addEventListener('click', closeForge);
$('forgeReset').addEventListener('click', resetForge);
$('forgeHistoryToggle').addEventListener('click',()=>toggleForgeHistory());
$('forgeHistoryClose').addEventListener('click',()=>toggleForgeHistory(false));
$('forgeHistoryList').addEventListener('click',e=>{const item=e.target.closest('[data-forge-chat]');if(item)loadForgeChat(item.dataset.forgeChat)});
$('forgeForm').addEventListener('submit', (e) => { e.preventDefault(); sendForge($('forgeInput').value); });
$('forgeInput').addEventListener('input', autoSizeForgeInput);
$('forgeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('forgeForm').requestSubmit(); } });
$('forgeTranscript').addEventListener('click', (e) => {
  const starter=e.target.closest('[data-forge-prompt]'); if(starter){sendForge(starter.dataset.forgePrompt);return;}
  const copy=e.target.closest('[data-copy-code]'); if(copy){const code=copy.closest('.md-code').querySelector('code').textContent;navigator.clipboard.writeText(code).then(()=>{copy.textContent='Скопировано';setTimeout(()=>copy.textContent='Копировать',1400);});}
});
$('forgeScopeTrigger').addEventListener('click', () => toggleForgeMenu('scope'));
$('forgeModelTrigger').addEventListener('click', () => toggleForgeMenu('model'));
document.querySelectorAll('.forge-menu').forEach(menu => menu.addEventListener('click', (e) => { const choice=e.target.closest('[data-forge-choice]'); if(choice) chooseForge(choice.dataset.forgeType, choice.dataset.forgeChoice); }));
document.addEventListener('click', (e) => { if(!e.target.closest('.forge-menu-wrap')) closeForgeMenus(); });
renderForgeMenus(); renderForgeHistory(); initPaneResizers(); loadForgeProjects();

setInterval(() => loadIncidents(), 30_000);
setInterval(() => loadDeployments(), 5 * 60_000);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (latest) { renderCharts(latest); renderKpis(latest); } drawMetricDetail(); }, 120);
});

bootstrap();
