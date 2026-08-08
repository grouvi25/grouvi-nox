import { $, C, bytes, rate, dur, ago, clamp, lvl, esc, setBar } from './js/utils.js';
import { spark, multiChart } from './js/charts.js';
import { initPaneResizers, setWorkspacePane } from './js/panes.js';
import { createNotificationController } from './js/notifications.js';
import { createIncidentController } from './js/incidents.js';
import { createFilesystemController } from './js/filesystem.js';
import { createForgeController } from './js/forge.js';
import {createDiscoveryController} from './js/discovery.js';
import {createSettingsController} from './js/settings-pane.js';

/* ----------------------------- icons ----------------------------- */
const ICON_CRIT = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24"><path d="M10.3 4.3L2.6 18a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 4.3a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>';

/* ----------------------------- render ---------------------------- */
let latest = null;
let persistedHistory = null;

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

const incidents=createIncidentController({api,formatWhen,pageSize:6});
const {loadIncidents}=incidents;
const filesystem=createFilesystemController({api,formatWhen,kv});
const {loadFilesystem}=filesystem;

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
const forge=createForgeController({api,formatWhen,setWorkspacePane});
const discoveryController=createDiscoveryController({api,openProject:openProjectDetail,openTarget:openServiceDetail});
const settings=createSettingsController({api,setWorkspacePane});

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

