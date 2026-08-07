import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { recordMetric, syncIncidents } from '../database.js';
import { notifyEvents, telegramState } from '../notifier.js';
import { enabledNames } from '../discovery/store.js';
import * as proc from './proc.js';
import * as svc from './services.js';
import { certificates } from './certs.js';
import { evaluate } from './alerts.js';

export const bus = new EventEmitter();

const history = {
  cpu: [], mem: [], swap: [], rx: [], tx: [], ioR: [], ioW: [], load: [], at: [],
};

const snapshot = {
  startedAt: Date.now(), updatedAt: null,
  cpu: null, memory: null, load: null, uptime: 0, network: null, diskIo: null, kernel: null,
  filesystems: [], containers: null, pm2: null, systemd: null, fail2ban: null,
  ssh:null,databases:[],backups:[],certificates: [], dockerDisk: null, os: null,
  alerts: [], history, telegram: telegramState(),
};

let incidentSyncing = false;

function push(key, value) {
  const arr = history[key];
  arr.push(Number.isFinite(value) ? Number(value.toFixed(2)) : 0);
  if (arr.length > config.historyPoints) arr.shift();
}

async function reconcileIncidents() {
  if (incidentSyncing) return;
  incidentSyncing = true;
  try {
    const events = syncIncidents(snapshot.alerts);
    if (events.length) {
      bus.emit('incidents', events);
      await notifyEvents(events);
    }
    snapshot.telegram = telegramState();
  } catch (e) {
    console.error('[incidents]', e.message);
  } finally {
    incidentSyncing = false;
  }
}

async function fastTick() {
  try {
    const [cpu, memory, load, uptime, network, diskIo] = await Promise.all([
      proc.cpu(), proc.memory(), proc.load(), proc.uptime(), proc.network(), proc.diskIo(),
    ]);
    Object.assign(snapshot, { cpu, memory, load, uptime, network, diskIo, updatedAt: Date.now() });
    push('cpu', cpu.usage); push('mem', memory.usedPct); push('swap', memory.swapPct);
    push('rx', network.rxRate / 1024); push('tx', network.txRate / 1024);
    push('ioR', diskIo.readRate / 1024); push('ioW', diskIo.writeRate / 1024); push('load', load.one);
    history.at.push(Date.now());
    if (history.at.length > config.historyPoints) history.at.shift();
    snapshot.alerts = evaluate(snapshot);
    bus.emit('tick', publicSnapshot());
  } catch (e) { console.error('[collector:fast]', e.message); }
}

async function slowTick() {
  try {
    const [filesystems, containers, pm2, systemd, fail2ban, ssh, backups, kernel] = await Promise.all([
      svc.filesystems(), svc.containers(), svc.pm2(), svc.systemd(), svc.fail2ban(),
      svc.sshActivity(),svc.backups(),proc.kernel(),
    ]);
    const containerNames=enabledNames('container'),pm2Names=enabledNames('service','pm2');
    if(containerNames&&containers?.items){containers.items=containers.items.filter(item=>containerNames.has(item.name));containers.running=containers.items.filter(x=>x.state==='running').length;containers.stopped=containers.items.filter(x=>x.state!=='running').length;containers.unhealthy=containers.items.filter(x=>x.health==='unhealthy').length}
    if(pm2Names&&pm2?.items){pm2.items=pm2.items.filter(item=>pm2Names.has(item.name));pm2.online=pm2.items.filter(x=>x.status==='online').length;pm2.down=pm2.items.filter(x=>x.status!=='online').length}
    Object.assign(snapshot,{filesystems,containers,pm2,systemd,fail2ban,ssh,backups,kernel});
    snapshot.alerts = evaluate(snapshot);
    await reconcileIncidents();
  } catch (e) { console.error('[collector:slow]', e.message); }
}

async function rareTick() {
  try {
    const [dockerDisk,os,databases]=await Promise.all([svc.dockerDisk(),svc.osInfo(),svc.databases()]);
    Object.assign(snapshot,{dockerDisk,os,databases});
    snapshot.alerts = evaluate(snapshot);
    await reconcileIncidents();
  } catch (e) { console.error('[collector:rare]', e.message); }
}

async function certTick() {
  try {
    snapshot.certificates=await certificates();const domains=enabledNames('domain');if(domains)snapshot.certificates=snapshot.certificates.filter(x=>domains.has(x.domain));
    snapshot.alerts = evaluate(snapshot);
    await reconcileIncidents();
  } catch (e) { console.error('[collector:cert]', e.message); }
}

function persistTick() {
  try {
    if (snapshot.updatedAt) recordMetric(snapshot);
  } catch (e) { console.error('[history]', e.message); }
}

export function publicSnapshot() {
  return { ...snapshot, serverTime: Date.now(), collectorUptimeMs: Date.now() - snapshot.startedAt };
}

export function startCollectors() {
  fastTick(); slowTick(); rareTick(); certTick();
  setInterval(fastTick, config.fastIntervalMs).unref();
  setInterval(slowTick, config.slowIntervalMs).unref();
  setInterval(rareTick, config.rareIntervalMs).unref();
  setInterval(certTick, config.certIntervalMs).unref();
  setInterval(persistTick, config.historyPersistIntervalMs).unref();
}
