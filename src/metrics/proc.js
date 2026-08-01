import fs from 'node:fs/promises';

const read = async (p) => { try { return await fs.readFile(p, 'utf8'); } catch { return ''; } };

let prevCpu = null;
let prevNet = null;
let prevDisk = null;

/* ------------------------------ CPU ------------------------------ */
function parseCpuLine(parts) {
  const n = parts.slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = n;
  const idleAll = idle + iowait;
  const total = user + nice + system + idleAll + irq + softirq + steal;
  return { total, idle: idleAll, iowait, steal };
}

export async function cpu() {
  const txt = await read('/proc/stat');
  const cur = { total: null, cores: [], ctxt: 0, procsRunning: 0, procsBlocked: 0 };

  for (const line of txt.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'cpu') cur.total = parseCpuLine(parts);
    else if (/^cpu\d+$/.test(parts[0])) cur.cores.push(parseCpuLine(parts));
    else if (parts[0] === 'ctxt') cur.ctxt = Number(parts[1]);
    else if (parts[0] === 'procs_running') cur.procsRunning = Number(parts[1]);
    else if (parts[0] === 'procs_blocked') cur.procsBlocked = Number(parts[1]);
  }

  const pct = (a, b) => {
    if (!a || !b) return 0;
    const dt = b.total - a.total;
    const di = b.idle - a.idle;
    if (dt <= 0) return 0;
    return Math.max(0, Math.min(100, ((dt - di) / dt) * 100));
  };

  const out = {
    usage: prevCpu ? pct(prevCpu.total, cur.total) : 0,
    cores: prevCpu && prevCpu.cores.length === cur.cores.length
      ? cur.cores.map((c, i) => pct(prevCpu.cores[i], c))
      : cur.cores.map(() => 0),
    iowait: prevCpu && cur.total.total > prevCpu.total.total
      ? ((cur.total.iowait - prevCpu.total.iowait) / (cur.total.total - prevCpu.total.total)) * 100
      : 0,
    steal: prevCpu && cur.total.total > prevCpu.total.total
      ? ((cur.total.steal - prevCpu.total.steal) / (cur.total.total - prevCpu.total.total)) * 100
      : 0,
    ctxSwitchesPerSec: prevCpu ? Math.max(0, cur.ctxt - prevCpu.ctxt) : 0,
    procsRunning: cur.procsRunning,
    procsBlocked: cur.procsBlocked,
    count: cur.cores.length,
  };
  prevCpu = cur;
  return out;
}

/* ---------------------------- memory ----------------------------- */
export async function memory() {
  const txt = await read('/proc/meminfo');
  const m = {};
  for (const line of txt.split('\n')) {
    const [k, v] = line.split(':');
    if (k && v) m[k.trim()] = parseInt(v.trim(), 10) * 1024;
  }
  const total = m.MemTotal || 0;
  const available = m.MemAvailable ?? ((m.MemFree || 0) + (m.Buffers || 0) + (m.Cached || 0));
  const used = total - available;
  const swapTotal = m.SwapTotal || 0;
  const swapUsed = swapTotal - (m.SwapFree || 0);
  return {
    total, available, used, free: m.MemFree || 0,
    buffers: m.Buffers || 0, cached: m.Cached || 0, shared: m.Shmem || 0,
    usedPct: total ? (used / total) * 100 : 0,
    swapTotal, swapUsed,
    swapPct: swapTotal ? (swapUsed / swapTotal) * 100 : 0,
  };
}

/* ----------------------------- load ------------------------------ */
export async function load() {
  const txt = (await read('/proc/loadavg')).trim().split(/\s+/);
  const [running, total] = (txt[3] || '0/0').split('/').map(Number);
  return {
    one: Number(txt[0]) || 0,
    five: Number(txt[1]) || 0,
    fifteen: Number(txt[2]) || 0,
    running: running || 0,
    processes: total || 0,
  };
}

export async function uptime() {
  const txt = await read('/proc/uptime');
  return Math.floor(Number(txt.split(/\s+/)[0]) || 0);
}

/* --------------------------- network ----------------------------- */
const SKIP_IFACE = /^(lo|docker|br-|veth|virbr)/;

export async function network() {
  const txt = await read('/proc/net/dev');
  const now = Date.now();
  const cur = { at: now, ifaces: {} };

  for (const line of txt.split('\n').slice(2)) {
    const [namePart, rest] = line.split(':');
    if (!rest) continue;
    const name = namePart.trim();
    const f = rest.trim().split(/\s+/).map(Number);
    cur.ifaces[name] = { rx: f[0] || 0, rxErr: f[2] || 0, rxDrop: f[3] || 0, tx: f[8] || 0, txErr: f[10] || 0, txDrop: f[11] || 0 };
  }

  const result = { rxRate: 0, txRate: 0, rxTotal: 0, txTotal: 0, errors: 0, drops: 0, perIface: [] };
  const dt = prevNet ? (now - prevNet.at) / 1000 : 0;

  for (const [name, v] of Object.entries(cur.ifaces)) {
    const primary = !SKIP_IFACE.test(name);
    let rxRate = 0; let txRate = 0;
    if (dt > 0 && prevNet.ifaces[name]) {
      rxRate = Math.max(0, (v.rx - prevNet.ifaces[name].rx) / dt);
      txRate = Math.max(0, (v.tx - prevNet.ifaces[name].tx) / dt);
    }
    if (primary) {
      result.rxRate += rxRate; result.txRate += txRate;
      result.rxTotal += v.rx; result.txTotal += v.tx;
      result.errors += v.rxErr + v.txErr;
      result.drops += v.rxDrop + v.txDrop;
      result.perIface.push({ name, rxRate, txRate, rxTotal: v.rx, txTotal: v.tx });
    }
  }
  prevNet = cur;
  result.perIface.sort((a, b) => (b.rxTotal + b.txTotal) - (a.rxTotal + a.txTotal));
  return result;
}

/* ----------------------------- disk io --------------------------- */
export async function diskIo() {
  const txt = await read('/proc/diskstats');
  const now = Date.now();
  const cur = { at: now, devs: {} };

  for (const line of txt.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2];
    if (!/^(vd|sd|nvme|xvd)[a-z0-9]+$/.test(name) || /\d+p?\d+$/.test(name)) continue;
    cur.devs[name] = {
      readBytes: Number(f[5]) * 512,
      writeBytes: Number(f[9]) * 512,
      ioMs: Number(f[12]),
    };
  }

  const dt = prevDisk ? (now - prevDisk.at) / 1000 : 0;
  const out = { readRate: 0, writeRate: 0, utilPct: 0, devices: [] };

  for (const [name, v] of Object.entries(cur.devs)) {
    let r = 0; let w = 0; let util = 0;
    if (dt > 0 && prevDisk.devs[name]) {
      r = Math.max(0, (v.readBytes - prevDisk.devs[name].readBytes) / dt);
      w = Math.max(0, (v.writeBytes - prevDisk.devs[name].writeBytes) / dt);
      util = Math.min(100, Math.max(0, ((v.ioMs - prevDisk.devs[name].ioMs) / (dt * 1000)) * 100));
    }
    out.readRate += r; out.writeRate += w;
    out.utilPct = Math.max(out.utilPct, util);
    out.devices.push({ name, readRate: r, writeRate: w, utilPct: util });
  }
  prevDisk = cur;
  return out;
}

export async function kernel() {
  const [ver, host] = await Promise.all([read('/proc/sys/kernel/osrelease'), read('/proc/sys/kernel/hostname')]);
  return { release: ver.trim(), hostname: host.trim() };
}
