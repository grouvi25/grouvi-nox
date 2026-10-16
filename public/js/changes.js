import { $, esc as escapeHtml } from './utils.js';
import { authenticate } from '/webauthn.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/* Hidden characters are shown, never rendered: what is on screen is what runs. */
const reveal = value => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, ch => `⟦U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`);
const esc = value => escapeHtml(reveal(value));

const KIND = { patch: 'Правка кода', file: 'Файл', command: 'Команда' };
const STATUS = {
  pending: ['ждёт', 'warn'], applied: ['применено', 'ok'], rolled_back: ['откачено', 'idle'], rejected: ['отклонено', 'idle'],
  failed: ['не удалось', 'crit'], auto_rolled_back: ['откат сам', 'warn'], running: ['идёт', 'info'],
};
const ERRORS = {
  approval_expired: 'Подтверждение истекло. Нажмите ещё раз.',
  approval_invalid: 'Подпись не принята.',
  approval_mismatch: 'Подпись относится к другому изменению.',
  unknown_credential: 'Этот ключ не зарегистрирован.',
  too_many_failed_approvals: 'Слишком много неудачных подтверждений. Подождите 10 минут.',
  changes_disabled: 'Изменения выключены на сервере.',
  broker_unavailable: 'Брокер не запущен.',
  proposal_changed: 'Предложение изменилось. Обновите список.',
  busy: 'Брокер занят другим изменением.',
  node_relay_not_ready: 'Для этого сервера связь ещё не настроена.',
  NotAllowedError: 'Отменено.',
  AbortError: 'Отменено.',
};
const explain = error => ERRORS[error?.name] || ERRORS[error?.message] || `Ошибка: ${error?.message || 'неизвестно'}`;

