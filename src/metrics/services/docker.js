import http from 'node:http';
import { config } from '../../config.js';

/* ---------------------------- docker ----------------------------- */
function dockerRequest(urlPath, timeout = 8000) {
  return new Promise((resolve) => {
    const payload=JSON.stringify({ path:urlPath });
    const req=http.request({socketPath:config.paths.dockerBroker,path:'/read',method:'POST',timeout,headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}},res=>{
      const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size<=768_000)chunks.push(chunk)});res.on('end',()=>resolve(res.statusCode===200?Buffer.concat(chunks):Buffer.alloc(0)));
    });
    req.on('error',()=>resolve(Buffer.alloc(0)));req.on('timeout',()=>{req.destroy();resolve(Buffer.alloc(0))});req.end(payload);
  });
}
async function dockerApi(urlPath,timeout=8000){const body=await dockerRequest(urlPath,timeout);try{return JSON.parse(body.toString('utf8'))}catch{return null}}

export async function containers() {
  const list = await dockerApi('/v1.44/containers/json?all=1');
  if (!Array.isArray(list)) return { available: false, items: [], running: 0, stopped: 0, unhealthy: 0 };

  const items = list.map((c) => {
    const status = c.Status || '';
    const health = /\((healthy|unhealthy|health: starting)\)/.exec(status)?.[1] || null;
    return {
      name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status,
      health,
      project: c.Labels?.['com.docker.compose.project'] || null,
      service: c.Labels?.['com.docker.compose.service'] || null,
      createdAt: c.Created ? c.Created * 1000 : null,
      ports: (c.Ports || [])
        .filter(p => p.PublicPort)
        .map(p => `${p.IP === '::' ? '' : p.IP || ''}:${p.PublicPort}->${p.PrivatePort}`),
    };
  }).sort((a, b) => (a.project || 'zz').localeCompare(b.project || 'zz') || a.name.localeCompare(b.name));

  return {
    available: true,
    items,
    running: items.filter(i => i.state === 'running').length,
    stopped: items.filter(i => i.state !== 'running').length,
    unhealthy: items.filter(i => i.health === 'unhealthy').length,
  };
}

export async function dockerDisk() {
  const df = await dockerApi('/v1.44/system/df', 20000);
  if (!df) return null;
  const sum = (arr, f) => (arr || []).reduce((a, x) => a + (f(x) || 0), 0);
  return {
    images: { count: (df.Images || []).length, size: sum(df.Images, i => i.Size) },
    containers: { count: (df.Containers || []).length, size: sum(df.Containers, c => c.SizeRw) },
    volumes: { count: (df.Volumes || []).length, size: sum(df.Volumes, v => v.UsageData?.Size) },
    buildCache: { size: sum(df.BuildCache, b => b.Size), reclaimable: sum(df.BuildCache, b => (b.InUse ? 0 : b.Size)) },
  };
}

function dockerRaw(urlPath,timeout=10_000){return dockerRequest(urlPath,timeout)}

function decodeDockerLogs(buffer) {
  // Docker multiplexed stream: 8-byte header followed by payload. TTY logs are plain text.
  if (!buffer.length) return '';
  const out = [];
  let offset = 0;
  while (offset + 8 <= buffer.length && buffer[offset] <= 2) {
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 0 || offset + 8 + length > buffer.length) break;
    out.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  const text = (out.length ? Buffer.concat(out) : buffer).toString('utf8');
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(password|passwd|secret|token|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1$2[REDACTED]')
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .split('\n').slice(-160).join('\n').slice(-40_000);
}

export async function containerDetail(name) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) return null;
  const encoded = encodeURIComponent(name);
  const [inspect, stats, logsBuffer] = await Promise.all([
    dockerApi(`/v1.44/containers/${encoded}/json`),
    dockerApi(`/v1.44/containers/${encoded}/stats?stream=false`, 12_000),
    dockerRaw(`/v1.44/containers/${encoded}/logs?stdout=true&stderr=true&timestamps=true&tail=160`, 12_000),
  ]);
  if (!inspect) return null;
  const cpuDelta = Number(stats?.cpu_stats?.cpu_usage?.total_usage || 0) - Number(stats?.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = Number(stats?.cpu_stats?.system_cpu_usage || 0) - Number(stats?.precpu_stats?.system_cpu_usage || 0);
  const cpuCount = Number(stats?.cpu_stats?.online_cpus || 1);
  const cpuPct = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
  const memory = Number(stats?.memory_stats?.usage || 0);
  const memoryLimit = Number(stats?.memory_stats?.limit || 0);
  return {
    name: String(inspect.Name || '').replace(/^\//, ''),
    id: String(inspect.Id || '').slice(0, 12),
    image: inspect.Config?.Image || '',
    state: inspect.State || {},
    created: inspect.Created,
    platform: inspect.Platform,
    restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || 'no',
    readonlyRootfs: Boolean(inspect.HostConfig?.ReadonlyRootfs),
    privileged: Boolean(inspect.HostConfig?.Privileged),
    networkMode: inspect.HostConfig?.NetworkMode || '',
    project: inspect.Config?.Labels?.['com.docker.compose.project'] || null,
    service: inspect.Config?.Labels?.['com.docker.compose.service'] || null,
    mounts: (inspect.Mounts || []).map(m => ({ destination: m.Destination, type: m.Type, rw: m.RW })),
    ports: inspect.NetworkSettings?.Ports || {},
    cpuPct: Number(cpuPct.toFixed(2)),
    memory,
    memoryLimit,
    memoryPct: memoryLimit ? Number((memory / memoryLimit * 100).toFixed(2)) : 0,
    pids: Number(stats?.pids_stats?.current || 0),
    network: stats?.networks || {},
    logs: decodeDockerLogs(logsBuffer),
  };
}
