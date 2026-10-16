import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeProposal, classifyProposal } from './policy.js';

/**
 * Where proposals live between the agent and the operator.
 *
 * The agent hands a proposal to the broker over its own socket; the broker
 * validates it and writes it here, in a directory only root can write and the
 * dashboard can read. The agent never writes into anything the dashboard
 * trusts, and the file the operator reviews is the file the broker checked.
 */

const MAX_PENDING = 40;
const MAX_AGE_MS = 24 * 3600_000;

export function createProposalStore({ dir, now = Date.now, chownGid = null }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  if (Number.isInteger(chownGid)) { try { fs.chownSync(dir, 0, chownGid); } catch { /* best effort */ } }

  const names = () => { try { return fs.readdirSync(dir).filter(n => /^p-[0-9]{14}-[0-9a-f]{6}\.json$/.test(n)); } catch { return []; } };

  function prune() {
    for (const name of names()) {
      try { if (now() - fs.statSync(path.join(dir, name)).mtimeMs > MAX_AGE_MS) fs.rmSync(path.join(dir, name), { force: true }); } catch { /* gone */ }
    }
  }

  /** The id is assigned here: a proposal cannot choose, or overwrite, another's. */
  function save(input) {
    prune();
    if (names().length >= MAX_PENDING) throw Object.assign(new Error('too_many_pending_proposals'), { status: 429 });
    const stamp = new Date(now()).toISOString().replace(/\D/g, '').slice(0, 14);
    const id = `p-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    const proposal = normalizeProposal({ ...input, id, createdAt: now() });
    const file = path.join(dir, `${id}.json`);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(proposal, null, 2), { mode: 0o640 });
    if (Number.isInteger(chownGid)) { try { fs.chownSync(temp, 0, chownGid); } catch { /* best effort */ } }
    fs.renameSync(temp, file);
    return { id, ...classifyProposal(proposal) };
  }

  return { save, prune, count: () => names().length, dir };
}
