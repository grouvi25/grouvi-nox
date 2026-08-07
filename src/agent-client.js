import http from 'node:http';

const socketPath = '/run/sentinel-ai/bridge.sock';

export function callAgent(messages, { model = 'glm-5.2', scope = 'vps', timeoutMs = 280_000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ messages, model, scope });
    const req = http.request({ socketPath, path: '/chat', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw = (raw + c).slice(-70000); });
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(raw); } catch { /* handled below */ }
        if (res.statusCode !== 200) return reject(Object.assign(new Error(data.error || `agent_http_${res.statusCode}`), { status: res.statusCode }));
        return resolve(String(data.answer || '').trim());
      });
    });
    req.on('timeout', () => req.destroy(new Error('agent_timeout')));
    req.on('error', reject);
    req.end(body);
  });
}