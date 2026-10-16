import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only record of everything the change broker did.
 *
 * Every line carries the hash of the previous one, so removing or editing a
 * line in the middle breaks the chain from that point on and verify() says
 * where. It cannot stop a root attacker from truncating the tail, which is why
 * each entry is also pushed to Telegram: that copy lives somewhere the host
 * cannot rewrite.
 */

const GENESIS = '0'.repeat(64);

function lineHash(prev, entry) {
  return crypto.createHash('sha256').update(prev).update('\n').update(JSON.stringify(entry)).digest('hex');
}

export function createJournal(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });

  function read() {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const rows = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { rows.push({ corrupt: line.slice(0, 80) }); }
    }
    return rows;
  }

  function append(entry) {
    for (const key of ['seq', 'ts', 'prev', 'hash']) if (key in entry) throw new Error(`journal_reserved_key_${key}`);
    const rows = read();
    const last = rows.at(-1);
    const prev = last?.hash || GENESIS;
    const body = { seq: (last?.seq || 0) + 1, ts: Date.now(), ...entry };
    const row = { ...body, prev, hash: lineHash(prev, body) };
    const fd = fs.openSync(file, 'a', 0o640);
    try { fs.writeSync(fd, `${JSON.stringify(row)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return row;
  }

  function verify() {
    let prev = GENESIS;
    let expected = 1;
    for (const row of read()) {
      if (row.corrupt) return { ok: false, brokenAt: expected, reason: 'unreadable_line' };
      const { prev: rowPrev, hash, ...body } = row;
      if (rowPrev !== prev || hash !== lineHash(prev, body) || row.seq !== expected) return { ok: false, brokenAt: row.seq ?? expected, reason: 'chain_mismatch' };
      prev = hash;
      expected += 1;
    }
    return { ok: true, entries: expected - 1, head: prev };
  }

  return { append, read, verify, file };
}
