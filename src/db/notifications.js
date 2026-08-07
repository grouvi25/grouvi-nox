import { initDatabase } from './connection.js';

export function recordNotification({ incidentId, eventType, success, detail = '' }) {
  initDatabase().prepare(`
    INSERT INTO notifications (incident_id,ts,channel,event_type,success,detail)
    VALUES (?,?,'telegram',?,?,?)
  `).run(incidentId || null, Date.now(), eventType, success ? 1 : 0, String(detail).slice(0, 1000));
}


const NOTIFICATION_DEFAULTS = Object.freeze({ enabled:true,warning:true,critical:true,opened:true,escalated:true,resolved:true,dailyDigest:true,quietEnabled:false,quietStart:23,quietEnd:8,criticalDuringQuiet:true,cooldownMin:30 });
export function getNotificationSettings(){
  const row=initDatabase().prepare('SELECT settings_json FROM notification_settings WHERE id=1').get();
  if(!row) return {...NOTIFICATION_DEFAULTS};
  try{return {...NOTIFICATION_DEFAULTS,...JSON.parse(row.settings_json)}}catch{return {...NOTIFICATION_DEFAULTS}}
}
export function updateNotificationSettings(input={}){
  const next={...getNotificationSettings()};
  for(const key of ['enabled','warning','critical','opened','escalated','resolved','dailyDigest','quietEnabled','criticalDuringQuiet']) if(typeof input[key]==='boolean') next[key]=input[key];
  for(const key of ['quietStart','quietEnd']){const value=Number(input[key]);if(Number.isInteger(value)&&value>=0&&value<=23)next[key]=value}
  const cooldown=Number(input.cooldownMin);if([5,15,30,60,120].includes(cooldown))next.cooldownMin=cooldown;
  initDatabase().prepare(`INSERT INTO notification_settings (id,settings_json,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at`).run(JSON.stringify(next),Date.now());return next;
}

export function notificationDeliveryHealth(hours=24) {
  const database=initDatabase(),since=Date.now()-Math.max(1,Number(hours)||24)*3600_000;
  const counts=database.prepare('SELECT COUNT(*) total,SUM(success=1) sent,SUM(success=0) failed FROM notifications WHERE ts>=?').get(since);
  const lastSuccess=database.prepare('SELECT ts,event_type FROM notifications WHERE success=1 ORDER BY ts DESC LIMIT 1').get()||null;
  const lastFailure=database.prepare('SELECT ts,event_type,detail FROM notifications WHERE success=0 ORDER BY ts DESC LIMIT 1').get()||null;
  const degraded=Boolean(lastFailure&&(!lastSuccess||lastFailure.ts>lastSuccess.ts));
  return { windowHours:hours,total:Number(counts.total||0),sent:Number(counts.sent||0),failed:Number(counts.failed||0),lastSuccess,lastFailure,degraded };
}

export function notificationStatus() {
  const database = initDatabase();
  return database.prepare(`SELECT * FROM notifications ORDER BY ts DESC LIMIT 20`).all();
}
