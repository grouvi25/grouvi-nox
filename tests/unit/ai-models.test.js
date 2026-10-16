import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { configuredModels, parseModelList, looksLikeApiFailure, isChatCandidate, rankModels, looksFree } from '../../src/ai-models.js';

test('the model list is ordered configuration, validated and de-duplicated', () => {
  assert.deepEqual(parseModelList('glm-5.3, kimi-k2.6 ,glm-5.3,,bad name,x'), ['glm-5.3', 'kimi-k2.6']);
  assert.deepEqual(parseModelList('a/b:c-1.2,;rm -rf'), ['a/b:c-1.2']);
  assert.equal(parseModelList(Array.from({ length: 20 }, (_, i) => `model-${i}`).join(',')).length, 8);
  assert.deepEqual(configuredModels({ SENTINEL_AI_MODELS: 'glm-5.3,kimi-k2.6', SENTINEL_AI_MODEL: 'old' }), ['glm-5.3', 'kimi-k2.6'], 'the list wins over the old pair');
  assert.deepEqual(configuredModels({ SENTINEL_AI_MODEL: 'a-model', SENTINEL_AI_FALLBACK_MODEL: 'b-model' }), ['a-model', 'b-model'], 'older installs keep working');
  assert.deepEqual(configuredModels({}), [], 'nothing is invented when nothing is configured');
});

test('a provider failure printed as an answer is recognised so the next model is tried', () => {
  assert.equal(looksLikeApiFailure('API call failed after 3 retries: HTTP 503: Нет доступного канала для модели X'), true);
  assert.equal(looksLikeApiFailure('Error: upstream said HTTP 429 too many requests'), true);
  assert.equal(looksLikeApiFailure('HTTP 502 bad gateway'), true);
  assert.equal(looksLikeApiFailure('   '), true);
  assert.equal(looksLikeApiFailure('На hub больше всего памяти у gh_api — 116 МиБ.'), false);
  assert.equal(looksLikeApiFailure('Сертификат истёк. Ошибка в логах nginx: HTTP 502 от upstream встречается редко.'), false, 'a real answer that mentions an error is still an answer');
});

test('only models that can hold a tool-using chat are candidates, and ranking prefers reliable then fast', () => {
  for (const id of ['glm-5.3', 'kimi-k2.6', 'mimo-v2.5-free', 'deepseek-v4-pro']) assert.equal(isChatCandidate(id), true, id);
  for (const id of ['qwen-image', 'text-embedding-3', 'whisper-1', 'qwen3.5-omni-plus', 'glm-4.6v-flash-vl', 'bad name']) assert.equal(isChatCandidate(id), false, id);
  const results = [
    { id: 'slow', ok: 3, runs: 3, medianMs: 4000 },
    { id: 'fast', ok: 3, runs: 3, medianMs: 1000 },
    { id: 'flaky', ok: 2, runs: 3, medianMs: 500 },
    { id: 'dead', ok: 0, runs: 3, medianMs: null },
    { id: 'free-ok', ok: 3, runs: 3, medianMs: 3000, free: true },
  ];
  assert.deepEqual(rankModels(results).map(r => r.id), ['fast', 'free-ok', 'slow'], 'flaky and dead models are not offered');
  assert.deepEqual(rankModels(results, { preferFree: true }).map(r => r.id), ['free-ok', 'fast', 'slow']);
  assert.deepEqual(rankModels(results, { minSuccess: 0.6 }).map(r => r.id), ['fast', 'free-ok', 'slow', 'flaky']);
  assert.equal(looksFree('mimo-v2.5-free'), true);
  assert.equal(looksFree('freedom-1'), false);
});

test('the bridge tries every configured model and says what each one answered', () => {
  const bridge = fs.readFileSync('deploy/forge/server.mjs', 'utf8');
  assert.match(bridge, /configuredModels\(process\.env\)/, 'the model order comes from configuration');
  assert.match(bridge, /looksLikeApiFailure\(text\)/, 'a printed provider error is not accepted as an answer');
  assert.match(bridge, /all_models_failed/, 'the failure names every model that was tried, not only the last');
  assert.doesNotMatch(bridge, /DeepSeek-V4-Pro|Qwen3\.6/, 'no model name is baked into the bridge');
});
