import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { normalizeProposal, proposalHash, classifyProposal, probeAllowed, redact } from './policy.js';

/**
 * Request handling for the change broker, kept apart from socket plumbing so
 * the security-relevant behaviour can be exercised without root or a unix
 * socket.
 *
 * Two audiences, two listeners:
 *   control - the dashboard's web service: issue a challenge, apply, roll back
 *   probe   - the sandboxed agent: read-only diagnostics, nothing else
 * Each socket is owned by exactly one account, so the agent cannot even open
 * the control socket.
 */

const MAX_BODY = 1_500_000;
const FAILURE_WINDOW_MS = 10 * 60_000;
const FAILURE_LIMIT = 6;
const PROBE_OUTPUT_CAP = 60_000;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body_too_large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('bad_json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

export const rollbackHash = (changeId, recordHash) => crypto.createHash('sha256').update(`rollback:${changeId}:${recordHash}`).digest('hex');

/** Resolves symlinks before the sensitive-path check, so a link cannot smuggle a secret past it. */
export function probeArgsSafe(argv, sensitive) {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-') && !arg.includes('/')) continue;
    const candidate = arg.includes('=') && arg.startsWith('-') ? arg.split('=').slice(1).join('=') : arg;
    if (!candidate.includes('/') && !fs.existsSync(candidate)) continue;
    try {
      const real = fs.realpathSync(candidate);
      if (real !== candidate && sensitive(real)) return false;
    } catch { /* does not exist: nothing to resolve */ }
  }
  return true;
}

