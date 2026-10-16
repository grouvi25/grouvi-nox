#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { normalizeProposal, classifyProposal } from '../src/changes/policy.js';

/**
 * How the agent asks for a change. It never applies anything itself.
 *
 *   nox-propose patch   --title T --why W [--project ID] [--post CMD]... [--health-url U | --health-cmd C] [--undo C]
 *   nox-propose file    --title T --why W --path /abs/target --from local-file [--validate C] [--post CMD]...
 *   nox-propose command --title T --why W --script CMD [--cwd DIR] [--timeout SEC] [--undo C] [--post CMD]...
 *
 * Add --node ID to aim at another host in the fleet. For `patch` the diff is
 * produced here from the agent's own checkout, so what the operator reviews is
 * what git says changed, not a description of it.
 */

const AI_STATE = process.env.SENTINEL_AI_STATE_DIR || '/var/lib/sentinel-ai';
const OUT_DIR = process.env.NOX_PROPOSALS_DIR || path.join(AI_STATE, 'proposals');
const MAX_PENDING = 40;
const MAX_AGE_MS = 24 * 3600_000;

function parse(argv) {
  const [kind, ...rest] = argv;
  const opts = { post: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!flag.startsWith('--')) throw new Error(`unexpected argument: ${flag}`);
    const name = flag.slice(2);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    i += 1;
    if (name === 'post') opts.post.push(value); else opts[name] = value;
  }
  return { kind, opts };
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.pager=cat', ...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

function projectFor(opts) {
  let projects = [];
  try { projects = JSON.parse(fs.readFileSync(path.join(AI_STATE, 'context', 'projects.json'), 'utf8')); } catch { /* none */ }
  const cwd = fs.realpathSync(process.cwd());
  const match = projects.find(p => (opts.project && (p.id === opts.project || p.name === opts.project)) || (!opts.project && (cwd === p.workspace || cwd.startsWith(`${p.workspace}${path.sep}`))));
  if (!match) throw new Error(`no matching project; known: ${projects.map(p => p.name).join(', ') || 'none'}. Run from inside a project workspace or pass --project.`);
  return match;
}

function build(kind, opts) {
  const base = {
    schema: 1,
    node: opts.node || 'local',
    scope: opts.project || 'vps',
    kind,
    title: opts.title,
    why: opts.why || '',
    createdAt: Date.now(),
    post: opts.post,
  };
  if (opts.undo) base.undo = opts.undo;
  if (opts['health-url']) base.healthcheck = { url: opts['health-url'], retries: Number(opts['health-retries']) || 10, delaySec: Number(opts['health-delay']) || 3 };
  else if (opts['health-cmd']) base.healthcheck = { script: opts['health-cmd'], retries: Number(opts['health-retries']) || 10, delaySec: Number(opts['health-delay']) || 3 };

  if (kind === 'patch') {
    const project = projectFor(opts);
    git(project.workspace, 'add', '-A');
    const diff = git(project.workspace, 'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv');
    if (!diff.trim()) throw new Error('the workspace has no changes to propose');
    return { ...base, scope: project.id, patch: { projectPath: project.path, base: git(project.workspace, 'rev-parse', 'HEAD').trim(), diff } };
  }
  if (kind === 'file') {
    if (!opts.path || !opts.from) throw new Error('file needs --path and --from');
    return { ...base, file: { path: opts.path, content: fs.readFileSync(opts.from, 'utf8') }, validate: opts.validate };
  }
  if (kind === 'command') {
    if (!opts.script) throw new Error('command needs --script');
    return { ...base, command: { script: opts.script, cwd: opts.cwd || '/', timeoutSec: Number(opts.timeout) || 120 } };
  }
  throw new Error('usage: nox-propose patch|file|command --title T --why W …');
}

function prune() {
  const entries = fs.readdirSync(OUT_DIR).filter(n => n.endsWith('.json')).map(n => ({ n, t: fs.statSync(path.join(OUT_DIR, n)).mtimeMs })).sort((a, b) => a.t - b.t);
  for (const { n, t } of entries) if (Date.now() - t > MAX_AGE_MS) fs.rmSync(path.join(OUT_DIR, n), { force: true });
  const left = fs.readdirSync(OUT_DIR).filter(n => n.endsWith('.json'));
  if (left.length >= MAX_PENDING) throw new Error(`too many pending proposals (${left.length}); wait for the operator to review them`);
}

try {
  const { kind, opts } = parse(process.argv.slice(2));
  if (!opts.title) throw new Error('--title is required');
  fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o750 });
  prune();
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const proposal = normalizeProposal({ ...build(kind, opts), id: `p-${stamp}-${crypto.randomBytes(3).toString('hex')}` });
  const verdict = classifyProposal(proposal);
  fs.writeFileSync(path.join(OUT_DIR, `${proposal.id}.json`), JSON.stringify(proposal, null, 2), { mode: 0o640 });
  console.log(`Proposal ${proposal.id} is waiting for the operator's approval in the dashboard (${verdict.tier}${verdict.reasons.length ? `: ${verdict.reasons.join(', ')}` : ''}).`);
  console.log('You cannot apply it yourself. Tell the operator what it does and why, then stop.');
} catch (error) {
  console.error(`nox-propose: ${error.message}`);
  process.exit(1);
}