let deploymentProjects=[],deployLimit=20;
const githubCommitUrl=(remote,sha)=>{const match=/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(String(remote||''));return match?`https://github.com/${match[1]}/${match[2]}/commit/${sha}`:null};
function renderDeployments(projects=deploymentProjects) {
  deploymentProjects=projects||[];const selected=$('deployProject')?.value||'all',q=$('deploySearch')?.value.trim().toLowerCase()||'',rows=[];
  for(const project of deploymentProjects){if(selected!=='all'&&project.dir!==selected)continue;for(const commit of project.commits||[]){const haystack=`${project.project} ${commit.sha} ${commit.subject} ${commit.body||''} ${commit.author} ${commit.authorEmail||''} ${(commit.refs||[]).join(' ')}`.toLowerCase();if(!q||haystack.includes(q))rows.push({...commit,project})}}
  rows.sort((a,b)=>new Date(b.at)-new Date(a.at));const visible=rows.slice(0,deployLimit),dirty=deploymentProjects.filter(x=>x.dirty).length,ahead=deploymentProjects.reduce((n,x)=>n+(x.ahead||0),0),behind=deploymentProjects.reduce((n,x)=>n+(x.behind||0),0);
  $('deployMeta').textContent=`${deploymentProjects.length} репозиториев · ${rows.length} коммитов`;
  $('deployOverview').innerHTML=`<div><span>Репозитории</span><b>${deploymentProjects.length}</b></div><div><span>Изменения локально</span><b class="${dirty?'warn':''}">${dirty}</b></div><div><span>Ahead</span><b>${ahead}</b></div><div><span>Behind</span><b class="${behind?'warn':''}">${behind}</b></div>`;
  $('deployments').innerHTML=visible.length?visible.map(({project,...c})=>{const sync=project.dirty?`${project.dirtyCount} изм.`:project.behind?`↓${project.behind}`:project.ahead?`↑${project.ahead}`:'clean';return `<button class="deploy-row" type="button" data-deploy-dir="${esc(project.dir)}" data-deploy-sha="${esc(c.sha)}"><span class="deploy-project"><b>${esc(project.project)}</b><small>${esc(project.branch)} · ${esc(sync)}</small></span><span class="deploy-sha">${esc(c.short)}</span><span class="deploy-message"><b>${esc(c.subject)}</b>${c.refs?.length?`<small>${c.refs.slice(0,3).map(ref=>`<i>${esc(ref)}</i>`).join('')}</small>`:''}</span><span class="deploy-author"><b>${esc(c.author)}</b><small>${esc(c.authorEmail||'')}</small></span><span class="deploy-time">${formatWhen(new Date(c.at).getTime())}</span></button>`}).join(''):'<div class="empty">По этому фильтру коммитов нет.</div>';
  $('deployShown').textContent=`Показано ${visible.length} из ${rows.length}`;$('deployMore').hidden=visible.length>=rows.length;
}
function renderDeployProjectOptions(){const select=$('deployProject'),value=select.value;select.innerHTML='<option value="all">Все проекты</option>'+deploymentProjects.map(p=>`<option value="${esc(p.dir)}">${esc(p.project)} · ${esc(p.branch)}</option>`).join('');select.value=deploymentProjects.some(p=>p.dir===value)?value:'all'}
async function loadDeployments() {try{deploymentProjects=(await api('/api/deployments')).projects||[];renderDeployProjectOptions();renderDeployments()}catch(e){$('deployments').innerHTML=`<div class="empty">Ошибка: ${esc(e.message)}</div>`}}
function openCommitDetail(dir,sha){const project=deploymentProjects.find(x=>x.dir===dir),commit=project?.commits?.find(x=>x.sha===sha);if(!project||!commit)return;openDetailShell('commit',commit.short);$('detailType').textContent='Git commit';$('detailTitle').textContent=commit.subject;$('detailStatus').textContent=project.branch;$('detailStatus').className=`pill ${project.dirty?'warn':'ok'}`;const url=githubCommitUrl(project.remote,commit.sha),refs=(commit.refs||[]).map(x=>`<i>${esc(x)}</i>`).join('');$('detailBody').innerHTML=`<section class="detail-section"><h3>Commit</h3>${detailStats([['Repository',project.project],['SHA',commit.sha],['Branch',project.branch],['Upstream',project.upstream||'not configured'],['Author',`${commit.author} <${commit.authorEmail||'—'}>`],['Committed by',commit.committer||commit.author],['Authored',new Date(commit.at).toLocaleString('ru-RU')],['Committed',new Date(commit.committedAt||commit.at).toLocaleString('ru-RU')],['Parents',commit.parents?.length?commit.parents.map(x=>x.slice(0,10)).join(' · '):'root commit'],['Working tree',project.dirty?`${project.dirtyCount} local changes`:'clean']])}</section>${refs?`<section class="detail-section"><h3>Refs</h3><div class="commit-refs">${refs}</div></section>`:''}<section class="detail-section"><h3>Message</h3><div class="commit-message"><b>${esc(commit.subject)}</b>${commit.body?`<p>${esc(commit.body)}</p>`:''}</div></section><section class="detail-section"><h3>Repository</h3>${detailStats([['Path',project.dir],['Remote',project.remote||'not configured'],['Sync',`ahead ${project.ahead||0} · behind ${project.behind||0}`]])}<div class="commit-actions"><button type="button" data-copy-sha="${esc(commit.sha)}">Copy SHA</button>${url?`<a href="${esc(url)}" target="_blank" rel="noopener">Open on GitHub</a>`:''}</div></section>`}

function detailStats(entries) {
  return `<div class="detail-grid">${entries.map(([k, v]) => `<div class="detail-stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
}

