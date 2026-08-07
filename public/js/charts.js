import { C, bytes, clamp } from './utils.js';

/* ---------------------------- charts ----------------------------- */
function prep(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function spark(canvas, series, color, maxOverride) {
  if (!canvas) return;
  const { ctx, w, h } = prep(canvas);
  if (!series || series.length < 2) return;
  const max = maxOverride ?? Math.max(1, ...series);
  const pad = 2;
  const step = w / (series.length - 1);
  const y = (v) => h - pad - (clamp(v, 0, max) / max) * (h - pad * 2);

  const line = new Path2D();
  line.moveTo(0, y(series[0]));
  for (let i = 1; i < series.length; i += 1) line.lineTo(i * step, y(series[i]));

  const area = new Path2D(line);
  area.lineTo(w, h); area.lineTo(0, h); area.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `${color}2e`);
  g.addColorStop(1, `${color}00`);
  ctx.fillStyle = g; ctx.fill(area);

  ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
  ctx.stroke(line);
}

export function multiChart(canvas, sets, { max, unit = '' } = {}) {
  if (!canvas) return;
  const { ctx, w, h } = prep(canvas);
  const padL = 44; const padR = 8; const padT = 9; const padB = 14;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const all = sets.flatMap(s => s.data || []);
  const peak = max ?? Math.max(1, ...all);
  const top = peak <= 1 ? 1 : peak * 1.14;

  ctx.strokeStyle = C.grid;
  ctx.fillStyle = C.axis;
  ctx.font = '10px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const yy = Math.round(padT + (plotH / 4) * i) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    const val = top * (1 - i / 4);
    const label = unit === 'KB' ? bytes(val * 1024, 0) : `${val.toFixed(top > 10 ? 0 : 1)}${unit}`;
    ctx.fillText(label, 4, yy + 3);
  }

  for (const s of sets) {
    const d = s.data || [];
    if (!d.length) continue;
    const y = (v) => padT + plotH - (clamp(v, 0, top) / top) * plotH;
    // A long range can legitimately contain one bucket shortly after first
    // install. Draw a visible point instead of an empty chart.
    if (d.length === 1) {
      const x = padL + plotW;
      ctx.beginPath(); ctx.arc(x, y(d[0]), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = s.color; ctx.fill();
      ctx.beginPath(); ctx.moveTo(padL, y(d[0])); ctx.lineTo(x, y(d[0]));
      ctx.strokeStyle = `${s.color}55`; ctx.lineWidth = 1; ctx.setLineDash([4, 5]); ctx.stroke(); ctx.setLineDash([]);
      continue;
    }
    const step = plotW / (d.length - 1);
    const p = new Path2D();
    p.moveTo(padL, y(d[0]));
    for (let i = 1; i < d.length; i += 1) p.lineTo(padL + i * step, y(d[i]));

    if (s.fill !== false) {
      const area = new Path2D(p);
      area.lineTo(padL + plotW, padT + plotH);
      area.lineTo(padL, padT + plotH);
      area.closePath();
      const g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      g.addColorStop(0, `${s.color}26`);
      g.addColorStop(1, `${s.color}00`);
      ctx.fillStyle = g; ctx.fill(area);
    }
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    ctx.stroke(p);
  }
}
