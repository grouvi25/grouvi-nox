import { $, esc } from './utils.js';
const labels={project:'Проекты',service:'Сервисы',container:'Контейнеры',domain:'Домены',backup:'Бэкапы',database:'Базы',runtime:'Runtime',capability:'Возможности'};
export function createDiscoveryController({api}) {
  async function load() {
    try {
      const data=await api('/api/discovery');
      const enabled=data.items.filter(item=>item.enabled);
      $('discoveryCount').textContent=data.items.length;
      $('nbDiscovery').textContent=enabled.length;
      $('discoverySummary').innerHTML=Object.entries(data.summary||{}).map(([type,count])=>`<div><span>${esc(labels[type]||type)}</span><b>${count}</b></div>`).join('');
      $('discoveryList').innerHTML=enabled.length
        ? enabled.slice(0,30).map(item=>`<div class="inventory-row"><span class="inventory-kind">${esc(labels[item.type]||item.type)}</span><span><b>${esc(item.name)}</b><small>${esc(item.path||item.source)}</small></span><span class="inventory-confidence">${Math.round(item.confidence*100)}%</span></div>`).join('')
        : '<div class="empty">Цели ещё не выбраны. Откройте мастер настройки.</div>';
    } catch(error) { $('discoveryList').innerHTML=`<div class="empty">Discovery недоступен: ${esc(error.message)}</div>`; }
  }
  return {load};
}
