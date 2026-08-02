import { config } from './config.js';
import { recordNotification } from './database.js';

const recentlySent = new Map();

const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function icon(severity, type) {
  if (type === 'resolved') return '✅';
  if (severity === 'critical') return '🔴';
  return '🟠';
}

function messageFor(event) {
  const i = event.incident;
  const status = event.type === 'opened' ? 'Новый инцидент'
    : event.type === 'escalated' ? 'Инцидент ухудшился'
      : 'Инцидент закрыт';
  const duration = i.resolved_at ? Math.max(1, Math.round((i.resolved_at - i.first_seen) / 60_000)) : null;
  return [
    `${icon(i.severity, event.type)} <b>${status}</b>`,
    `<b>${esc(i.title)}</b>`,
    i.detail ? esc(i.detail) : '',
    `Источник: <code>${esc(i.source)}</code>`,
    duration ? `Длительность: ${duration} мин.` : '',
    `<a href="${config.origin}/#s-incidents">Открыть VPS Sentinel</a>`,
  ].filter(Boolean).join('\n');
}

export function telegramState() {
  return {
    enabled: config.telegram.enabled,
    configured: Boolean(config.telegram.botToken && config.telegram.chatId),
    chat: config.telegram.chatId ? `…${config.telegram.chatId.slice(-4)}` : null,
  };
}

export async function notifyIncident(event) {
  if (!config.telegram.enabled) return { skipped: true, reason: 'not_configured' };
  const key = `${event.type}:${event.incident.id}:${event.incident.severity}`;
  const last = recentlySent.get(key) || 0;
  if (Date.now() - last < config.telegram.cooldownMs) return { skipped: true, reason: 'deduplicated' };

  const endpoint = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text: messageFor(event),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.description || `HTTP ${response.status}`);
    recentlySent.set(key, Date.now());
    recordNotification({ incidentId: event.incident.id, eventType: event.type, success: true, detail: 'sent' });
    return { sent: true };
  } catch (error) {
    recordNotification({ incidentId: event.incident.id, eventType: event.type, success: false, detail: error.message });
    console.error('[telegram]', error.message);
    return { sent: false, error: error.message };
  }
}

export async function notifyEvents(events) {
  for (const event of events) {
    // Warning recovery messages are useful; repetitive updates are never sent.
    // eslint-disable-next-line no-await-in-loop
    await notifyIncident(event);
  }
}
