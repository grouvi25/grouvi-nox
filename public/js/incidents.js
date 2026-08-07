import { $, esc } from './utils.js';

export function createIncidentController({ api, formatWhen, pageSize=6 }) {
  let filter='active',page=1;
function incidentStatusPill(status) {
  if (status === 'resolved') return '<span class="pill ok">закрыт</span>';
  if (status === 'acknowledged') return '<span class="pill info">принят</span>';
  return '<span class="pill warn">открыт</span>';
}

function renderIncidents(items,counts={},pagination={}){
  $('incidentCount').textContent=counts.total??items.length;$('icAll').textContent=counts.total||0;$('icActive').textContent=counts.active||0;$('icOpen').textContent=counts.open||0;$('icAck').textContent=counts.acknowledged||0;$('icResolved').textContent=counts.resolved||0;
  $('incidentActive').textContent=counts.active||0;$('incidentCritical').textContent=counts.critical||0;$('incidentResolved').textContent=counts.resolved||0;$('incidentHint').textContent=counts.active?`${counts.active} требуют внимания, архив разбит на страницы`:'Всё спокойно, активных инцидентов нет';
  $('nbIncidents').textContent=counts.active||0;$('nbIncidents').className=`n-badge${counts.critical?' alert':counts.active?' warn':''}`;
  if(!items.length){$('incidentList').innerHTML='<div class="empty incident-empty">В этом фильтре всё чисто.</div>'}else{
    $('incidentList').innerHTML=items.map(i=>`<article class="incident-row" data-incident-id="${i.id}"><span class="incident-mark ${i.severity}"></span><div class="incident-main"><div class="incident-title">${esc(i.title)}</div><div class="incident-detail">${esc(i.detail||i.incident_key)}</div><div class="incident-mobile-meta">${formatWhen(i.first_seen)} · ${i.occurrences} срабатываний</div></div><div class="incident-meta">${incidentStatusPill(i.status)}<span>${formatWhen(i.first_seen)}</span><span>${i.occurrences} срабатываний</span></div><div class="incident-actions">${i.severity==='critical'&&!i.investigation?`<button class="action-sm investigate" data-incident-action="investigate" data-id="${i.id}">AI-разбор</button>`:''}${i.investigation?`<button class="action-sm" data-incident-expand="${i.id}">Разбор готов</button>`:''}<label class="incident-status-control"><span>Статус</span><select data-incident-status data-id="${i.id}" data-previous="${i.status}"><option value="open" ${i.status==='open'?'selected':''}>Открыт</option><option value="acknowledged" ${i.status==='acknowledged'?'selected':''}>Принят</option><option value="resolved" ${i.status==='resolved'?'selected':''}>Закрыт</option></select></label></div>${i.investigation?`<div class="incident-ai" id="incidentAi${i.id}" hidden><div class="incident-ai-head"><span>Sentinel Forge</span><time>${formatWhen(i.investigated_at)}</time></div><pre>${esc(i.investigation)}</pre></div>`:''}</article>`).join('')
  }
  const total=Number(pagination.total||0),pages=Math.max(1,Math.ceil(total/pageSize));
  $('incidentPager').hidden=total<=pageSize;
  $('incidentPageMeta').textContent=`${Math.min(page,pages)} / ${pages}`;
  $('incidentPrev').disabled=page<=1;$('incidentNext').disabled=page>=pages;
}
async function loadIncidents(status=filter,requestedPage=page){const targetPage=Number(requestedPage)||1;try{const offset=(targetPage-1)*pageSize;const data=await api(`/api/incidents?status=${encodeURIComponent(status)}&limit=${pageSize}&offset=${offset}`);const pages=Math.max(1,Math.ceil(Number(data.pagination?.total||0)/pageSize));if(targetPage>pages){page=pages;return loadIncidents(status,pages)}page=targetPage;renderIncidents(data.incidents||[],data.counts||{},data.pagination||{})}catch(e){$('incidentList').innerHTML=`<div class="empty">Ошибка загрузки: ${esc(e.message)}</div>`}}


async function incidentAction(id, action, button) {
  button.disabled = true;
  button.textContent = 'Сохраняю…';
  try {
    await api(`/api/incidents/${id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    await loadIncidents();
  } catch (e) { button.disabled = false; button.textContent = 'Ошибка'; }
}

async function changeIncidentStatus(id, status, select) {
  const previous = select.dataset.previous || select.querySelector('option[selected]')?.value || '';
  select.disabled = true;
  try {
    await api(`/api/incidents/${id}/status`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ status }) });
    select.dataset.previous = status;
    await loadIncidents(filter);
  } catch (e) { if (previous) select.value = previous; select.disabled = false; }
}


  function onFilterClick(e){const button=e.target.closest('[data-status]');if(!button)return;filter=button.dataset.status;page=1;$('incidentFilters').querySelectorAll('.seg').forEach(x=>x.classList.toggle('active',x===button));loadIncidents(filter,page)}
  function onContentClick(e){const action=e.target.closest('[data-incident-action]');if(action){incidentAction(action.dataset.id,action.dataset.incidentAction,action);return true}const expand=e.target.closest('[data-incident-expand]');if(expand){const box=$(`incidentAi${expand.dataset.incidentExpand}`),show=box.hidden;box.hidden=!show;expand.textContent=show?'Скрыть разбор':'Разбор готов';return true}return false}
  function onContentChange(e){const select=e.target.closest('[data-incident-status]');if(select)changeIncidentStatus(select.dataset.id,select.value,select)}
  function previous(){if(page>1){page-=1;loadIncidents(filter,page)}}
  function next(){page+=1;loadIncidents(filter,page)}
  return { loadIncidents,onFilterClick,onContentClick,onContentChange,previous,next };
}
