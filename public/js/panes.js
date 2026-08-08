import { $, clamp } from './utils.js';

const PANE_LIMITS = {
  forge: { min: 420, max: 760, fallback: 560 },
  notify: { min: 360, max: 580, fallback: 440 },
  detail: { min: 400, max: 720, fallback: 540 },
  settings: { min: 560, max: 920, fallback: 780 },
};
function paneWidth(kind) {
  const limits=PANE_LIMITS[kind], saved=Number(localStorage.getItem(`sentinelPaneWidth:${kind}`));
  return clamp(saved || limits.fallback, limits.min, Math.min(limits.max, Math.max(limits.min, window.innerWidth - 640)));
}
function applyPaneWidth(pane, width) {
  const kind=pane.dataset.paneKind, limits=PANE_LIMITS[kind]; if(!limits) return;
  const max=Math.min(limits.max, Math.max(limits.min, window.innerWidth - 640));
  const next=clamp(Number(width)||limits.fallback,limits.min,max);
  pane.style.setProperty('--pane-width',`${next}px`);
  pane.querySelector('[data-pane-resizer]')?.setAttribute('aria-valuenow',String(Math.round(next)));
  return next;
}
export function initPaneResizers(){
  document.querySelectorAll('[data-pane-kind]').forEach(pane=>{
    applyPaneWidth(pane,paneWidth(pane.dataset.paneKind));
    const handle=pane.querySelector('[data-pane-resizer]'); if(!handle)return;
    const begin=(clientX)=>{pane.classList.add('resizing');document.body.classList.add('pane-dragging');const move=(x)=>applyPaneWidth(pane,window.innerWidth-x);const onMove=e=>move(e.clientX);const stop=()=>{document.removeEventListener('pointermove',onMove);document.removeEventListener('pointerup',stop);document.body.classList.remove('pane-dragging');pane.classList.remove('resizing');const value=parseInt(getComputedStyle(pane).getPropertyValue('--pane-width'),10);if(value)localStorage.setItem(`sentinelPaneWidth:${pane.dataset.paneKind}`,String(value));window.dispatchEvent(new Event('resize'))};document.addEventListener('pointermove',onMove);document.addEventListener('pointerup',stop,{once:true});move(clientX)};
    handle.addEventListener('pointerdown',e=>{if(window.innerWidth<=1100)return;e.preventDefault();handle.setPointerCapture?.(e.pointerId);begin(e.clientX)});
    handle.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)||window.innerWidth<=1100)return;e.preventDefault();const limits=PANE_LIMITS[pane.dataset.paneKind];let width=parseInt(getComputedStyle(pane).getPropertyValue('--pane-width'),10)||limits.fallback;if(e.key==='ArrowLeft')width+=24;if(e.key==='ArrowRight')width-=24;if(e.key==='Home')width=limits.min;if(e.key==='End')width=limits.max;const next=applyPaneWidth(pane,width);localStorage.setItem(`sentinelPaneWidth:${pane.dataset.paneKind}`,String(next));window.dispatchEvent(new Event('resize'))});
  });
}

export function setWorkspacePane(activeId = null) {
  for (const id of ['forgePane', 'notifyPane', 'settingsPane', 'detailPane']) {
    const pane = $(id); const open = id === activeId;
    pane.classList.toggle('open', open);
    pane.setAttribute('aria-hidden', String(!open));
  }
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  setTimeout(() => window.dispatchEvent(new Event('resize')), 320);
}
