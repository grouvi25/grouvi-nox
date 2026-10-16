#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { configuredModels, isChatCandidate, looksFree, rankModels, MAX_MODELS } from '../src/ai-models.js';

/**
 * Asks the gateway which models it offers, tries each one with a real
 * tool-calling request, and (with --apply) writes the working ones, best first.
 *
 *   noxctl ai-models                 report only
 *   noxctl ai-models --apply         write SENTINEL_AI_MODELS and restart the bridge
 *   noxctl ai-models --models a,b    test only these
 *   noxctl ai-models --prefer-free   let free models lead the list
 *   noxctl ai-models --keep N        how many to keep (default 3)
 */

const AI_ENV = process.env.SENTINEL_AI_ENV || '/etc/sentinel-ai.env';
const HERMES_CONFIG = process.env.SENTINEL_AI_HERMES_CONFIG || '/var/lib/sentinel-ai/.hermes/config.yaml';
const RUNS = 3;

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const readEnv = file => Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const env = readEnv(AI_ENV);
const key = env.SENTINEL_AI_API_KEY || env.HCNSEC_API_KEY;
if (!key) { console.error('No AI key configured (Settings, or noxctl configure ai).'); process.exit(1); }

const config = fs.readFileSync(HERMES_CONFIG, 'utf8');
const base = (/^\s+base_url:\s*(\S+)/m.exec(config)?.[1] || '').replace(/\/$/, '');
if (!/^https:\/\//.test(base)) { console.error('Gateway base_url not found in the Hermes configuration.'); process.exit(1); }

async function listModels() {
  const response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`gateway answered ${response.status} to /models`);
  return ((await response.json()).data || []).map(m => m.id);
}

async function probe(model) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Check disk usage. Use the tool run_probe with argv ["df","-h"].' }],
        tools: [{ type: 'function', function: { name: 'run_probe', description: 'run a read-only command', parameters: { type: 'object', properties: { argv: { type: 'array', items: { type: 'string' } } }, required: ['argv'] } } }],
        tool_choice: 'auto',
        max_tokens: 80,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const data = await response.json().catch(() => ({}));
    const call = data.choices?.[0]?.message?.tool_calls?.[0];
    let good = false;
    try { good = Array.isArray(JSON.parse(call?.function?.arguments || '{}').argv); } catch { /* malformed arguments */ }
    return { ok: response.ok && good, ms: Date.now() - started, status: response.status };
  } catch {
    return { ok: false, ms: Date.now() - started, status: 0 };
  }
}

async function test(model) {
  const runs = [];
  for (let i = 0; i < RUNS; i += 1) runs.push(await probe(model));
  const times = runs.filter(r => r.ok).map(r => r.ms).sort((a, b) => a - b);
  return { id: model, runs: RUNS, ok: runs.filter(r => r.ok).length, medianMs: times.length ? times[Math.floor(times.length / 2)] : null, free: looksFree(model), status: [...new Set(runs.map(r => r.status))].join(',') };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next; next += 1; out[i] = await fn(items[i]); }
  }));
  return out;
}

const requested = value('models');
const candidates = requested ? requested.split(',').map(s => s.trim()).filter(Boolean) : (await listModels()).filter(isChatCandidate);
console.log(`Gateway ${base}: testing ${candidates.length} model(s), ${RUNS} tool-calling requests each…`);
const results = await pool(candidates, 3, test);

const width = Math.max(...results.map(r => r.id.length), 8);
for (const r of results.sort((a, b) => b.ok - a.ok || (a.medianMs ?? 1e9) - (b.medianMs ?? 1e9))) {
  console.log(`  ${r.id.padEnd(width)}  ${r.ok}/${r.runs}  ${r.medianMs ? `${(r.medianMs / 1000).toFixed(1)}s`.padStart(5) : '    -'}  ${r.ok === r.runs ? 'works' : r.ok ? 'flaky' : `unavailable (${r.status})`}${r.free ? '  free' : ''}`);
}

const keep = Math.min(MAX_MODELS, Math.max(1, Number(value('keep')) || 3));
const ranked = rankModels(results, { preferFree: flag('prefer-free'), minSuccess: 1 }).slice(0, keep).map(r => r.id);
const current = configuredModels(env);
console.log(`\nCurrent order:  ${current.join(', ') || '(none)'}`);
console.log(`Best working:   ${ranked.join(', ') || '(none)'}`);

if (!ranked.length) { console.error('No model passed every request; nothing to apply.'); process.exit(2); }
if (!flag('apply')) { console.log('\nRun again with --apply to use this order.'); process.exit(0); }

const lines = fs.readFileSync(AI_ENV, 'utf8').split(/\r?\n/).filter(l => l && !/^SENTINEL_AI_(?:MODELS|MODEL|FALLBACK_MODEL)=/.test(l));
lines.push(`SENTINEL_AI_MODELS=${ranked.join(',')}`, `SENTINEL_AI_MODEL=${ranked[0]}`);
if (ranked[1]) lines.push(`SENTINEL_AI_FALLBACK_MODEL=${ranked[1]}`);
fs.copyFileSync(AI_ENV, `${AI_ENV}.bak`);
fs.writeFileSync(AI_ENV, `${lines.join('\n')}\n`, { mode: 0o600 });

const updated = config.replace(/(^model:\n(?:^[ \t].*\n)*?[ \t]+default:\s*).+$/m, `$1${ranked[0]}`).replace(/(^ {4}default_model:\s*).+$/m, `$1${ranked[0]}`);
if (updated !== config) fs.writeFileSync(HERMES_CONFIG, updated);
try { execFileSync('systemctl', ['restart', 'sentinel-ai-bridge'], { timeout: 20_000 }); console.log(`Applied: ${ranked.join(', ')} (previous settings saved to ${AI_ENV}.bak). Bridge restarted.`); } catch { console.log(`Applied: ${ranked.join(', ')}. Restart the bridge: systemctl restart sentinel-ai-bridge`); }