export function createBroker({ enabled, gate, executor, journal, notify = () => {}, sensitiveRead, hostLabel = 'host', runProbe = defaultRunProbe, relayProbe = null, proposals = null, now = Date.now }) {
  const failures = [];

  const recordFailure = reason => {
    failures.push(now());
    journal.append({ event: 'approval_rejected', reason });
    notify({ type: 'approval_rejected', reason });
  };
  const locked = () => {
    while (failures.length && now() - failures[0] > FAILURE_WINDOW_MS) failures.shift();
    return failures.length >= FAILURE_LIMIT;
  };

  /** Shared by the agent's socket and the hub relay; the filter is applied here, never trusted from the caller. */
  async function probeRequest(body, { allowRelay }) {
    const argv = Array.isArray(body.argv) ? body.argv.map(String) : [];
    const verdict = probeAllowed(argv);
    if (!verdict.ok) return { status: 403, payload: { error: 'probe_not_allowed', reason: verdict.reason } };
    if (!probeArgsSafe(argv, sensitiveRead)) return { status: 403, payload: { error: 'probe_not_allowed', reason: 'sensitive_path_via_link' } };
    const timeoutSec = Math.min(30, Math.max(2, Number(body.timeoutSec) || 20));
    if (allowRelay && body.node && body.node !== 'local') {
      if (!relayProbe) return { status: 501, payload: { error: 'node_relay_not_ready' } };
      const remote = await relayProbe(String(body.node), { argv, timeoutSec });
      return { status: 200, payload: { code: remote.code, out: redact(String(remote.out || '')).slice(-PROBE_OUTPUT_CAP), truncated: Boolean(remote.truncated) } };
    }
    const result = await runProbe(argv, timeoutSec);
    return { status: 200, payload: { code: result.code, out: redact(result.out).slice(-PROBE_OUTPUT_CAP), truncated: result.out.length > PROBE_OUTPUT_CAP } };
  }

  async function control(req, res) {
    try {
      const url = new URL(req.url, 'http://broker');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /health') {
        return json(res, 200, { ok: true, enabled: enabled(), ...executor.state(), journal: journal.verify(), host: hostLabel });
      }
      if (!enabled()) return json(res, 503, { error: 'changes_disabled' });

      if (route === 'GET /changes') return json(res, 200, { changes: executor.list(Math.min(200, Number(url.searchParams.get('limit')) || 50)) });
      if (req.method === 'GET' && url.pathname.startsWith('/changes/')) {
        const change = executor.get(decodeURIComponent(url.pathname.slice('/changes/'.length)));
        return change ? json(res, 200, change) : json(res, 404, { error: 'not_found' });
      }
      if (route === 'GET /journal') {
        const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
        return json(res, 200, { verify: journal.verify(), entries: journal.read().slice(-limit).reverse() });
      }

      if (req.method !== 'POST') return json(res, 404, { error: 'not_found' });
      const body = await readBody(req);

      if (route === 'POST /probe') {
        const answer = await probeRequest(body, { allowRelay: false });
        return json(res, answer.status, answer.payload);
      }

      if (route === 'POST /challenge') {
        if (locked()) return json(res, 429, { error: 'too_many_failed_approvals' });
        if (body.purpose === 'rollback') {
          const change = executor.get(String(body.changeId || ''));
          if (!change) return json(res, 404, { error: 'not_found' });
          const hash = rollbackHash(change.changeId, change.hash);
          return json(res, 200, { hash, purpose: 'rollback', ...gate.issue(hash, 'rollback') });
        }
        const proposal = normalizeProposal(body.proposal);
        const hash = proposalHash(proposal);
        return json(res, 200, { hash, purpose: 'apply', ...classifyProposal(proposal), ...gate.issue(hash, 'apply') });
      }

      if (route === 'POST /apply') {
        if (locked()) return json(res, 429, { error: 'too_many_failed_approvals' });
        const proposal = normalizeProposal(body.proposal);
        const hash = proposalHash(proposal);
        let who;
        try { who = await gate.verify({ nonce: body.nonce, hash, purpose: 'apply', assertion: body.assertion }); } catch (error) { recordFailure(error.message); throw error; }
        return json(res, 200, await executor.apply(proposal, { hash, by: who.label, credentialId: who.credentialId }));
      }

      if (route === 'POST /rollback') {
        if (locked()) return json(res, 429, { error: 'too_many_failed_approvals' });
        const change = executor.get(String(body.changeId || ''));
        if (!change) return json(res, 404, { error: 'not_found' });
        const hash = rollbackHash(change.changeId, change.hash);
        let who;
        try { who = await gate.verify({ nonce: body.nonce, hash, purpose: 'rollback', assertion: body.assertion }); } catch (error) { recordFailure(error.message); throw error; }
        return json(res, 200, await executor.rollback(change.changeId, { force: Boolean(body.force), by: who.label, credentialId: who.credentialId }));
      }

      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      return json(res, error.status || 500, { error: error.status ? error.message : 'broker_error' });
    }
  }

  async function probe(req, res) {
    try {
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, enabled: enabled() });
      if (req.method !== 'POST' || !['/probe', '/propose'].includes(req.url)) return json(res, 404, { error: 'not_found' });
      if (!enabled()) return json(res, 503, { error: 'changes_disabled' });
      const body = await readBody(req);
      if (req.url === '/propose') {
        if (!proposals) return json(res, 501, { error: 'proposals_not_configured' });
        let saved;
        try { saved = proposals.save(body.proposal); } catch (error) { return json(res, error.status || 400, { error: error.message || 'bad_proposal' }); }
        journal.append({ event: 'proposal_received', proposalId: saved.id, tier: saved.tier });
        return json(res, 200, saved);
      }
      const answer = await probeRequest(body, { allowRelay: true });
      return json(res, answer.status, answer.payload);
    } catch (error) {
      return json(res, error.status || 500, { error: error.status ? error.message : 'probe_error' });
    }
  }

  return { control, probe };
}

/* Git can execute programs named in a repository's own config (external diff,
   fsmonitor, pager). The agent controls the checkouts it edits, so a read-only
   probe must not honour any of that. */
const GIT_LOCKDOWN = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never'];

export function defaultRunProbe(argv, timeoutSec) {
  const [cmd, ...rest] = argv;
  let args = rest;
  if (cmd === 'git') {
    let sub = 0;
    while (rest[sub] === '-C') sub += 2;
    const patchy = ['diff', 'log', 'show', 'blame'].includes(rest[sub]);
    args = [...GIT_LOCKDOWN, ...rest.slice(0, sub + 1), ...(patchy ? ['--no-ext-diff', '--no-textconv'] : []), ...rest.slice(sub + 1)];
  }
  return new Promise(resolve => {
    execFile(cmd, args, {
      cwd: '/',
      timeout: timeoutSec * 1000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.platform === 'linux' ? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' : process.env.PATH, LANG: 'C.UTF-8', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', PAGER: 'cat', SYSTEMD_PAGER: '' },
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: `${stdout || ''}${stderr || ''}` });
    });
  });
}

export { isSensitiveRead as sensitiveReadMatcher } from './policy.js';
