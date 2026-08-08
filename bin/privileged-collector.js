#!/usr/bin/env node
/**
 * Privileged read-only side-car.
 * Collects the two signals unavailable to the unprivileged web process:
 * PM2 state/log tails and fail2ban. It also reads git deployment metadata.
 * It never accepts commands from the network and only writes one JSON snapshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import {startDockerReadBroker} from './docker-read-broker.js';
import {startIntegrationConfigBroker} from './integration-config-broker.js';
import { discoverHost } from '../src/discovery/scanner.js';

const STATE_DIR = process.env.STATE_DIR || '/var/lib/vps-sentinel';
const OUT = path.join(STATE_DIR, 'privileged.json');
const FS_OUT = path.join(STATE_DIR, 'filesystem.json');
const DISCOVERY_OUT=path.join(STATE_DIR,'discovery.json');
const DISCOVERY_SETTINGS=path.join(STATE_DIR,'discovery-settings.json');
const DISCOVERY_RESCAN=path.join(STATE_DIR,'discovery-rescan');
const DOCKER_BROKER=process.env.DOCKER_BROKER_SOCKET||path.join(STATE_DIR,'docker-read.sock');
const INTEGRATION_BROKER=process.env.INTEGRATION_BROKER_SOCKET||path.join(STATE_DIR,'integration-config.sock');
const INTERVAL = Number(process.env.PRIV_INTERVAL_MS || 15000);
const FS_INTERVAL = Number(process.env.FS_INDEX_INTERVAL_MS || 600_000);
const DISCOVERY_INTERVAL=Number(process.env.DISCOVERY_INTERVAL_MS||900_000);
const FS_MAX_ENTRIES = Number(process.env.FS_MAX_ENTRIES || 60_000);
const PM2_BIN = process.env.PM2_BIN || '/usr/bin/pm2';
const F2B_BIN = process.env.FAIL2BAN_BIN || '/usr/bin/fail2ban-client';
function discoverySettings(){try{return JSON.parse(fs.readFileSync(DISCOVERY_SETTINGS,'utf8'))}catch{return{enabledIds:[],disabledIds:[],roots:[]}}}
function discoverySnapshot(){try{return JSON.parse(fs.readFileSync(DISCOVERY_OUT,'utf8'))}catch{return{items:[]}}}
function deployDirs(){const explicit=String(process.env.DEPLOY_DIRS||'').split(',').map(x=>x.trim()).filter(Boolean),settings=discoverySettings(),on=new Set(settings.enabledIds||[]),off=new Set(settings.disabledIds||[]),discovered=discoverySnapshot().items.filter(x=>x.type==='project'&&x.path&&(on.has(x.id)||(!off.has(x.id)&&x.defaultEnabled&&x.confidence>=Number(settings.preferences?.autoEnableConfidence||.75)))).map(x=>x.path);return[...new Set([...explicit,...discovered])]}


function run(cmd, args, timeout = 10000, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout, cwd, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL',
      env: { ...process.env, HOME: '/root' },
    }, (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

function redact(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(password|passwd|secret|token|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1$2[REDACTED]')
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .slice(-24_000);
}

function tailFile(filePath, maxBytes = 12_000) {
  if (!filePath) return '';
  try {
    const st = fs.statSync(filePath);
    const length = Math.min(maxBytes, st.size);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, Math.max(0, st.size - length));
    fs.closeSync(fd);
    return redact(buf.toString('utf8')).split('\n').slice(-100).join('\n');
  } catch { return ''; }
}

async function pm2() {
  const result = await run(PM2_BIN, ['jlist']);
  if (!result.ok) return { available: false, items: [] };
  const start = result.stdout.indexOf('[');
  if (start < 0) return { available: false, items: [] };
  let list;
  try { list = JSON.parse(result.stdout.slice(start)); } catch { return { available: false, items: [] }; }
  if (!Array.isArray(list)) return { available: false, items: [] };

  const items = list.map(p => ({
    name: p.name,
    pid: p.pid || null,
    status: p.pm2_env?.status || 'unknown',
    restarts: p.pm2_env?.restart_time ?? 0,
    unstableRestarts: p.pm2_env?.unstable_restarts ?? 0,
    uptimeMs: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    cpu: p.monit?.cpu ?? 0,
    memory: p.monit?.memory ?? 0,
    execMode: p.pm2_env?.exec_mode || 'fork',
    cwd: p.pm2_env?.pm_cwd || null,
    script: p.pm2_env?.pm_exec_path || null,
    nodeVersion: p.pm2_env?.node_version || null,
    outLog: tailFile(p.pm2_env?.pm_out_log_path),
    errorLog: tailFile(p.pm2_env?.pm_err_log_path),
  })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    available: true, items,
    online: items.filter(i => i.status === 'online').length,
    down: items.filter(i => i.status !== 'online').length,
  };
}

async function systemdDetails() {
  const settings=discoverySettings(),on=new Set(settings.enabledIds||[]),off=new Set(settings.disabledIds||[]),threshold=Number(settings.preferences?.autoEnableConfidence||.75);const units=discoverySnapshot().items.filter(item=>item.type==='service'&&item.source==='systemd'&&item.meta?.custom&&(on.has(item.id)||(!off.has(item.id)&&item.defaultEnabled&&item.confidence>=threshold))).map(item=>item.name).filter(name=>/^[A-Za-z0-9_.@-]+\.service$/.test(name)).slice(0,40);
  const items=await Promise.all(units.map(async unit=>{
    const [show,journal]=await Promise.all([
      run('systemctl',['show',unit,'--no-pager','--property=ActiveState,SubState,MainPID,MemoryCurrent,CPUUsageNSec,ActiveEnterTimestamp,WorkingDirectory,ExecStart,FragmentPath'],5000),
      run('journalctl',['-u',unit,'-n','140','--no-pager','--output=short-iso'],7000),
    ]);
    const detail={unit,name:unit};
    for(const line of show.stdout.split('\n')){const i=line.indexOf('=');if(i<1)continue;const key=line.slice(0,i),value=line.slice(i+1);if(key==='ActiveState')detail.status=value;else if(key==='SubState')detail.subState=value;else if(key==='MainPID')detail.pid=Number(value)||null;else if(key==='MemoryCurrent')detail.memory=Number(value)||0;else if(key==='CPUUsageNSec')detail.cpuNs=Number(value)||0;else if(key==='ActiveEnterTimestamp')detail.startedAt=value||null;else if(key==='WorkingDirectory')detail.cwd=value||null;else if(key==='ExecStart')detail.execStart=value.slice(0,700);else if(key==='FragmentPath')detail.fragmentPath=value}
    detail.logs=redact(journal.stdout||journal.stderr).split('\n').slice(-140).join('\n');return detail;
  }));
  return{available:true,items};
}

async function fail2ban() {
  const result = await run(F2B_BIN, ['status', 'sshd']);
  if (!result.ok) return { available: false };
  const num = (re) => Number(re.exec(result.stdout)?.[1] ?? 0);
  return {
    available: true,
    currentlyBanned: num(/Currently banned:\s+(\d+)/),
    totalBanned: num(/Total banned:\s+(\d+)/),
    currentlyFailed: num(/Currently failed:\s+(\d+)/),
    totalFailed: num(/Total failed:\s+(\d+)/),
  };
}

function cleanRemote(value){return String(value||'').replace(/^(https?:\/\/)[^/@]+@/,'$1').replace(/^(ssh:\/\/)[^/@]+@/,'$1').slice(0,500)}
async function deployments() {
  const projects = [];
  for (const dir of deployDirs()) {
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const result = await run('git', ['log', '-30', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%aI%x1f%an%x1f%ae%x1f%cI%x1f%cn%x1f%P%x1f%D%x1f%s%x1f%b%x1e'], 10_000, dir);
    if (!result.ok) continue;
    const commits = result.stdout.split('\x1e').map(x => x.trim()).filter(Boolean).map(row => {
      const [sha, short, at, author, authorEmail, committedAt, committer, parents, refs, subject, ...body] = row.split('\x1f');
      return { sha, short, at, author, authorEmail, committedAt, committer, parents:parents?parents.split(' '):[], refs:refs?refs.split(',').map(x=>x.trim()).filter(Boolean):[], subject, body:body.join('\x1f').trim().slice(0,8000) };
    });
    const [branchResult,statusResult,upstreamResult,remoteResult]=await Promise.all([
      run('git',['branch','--show-current'],3000,dir),run('git',['status','--porcelain=v1'],5000,dir),run('git',['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}'],3000,dir),run('git',['remote','get-url','origin'],3000,dir),
    ]);
    const branch=branchResult.stdout.trim()||'detached',statusLines=statusResult.stdout.split('\n').filter(Boolean),upstream=upstreamResult.ok?upstreamResult.stdout.trim():null;
    let ahead=0,behind=0;if(upstream){const sync=await run('git',['rev-list','--left-right','--count',`HEAD...${upstream}`],5000,dir),parts=sync.stdout.trim().split(/\s+/).map(Number);ahead=parts[0]||0;behind=parts[1]||0}
    projects.push({project:path.basename(dir),dir,branch,upstream,remote:cleanRemote(remoteResult.stdout.trim()),dirty:statusLines.length>0,dirtyCount:statusLines.length,ahead,behind,head:commits[0]?.sha||null,commits});
  }
  return projects.sort((a,b)=>new Date(b.commits[0]?.at||0)-new Date(a.commits[0]?.at||0));
}

function filesystemRoots(){const configured=discoverySettings().roots||[];const standard=['/etc','/opt','/srv','/var/www','/usr/local','/home','/root','/boot','/tmp'];return[...new Set([...standard,...configured])].filter(x=>fs.existsSync(x))}
const EXCLUDED_NAMES = new Set(['node_modules', '.git', '__pycache__', '.cache']);
const EXCLUDED_PREFIXES = [
  '/var/lib/docker','/var/lib/containerd','/var/lib/snapd','/proc','/sys','/dev','/run',
];
const SECRET_NAME = /(^|[._-])(env|secret|credential|token|private|passwd|shadow|id_rsa|id_ed25519)([._-]|$)|\.pem$|\.key$/i;

function excludedPath(full, name) {
  return EXCLUDED_NAMES.has(name)||name==='.ssh'||/^quarantine(?:[-_.]|$)/i.test(name)||EXCLUDED_PREFIXES.some(prefix=>full===prefix||full.startsWith(`${prefix}/`));
}

function fsRisk(full, name, stat) {
  const flags = [];
  if (stat.mode & 0o002) flags.push('world-writable');
  if (stat.mode & 0o4000) flags.push('setuid');
  if (stat.mode & 0o2000) flags.push('setgid');
  if (SECRET_NAME.test(name)) flags.push('sensitive-name');
  if (stat.size > 500 * 1024 * 1024) flags.push('large');
  if (Date.now() - stat.mtimeMs < 24 * 3600_000) flags.push('recent');
  if (full.startsWith('/root') || full.startsWith('/etc')) flags.push('privileged-area');
  return flags;
}

function indexFilesystem() {
  const entries = [];
  const totals = { files: 0, directories: 0, symlinks: 0, bytes: 0, excluded: 0, truncated: false };
  const largest = [];
  const risks = [];
  const roots=filesystemRoots();
  const stack=roots.map(root => ({ full: root, parent: '/', depth: 1 }));

  while (stack.length && entries.length < FS_MAX_ENTRIES) {
    const current = stack.pop();
    let stat;
    try { stat = fs.lstatSync(current.full); } catch { continue; }
    const name = path.basename(current.full) || current.full;
    const isDir = stat.isDirectory();
    const isLink = stat.isSymbolicLink();
    const excluded = isDir && excludedPath(current.full, name);
    const risk = fsRisk(current.full, name, stat);
    const item = {
      path: current.full, parent: current.parent, name,
      type: isDir ? 'directory' : isLink ? 'symlink' : stat.isFile() ? 'file' : 'other',
      size: stat.size, mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'),
      uid: stat.uid, gid: stat.gid, mtime: stat.mtimeMs,
      depth: current.depth, excluded, risk,
    };
    entries.push(item);
    if (isDir) totals.directories += 1;
    else if (isLink) totals.symlinks += 1;
    else if (stat.isFile()) { totals.files += 1; totals.bytes += stat.size; }
    if (excluded) totals.excluded += 1;
    if (risk.some(x => x !== 'recent' && x !== 'privileged-area')) risks.push(item);
    if (stat.isFile() && stat.size > 10 * 1024 * 1024) largest.push(item);

    if (!isDir || excluded || current.depth >= 9) continue;
    let children;
    try { children = fs.readdirSync(current.full, { withFileTypes: true }); } catch { continue; }
    // Reverse alphabetical push gives stable alphabetical traversal after stack pop.
    children.sort((a, b) => b.name.localeCompare(a.name));
    for (const child of children) {
      const full = path.join(current.full, child.name);
      stack.push({ full, parent: current.full, depth: current.depth + 1 });
    }
  }
  totals.truncated = stack.length > 0;
  largest.sort((a, b) => b.size - a.size);
  risks.sort((a, b) => b.mtime - a.mtime);
  return {
    at:Date.now(),roots,totals,
    entries,
    largest: largest.slice(0, 100),
    risks: risks.slice(0, 300),
    policy: {
      metadataOnly: true,
      contentAccess: false,
      excluded: ['node_modules', '.git', 'caches', 'Docker/containerd internals', 'SSH private areas', 'malware quarantine'],
    },
  };
}

async function filesystemTick() {
  try {
    const payload = JSON.stringify(indexFilesystem());
    const tmp = `${FS_OUT}.tmp`;
    fs.writeFileSync(tmp, payload, { mode: 0o644 });
    fs.renameSync(tmp, FS_OUT);
    fs.chmodSync(FS_OUT, 0o644);
    console.log(`[filesystem] indexed ${JSON.parse(payload).entries.length} entries`);
  } catch (e) { console.error('[filesystem]', e.message); }
}

async function discoveryTick(){try{const configured=discoverySettings().roots||[];const snapshot=discoverHost({roots:configured.length?configured:undefined});const tmp=`${DISCOVERY_OUT}.tmp`;fs.writeFileSync(tmp,JSON.stringify(snapshot),{mode:0o644});fs.renameSync(tmp,DISCOVERY_OUT);fs.chmodSync(DISCOVERY_OUT,0o644);console.log(`[discovery] ${snapshot.items.length} targets`)}catch(error){console.error('[discovery]',error.message)}}

async function tick(){if(fs.existsSync(DISCOVERY_RESCAN)){try{fs.unlinkSync(DISCOVERY_RESCAN)}catch{}await discoveryTick()}
  try {
    const [p, f, d, units] = await Promise.all([pm2(), fail2ban(), deployments(), systemdDetails()]);
    const payload = JSON.stringify({ at: Date.now(), pm2: p, fail2ban: f, deployments: d, systemdDetails: units });
    const tmp = `${OUT}.tmp`;
    fs.writeFileSync(tmp, payload, { mode: 0o644 });
    fs.renameSync(tmp, OUT);
    fs.chmodSync(OUT, 0o644);
  } catch (e) {
    console.error('[privileged]', e.message);
  }
}

fs.mkdirSync(STATE_DIR, { recursive: true });
const stateGid=fs.statSync(STATE_DIR).gid;
const dockerBroker=startDockerReadBroker({socketPath:DOCKER_BROKER,dockerSocket:process.env.DOCKER_SOCKET||'/var/run/docker.sock',gid:stateGid});
const integrationBroker=startIntegrationConfigBroker({socketPath:INTEGRATION_BROKER,gid:stateGid});
await Promise.all([once(dockerBroker,'listening'),once(integrationBroker,'listening')]);
await discoveryTick();await tick();await filesystemTick();
setInterval(tick, INTERVAL);
setInterval(filesystemTick,FS_INTERVAL);
setInterval(discoveryTick,DISCOVERY_INTERVAL);
console.log(`[privileged] writing ${OUT} every ${INTERVAL} ms`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