let detailRefreshTimer=null,detailRequestToken=0;
function stopDetailRefresh(){clearTimeout(detailRefreshTimer);detailRefreshTimer=null;detailRequestToken+=1}
function openDetailShell(type, name) {
  stopDetailRefresh();
  const labels={container:'Docker container',pm2:'PM2 process',systemd:'systemd service',project:'Project workspace',commit:'Git commit'};
  $('detailType').textContent = labels[type]||'Service';
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

function renderSystemdDetail(d) {
  const active=d.status==='active';$('detailStatus').textContent=d.subState||d.status||'unknown';$('detailStatus').className=`pill ${active?'ok':'crit'}`;
  $('detailBody').innerHTML=`<section class="detail-section"><h3>Состояние</h3>${detailStats([['Unit',d.unit],['PID',String(d.pid||'—')],['Memory',bytes(d.memory||0)],['Started',d.startedAt||'—'],['CWD',d.cwd||'—'],['Unit file',d.fragmentPath||'—']])}</section><section class="detail-section"><h3>journalctl · обновляется автоматически</h3><pre class="log-view">${esc(d.logs||'Журнал пуст.')}</pre></section>`;
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

async function refreshServiceDetail(type,name,token){
  try{const data=await api(`/api/services/${type}/${encodeURIComponent(name)}`);if(token!==detailRequestToken)return;if(type==='container')renderContainerDetail(data.detail);else if(type==='pm2')renderPm2Detail(data.detail);else renderSystemdDetail(data.detail);detailRefreshTimer=setTimeout(()=>refreshServiceDetail(type,name,token),5000)}catch(e){if(token!==detailRequestToken)return;$('detailStatus').textContent='ошибка';$('detailStatus').className='pill crit';$('detailBody').innerHTML=`<div class="empty">Не удалось загрузить: ${esc(e.message)}</div>`}}
async function openServiceDetail(type,name){openDetailShell(type,name);const token=detailRequestToken;await refreshServiceDetail(type,name,token)}

const componentStatus=component=>{const d=component.detail||{},raw=d.state?.Health?.Status||d.state?.Status||d.status||d.subState||component.meta?.status||'detected';const ok=/running|healthy|online|active/i.test(String(raw));return{raw,ok}};
const componentLogs=component=>{const d=component.detail||{};if(component.adapter==='pm2')return[`stdout\n${d.outLog||''}`,`stderr\n${d.errorLog||''}`].join('\n');return d.logs||''};
function renderProjectDetail(payload){
  const p=payload.project,body=$('detailBody'),scroll=body.scrollTop,runtimes=p.components.filter(x=>x.adapter),attention=runtimes.filter(x=>!componentStatus(x).ok).length;
  $('detailTitle').textContent=p.name;$('detailStatus').textContent=attention?`${attention} требуют внимания`:'healthy';$('detailStatus').className=`pill ${attention?'warn':'ok'}`;
  const components=p.components.map(c=>{const status=componentStatus(c);return `<button class="project-component" type="button" ${c.adapter?`data-service-type="${esc(c.adapter)}" data-service-name="${esc(c.name)}"`:''}><span>${esc(c.adapter||c.type)}</span><span><b>${esc(c.name)}</b><small>${esc(c.relation||c.source)}</small></span><i class="pill ${status.ok?'ok':'idle'}">${esc(status.raw)}</i></button>`}).join('');
  const logs=runtimes.map(c=>`<details class="runtime-log" open><summary>${esc(c.adapter)} · ${esc(c.name)}<span>live</span></summary><pre class="log-view">${esc(componentLogs(c)||'Логи пока пусты.')}</pre></details>`).join('');
  body.innerHTML=`<div class="project-livebar"><span><i></i>live refresh</span><small>${new Date(payload.refreshedAt).toLocaleTimeString('ru-RU')}</small></div><section class="detail-section"><h3>Проект</h3>${detailStats([['Path',p.path||'—'],['Runtime',String(runtimes.length)],['Components',String(p.components.length)],['Stack',p.stack.join(' · ')||'metadata']])}<p class="detail-subtle">Связи собраны автоматически по рабочим каталогам, Compose labels и конфигурации сервисов.</p></section><section class="detail-section"><h3>Компоненты</h3><div class="project-components">${components||'<div class="empty">Связанные компоненты пока не найдены.</div>'}</div></section><section class="detail-section"><h3>Логи runtime · секреты редактируются</h3>${logs||'<div class="empty">У проекта нет активного runtime с доступным журналом.</div>'}</section>`;body.scrollTop=scroll;
}
async function refreshProjectDetail(id,token){try{const payload=await api(`/api/projects/${encodeURIComponent(id)}`);if(token!==detailRequestToken)return;renderProjectDetail(payload);detailRefreshTimer=setTimeout(()=>refreshProjectDetail(id,token),payload.refreshMs||5000)}catch(e){if(token!==detailRequestToken)return;$('detailStatus').textContent='ошибка';$('detailStatus').className='pill crit';$('detailBody').innerHTML=`<div class="empty">Не удалось собрать проект: ${esc(e.message)}</div>`}}
async function openProjectDetail(id){openDetailShell('project','Проект');const token=detailRequestToken;await refreshProjectDetail(id,token)}

function closeDetail() { stopDetailRefresh();activeMetricDetail=null;setWorkspacePane(); }

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

function liveMetricRows(){const h=latest?.history||{},at=h.at||[];return at.map((ts,index)=>({ts,cpu:Number(h.cpu?.[index]||0),memory:Number(h.mem?.[index]||0),swap:Number(h.swap?.[index]||0),load1:Number(h.load?.[index]||0),network_rx:Number(h.rx?.[index]||0)*1024,network_tx:Number(h.tx?.[index]||0)*1024,disk_read:Number(h.ioR?.[index]||0)*1024,disk_write:Number(h.ioW?.[index]||0)*1024}))}
function metricDetailRows(){const merged=new Map();for(const row of persistedHistory?.rows||[])merged.set(Number(row.ts),row);for(const row of liveMetricRows())merged.set(Number(row.ts),row);return[...merged.values()].sort((a,b)=>a.ts-b.ts).slice(-2400)}
function metricDetailStatsMarkup(spec,rows){const primary=rows.map(r=>Number(r[spec.keys[0][0]]||0));return detailStats([['Текущее',metricValue(primary.at(-1)||0,spec.unit)],['Среднее',metricValue(primary.reduce((a,b)=>a+b,0)/(primary.length||1),spec.unit)],['Минимум',metricValue(primary.length?Math.min(...primary):0,spec.unit)],['Максимум',metricValue(primary.length?Math.max(...primary):0,spec.unit)],['P95',metricValue(percentile(primary,.95),spec.unit)],['Точек',String(rows.length)]])}
function refreshMetricDetail(){const metric=activeMetricDetail,spec=METRICS[metric],stats=$('metricDetailStats'),inspect=$('metricDetailInspect');if(!spec||!stats||!$('detailPane').classList.contains('open'))return;const rows=metricDetailRows();stats.innerHTML=metricDetailStatsMarkup(spec,rows);$('detailStatus').textContent=`live · ${persistedHistory?.range||'realtime'}`;if(inspect&&!inspect.matches(':hover'))inspect.textContent=rows.length?`Период: ${formatWhen(rows[0].ts)} → ${formatWhen(rows.at(-1).ts)} · обновлено сейчас`:'Ожидаю данные';drawMetricDetail()}
function drawMetricDetail(){
  const metric=activeMetricDetail,spec=METRICS[metric],canvas=$('metricDetailCanvas');
  if(!spec||!canvas||!$('detailPane').classList.contains('open'))return;
  const rows=metricDetailRows();
  const rect=canvas.getBoundingClientRect();
  if(rect.width<40||rect.height<40)return;
  const sets=spec.keys.map(([key,,color])=>({data:rows.map(r=>spec.unit==='bytes'?Number(r[key]||0)/1024:Number(r[key]||0)),color}));
  multiChart(canvas,sets,{max:spec.max,unit:spec.unit==='bytes'?'KB':spec.unit});
}
function scheduleMetricDetailDraw(){requestAnimationFrame(drawMetricDetail);setTimeout(drawMetricDetail,180);setTimeout(drawMetricDetail,360)}

function openMetricDetail(metric) {
  const spec = METRICS[metric];
  if (!spec) return;
  openDetailShell('metric', spec.title);
  activeMetricDetail=metric;
  $('detailType').textContent = 'Историческая метрика';
  $('detailStatus').textContent = persistedHistory?.range || '24h';
  $('detailStatus').className = 'pill info';
  const rows = metricDetailRows();
  $('detailBody').innerHTML = `
    <section class="detail-section"><h3>${esc(persistedHistory?.range || 'realtime')} · live статистика</h3><div id="metricDetailStats">${metricDetailStatsMarkup(spec,rows)}</div></section>
    <section class="detail-section"><h3>Детальный график · обновление каждые 2 секунды</h3><div class="metric-detail-chart"><canvas id="metricDetailCanvas"></canvas></div><div class="metric-detail-inspect" id="metricDetailInspect">${rows.length?`Период: ${formatWhen(rows[0].ts)} → ${formatWhen(rows.at(-1).ts)}`:'Ожидаю данные'}</div></section>
    <section class="detail-section"><h3>Ряды</h3><div class="metric-series-list">${spec.keys.map(([,label])=>`<span>${esc(label)}</span>`).join('')}</div></section>`;
  const canvas = $('metricDetailCanvas');
  scheduleMetricDetailDraw();
  canvas.addEventListener('mousemove', (e) => {
    const rows=metricDetailRows();if(!rows.length)return;
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
  refreshMetricDetail();
  renderCores(d);

  const now = Date.now();
  if (now - lastFull > 15_000) {
    lastFull = now;
    renderFs(d); renderContainers(d); renderPm2(d);
    renderSecurity(d); renderCerts(d); renderBackups(d);
    renderServices(d); renderDockerDisk(d); renderLogins(d);
  }
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
  try{const setup=await api('/api/setup');if(!setup.completed){location.href='/setup';return}}catch{}
  try {
    const r = await fetch('/api/snapshot', { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login'; return; }
    render(await r.json());
  } catch { /* websocket will fill in */ }
  await Promise.allSettled([loadHistory('24h'),loadIncidents('all'),loadDeployments(),loadNotificationState(),loadFilesystem('/'),discoveryController.load()]);
  connect();
  if(location.hash==='#settings')settings.open();
}

/* ------------------------------ ui ------------------------------- */
$('logout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/login';
});

const sidebar=$('sidebar'),navScrim=$('navScrim');
function setNavigation(open){sidebar.classList.toggle('open',open);navScrim.hidden=!open}
$('burger').addEventListener('click',()=>setNavigation(!sidebar.classList.contains('open')));
navScrim.addEventListener('click',()=>setNavigation(false));

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
  setNavigation(false);
}));
navItems[0]?.classList.add('active');

$('historyRange').addEventListener('click', (e) => {
  const button = e.target.closest('[data-range]');
  if (!button) return;
  $('historyRange').querySelectorAll('.seg').forEach(x => x.classList.toggle('active', x === button));
  loadHistory(button.dataset.range);
});

$('incidentFilters').addEventListener('click',incidents.onFilterClick);

$('content').addEventListener('click', (e) => {
  if(incidents.onContentClick(e))return;
  const metric = e.target.closest('[data-metric]');
  if (metric) { openMetricDetail(metric.dataset.metric); return; }
  const service = e.target.closest('[data-service-type]');
  if (service) openServiceDetail(service.dataset.serviceType, service.dataset.serviceName);
});

$('content').addEventListener('change',incidents.onContentChange);

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
$('settingsOpen').addEventListener('click',()=>{history.replaceState(null,'','#settings');settings.open()});
$('settingsClose').addEventListener('click',settings.close);
$('settingsRefresh').addEventListener('click',()=>settings.load());
$('settingsRail').addEventListener('click',e=>{const item=e.target.closest('[data-settings-nav]');if(item)settings.navigate(item.dataset.settingsNav)});
$('settingsRailToggle').addEventListener('click',()=>settings.setRail(!$('settingsRail').classList.contains('open')));
$('settingsRailClose').addEventListener('click',()=>settings.setRail(false));
$('settingsRailScrim').addEventListener('click',()=>settings.setRail(false));
$('deployProject').addEventListener('change',()=>{deployLimit=20;renderDeployments()});
$('deploySearch').addEventListener('input',()=>{deployLimit=20;renderDeployments()});
$('deployMore').addEventListener('click',()=>{deployLimit+=20;renderDeployments()});
$('deployments').addEventListener('click',e=>{const row=e.target.closest('[data-deploy-sha]');if(row)openCommitDetail(row.dataset.deployDir,row.dataset.deploySha)});
$('detailBody').addEventListener('click',e=>{const copy=e.target.closest('[data-copy-sha]');if(copy)navigator.clipboard.writeText(copy.dataset.copySha).then(()=>{copy.textContent='Copied';setTimeout(()=>copy.textContent='Copy SHA',1200)})});
$('detailBody').addEventListener('click',e=>{const service=e.target.closest('[data-service-type]');if(service)openServiceDetail(service.dataset.serviceType,service.dataset.serviceName)});
window.addEventListener('keydown',e=>{if(e.key==='Escape'){setNavigation(false);settings.close();closeDetail();forge.closeForge();closeNotifications()}});
$('fsEntries').addEventListener('click',filesystem.onEntriesClick);
$('fsEntries').addEventListener('keydown',filesystem.onEntriesKeydown);
$('fsBreadcrumb').addEventListener('click',filesystem.onBreadcrumbClick);
$('fsUp').addEventListener('click',filesystem.up);
$('fsSearch').addEventListener('input',filesystem.search);
$('incidentPrev').addEventListener('click',incidents.previous);
$('incidentNext').addEventListener('click',incidents.next);
$('notifyOpen').addEventListener('click',openNotifications);
$('notifyClose').addEventListener('click',closeNotifications);
$('notifyForm').addEventListener('submit',saveNotifications);
$('notifyForm').addEventListener('input',syncNotificationFooter);
$('notifyForm').addEventListener('change',syncNotificationFooter);
$('notifyTest').addEventListener('click',testNotification);
$('notifyForm').elements.quietStart.innerHTML=hourOptions();$('notifyForm').elements.quietEnd.innerHTML=hourOptions();
$('forgeOpen').addEventListener('click',forge.openForge);
$('forgeClose').addEventListener('click',forge.closeForge);
$('forgeReset').addEventListener('click',forge.resetForge);
$('forgeHistoryToggle').addEventListener('click',()=>forge.toggleForgeHistory());
$('forgeHistoryClose').addEventListener('click',()=>forge.toggleForgeHistory(false));
$('forgeHistoryList').addEventListener('click',e=>{const item=e.target.closest('[data-forge-chat]');if(item)forge.loadForgeChat(item.dataset.forgeChat)});
$('forgeForm').addEventListener('submit',e=>{e.preventDefault();forge.sendForge($('forgeInput').value)});
$('forgeInput').addEventListener('input',forge.autoSizeForgeInput);
$('forgeInput').addEventListener('keydown', (e) => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('forgeForm').requestSubmit()} });
$('forgeTranscript').addEventListener('click', (e) => {
  const starter=e.target.closest('[data-forge-prompt]');if(starter){forge.sendForge(starter.dataset.forgePrompt);return}
  const copy=e.target.closest('[data-copy-code]'); if(copy){const code=copy.closest('.md-code').querySelector('code').textContent;navigator.clipboard.writeText(code).then(()=>{copy.textContent='Скопировано';setTimeout(()=>copy.textContent='Копировать',1400);});}
});
$('forgeScopeTrigger').addEventListener('click',()=>forge.toggleForgeMenu('scope'));
$('forgeModelTrigger').addEventListener('click',()=>forge.toggleForgeMenu('model'));
document.querySelectorAll('.forge-menu').forEach(menu=>menu.addEventListener('click',e=>{const choice=e.target.closest('[data-forge-choice]');if(choice)forge.chooseForge(choice.dataset.forgeType,choice.dataset.forgeChoice)}));
document.addEventListener('click',e=>{if(!e.target.closest('.forge-menu-wrap'))forge.closeForgeMenus()});
forge.renderForgeMenus();forge.renderForgeHistory();initPaneResizers();forge.loadForgeProjects();

setInterval(() => loadIncidents(), 30_000);
setInterval(()=>loadDeployments(),5*60_000);
setInterval(()=>discoveryController.load(),5*60_000);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (latest) { renderCharts(latest); renderKpis(latest); } drawMetricDetail(); }, 120);
});

bootstrap();
