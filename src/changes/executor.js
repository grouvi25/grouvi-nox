import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { classifyProposal, normalizeProposal, proposalHash } from './policy.js';
import { readRegularFile } from './fsutil.js';

/**
 * Applies an already-approved proposal and can undo it.
 *
 * Authorisation is not decided here. The broker verifies the operator's
 * passkey signature over the proposal hash before this module is called, so
 * everything below can assume "a human looked at exactly this".
 */

const OUTPUT_CAP = 256 * 1024;
const STEP_LOG_CAP = 20 * 1024;
const LINUX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const tail = (text, max = STEP_LOG_CAP) => (text.length > max ? `…${text.slice(-max)}` : text);

function shellBinary() {
  if (process.env.NOX_SHELL) return process.env.NOX_SHELL;
  return fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
}

export function runScript(script, { cwd = '/', timeoutSec = 120, env = {} } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let out = '';
    let timedOut = false;
    const child = spawn(shellBinary(), ['-c', script], {
      cwd,
      env: { PATH: process.platform === 'linux' ? LINUX_PATH : process.env.PATH, HOME: process.platform === 'linux' ? '/root' : process.env.HOME, LANG: 'C.UTF-8', ...env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = chunk => { out = (out + chunk).slice(-OUTPUT_CAP); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, timeoutSec * 1000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: 127, signal: null, timedOut, out: `${out}${error.message}`, ms: Date.now() - started }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? 1, signal, timedOut, out, ms: Date.now() - started }); });
  });
}

