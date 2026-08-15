import { getNotificationSettings, incidentDigest } from '../src/database.js';
import { sendTelegramText } from '../src/notifier.js';
import { config } from '../src/config.js';

const settings=getNotificationSettings();
if(!settings.enabled||!settings.dailyDigest)process.exit(0);
const d = incidentDigest(24);
const lines = [
  '🛡️ <b>Grouvi Nox · суточный отчёт</b>',
  `Период: последние 24 часа`,
  `Новых инцидентов: <b>${d.opened}</b>`,
  `Критических: <b>${d.critical}</b>`,
  `Закрыто: <b>${d.resolved}</b>`,
  `Сейчас активны: <b>${d.active}</b>`,
  '',
  ...(d.top.length ? d.top.map((x) => `${x.severity === 'critical' ? '🔴' : '🟠'} ${String(x.title).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}`) : ['✅ За сутки новых аварий не зафиксировано.']),
  '',
  `<a href="${config.origin}/#s-incidents">Открыть Grouvi Nox</a>`,
];
const result = await sendTelegramText(lines.join('\n'), { eventType: 'daily_report' });
if (!result.sent) process.exitCode = result.skipped ? 0 : 1;