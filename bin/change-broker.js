#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';
import { createJournal } from '../src/changes/journal.js';
import { createExecutor } from '../src/changes/executor.js';
import { createProposalStore } from '../src/changes/proposals.js';
import { createApprovalGate } from '../src/changes/approval.js';
import Database from 'better-sqlite3';
import { createBroker, sensitiveReadMatcher } from '../src/changes/broker.js';
import { createControlClient } from '../src/changes/fleet-link.js';

/**
 * Change broker: the only process that applies agent-proposed changes.
 *
 * Runs as root, because restarting containers and editing configs needs it,
 * and is therefore kept small, off by default and unreachable from anything
 * that handles untrusted input. See docs/CHANGES.md for the threat model.
 */

const changesDir = process.env.CHANGES_DIR || path.join(config.stateDir, 'changes');
const controlSocket = process.env.CHANGES_SOCKET || path.join(config.stateDir, 'changes.sock');
const probeSocket = process.env.CHANGES_PROBE_SOCKET || '/var/lib/sentinel-ai/probe.sock';
const webUser = process.env.SENTINEL_USER || 'vpssentinel';
const agentUser = process.env.SENTINEL_AI_USER || 'sentinel-ai';
const enabledFlag = path.join(changesDir, 'ENABLED');

const uidOf = user => { try { return Number(execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim()); } catch { return null; } };
const gidOf = user => { try { return Number(execFileSync('id', ['-g', user], { encoding: 'utf8' }).trim()); } catch { return null; } };

const enabled = () => fs.existsSync(enabledFlag);

/* A fleet node does not trust its own passkeys for this: it trusts the hub
   operator's, imported by the root user with `noxctl changes import-approvers`. */
function approvers() {
  try { return JSON.parse(fs.readFileSync(path.join(changesDir, 'approvers.json'), 'utf8')); } catch { return null; }
}

function loadCredentials() {
  const imported = approvers();
  if (imported) return imported.credentials || [];
  try { return JSON.parse(fs.readFileSync(path.join(config.stateDir, 'state.json'), 'utf8')).credentials || []; } catch { return []; }
}

const STATUS_LABEL = { applied: 'применено', failed: 'не удалось', auto_rolled_back: 'откачено автоматически', rolled_back: 'откачено' };

async function notify(event) {
  if (!config.telegram.enabled) return;
  let text;
  if (event.type === 'apply') {
    const r = event.record;
    text = `Nox Forge · ${config.hostLabel}\n${r.title}\n${STATUS_LABEL[r.status] || r.status}${r.reason ? ` (${r.reason})` : ''}\nПодтвердил: ${r.by || '—'}${r.tier === 'dangerous' ? `\nОпасное: ${r.reasons.join(', ')}` : ''}\nid ${r.changeId}`;
  } else if (event.type === 'rollback') {
    text = `Nox Forge · ${config.hostLabel}\nОткат: ${event.record.title}\n${event.ok ? 'выполнен' : `не удался (${event.reason})`}\nid ${event.record.changeId}`;
  } else if (event.type === 'approval_rejected') {
    text = `Nox Forge · ${config.hostLabel}\nОтклонена подпись подтверждения: ${event.reason}. Если это были не вы, проверьте доступ к дашборду.`;
  } else return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegram.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* the journal is the record; Telegram is the out-of-band copy */ }
}

/* The agent may look at other servers of the fleet. Only reads travel this way,
   and the node applies its own probe filter again on arrival. */
function lookupNode(nodeId) {
  const secret = [config.fleet.nodes[nodeId]].flat().find(s => typeof s === 'string' && s.length >= 32);
  let url = null;
  try {
    const db = new Database(path.join(config.stateDir, 'sentinel.db'), { readonly: true, fileMustExist: true });
    try { url = db.prepare('SELECT public_url FROM fleet_nodes WHERE node_id = ?').get(nodeId)?.public_url || null; } finally { db.close(); }
  } catch { /* hub database unavailable */ }
  return url && secret ? { url, secret } : null;
}
const fleetClient = createControlClient({ lookup: lookupNode, hubId: config.fleet.nodeId || 'hub' });
const relayProbe = (node, { argv, timeoutSec }) => fleetClient.call(node, 'POST', '/v1/probe', { argv, timeoutSec }, { timeoutMs: (timeoutSec + 10) * 1000 });

const journal = createJournal(path.join(changesDir, 'journal.jsonl'));
const executor = createExecutor({ changesDir, journal, notify });
const gate = createApprovalGate({ loadCredentials, rpID: () => approvers()?.rpID || config.rpID, origin: () => approvers()?.origin || config.origin });
const proposals = createProposalStore({ dir: path.join(changesDir, 'proposals'), chownGid: gidOf(webUser) });
const broker = createBroker({ enabled, gate, executor, journal, notify, sensitiveRead: sensitiveReadMatcher, hostLabel: config.hostLabel, relayProbe, proposals });

function listen(handler, socketPath, owner, group) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try { fs.unlinkSync(socketPath); } catch { /* not there */ }
  const server = http.createServer(handler);
  server.requestTimeout = 0;
  server.headersTimeout = 20_000;
  server.listen(socketPath, () => {
    // 0600 and the owning account only: group membership must not be enough,
    // because the agent shares a group with the web service.
    if (Number.isInteger(owner)) fs.chownSync(socketPath, owner, Number.isInteger(group) ? group : 0);
    fs.chmodSync(socketPath, 0o600);
    console.log(`[change-broker] ${socketPath}`);
  });
  return server;
}

fs.mkdirSync(changesDir, { recursive: true, mode: 0o750 });
const webGid = gidOf(webUser);
if (Number.isInteger(webGid)) { try { fs.chownSync(changesDir, 0, webGid); fs.chmodSync(changesDir, 0o750); } catch { /* best effort */ } }

const servers = [listen(broker.control, controlSocket, uidOf(webUser), gidOf(webUser))];
if (uidOf(agentUser) !== null && fs.existsSync(path.dirname(probeSocket))) servers.push(listen(broker.probe, probeSocket, uidOf(agentUser), gidOf(agentUser)));
console.log(`[change-broker] ${enabled() ? 'ENABLED' : 'disabled (create ENABLED via noxctl changes enable)'}; journal ${JSON.stringify(journal.verify())}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { for (const s of servers) s.close(); setTimeout(() => process.exit(0), 500).unref(); });
}
