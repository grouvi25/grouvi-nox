import { callAgent } from './agent-client.js';
import { updateIncidentInvestigation } from './database.js';

export async function investigateIncident(incident) {
  const prompt = `Проведи аварийное расследование инцидента VPS. Используй /var/lib/sentinel-ai/context/VPS.md и только read-only диагностику. Сделай не более 4 командных проверок и заверши расследование максимум за 90 секунд. Не меняй production.\n\nИнцидент #${incident.id}\nSeverity: ${incident.severity}\nSource: ${incident.source}\nTitle: ${incident.title}\nDetail: ${incident.detail || 'нет'}\nFirst seen: ${new Date(incident.first_seen).toISOString()}\nOccurrences: ${incident.occurrences}\n\nВерни компактный отчёт на русском с секциями: Вердикт, Доказательства, Вероятная причина, Безопасный следующий шаг. Не выдумывай факты.`;
  try {
    const report = await callAgent([{ role: 'user', content: prompt }]);
    return updateIncidentInvestigation(incident.id, report.slice(0, 12000));
  } catch (error) {
    console.error('[investigation]', error.message);
    return incident;
  }
}