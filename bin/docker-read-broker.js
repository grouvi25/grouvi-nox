import fs from 'node:fs';
import http from 'node:http';

const EXACT = new Set(['/v1.44/containers/json?all=1', '/v1.44/system/df']);
const DETAIL = /^\/v1\.44\/containers\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/(json|stats\?stream=false|logs\?stdout=true&stderr=true&timestamps=true&tail=160)$/;
export function allowedDockerPath(value) {
  if (EXACT.has(value)) return true;
  const match=DETAIL.exec(value);
  return Boolean(match && match[1] !== '.' && match[1] !== '..' && !match[1].includes('..'));
}

export function startDockerReadBroker({ socketPath, dockerSocket = '/var/run/docker.sock', gid }) {
  try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/read') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let target = '';
      try { target = JSON.parse(body).path; } catch { res.writeHead(400).end(); return; }
      if (!allowedDockerPath(target)) { res.writeHead(403).end(); return; }
      const upstream = http.request({ socketPath: dockerSocket, path: target, method: 'GET', timeout: 20_000 }, response => {
        res.writeHead(response.statusCode || 502, { 'content-type': response.headers['content-type'] || 'application/octet-stream' });
        let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; if (bytes <= 768_000) res.write(chunk); else upstream.destroy(); });
        response.on('end',()=>res.end());response.on('close',()=>{if(!res.writableEnded)res.end()});
      });
      upstream.on('timeout', () => upstream.destroy(new Error('docker_timeout')));
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      upstream.end();
    });
  });
  server.listen(socketPath, () => {
    if(Number.isInteger(gid))fs.chownSync(socketPath,0,gid);
    fs.chmodSync(socketPath,0o660);
    console.log(`[docker-broker] read-only socket ${socketPath}`);
  });
  return server;
}
