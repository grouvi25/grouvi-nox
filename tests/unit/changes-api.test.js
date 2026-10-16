import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

/* The routes read config at import time, so each scenario runs in its own
   process with an isolated state directory, proposals directory and a fake
   broker standing in for the root process. */

const script = String.raw`
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { proposalHash as hashOf, normalizeProposal as normalizeOf } from './src/changes/policy.js';
const dir = process.env.TEST_DIR;
const proposal = {
  schema: 1, id: 'p-20261017120000-abc123', node: 'local', scope: 'vps', kind: 'command', title: 'Restart api', why: 'it hung', createdAt: 5,
  command: { script: 'docker restart api', cwd: '/', timeoutSec: 60 }, post: [],
};
fs.mkdirSync(process.env.NOX_PROPOSALS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.NOX_PROPOSALS_DIR, proposal.id + '.json'), JSON.stringify(proposal));
const calls = [];
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, enabled: true, busy: null, journal: { ok: true }, host: 't' }));
    if (req.url.startsWith('/changes')) return res.end(JSON.stringify({ changes: [] }));
    if (req.url === '/challenge') return res.end(JSON.stringify({ hash: hashOf(normalizeOf(JSON.parse(raw).proposal)), nonce: 'n1', challenge: Buffer.alloc(32, 7).toString('base64url'), expiresAt: Date.now() + 60000 }));
    if (req.url === '/apply') return res.end(JSON.stringify({ status: 'applied', changeId: 'c1', steps: [] }));
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise(r => fake.listen(process.env.CHANGES_SOCKET, r));
const { createApp } = await import('./src/app.js');
const { proposalHash, normalizeProposal } = await import('./src/changes/policy.js');
const authed = (req, res, next) => { req.session = { sid: 't' }; next(); };
const app = http.createServer(createApp({ apiAuth: authed }));
const locked = http.createServer(createApp());
await Promise.all([app, locked].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
const base = 'http://127.0.0.1:' + app.address().port;
const out = {};
const j = async (method, url, body, headers = {}) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

out.unauth = (await fetch('http://127.0.0.1:' + locked.address().port + '/api/changes/proposals')).status;
const list = await j('GET', '/api/changes/proposals');
out.list = list.body.proposals.map(p => ({ id: p.id, tier: p.tier, status: p.status, hasScript: p.script }));
const hash = list.body.proposals[0].hash;
out.hashMatches = hash === proposalHash(normalizeProposal(proposal));
out.status = (await j('GET', '/api/changes/status')).body;
out.crossSite = (await j('POST', '/api/changes/proposals/' + proposal.id + '/challenge', {}, { origin: 'https://evil.example' })).status;
const ch = await j('POST', '/api/changes/proposals/' + proposal.id + '/challenge', { hash });
out.challenge = { status: ch.status, nonce: ch.body.nonce, challengeB64: ch.body.options && ch.body.options.challenge, rp: ch.body.options && ch.body.options.rpId };
out.staleChallenge = (await j('POST', '/api/changes/proposals/' + proposal.id + '/challenge', { hash: 'deadbeef' })).status;
out.staleApply = (await j('POST', '/api/changes/proposals/' + proposal.id + '/apply', { hash: 'deadbeef', nonce: 'n', assertion: {} })).status;
const started = await j('POST', '/api/changes/proposals/' + proposal.id + '/apply', { hash, nonce: 'n1', assertion: { id: 'a' } });
out.apply = started.status;
await new Promise(r => setTimeout(r, 200));
const job = await j('GET', '/api/changes/jobs/' + started.body.jobId);
out.job = job.body;
out.sentToBroker = calls.find(c => c.url === '/apply').body;
out.badId = (await j('GET', '/api/changes/proposals/..%2F..%2Fetc%2Fpasswd')).status;
out.reject = (await j('POST', '/api/changes/proposals/' + proposal.id + '/reject', {})).status;
out.rejections = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'proposal-rejections.json'), 'utf8')));
console.log(JSON.stringify(out));
process.exit(0);
`;

test('change routes: auth boundary, same-origin, hash pinning and relay to the broker', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'nox-api-'));
  fs.mkdirSync(path.join(dir, 'state'));
  const file = path.join(process.cwd(), '.nox-api-scenario.mjs');
  fs.writeFileSync(file, script);
  try {
    const run = spawnSync(process.execPath, [file], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, TEST_DIR: path.join(dir, 'state'), STATE_DIR: path.join(dir, 'state'), ADMIN_SOCKET: path.join(dir, 'state', 'admin.sock'), NOX_PROPOSALS_DIR: path.join(dir, 'proposals'), CHANGES_SOCKET: path.join(dir, 'broker.sock'), ORIGIN: 'https://vps.example.test', RP_ID: 'vps.example.test' },
    });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout.trim().split('\n').pop());
    assert.equal(out.unauth, 401);
    assert.deepEqual(out.list, [{ id: 'p-20261017120000-abc123', tier: 'routine', status: 'pending', hasScript: 'docker restart api' }]);
    assert.equal(out.hashMatches, true);
    assert.deepEqual(out.status, { available: true, enabled: true, busy: null, journalOk: true, host: 't' });
    assert.equal(out.crossSite, 403);
    assert.equal(out.challenge.status, 200);
    assert.equal(out.challenge.nonce, 'n1');
    assert.equal(out.challenge.challengeB64, Buffer.alloc(32, 7).toString('base64url'), 'the browser must sign exactly the broker challenge');
    assert.equal(out.challenge.rp, 'vps.example.test');
    assert.equal(out.staleChallenge, 409);
    assert.equal(out.staleApply, 409);
    assert.equal(out.apply, 202);
    assert.equal(out.job.status, 'done');
    assert.equal(out.job.result.changeId, 'c1');
    assert.equal(out.sentToBroker.proposal.command.script, 'docker restart api');
    assert.equal(out.sentToBroker.nonce, 'n1');
    assert.equal(out.badId, 404);
    assert.equal(out.reject, 200);
    assert.deepEqual(out.rejections, ['p-20261017120000-abc123']);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
