import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { bytes, clamp, dur, esc, lvl } from '../../public/js/utils.js';
import { renderMarkdown } from '../../public/js/markdown.js';

test('formatters and thresholds preserve dashboard behavior',()=>{assert.equal(bytes(1024),'1.0 КБ');assert.equal(dur(3660),'1ч 1м');assert.equal(esc('<x>'),'&lt;x&gt;');assert.equal(clamp(120,0,100),100);assert.equal(lvl(95,80,90),'crit')});
test('markdown preserves supported structures and escaping',()=>{const html=renderMarkdown('## Заголовок\n\n**жирный**\n\n```js\nconst x=1;\n```');assert.match(html,/<h4>Заголовок<\/h4>/);assert.match(html,/<strong>жирный<\/strong>/);assert.match(html,/data-copy-code/);assert.match(renderMarkdown('<script>x<\/script>'),/&lt;script&gt;/)});
test('modular CSS stays pinned to the approved refactor baseline',()=>{const dir='public/css',text=fs.readdirSync(dir).filter(x=>x.endsWith('.css')).sort().map(x=>fs.readFileSync(path.join(dir,x),'utf8')).join('');assert.equal(crypto.createHash('sha256').update(text).digest('hex'),'ac3b24c86789908eec09c4bcf4ccaf4c2679eb9c78ecc726e3d59af3490030a2')});
test('API paths survive router split',()=>{const expected=['/snapshot', '/history', '/incidents', '/incidents/:id/status', '/incidents/:id/ack', '/incidents/:id/resolve', '/incidents/:id/investigate', '/agent/projects', '/agent/chat', '/agent/chat/:jobId', '/services/container/:name', '/services/pm2/:name', '/deployments', '/filesystem', '/notifications', '/notifications/settings', '/notifications/test', '/session', '/audit'];const dir='src/routes/api',source=fs.readdirSync(dir).filter(x=>x.endsWith('.js')).map(x=>fs.readFileSync(path.join(dir,x),'utf8')).join('\n');for(const route of expected)assert.ok(source.includes(`'${route}'`),route)});
test('database initializes with stable defaults',()=>{const dir=mkdtempSync(path.join(tmpdir(),'sentinel-db-')),code=`import {initDatabase,incidentCounts,getNotificationSettings,listIncidents} from './src/database.js';initDatabase();const c=incidentCounts(),s=getNotificationSettings();if(c.total!==0||s.cooldownMin!==30||listIncidents({status:'active',limit:6}).length!==0)process.exit(1)`;const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,STATE_DIR:dir}});rmSync(dir,{recursive:true,force:true});assert.equal(r.status,0,r.stderr?.toString())});

import http from 'node:http';
import Database from 'better-sqlite3';
import { createApp } from '../../src/app.js';
import { migrateDatabase, latestSchemaVersion } from '../../src/db/migrations.js';
import { allowedDockerPath } from '../../bin/docker-read-broker.js';

async function withServer(app, fn) {
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve=>server.close(resolve)); }
}

test('HTTP shell preserves health, auth boundary, headers and 404 contract',async()=>{
  await withServer(createApp(),async base=>{
    const health=await fetch(`${base}/healthz`);assert.equal(health.status,200);assert.equal((await health.json()).ok,true);assert.equal(health.headers.get('x-content-type-options'),'nosniff');
    const root=await fetch(`${base}/`,{redirect:'manual'});assert.equal(root.status,302);assert.equal(root.headers.get('location'),'/login');
    const api=await fetch(`${base}/api/history`);assert.equal(api.status,401);assert.deepEqual(await api.json(),{error:'unauthorized'});
    const missing=await fetch(`${base}/definitely-missing`);assert.equal(missing.status,404);assert.deepEqual(await missing.json(),{error:'not_found'});
  });
});

test('database migrations are versioned and idempotent',()=>{
  const db=new Database(':memory:');assert.equal(migrateDatabase(db),latestSchemaVersion);assert.equal(migrateDatabase(db),latestSchemaVersion);
  const columns=db.prepare('PRAGMA table_info(incidents)').all().map(x=>x.name);assert.ok(columns.includes('investigation'));assert.ok(columns.includes('investigated_at'));
});

test('Docker broker accepts only fixed read-only endpoints',()=>{
  assert.equal(allowedDockerPath('/v1.44/containers/json?all=1'),true);assert.equal(allowedDockerPath('/v1.44/system/df'),true);
  assert.equal(allowedDockerPath('/v1.44/containers/web-1/stats?stream=false'),true);assert.equal(allowedDockerPath('/v1.44/containers/web-1/stop'),false);
  assert.equal(allowedDockerPath('/v1.44/images/json'),false);assert.equal(allowedDockerPath('/v1.44/containers/../json'),false);
});