function when(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

function diffMarkup(diff) {
  return String(diff).split('\n').map(line => {
    const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta'
      : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    return `<span class="d-${cls}">${esc(line) || ' '}</span>`;
  }).join('');
}

function steps(list) {
  if (!list?.length) return '';
  return `<div class="chg-steps">${list.map(s => `<details${s.code ? ' open' : ''}><summary><i class="chg-dot ${s.code ? 'bad' : 'good'}"></i>${esc(s.name)}<small>${s.ms ? `${(s.ms / 1000).toFixed(1)} с` : ''}</small></summary>${s.script ? `<pre class="chg-code">${esc(s.script)}</pre>` : ''}${s.out ? `<pre class="chg-out">${esc(s.out)}</pre>` : ''}</details>`).join('')}</div>`;
}

function proposalBody(p) {
  const rows = [];
  if (p.kind !== 'command' && p.target) rows.push(`<div class="chg-meta"><span class="mono">${esc(p.target)}</span></div>`);
  if (p.why) rows.push(`<div class="chg-why"><small>Описание от агента, не проверено</small><p>${esc(p.why)}</p></div>`);
  if (p.reasons?.length) rows.push(`<ul class="chg-reasons">${p.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`);
  if (p.kind === 'patch') {
    rows.push(`<div class="chg-files">${(p.files || []).map(f => `<code>${esc(f)}</code>`).join('')}<small>+${p.stats?.added ?? 0} −${p.stats?.removed ?? 0}</small></div>`);
    rows.push(p.diff ? `<pre class="chg-diff">${diffMarkup(p.diff)}</pre>` : '<div class="chg-skeleton"></div>');
  } else if (p.kind === 'file') {
    if (p.content === undefined) rows.push('<div class="chg-skeleton"></div>');
    else {
      if (p.current?.readable) rows.push(`<small class="chg-label">Сейчас</small><pre class="chg-code">${esc(p.current.content)}</pre>`);
      else if (p.current?.sensitive) rows.push('<small class="chg-label">Текущее содержимое скрыто</small>');
      else if (p.current?.missing) rows.push('<small class="chg-label">Файл будет создан</small>');
      rows.push(`<small class="chg-label">Станет</small><pre class="chg-code">${esc(p.content)}</pre>`);
    }
  } else {
    rows.push(`<small class="chg-label">Выполнится от root в ${esc(p.target || '/')}</small><pre class="chg-code">${esc(p.script)}</pre>`);
  }
  if (p.validate) rows.push(`<small class="chg-label">Проверка перед сохранением</small><pre class="chg-code">${esc(p.validate)}</pre>`);
  if (p.post?.length) rows.push(`<small class="chg-label">После применения</small><pre class="chg-code">${esc(p.post.join('\n'))}</pre>`);
  if (p.healthcheck) rows.push(`<small class="chg-label">Проверка здоровья, при провале откат</small><pre class="chg-code">${esc(p.healthcheck.url || p.healthcheck.script)}</pre>`);
  if (p.undo) rows.push(`<small class="chg-label">Откат</small><pre class="chg-code">${esc(p.undo)}</pre>`);
  return rows.join('');
}

export function createChangesController({ api, setWorkspacePane }) {
  let tab = 'pending';
  let proposals = [];
  let history = [];
  let status = { available: false, enabled: false };
  let openId = null;
  const details = new Map();
  const results = new Map();
  const busy = new Set();
  let timer = null;

  const post = (url, body) => api(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body || {}) });

  async function pollJob(jobId) {
    for (let i = 0; i < 800; i += 1) {
      await sleep(i < 10 ? 700 : 1500);
      const res = await fetch(`/api/changes/jobs/${encodeURIComponent(jobId)}`, { credentials: 'same-origin' });
      if (res.status === 202) continue;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `http_${res.status}`);
      return data.result;
    }
    throw new Error('timeout');
  }

  function badge() {
    const pending = proposals.filter(p => p.status === 'pending').length;
    const nb = $('nbChanges');
    if (nb) { nb.textContent = String(pending); nb.hidden = !pending; }
    const pill = $('changesPanePill');
    if (pill) { pill.textContent = status.enabled ? (pending ? `${pending} ждут` : 'пусто') : 'выключено'; pill.className = `pill ${status.enabled ? (pending ? 'warn' : 'idle') : 'crit'}`; }
  }

  function card(p) {
    const [label, tone] = STATUS[p.status] || [p.status, 'idle'];
    const open = openId === p.id;
    const actionable = p.status === 'pending';
    const isBusy = busy.has(p.id);
    const result = results.get(p.id);
    return `<article class="chg-card${open ? ' open' : ''}${p.tier === 'dangerous' ? ' danger' : ''}" data-id="${esc(p.id)}">
      <button type="button" class="chg-head" data-toggle="${esc(p.id)}" aria-expanded="${open}">
        <span class="chg-title">${esc(p.title)}</span>
        <span class="chg-tags">${p.tier === 'dangerous' ? '<i class="pill crit">опасное</i>' : ''}<i class="pill ${tone}">${esc(label)}</i></span>
        <small>${esc(KIND[p.kind] || p.kind)} · ${esc(p.node === 'local' ? 'этот сервер' : p.node)} · ${esc(when(p.createdAt))}</small>
      </button>
      ${open ? `<div class="chg-body">${proposalBody({ ...p, ...(details.get(p.id) || {}) })}
        ${result ? `<div class="chg-result ${result.ok ? 'ok' : 'bad'}" role="status">${esc(result.text)}${steps(result.steps)}</div>` : ''}
        ${actionable ? `<footer class="chg-actions"><button type="button" class="drawer-button" data-reject="${esc(p.id)}"${isBusy ? ' disabled' : ''}>Отклонить</button><button type="button" class="drawer-button primary${isBusy ? ' loading' : ''}" data-apply="${esc(p.id)}"${isBusy ? ' disabled' : ''}>${isBusy ? esc(result?.phase || 'Подтвердите ключом') : 'Применить'}</button></footer>` : ''}
      </div>` : ''}
    </article>`;
  }

  function historyCard(c) {
    const [label, tone] = STATUS[c.status] || [c.status, 'idle'];
    const open = openId === c.changeId;
    const isBusy = busy.has(c.changeId);
    const result = results.get(c.changeId);
    const detail = details.get(c.changeId);
    return `<article class="chg-card${open ? ' open' : ''}${c.tier === 'dangerous' ? ' danger' : ''}" data-id="${esc(c.changeId)}">
      <button type="button" class="chg-head" data-toggle="${esc(c.changeId)}" aria-expanded="${open}">
        <span class="chg-title">${esc(c.title)}</span>
        <span class="chg-tags">${c.tier === 'dangerous' ? '<i class="pill crit">опасное</i>' : ''}<i class="pill ${tone}">${esc(label)}</i></span>
        <small>${esc(KIND[c.kind] || c.kind)} · ${esc(c.host === 'local' ? 'этот сервер' : c.host)} · ${esc(when(c.startedAt))} · ${esc(c.by || '')}</small>
      </button>
      ${open ? `<div class="chg-body">
        ${c.reason ? `<div class="chg-result bad">${esc(c.reason)}</div>` : ''}
        ${detail ? steps(detail.steps) : '<div class="chg-skeleton"></div>'}
        ${result ? `<div class="chg-result ${result.ok ? 'ok' : 'bad'}" role="status">${esc(result.text)}</div>` : ''}
        ${c.canRollback ? `<footer class="chg-actions"><button type="button" class="drawer-button${isBusy ? ' loading' : ''}" data-rollback="${esc(c.changeId)}"${isBusy ? ' disabled' : ''}>${isBusy ? 'Подтвердите ключом' : 'Откатить'}</button></footer>` : ''}
      </div>` : ''}
    </article>`;
  }

  function render() {
    badge();
    const list = $('changesList');
    if (!list) return;
    $('changesTabPending').classList.toggle('active', tab === 'pending');
    $('changesTabHistory').classList.toggle('active', tab === 'history');
    $('changesTabPending').setAttribute('aria-selected', String(tab === 'pending'));
    $('changesTabHistory').setAttribute('aria-selected', String(tab === 'history'));
    if (!status.available) { list.innerHTML = '<div class="chg-empty">Брокер изменений не запущен.</div>'; return; }
    if (!status.enabled) { list.innerHTML = '<div class="chg-empty">Выключено. Включение на сервере: <code>noxctl changes enable</code></div>'; return; }
    if (tab === 'pending') {
      const visible = proposals.filter(p => p.status === 'pending' || openId === p.id || results.has(p.id));
      list.innerHTML = visible.length ? visible.map(card).join('') : '<div class="chg-empty">Нет предложений.</div>';
    } else {
      list.innerHTML = history.length ? history.map(historyCard).join('') : '<div class="chg-empty">Изменений ещё не было.</div>';
    }
  }

  async function load() {
    try { status = await api('/api/changes/status'); } catch { status = { available: false, enabled: false }; }
    if (status.available && status.enabled) {
      const [p, h] = await Promise.allSettled([api('/api/changes/proposals'), api('/api/changes/history')]);
      if (p.status === 'fulfilled') proposals = p.value.proposals || [];
      if (h.status === 'fulfilled') history = h.value.changes || [];
    }
    render();
  }

  async function expand(id) {
    openId = openId === id ? null : id;
    render();
    if (!openId || details.has(id)) return;
    try {
      const host = history.find(c => c.changeId === id)?.host || 'local';
      const data = await api(tab === 'pending' ? `/api/changes/proposals/${encodeURIComponent(id)}` : `/api/changes/history/${encodeURIComponent(id)}?host=${encodeURIComponent(host)}`);
      details.set(id, data);
      render();
    } catch { /* the card stays without detail */ }
  }

  async function approveProposal(id) {
    const p = proposals.find(x => x.id === id);
    if (!p || busy.has(id)) return;
    busy.add(id);
    results.set(id, { phase: 'Подтвердите ключом', ok: true, text: '' });
    render();
    try {
      const challenge = await post(`/api/changes/proposals/${encodeURIComponent(id)}/challenge`, { hash: p.hash });
      const assertion = await authenticate(challenge.options);
      results.set(id, { phase: 'Применяю', ok: true, text: '' });
      render();
      const started = await post(`/api/changes/proposals/${encodeURIComponent(id)}/apply`, { hash: p.hash, nonce: challenge.nonce, assertion });
      const outcome = await pollJob(started.jobId);
      const good = outcome.status === 'applied';
      results.set(id, { ok: good, steps: outcome.steps, text: good ? 'Применено.' : outcome.status === 'auto_rolled_back' ? 'Проверка не прошла, изменение откачено автоматически.' : `Не удалось: ${outcome.reason || outcome.status}` });
    } catch (error) {
      results.set(id, { ok: false, text: explain(error) });
    } finally {
      busy.delete(id);
      await load();
    }
  }

  async function rollbackChange(id, force = false) {
    if (busy.has(id)) return;
    busy.add(id);
    render();
    try {
      const host = history.find(c => c.changeId === id)?.host || 'local';
      const challenge = await post(`/api/changes/history/${encodeURIComponent(id)}/challenge`, { host });
      const assertion = await authenticate(challenge.options);
      const started = await post(`/api/changes/history/${encodeURIComponent(id)}/rollback`, { nonce: challenge.nonce, assertion, force, host });
      const outcome = await pollJob(started.jobId);
      results.set(id, outcome.rollbackOk
        ? { ok: true, text: 'Откат выполнен.' }
        : { ok: false, text: outcome.rollbackReason === 'files_changed_since_apply' ? `Файлы менялись после применения: ${(outcome.files || []).join(', ')}. Откат отменён.` : `Откат не удался: ${outcome.rollbackReason}` });
      details.delete(id);
    } catch (error) {
      results.set(id, { ok: false, text: explain(error) });
    } finally {
      busy.delete(id);
      await load();
    }
  }

  async function reject(id) {
    try { await post(`/api/changes/proposals/${encodeURIComponent(id)}/reject`); openId = null; } catch (error) { results.set(id, { ok: false, text: explain(error) }); }
    await load();
  }

  function bind() {
    $('changesOpen').addEventListener('click', open);
    $('changesClose').addEventListener('click', close);
    $('changesTabPending').addEventListener('click', () => { tab = 'pending'; openId = null; render(); });
    $('changesTabHistory').addEventListener('click', () => { tab = 'history'; openId = null; render(); });
    $('changesList').addEventListener('click', event => {
      const t = event.target.closest('[data-toggle],[data-apply],[data-reject],[data-rollback]');
      if (!t) return;
      if (t.dataset.toggle) expand(t.dataset.toggle);
      else if (t.dataset.apply) approveProposal(t.dataset.apply);
      else if (t.dataset.reject) reject(t.dataset.reject);
      else if (t.dataset.rollback) rollbackChange(t.dataset.rollback);
    });
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden && !busy.size) load().catch(() => {}); }, 25_000);
    load().catch(() => {});
  }

  function open() { setWorkspacePane('changesPane'); load().catch(() => {}); }
  function close() { setWorkspacePane(); }

  return { bind, open, close, load };
}
