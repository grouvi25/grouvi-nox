import { $, esc } from './utils.js';
import { renderMarkdown } from './markdown.js';

export function createForgeController({ api, formatWhen, setWorkspacePane }) {
  const sidebar=$('sidebar');
/* ------------------------- Nox Forge ------------------------ */
const forgeMessages = [];
const FORGE_CHATS_KEY='sentinelForgeChats:v1';
let forgeChatId=crypto.randomUUID?.()||String(Date.now());
let forgeChatStarted=Date.now();
let forgeBusy = false;
let forgeModel = localStorage.getItem('forgeModel') || 'Qwen3.6-35B-A3B';

let forgeScope = localStorage.getItem('forgeScope') || 'vps';
let forgeProjects = [{ id:'vps', name:'Весь VPS', detail:'Система и все сервисы' }];
let forgeModels = [
  { id:'DeepSeek-V4-Pro', name:'DeepSeek V4 Pro', detail:'Проверен с полным набором инструментов' },
  { id:'Qwen3.6-35B-A3B', name:'Qwen 3.6', detail:'Проверен с полным набором инструментов' },
];

function readForgeChats(){try{const value=JSON.parse(localStorage.getItem(FORGE_CHATS_KEY)||'[]');return Array.isArray(value)?value.slice(0,20):[]}catch{return []}}
function forgeChatTitle(messages){const first=messages.find(x=>x.role==='user')?.content||'Новый чат';return first.replace(/\s+/g,' ').trim().slice(0,54)}
function saveForgeChat(){if(!forgeMessages.length)return;const chats=readForgeChats().filter(x=>x.id!==forgeChatId);chats.unshift({id:forgeChatId,title:forgeChatTitle(forgeMessages),updatedAt:Date.now(),startedAt:forgeChatStarted,model:forgeModel,scope:forgeScope,messages:forgeMessages.slice(-14)});localStorage.setItem(FORGE_CHATS_KEY,JSON.stringify(chats.slice(0,20)));renderForgeHistory()}
function renderForgeConversation(){const transcript=$('forgeTranscript');transcript.innerHTML=forgeMessages.length?'':forgeWelcomeMarkup();for(const message of forgeMessages)appendForgeMessage(message.role,message.content,false,{model:message.model||''})}
function renderForgeHistory(){const chats=readForgeChats();$('forgeHistoryList').innerHTML=chats.length?chats.map(chat=>`<button type="button" class="forge-history-item ${chat.id===forgeChatId?'active':''}" data-forge-chat="${esc(chat.id)}"><b>${esc(chat.title)}</b><span>${formatWhen(chat.updatedAt)} · ${esc(forgeProjects.find(x=>x.id===chat.scope)?.name||chat.scope||'VPS')}</span></button>`).join(''):'<div class="forge-history-empty">История появится после первого ответа.</div>'}
function toggleForgeHistory(force){const panel=$('forgeHistory'),show=typeof force==='boolean'?force:panel.hidden;panel.hidden=!show;$('forgeHistoryToggle').setAttribute('aria-expanded',String(show));if(show)renderForgeHistory()}
function loadForgeChat(id){const chat=readForgeChats().find(x=>x.id===id);if(!chat||forgeBusy)return;saveForgeChat();forgeChatId=chat.id;forgeChatStarted=chat.startedAt||chat.updatedAt;forgeMessages.splice(0,forgeMessages.length,...(chat.messages||[]));if(forgeModels.some(x=>x.id===chat.model))forgeModel=chat.model;if(chat.scope)forgeScope=chat.scope;renderForgeMenus();renderForgeConversation();toggleForgeHistory(false)}

function forgeTime() {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date());
}

function appendForgeMessage(role, text, loading = false, meta = {}) {
  $('forgeWelcome')?.remove();
  const article = document.createElement('article');
  article.className = `forge-chat-message ${role}${loading ? ' loading' : ''}`;
  const wrap = document.createElement('div'); wrap.className = 'forge-chat-content';
  const top = document.createElement('div'); top.className = 'forge-chat-meta';
  const name = document.createElement('b'); name.textContent = role === 'assistant' ? 'Nox Forge' : 'Вы';
  const details = document.createElement('span'); details.textContent = meta.model ? `${meta.model} · ${forgeTime()}` : forgeTime();
  top.append(name, details);
  const content = document.createElement('div');
  content.className = loading ? 'forge-thinking-v2' : 'forge-markdown';
  if (loading) content.innerHTML = '<span></span><span></span><span></span><b>думает и проверяет</b>';
  else if (role === 'assistant') content.innerHTML = renderMarkdown(text);
  else content.textContent = text;
  wrap.append(top, content); article.append(wrap); $('forgeTranscript').append(article);
  $('forgeTranscript').scrollTo({ top: $('forgeTranscript').scrollHeight, behavior: 'smooth' });
  return article;
}

function setForgeBusy(value) {
  forgeBusy = value;
  $('forgeSend').disabled = value; $('forgeInput').disabled = value;
  $('forgeModelTrigger').disabled = value; $('forgeScopeTrigger').disabled = value;
  $('forgePresence').textContent = value ? 'работает' : 'готов';
  $('forgePane').classList.toggle('busy', value);
}

