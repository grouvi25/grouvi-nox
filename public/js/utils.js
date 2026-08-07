export const $ = (id) => document.getElementById(id);

/* palette mirrors style.css */
export const C = {
  accent: '#F4EDE4', blue: '#3b82f6', green: '#22c55e',
  red: '#ef4444', amber: '#f59e0b', purple: '#a855f7',
  grid: 'rgba(255,255,255,.045)', axis: '#666',
};

/* ----------------------------- utils ----------------------------- */
const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
export function bytes(n, digits = 1) {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}
export const rate = (n) => `${bytes(n, 1)}/с`;
export function dur(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}
export function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)} с назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн назад`;
}
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lvl = (v, w, c) => (v >= c ? 'crit' : v >= w ? 'warn' : 'ok');
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function setBar(el, pct, level) {
  if (!el) return;
  const step = Math.round(clamp(pct, 0, 100) / 5) * 5;
  el.className = `w${step}${level === 'ok' ? '' : ` ${level}`}`;
}
