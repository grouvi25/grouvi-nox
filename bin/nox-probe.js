#!/usr/bin/env node
import http from 'node:http';

/**
 * Read-only look at the server for the agent.
 *
 *   nox-probe [--node ID] [--timeout SEC] -- docker ps
 *
 * The broker decides what may run; anything that is not plainly a read is
 * refused there, and credentials are scrubbed from the output.
 */

const SOCKET = process.env.CHANGES_PROBE_SOCKET || '/var/lib/sentinel-ai/probe.sock';
/* Server answers are printed to a terminal; strip anything that could forge log lines. */
const plain = value => String(value ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').slice(0, 200);
const args = process.argv.slice(2);
const split = args.indexOf('--');
const flags = split < 0 ? [] : args.slice(0, split);
const argv = split < 0 ? args : args.slice(split + 1);
const body = { argv, timeoutSec: 20 };
for (let i = 0; i < flags.length; i += 2) {
  if (flags[i] === '--node') body.node = flags[i + 1];
  else if (flags[i] === '--timeout') body.timeoutSec = Number(flags[i + 1]) || 20;
}
if (!argv.length) { console.error('usage: nox-probe [--node ID] [--timeout SEC] -- <command> [args…]'); process.exit(2); }

const payload = JSON.stringify(body);
const req = http.request({ socketPath: SOCKET, path: '/probe', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, timeout: 40_000 }, res => {
  let raw = '';
  res.on('data', c => { raw += c; });
  res.on('end', () => {
    let data = {};
    try { data = JSON.parse(raw); } catch { /* handled below */ }
    if (res.statusCode !== 200) {
      console.error(`nox-probe refused: ${plain(data.error || res.statusCode)}${data.reason ? ` (${plain(data.reason)})` : ''}`);
      process.exit(res.statusCode === 403 ? 3 : res.statusCode === 429 ? 4 : 1);
    }
    process.stdout.write(data.out || '');
    if (data.truncated) console.error('[output truncated]');
    process.exit(data.code || 0);
  });
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', error => { console.error(`nox-probe: ${error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'broker not running or changes disabled' : plain(error.message)}`); process.exit(1); });
req.end(payload);
