import tls from 'node:tls';
import { nginxDomains } from './services.js';

function probe(servername, timeout = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const socket = tls.connect({
      host: '127.0.0.1',
      port: 443,
      servername,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    }, () => {
      try {
        const cert = socket.getPeerX509Certificate
          ? socket.getPeerX509Certificate()
          : null;
        if (cert) {
          done({
            domain: servername,
            ok: true,
            subject: cert.subject?.split('\n')[0] || '',
            issuer: (/CN=([^\n]+)/.exec(cert.issuer || '')?.[1] || '').trim(),
            validTo: new Date(cert.validTo).getTime(),
            san: (cert.subjectAltName || '').replace(/DNS:/g, '').split(', ').slice(0, 8),
          });
        } else {
          const legacy = socket.getPeerCertificate();
          done(legacy?.valid_to
            ? { domain: servername, ok: true, issuer: legacy.issuer?.CN || '', validTo: new Date(legacy.valid_to).getTime(), san: [] }
            : { domain: servername, ok: false, error: 'no_certificate' });
        }
      } catch (e) {
        done({ domain: servername, ok: false, error: e.message });
      } finally {
        socket.destroy();
      }
    });

    socket.setTimeout(timeout, () => { socket.destroy(); done({ domain: servername, ok: false, error: 'timeout' }); });
    socket.on('error', (e) => { done({ domain: servername, ok: false, error: e.code || e.message }); });
  });
}

export async function certificates() {
  const domains = nginxDomains();
  const results = [];
  // sequential: cheap, avoids hammering nginx
  for (const d of domains) {
    // eslint-disable-next-line no-await-in-loop
    const r = await probe(d);
    if (r.ok) {
      r.daysLeft = Math.floor((r.validTo - Date.now()) / 86400000);
    }
    results.push(r);
  }
  results.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
  return results;
}
