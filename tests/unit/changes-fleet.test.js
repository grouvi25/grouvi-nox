import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { controlHeaders, createControlClient, createControlRouter } from '../../src/changes/fleet-link.js';

const SECRET = 'a'.repeat(64);

async function withNode({ allowedIps = ['127.0.0.1'], secrets = [SECRET], brokerApi }, fn) {
  const calls = [];
  const api = brokerApi || {
    health: async () => ({ ok: true }),
    changes: async () => ({ changes: [{ changeId: 'c1', title: 'x' }] }),
    change: async id => ({ changeId: id }),
    challenge: async payload => { calls.push(['challenge', payload]); return { hash: 'h', nonce: 'n', challenge: 'c' }; },
    probe: async payload => { calls.push(['probe', payload]); return { code: 0, out: 'ok' }; },
    apply: async payload => { calls.push(['apply', payload]); await new Promise(r => setTimeout(r, 30)); return { status: 'applied', changeId: 'c9' }; },
    rollback: async payload => { calls.push(['rollback', payload]); return { rollbackOk: true }; },
  };
  const app = express();
  app.use('/fleet-control', createControlRouter({ brokerApi: api, secrets: () => secrets, allowedIps: () => allowedIps }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { return await fn({ url, calls }); } finally { server.close(); }
}

const raw = async (url, method, route, body, headers) => {
  const response = await fetch(`${url}${route}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : body });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

test('hub calls reach the node broker and long operations are polled to completion', async () => {
  await withNode({}, async ({ url, calls }) => {
    const client = createControlClient({ lookup: () => ({ url, secret: SECRET }), hubId: 'hub' });
    assert.deepEqual(await client.call('n1', 'GET', '/v1/health'), { ok: true });
    assert.equal((await client.call('n1', 'POST', '/v1/challenge', { proposal: { id: 'p' } })).nonce, 'n');
    const result = await client.callAndWait('n1', '/v1/apply', { proposal: { id: 'p' }, nonce: 'n', assertion: { id: 'a' } }, { pollMs: 20 });
    assert.equal(result.status, 'applied');
    assert.deepEqual(calls.map(c => c[0]), ['challenge', 'apply']);
    assert.equal(calls[1][1].assertion.id, 'a', 'the passkey signature is passed through untouched for the node broker to verify');
  });
});

test('the node refuses control traffic unless the hub address was explicitly allowed', async () => {
  await withNode({ allowedIps: [] }, async ({ url }) => {
    const body = '{}';
    const res = await raw(url, 'POST', '/fleet-control/v1/challenge', body, controlHeaders(SECRET, 'hub', 'POST', '/fleet-control/v1/challenge', body));
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'fleet_control_disabled');
  });
  await withNode({ allowedIps: ['203.0.113.9'] }, async ({ url }) => {
    const body = '{}';
    const res = await raw(url, 'POST', '/fleet-control/v1/challenge', body, controlHeaders(SECRET, 'hub', 'POST', '/fleet-control/v1/challenge', body));
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'forbidden');
  });
});

test('forged, stale, replayed and re-routed requests are rejected', async () => {
  await withNode({}, async ({ url, calls }) => {
    const body = JSON.stringify({ proposal: { id: 'p' } });
    const route = '/fleet-control/v1/challenge';
    const good = controlHeaders(SECRET, 'hub', 'POST', route, body);

    assert.equal((await raw(url, 'POST', route, body, controlHeaders('b'.repeat(64), 'hub', 'POST', route, body))).status, 401, 'wrong secret');
    assert.equal((await raw(url, 'POST', route, JSON.stringify({ proposal: { id: 'other' } }), good)).status, 401, 'body swapped after signing');
    assert.equal((await raw(url, 'POST', '/fleet-control/v1/apply', body, good)).status, 401, 'signature reused on another endpoint');
    assert.equal((await raw(url, 'GET', route, '', good)).status, 401, 'signature reused with another method');
    assert.equal((await raw(url, 'POST', route, body, { ...good, 'X-Sentinel-Timestamp': String(Date.now() - 120_000) })).status, 401, 'stale');
    assert.equal(calls.length, 0, 'nothing reached the broker');

    const fresh = controlHeaders(SECRET, 'hub', 'POST', route, body);
    assert.equal((await raw(url, 'POST', route, body, fresh)).status, 200);
    assert.equal((await raw(url, 'POST', route, body, fresh)).status, 409, 'replay');
    assert.equal(calls.length, 1);
    assert.equal((await raw(url, 'POST', route, body, {})).status, 401, 'unsigned');
  });
});

test('noxctl changes subcommands are parseable bash with real line continuations', async () => {
  const { readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const source = readFileSync('bin/noxctl', 'utf8');
  const literal = String.fromCharCode(92) + 'n' + ' '.repeat(6) + 'node -e';
  assert.ok(!source.includes(literal), 'a literal backslash-n is not a line continuation');
  const start = source.indexOf('export-approvers)\n');
  const next = source.indexOf('node -e', start);
  assert.ok(source.slice(start, next).includes(String.fromCharCode(92) + '\n'), 'export-approvers continues onto its node command');
  const check = spawnSync('bash', ['-n', 'bin/noxctl'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('an update restarts the Forge bridge and never the change broker mid-change', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('bin/noxctl', 'utf8');
  const afterRestart = source.slice(source.indexOf("update_progress restarting"), source.indexOf("update_progress healthcheck"));
  assert.match(afterRestart, /sentinel-ai-bridge/, 'the bridge runs code from the new bundle, so the success path must restart it');
  assert.match(source, /A change is being applied; the change broker was not restarted/, 'converge must not restart the broker while it applies a change');
});
