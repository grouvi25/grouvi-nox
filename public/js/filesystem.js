import { $, bytes, esc } from './utils.js';

export function createFilesystemController({ api, formatWhen, kv }) {
  let currentPath='/',overview={largest:[],risks:[]},timer=null;
function fsIcon(type, excluded) {
  if (excluded) return '<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>';
  if (type === 'directory') return '<svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 012-2h5l2 2h7a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';
  if (type === 'symlink') return '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.5.5l2-2a5 5 0 00-7-7l-1.1 1.1M14 11a5 5 0 00-7.5-.5l-2 2a5 5 0 007 7l1.1-1.1"/></svg>';
  return '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>';
}

function breadcrumb(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  let built = '';
  const items = [{ name: '/', path: '/' }];
  for (const part of parts) { built += `/${part}`; items.push({ name: part, path: built }); }
  $('fsBreadcrumb').innerHTML = items.map((item, i) => `${i ? '<span class="crumb-sep">/</span>' : ''}<button class="crumb" data-fs-path="${esc(item.path)}">${esc(item.name)}</button>`).join('');
}

function renderFilesystem(data) {
  currentPath = data.path || '/';
  breadcrumb(currentPath);
  const totals = data.totals || {};
  $('fsIndexCount').textContent = `${(totals.files || 0).toLocaleString('ru-RU')} файлов`;
  $('fsIndexMeta').textContent = `${formatWhen(data.at)} · ${totals.truncated ? 'индекс ограничен' : 'полный индекс'} · содержимое файлов скрыто`;
  $('fsEntries').innerHTML = data.children?.length ? data.children.map(item => {
    const critical = item.risk?.some(x => ['world-writable','setuid','setgid'].includes(x));
    return `<div class="fs-row ${item.type} ${item.excluded ? 'fs-excluded' : ''}" ${item.type === 'directory' && !item.excluded ? `role="button" tabindex="0" data-fs-path="${esc(item.path)}"` : ''}>
      <span class="fs-name">${fsIcon(item.type,item.excluded)}<span class="fs-label" title="${esc(item.path)}">${esc(item.name)}</span>${item.risk?.length ? `<span class="fs-flags"><i class="risk-dot ${critical ? 'critical' : ''}" title="${esc(item.risk.join(', '))}"></i></span>` : ''}</span>
      <span>${item.type === 'file' ? bytes(item.size) : item.excluded ? 'скрыто' : '—'}</span>
      <span>${esc(item.mode || '—')}</span>
      <span>${formatWhen(item.mtime)}</span>
    </div>`;
  }).join('') : '<div class="empty">Папка пуста или не вошла в безопасный индекс.</div>';
  $('fsSummary').innerHTML = kv('Директорий', (totals.directories || 0).toLocaleString('ru-RU'))
    + kv('Файлов', (totals.files || 0).toLocaleString('ru-RU'))
    + kv('Симлинков', (totals.symlinks || 0).toLocaleString('ru-RU'))
    + kv('Известный объём', bytes(totals.bytes || 0))
    + kv('Исключено зон', String(totals.excluded || 0), 'секреты и тяжёлые технические деревья');
  if (data.largest?.length) overview.largest = data.largest;
  if (data.risks?.length) overview.risks = data.risks;
  $('fsLargest').innerHTML = overview.largest.slice(0, 12).map(x => `<div class="fs-mini-row"><span title="${esc(x.path)}">${esc(x.path)}</span><b>${bytes(x.size)}</b></div>`).join('') || '<div class="empty">Нет файлов крупнее 10 МБ.</div>';
  $('fsRisks').innerHTML = overview.risks.slice(0, 12).map(x => `<div class="fs-mini-row"><span title="${esc(x.path)}">${esc(x.path)}</span><b>${esc(x.risk.filter(r => r !== 'recent' && r !== 'privileged-area').join(', ') || x.risk.join(', '))}</b></div>`).join('') || '<div class="empty">Явных рисков прав не найдено.</div>';
}

async function loadFilesystem(pathname = currentPath, query = '') {
  $('fsEntries').innerHTML = '<div class="empty">Загружаю metadata index…</div>';
  try {
    const q = query ? `&q=${encodeURIComponent(query)}` : '';
    const data = await api(`/api/filesystem?path=${encodeURIComponent(pathname)}${q}`);
    renderFilesystem(data);
  } catch (e) { $('fsEntries').innerHTML = `<div class="empty">Ошибка индекса: ${esc(e.message)}</div>`; }
}

function fsParent(pathname) {
  if (pathname === '/') return '/';
  const parts = pathname.split('/').filter(Boolean); parts.pop();
  return `/${parts.join('/')}` || '/';
}

  function onEntriesClick(e){const row=e.target.closest('[data-fs-path]');if(row)loadFilesystem(row.dataset.fsPath)}
  function onEntriesKeydown(e){if(e.key==='Enter'){const row=e.target.closest('[data-fs-path]');if(row)loadFilesystem(row.dataset.fsPath)}}
  function onBreadcrumbClick(e){const crumb=e.target.closest('[data-fs-path]');if(crumb)loadFilesystem(crumb.dataset.fsPath)}
  function up(){loadFilesystem(fsParent(currentPath))}
  function search(e){clearTimeout(timer);const value=e.target.value.trim();timer=setTimeout(()=>loadFilesystem(value?'/':currentPath,value),280)}
  return { loadFilesystem,onEntriesClick,onEntriesKeydown,onBreadcrumbClick,up,search };
}