export function runGit(args, { cwd, input } = {}) {
  return new Promise(resolve => {
    const child = execFile('git', ['-c', 'safe.directory=*', ...args], { cwd, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: stdout || '', err: stderr || (error && !stdout ? error.message : '') });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function ownerOf(target) {
  try { const s = fs.statSync(target); return { uid: s.uid, gid: s.gid }; } catch { return null; }
}

function chownTo(target, owner) {
  if (!owner || process.platform === 'win32' || process.getuid?.() !== 0) return;
  try { fs.lchownSync(target, owner.uid, owner.gid); } catch { /* best effort */ }
}

function insideRealRoot(root, candidate) {
  let probe = candidate;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  return real === root || real.startsWith(root + path.sep);
}

export function createExecutor({ changesDir, journal, notify = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), healthFetch = fetch }) {
  fs.mkdirSync(changesDir, { recursive: true, mode: 0o750 });
  let busy = null;
  const KEEP = 300;

  /* A broker that died mid-change leaves a record that says "running" forever.
     Say what is actually known: it was interrupted, and the state is unverified. */
  function recoverInterrupted() {
    let names = [];
    try { names = fs.readdirSync(changesDir).filter(n => /^[0-9A-Za-z-]{10,80}$/.test(n)); } catch { return; }
    for (const name of names) {
      let record;
      try { record = JSON.parse(fs.readFileSync(path.join(changesDir, name, 'result.json'), 'utf8')); } catch { continue; }
      if (record.status !== 'running') continue;
      record.status = 'interrupted';
      record.reason = 'broker_stopped_mid_change';
      record.finishedAt = Date.now();
      fs.writeFileSync(path.join(changesDir, name, 'result.json'), JSON.stringify(record, null, 2), { mode: 0o640 });
      journal.append({ event: 'apply_interrupted', changeId: name });
      notify({ type: 'apply', record });
    }
  }

  /* Snapshots are full copies of whatever was edited; keep the recent ones. */
  function prune() {
    try {
      const names = fs.readdirSync(changesDir).filter(n => /^[0-9A-Za-z-]{10,80}$/.test(n)).sort();
      for (const name of names.slice(0, Math.max(0, names.length - KEEP))) fs.rmSync(path.join(changesDir, name), { recursive: true, force: true });
    } catch { /* best effort */ }
  }
  recoverInterrupted();

  const recordFile = id => path.join(changesDir, id, 'result.json');
  const readRecord = id => { try { return JSON.parse(fs.readFileSync(recordFile(id), 'utf8')); } catch { return null; } };
  const writeRecord = record => {
    fs.mkdirSync(path.join(changesDir, record.changeId), { recursive: true, mode: 0o750 });
    fs.writeFileSync(recordFile(record.changeId), JSON.stringify(record, null, 2), { mode: 0o640 });
  };

  async function exclusive(label, fn) {
    if (busy) throw Object.assign(new Error('busy'), { status: 409, detail: busy });
    busy = label;
    try { return await fn(); } finally { busy = null; }
  }

  function stepLogger(record) {
    return (name, result, extra = {}) => {
      record.steps.push({ name, code: result?.code ?? 0, ms: result?.ms ?? 0, timedOut: Boolean(result?.timedOut), out: tail(String(result?.out ?? result?.err ?? '')), ...extra });
    };
  }

  async function runSteps(scripts, label, cwd, log, timeoutSec = 300) {
    for (const [index, script] of scripts.entries()) {
      const result = await runScript(script, { cwd, timeoutSec });
      log(`${label} ${index + 1}`, result, { script });
      if (result.code !== 0) return false;
    }
    return true;
  }

  async function checkHealth(health, cwd, log) {
    if (!health) return true;
    for (let attempt = 1; attempt <= health.retries; attempt += 1) {
      await sleep(health.delaySec * 1000);
      if (health.url) {
        try {
          const response = await healthFetch(health.url, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
          const ok = health.expectStatus ? response.status === health.expectStatus : response.status >= 200 && response.status < 400;
          if (ok) { log('healthcheck', { code: 0, out: `${health.url} → ${response.status} (attempt ${attempt})`, ms: 0 }); return true; }
        } catch { /* retry */ }
      } else {
        const result = await runScript(health.script, { cwd, timeoutSec: 30 });
        if (result.code === 0) { log('healthcheck', { ...result, out: `ok on attempt ${attempt}\n${result.out}` }); return true; }
      }
    }
    log('healthcheck', { code: 1, out: `unhealthy after ${health.retries} attempts`, ms: 0 });
    return false;
  }

  /* ----------------------------- patch ----------------------------- */

  async function patchApply(p, record, log) {
    const root = fs.realpathSync(p.patch.projectPath);
    if (!fs.statSync(root).isDirectory()) throw Object.assign(new Error('project_missing'), { status: 400 });
    for (const file of p.patch.files) {
      const abs = path.join(root, file);
      if (!insideRealRoot(root, abs)) throw Object.assign(new Error('patch_path_escapes_project'), { status: 400 });
      try { if (fs.lstatSync(abs).isSymbolicLink()) throw Object.assign(new Error('patch_through_symlink'), { status: 400 }); } catch (error) { if (error.status) throw error; }
    }
    const head = await runGit(['rev-parse', 'HEAD'], { cwd: root });
    record.head = head.code === 0 ? head.out.trim() : null;
    record.baseMatches = Boolean(record.head && p.patch.base && record.head.startsWith(p.patch.base));
    const check = await runGit(['apply', '--check', '--whitespace=nowarn', '-'], { cwd: root, input: p.patch.diff });
    log('git apply --check', check);
    if (check.code !== 0) return { ok: false, reason: 'does_not_apply' };

    const backup = path.join(changesDir, record.changeId, 'before');
    const known = [];
    for (const file of p.patch.files) {
      const abs = path.join(root, file);
      const content = readRegularFile(abs);
      if (content) {
        fs.mkdirSync(path.dirname(path.join(backup, file)), { recursive: true });
        fs.writeFileSync(path.join(backup, file), content, { mode: 0o600 });
        known.push(file);
      }
    }
    const applied = await runGit(['apply', '--whitespace=nowarn', '-'], { cwd: root, input: p.patch.diff });
    log('git apply', applied);
    if (applied.code !== 0) return { ok: false, reason: 'apply_failed' };

    const owner = ownerOf(root);
    const after = {};
    for (const file of p.patch.files) {
      const abs = path.join(root, file);
      const content = readRegularFile(abs);
      if (content) chownTo(abs, owner);
      after[file] = content ? sha256(content) : null;
    }
    record.rollbackData = { root, backedUp: known, after };
    return { ok: true, cwd: root };
  }

  async function patchRevert(record, { force }, log) {
    const { root, backedUp, after } = record.rollbackData;
    const diff = fs.readFileSync(path.join(changesDir, record.changeId, 'proposal.json'), 'utf8');
    const proposal = JSON.parse(diff);
    const drifted = Object.entries(after).filter(([file, hash]) => {
      const abs = path.join(root, file);
      const content = readRegularFile(abs);
      return (content ? sha256(content) : null) !== hash;
    }).map(([file]) => file);
    if (drifted.length && !force) return { ok: false, reason: 'files_changed_since_apply', files: drifted };
    const reverse = await runGit(['apply', '-R', '--whitespace=nowarn', '-'], { cwd: root, input: proposal.patch.diff });
    log('git apply -R', reverse);
    if (reverse.code === 0) return { ok: true, cwd: root };
    if (!force) return { ok: false, reason: 'reverse_patch_conflict' };
    const backup = path.join(changesDir, record.changeId, 'before');
    for (const file of proposal.patch.files) {
      const abs = path.join(root, file);
      if (backedUp.includes(file)) fs.copyFileSync(path.join(backup, file), abs); else fs.rmSync(abs, { force: true });
    }
    log('restore from snapshot', { code: 0, out: `${backedUp.length} file(s) restored, newly created files removed`, ms: 0 });
    return { ok: true, cwd: root };
  }

  /* ------------------------------ file ----------------------------- */

  async function fileApply(p, record, log) {
    let target = p.file.path;
    let existed = false;
    let mode = 0o644;
    let owner = null;
    try {
      const real = fs.realpathSync(target);
      const stat = fs.statSync(real);
      if (!stat.isFile()) throw Object.assign(new Error('target_not_a_file'), { status: 400 });
      target = real; existed = true; mode = stat.mode & 0o7777; owner = { uid: stat.uid, gid: stat.gid };
    } catch (error) {
      if (error.status) throw error;
      if (!fs.existsSync(path.dirname(target))) throw Object.assign(new Error('parent_directory_missing'), { status: 400 });
      owner = ownerOf(path.dirname(target));
    }
    const backupPath = path.join(changesDir, record.changeId, 'before', 'file');
    if (existed) { fs.mkdirSync(path.dirname(backupPath), { recursive: true }); fs.copyFileSync(target, backupPath); }
    const before = existed ? sha256(fs.readFileSync(target)) : null;
    const temp = path.join(path.dirname(target), `.nox-${record.changeId.slice(-8)}.tmp`);
    fs.writeFileSync(temp, p.file.content, { mode });
    fs.chmodSync(temp, mode);
    chownTo(temp, owner);
    fs.renameSync(temp, target);
    record.rollbackData = { target, existed, before, after: sha256(Buffer.from(p.file.content)) };
    log('write file', { code: 0, out: `${target} (${Buffer.byteLength(p.file.content)} bytes, ${existed ? 'replaced' : 'created'})`, ms: 0 });
    if (p.validate) {
      const result = await runScript(p.validate, { cwd: '/', timeoutSec: 60 });
      log('validate', result, { script: p.validate });
      if (result.code !== 0) { fileRestore(record); log('restore after failed validation', { code: 0, out: 'previous content restored', ms: 0 }); return { ok: false, reason: 'validation_failed' }; }
    }
    return { ok: true, cwd: '/' };
  }

  function fileRestore(record) {
    const { target, existed } = record.rollbackData;
    if (existed) {
      const backup = path.join(changesDir, record.changeId, 'before', 'file');
      const temp = `${target}.nox-restore`;
      fs.copyFileSync(backup, temp);
      const stat = fs.statSync(target);
      fs.chmodSync(temp, stat.mode & 0o7777);
      chownTo(temp, { uid: stat.uid, gid: stat.gid });
      fs.renameSync(temp, target);
    } else fs.rmSync(target, { force: true });
  }

  async function fileRevert(record, { force }, log) {
    const { target, after } = record.rollbackData;
    const content = readRegularFile(target);
    const current = content ? sha256(content) : null;
    if (current !== after && !force) return { ok: false, reason: 'files_changed_since_apply', files: [target] };
    fileRestore(record);
    log('restore file', { code: 0, out: target, ms: 0 });
    return { ok: true, cwd: '/' };
  }

  /* ----------------------------- command --------------------------- */

  async function commandApply(p, record, log) {
    const result = await runScript(p.command.script, { cwd: p.command.cwd, timeoutSec: p.command.timeoutSec });
    log('command', result, { script: p.command.script });
    record.rollbackData = { undo: p.undo || null };
    return result.code === 0 ? { ok: true, cwd: p.command.cwd } : { ok: false, reason: result.timedOut ? 'command_timed_out' : 'command_failed' };
  }

  async function commandRevert(record, p, log) {
    if (!p.undo) return { ok: false, reason: 'no_undo_defined' };
    const result = await runScript(p.undo, { cwd: p.command?.cwd || '/', timeoutSec: p.command?.timeoutSec || 120 });
    log('undo', result, { script: p.undo });
    return result.code === 0 ? { ok: true, cwd: p.command?.cwd || '/' } : { ok: false, reason: 'undo_failed' };
  }

  /* ----------------------------- public ---------------------------- */

  async function apply(input, approval) {
    const proposal = normalizeProposal(input);
    const hash = proposalHash(proposal);
    if (approval?.hash !== hash) throw Object.assign(new Error('hash_mismatch'), { status: 400 });
    const verdict = classifyProposal(proposal);
    return exclusive(`apply ${proposal.id}`, async () => {
      const changeId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${hash.slice(0, 8)}`;
      const record = {
        changeId, proposalId: proposal.id, hash, node: proposal.node, kind: proposal.kind, title: proposal.title,
        tier: verdict.tier, reasons: verdict.reasons, by: approval.by || null, credentialId: approval.credentialId || null,
        status: 'running', startedAt: Date.now(), finishedAt: null, steps: [], rollbackData: null,
      };
      fs.mkdirSync(path.join(changesDir, changeId), { recursive: true, mode: 0o750 });
      fs.writeFileSync(path.join(changesDir, changeId, 'proposal.json'), JSON.stringify(proposal, null, 2), { mode: 0o640 });
      writeRecord(record);
      journal.append({ event: 'apply_start', changeId, proposalId: proposal.id, proposalHash: hash, node: proposal.node, kind: proposal.kind, tier: verdict.tier, reasons: verdict.reasons, by: record.by, credentialId: record.credentialId, title: proposal.title });
      const log = stepLogger(record);
      let outcome;
      try {
        const stage = proposal.kind === 'patch' ? await patchApply(proposal, record, log) : proposal.kind === 'file' ? await fileApply(proposal, record, log) : await commandApply(proposal, record, log);
        outcome = stage;
        if (stage.ok) {
          const posted = await runSteps(proposal.post, 'post', stage.cwd, log);
          const healthy = posted ? await checkHealth(proposal.healthcheck, stage.cwd, log) : false;
          if (!posted || !healthy) {
            const undone = await revert(record, proposal, { force: true, silent: true }, log);
            outcome = { ok: false, reason: posted ? 'unhealthy' : 'post_failed', autoRolledBack: undone.ok };
          }
        }
        record.status = outcome.ok ? 'applied' : outcome.autoRolledBack ? 'auto_rolled_back' : 'failed';
        record.reason = outcome.reason || null;
      } catch (error) {
        record.status = 'failed';
        record.reason = error.message;
        log('error', { code: 1, out: error.message, ms: 0 });
      }
      record.finishedAt = Date.now();
      writeRecord(record);
      journal.append({ event: 'apply_done', changeId, status: record.status, reason: record.reason || null });
      notify({ type: 'apply', record });
      prune();
      return publicRecord(record);
    });
  }

  async function revert(record, proposal, { force = false, silent = false }, log) {
    let stage;
    if (record.kind === 'patch') stage = await patchRevert(record, { force }, log);
    else if (record.kind === 'file') stage = await fileRevert(record, { force }, log);
    else stage = await commandRevert(record, proposal, log);
    if (!stage.ok) return stage;
    const rerun = await runSteps(proposal.post, silent ? 'post (after auto rollback)' : 'post (after rollback)', stage.cwd, log);
    return rerun ? stage : { ...stage, ok: stage.ok, postFailed: true };
  }

  async function rollback(changeId, { force = false, by = null, credentialId = null } = {}) {
    if (!/^[0-9A-Za-z-]{10,80}$/.test(changeId)) throw Object.assign(new Error('bad_change_id'), { status: 400 });
    const record = readRecord(changeId);
    if (!record) throw Object.assign(new Error('not_found'), { status: 404 });
    if (record.status !== 'applied') throw Object.assign(new Error(`cannot_rollback_${record.status}`), { status: 409 });
    return exclusive(`rollback ${changeId}`, async () => {
      const proposal = JSON.parse(fs.readFileSync(path.join(changesDir, changeId, 'proposal.json'), 'utf8'));
      journal.append({ event: 'rollback_start', changeId, by, credentialId, force });
      const log = stepLogger(record);
      let result;
      try { result = await revert(record, proposal, { force }, log); } catch (error) { result = { ok: false, reason: error.message }; log('error', { code: 1, out: error.message, ms: 0 }); }
      if (result.ok) { record.status = 'rolled_back'; record.rolledBackAt = Date.now(); }
      else record.lastRollbackError = { reason: result.reason, files: result.files || [], at: Date.now() };
      writeRecord(record);
      journal.append({ event: 'rollback_done', changeId, ok: result.ok, reason: result.reason || null });
      notify({ type: 'rollback', record, ok: result.ok, reason: result.reason });
      return { ...publicRecord(record), rollbackOk: result.ok, rollbackReason: result.reason || null, files: result.files || [] };
    });
  }

  function publicRecord(record) {
    const { rollbackData, ...rest } = record;
    return { ...rest, canRollback: record.status === 'applied' };
  }

  function list(limit = 50) {
    let names = [];
    try { names = fs.readdirSync(changesDir).filter(n => /^[0-9A-Za-z-]{10,80}$/.test(n)).sort().reverse().slice(0, limit); } catch { /* empty */ }
    return names.map(readRecord).filter(Boolean).map(r => { const { steps, ...rest } = publicRecord(r); return { ...rest, stepCount: steps.length }; });
  }

  function get(changeId) {
    if (!/^[0-9A-Za-z-]{10,80}$/.test(changeId)) return null;
    const record = readRecord(changeId);
    if (!record) return null;
    let proposal = null;
    try { proposal = JSON.parse(fs.readFileSync(path.join(changesDir, changeId, 'proposal.json'), 'utf8')); } catch { /* gone */ }
    return { ...publicRecord(record), proposal };
  }

  return { apply, rollback, list, get, state: () => ({ busy }) };
}