test('Telegram retries transient failures and records eventual success',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'sentinel-tg-'));
  const code=`let attempts=0;global.fetch=async()=>{attempts+=1;return{ok:attempts===3,status:attempts===3?200:503,json:async()=>attempts===3?{ok:true}:{ok:false,description:'temporary'}}};const n=await import('./src/notifier.js');const r=await n.sendTelegramText('test',{eventType:'unit'});if(!r.sent||r.attempts!==3)process.exit(2);const d=await import('./src/database.js');const h=d.notificationDeliveryHealth();if(h.sent!==1||h.failed!==0)process.exit(3)`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,STATE_DIR:dir,SENTINEL_TELEGRAM_BOT_TOKEN:'fake',SENTINEL_TELEGRAM_CHAT_ID:'1'}});rmSync(dir,{recursive:true,force:true});assert.equal(r.status,0,r.stderr?.toString());
});

test('Telegram does not retry permanent client errors',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'sentinel-tg-'));
  const code=`let attempts=0;global.fetch=async()=>{attempts+=1;return{ok:false,status:400,json:async()=>({ok:false,description:'bad request'})}};const n=await import('./src/notifier.js');const r=await n.sendTelegramText('test',{eventType:'unit'});if(r.sent||attempts!==1)process.exit(2);const d=await import('./src/database.js');if(d.notificationDeliveryHealth().failed!==1)process.exit(3)`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,STATE_DIR:dir,SENTINEL_TELEGRAM_BOT_TOKEN:'fake',SENTINEL_TELEGRAM_CHAT_ID:'1'}});rmSync(dir,{recursive:true,force:true});assert.equal(r.status,0,r.stderr?.toString());
});

import { evaluate as evaluateAlerts } from '../../src/metrics/alerts.js';
import * as procMetrics from '../../src/metrics/proc.js';
import { filesystems, osInfo, systemd } from '../../src/metrics/services.js';

test('alert evaluation covers critical infrastructure signals',()=>{
  const alerts=evaluateAlerts({filesystems:[{mount:'/',usedPct:95,inodePct:90}],memory:{usedPct:97,swapPct:60},cpu:{usage:99,count:2,steal:20},load:{five:8},containers:{items:[{name:'web',health:'unhealthy',state:'running'}]},pm2:{items:[{name:'api',status:'stopped'}]},systemd:{failedUnits:['bad.service'],nginx:'failed'},certificates:[{ok:true,domain:'x.test',daysLeft:1}],backups:[{exists:true,newest:{},dir:'/backup',ageHours:100}],os:{rebootRequired:true,kernelRunning:'1',kernelInstalled:'2'}});
  assert.ok(alerts.length>=10);assert.equal(alerts[0].level,'critical');assert.ok(alerts.some(x=>x.key==='docker:web'));assert.ok(alerts.some(x=>x.key==='reboot'));
});

test('proc and host collectors return typed read-only snapshots',async()=>{
  const [cpu,memory,load,uptime,kernel,fsRows,os,units]=await Promise.all([procMetrics.cpu(),procMetrics.memory(),procMetrics.load(),procMetrics.uptime(),procMetrics.kernel(),filesystems(),osInfo(),systemd()]);
  assert.ok(cpu.count>=1);assert.ok(memory.total>0);assert.equal(typeof load.one,'number');assert.ok(uptime>0);assert.equal(typeof kernel.hostname,'string');assert.ok(Array.isArray(fsRows));assert.equal(typeof os.pretty,'string');assert.ok(Array.isArray(units.failedUnits));
});

test('incident lifecycle, history bucketing and settings persist',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'sentinel-domain-'));
  const code=`const d=await import('./src/database.js');d.initDatabase();d.recordMetric({cpu:{usage:10},memory:{usedPct:20,swapPct:0},load:{one:.2},network:{rxRate:1,txRate:2},diskIo:{readRate:3,writeRate:4},filesystems:[{mount:'/',usedPct:30}],containers:{stopped:0,unhealthy:0},pm2:{down:0},alerts:[]});if(d.getHistory('24h').rows.length!==1)process.exit(2);let e=d.syncIncidents([{key:'unit:test',level:'warning',message:'warning'}]);if(e[0]?.type!=='opened')process.exit(3);e=d.syncIncidents([{key:'unit:test',level:'critical',message:'critical'}]);if(e[0]?.type!=='escalated')process.exit(4);const id=d.listIncidents({status:'active'})[0].id;if(d.setIncidentStatus(id,'acknowledged')?.status!=='acknowledged')process.exit(5);if(d.setIncidentStatus(id,'resolved')?.status!=='resolved')process.exit(6);const settings=d.updateNotificationSettings({quietEnabled:true,quietStart:22,quietEnd:7,cooldownMin:60});if(!settings.quietEnabled||settings.cooldownMin!==60)process.exit(7)`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,STATE_DIR:dir,INCIDENT_RESOLVE_GRACE_MS:'0'}});rmSync(dir,{recursive:true,force:true});assert.equal(r.status,0,r.stderr?.toString());
});