async function sendForge(text) {
  if (forgeBusy) return;
  const prompt = String(text || '').trim(); if (!prompt) return;
  const model = forgeModel; const scope = forgeScope;
  setForgeBusy(true); appendForgeMessage('user', prompt); forgeMessages.push({ role: 'user', content: prompt });
  const pending = appendForgeMessage('assistant', '', true, { model });
  $('forgeInput').value = ''; autoSizeForgeInput();
  try {
    const started = await api('/api/agent/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: forgeMessages.slice(-14), model, scope }),
    });
    let data = started;
    const deadline = Date.now() + 170_000;
    while (data.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      data = await api(`/api/agent/chat/${encodeURIComponent(started.jobId)}`);
    }
    if (data.status === 'running') throw new Error('agent_timeout');
    pending.remove(); appendForgeMessage('assistant', data.answer || 'Ответ пуст.', false, { model: data.model || model });
    forgeMessages.push({ role: 'assistant', content: data.answer || '', model: data.model || model });
    if (forgeMessages.length > 14) forgeMessages.splice(0, forgeMessages.length - 14);
    saveForgeChat();
  } catch (e) {
    pending.remove();
    const message = e.message === 'agent_busy' ? '**Агент занят.** Дождитесь завершения текущей задачи.'
      : e.message === 'agent_timeout' ? '**Время вышло.** Разбейте задачу на более короткие шаги.'
        : `**Связь с агентом прервалась.**\n\nОшибка: \`${e.message}\``;
    appendForgeMessage('assistant', message, false, { model });
  } finally { setForgeBusy(false); $('forgeInput').focus(); }
}

function forgeWelcomeMarkup() {
  return `<div class="forge-welcome" id="forgeWelcome"><h3>Чем помочь?</h3><p>Диагностика VPS, расследование инцидентов и работа с кодом.</p><div class="forge-starters" id="forgeSuggestions"><button type="button" data-forge-prompt="Проверь состояние VPS и назови главный риск.">Проверить VPS</button><button type="button" data-forge-prompt="Разбери открытые инциденты и найди причины.">Инциденты</button><button type="button" data-forge-prompt="Проверь выбранный проект, git status и тесты.">Код и тесты</button></div></div>`;
}

function resetForge() { if (forgeBusy) return; saveForgeChat(); forgeChatId=crypto.randomUUID?.()||String(Date.now()); forgeChatStarted=Date.now(); forgeMessages.splice(0); $('forgeTranscript').innerHTML=forgeWelcomeMarkup(); toggleForgeHistory(false); renderForgeHistory(); }
function openForge() { setWorkspacePane('forgePane'); sidebar.classList.remove('open'); setTimeout(() => $('forgeInput').focus(), 180); }
function closeForge() { setWorkspacePane(); }
function autoSizeForgeInput() { const el=$('forgeInput'); el.style.height='auto'; el.style.height=`${Math.min(el.scrollHeight,180)}px`; }
function menuMarkup(items, selected, type) {
  return items.map(item => `<button type="button" class="forge-menu-item ${item.id===selected?'selected':''}" role="option" aria-selected="${item.id===selected}" data-forge-choice="${esc(item.id)}" data-forge-type="${type}"><span class="forge-choice-mark">${item.id===selected?'✓':''}</span><span><b>${esc(item.name)}</b><small>${esc(item.detail || '')}</small></span></button>`).join('');
}
function closeForgeMenus() {
  document.querySelectorAll('.forge-menu.open').forEach(x => x.classList.remove('open'));
  $('forgeScopeTrigger').setAttribute('aria-expanded','false'); $('forgeModelTrigger').setAttribute('aria-expanded','false');
}
function renderForgeMenus() {
  $('forgeScopeMenu').innerHTML = menuMarkup(forgeProjects, forgeScope, 'scope');
  $('forgeModelMenu').innerHTML = menuMarkup(forgeModels, forgeModel, 'model');
  $('forgeScopeLabel').textContent = forgeProjects.find(x=>x.id===forgeScope)?.name || 'Весь VPS';
  $('forgeModelLabel').textContent = forgeModels.find(x=>x.id===forgeModel)?.name || 'GLM 5.2';
}
function toggleForgeMenu(name) {
  const menu=$(name==='scope'?'forgeScopeMenu':'forgeModelMenu'); const trigger=$(name==='scope'?'forgeScopeTrigger':'forgeModelTrigger'); const opening=!menu.classList.contains('open');
  closeForgeMenus(); if(opening){menu.classList.add('open');trigger.setAttribute('aria-expanded','true');}
}
function chooseForge(type, value) {
  if(type==='scope'){forgeScope=value;localStorage.setItem('forgeScope',value);} else {forgeModel=value;localStorage.setItem('forgeModel',value);}
  renderForgeMenus(); closeForgeMenus(); $('forgeInput').focus();
}
async function loadForgeProjects() {
  try { const data=await api('/api/agent/projects'); if(Array.isArray(data.projects)&&data.projects.length) forgeProjects=data.projects;if(Array.isArray(data.models)&&data.models.length)forgeModels=data.models.map(id=>({id,name:id,detail:'Настроено установщиком'})); } catch { /* keep VPS context */ }
  if(!forgeProjects.some(x=>x.id===forgeScope))forgeScope='vps';if(!forgeModels.some(x=>x.id===forgeModel))forgeModel=forgeModels[0].id;renderForgeMenus();
}


  return { openForge,closeForge,resetForge,toggleForgeHistory,loadForgeChat,sendForge,autoSizeForgeInput,toggleForgeMenu,chooseForge,closeForgeMenus,renderForgeMenus,renderForgeHistory,loadForgeProjects };
}
