/**
 * Which models Nox Forge may use, in what order, and how to tell a working one.
 *
 * The list is plain configuration, not something baked into the code: a gateway
 * renames and retires models, and a hardcoded fallback that stops existing
 * turns every primary hiccup into a confusing error about the fallback.
 */

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,159}$/;
export const MAX_MODELS = 8;

export function parseModelList(value) {
  const seen = new Set();
  const out = [];
  for (const raw of String(value || '').split(',')) {
    const id = raw.trim();
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, MAX_MODELS);
}

/** SENTINEL_AI_MODELS wins; otherwise the older primary + fallback pair keeps working. */
export function configuredModels(env = process.env) {
  const list = parseModelList(env.SENTINEL_AI_MODELS);
  if (list.length) return list;
  return parseModelList([env.SENTINEL_AI_MODEL, env.SENTINEL_AI_FALLBACK_MODEL].filter(Boolean).join(','));
}

/**
 * The agent runtime prints some provider failures as its answer and still exits
 * cleanly. Treating that as an answer stops the next model from being tried.
 */
export function looksLikeApiFailure(text) {
  const head = String(text || '').trim().slice(0, 400);
  if (!head) return true;
  return /^(?:API call failed|Error calling|Request failed|Provider error|Rate limit)/i.test(head)
    || /^(?:Error|Failed)[: ].{0,200}\bHTTP (?:4\d\d|5\d\d)\b/i.test(head)
    || /^HTTP (?:429|5\d\d)\b/.test(head);
}

/** Models that cannot hold a tool-using chat: images, embeddings, speech, vision-only. */
const NOT_CHAT = /(?:image|embed|rerank|tts|whisper|speech|audio|video|vision|-vl\b|vl-|flux|dall|sdxl|moderation|ocr|asr|omni)/i;
export const isChatCandidate = id => MODEL_ID.test(String(id)) && !NOT_CHAT.test(String(id));

/**
 * @param {{id:string, ok:number, runs:number, medianMs:number|null, free?:boolean}[]} results
 * Reliable first, then fast. Free models only lead when asked to, because "free"
 * models are the ones that vanish for a minute at a time.
 */
export function rankModels(results, { preferFree = false, minSuccess = 1 } = {}) {
  return results
    .filter(r => r.runs > 0 && r.ok / r.runs >= minSuccess)
    .sort((a, b) => {
      if (preferFree && Boolean(a.free) !== Boolean(b.free)) return a.free ? -1 : 1;
      if (a.ok !== b.ok) return b.ok - a.ok;
      return (a.medianMs ?? Infinity) - (b.medianMs ?? Infinity);
    });
}

export const looksFree = id => /(?:^|[-_.])free(?:$|[-_.])/i.test(String(id));
