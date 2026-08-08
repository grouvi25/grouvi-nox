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
test('modular CSS stays pinned to the approved refactor baseline',()=>{const dir='public/css',text=fs.readdirSync(dir).filter(x=>x.endsWith('.css')).sort().map(x=>fs.readFileSync(path.join(dir,x),'utf8')).join('');assert.equal(crypto.createHash('sha256').update(text).digest('hex'),'7dceb616dd11dfa22febc02bb6cd47b0d95fbd0a574a77d6ddf5710b5f331000')});
test('API paths survive router split',()=>{const expected=['/snapshot', '/history', '/incidents', '/incidents/:id/status', '/incidents/:id/ack', '/incidents/:id/resolve', '/incidents/:id/investigate', '/agent/projects', '/agent/chat', '/agent/chat/:jobId', '/services/container/:name', '/services/pm2/:name', '/services/systemd/:name', '/projects/:id', '/projects', '/deployments', '/filesystem', '/notifications', '/notifications/settings', '/notifications/test', '/session', '/audit'];const dir='src/routes/api',source=fs.readdirSync(dir).filter(x=>x.endsWith('.js')).map(x=>fs.readFileSync(path.join(dir,x),'utf8')).join('\n');for(const route of expected)assert.ok(source.includes(`'${route}'`),route)});
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

import { candidate, mergeCandidates, stableId } from '../../src/discovery/model.js';
import { discoverHost } from '../../src/discovery/scanner.js';
import { buildProjectGraph } from '../../src/discovery/graph.js';
import { readDiscoverySettings, writeDiscoverySettings } from '../../src/discovery/store.js';

test('discovery model is stable, scored and deduplicated',()=>{
  assert.equal(stableId('project','/opt/app'),stableId('project','/opt/app'));
  const merged=mergeCandidates([candidate({type:'project',key:'/opt/app',name:'app',source:'a',confidence:.7,reasons:['git']}),candidate({type:'project',key:'/opt/app',name:'app',source:'b',confidence:.9,reasons:['compose']})]);
  assert.equal(merged.length,1);assert.equal(merged[0].confidence,.9);assert.deepEqual(new Set(merged[0].reasons),new Set(['git','compose']));
});

test('discovery scanner identifies generic project, backup and database fixtures',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'sentinel-discovery-'));fs.mkdirSync(path.join(root,'app','.git'),{recursive:true});fs.writeFileSync(path.join(root,'app','package.json'),'{"name":"fixture-app"}');fs.mkdirSync(path.join(root,'daily-backups'));fs.writeFileSync(path.join(root,'app','data.sqlite'),'db');
  const result=discoverHost({roots:[root]});rmSync(root,{recursive:true,force:true});assert.ok(result.items.some(x=>x.type==='project'&&x.name==='fixture-app'));assert.ok(result.items.some(x=>x.type==='backup'));assert.ok(result.items.some(x=>x.type==='database'));
});

test('project graph links Compose, PM2, systemd and nested assets automatically',()=>{
  const project=candidate({type:'project',key:'/opt/app',name:'app',path:'/opt/app',source:'filesystem',confidence:.95,reasons:['git']});
  const items=[project,candidate({type:'container',key:'web',name:'app-web',source:'docker',confidence:.99,reasons:['docker'],meta:{workingDir:'/opt/app',project:'app'}}),candidate({type:'service',key:'pm2:web',name:'web',source:'pm2',confidence:.97,reasons:['pm2'],meta:{cwd:'/opt/app',status:'online'}}),candidate({type:'service',key:'app.service',name:'app.service',source:'systemd',confidence:.95,reasons:['unit'],meta:{workingDirectory:'/opt/app',status:'active'}}),candidate({type:'database',key:'/opt/app/data.db',name:'data.db',path:'/opt/app/data.db',source:'filesystem',confidence:.8,reasons:['db']})].map(item=>({...item,enabled:true}));
  const graph=buildProjectGraph({items,generatedAt:1});assert.equal(graph.projects.length,1);assert.equal(graph.projects[0].health.runtimeCount,3);assert.equal(graph.projects[0].components.length,4);assert.equal(graph.unassigned.length,0);
});

test('discovery settings only accept known ids and persist completion',()=>{
  const root=process.env.STATE_DIR;if(!root)return;const snapshot={schema:1,generatedAt:Date.now(),summary:{project:1},items:[candidate({type:'project',key:'/srv/app',name:'app',path:'/srv/app',source:'fixture',confidence:.9,reasons:['git']})],suggested:{}};fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'discovery.json'),JSON.stringify(snapshot));const settings=writeDiscoverySettings({enabledIds:[snapshot.items[0].id,'unknown'],disabledIds:[],roots:['/srv'],complete:true});assert.deepEqual(settings.enabledIds,[snapshot.items[0].id]);assert.ok(settings.completedAt);assert.equal(readDiscoverySettings().roots[0],'/srv');
});

import {startIntegrationConfigBroker,integrationSummary} from '../../bin/integration-config-broker.js';

test('integration broker writes Telegram and AI secrets without exposing values',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'sentinel-integrations-')),socket=path.join(dir,'broker.sock'),sentinelEnv=path.join(dir,'sentinel.env'),aiEnv=path.join(dir,'ai.env'),aiConfig=path.join(dir,'config.yaml');
  fs.writeFileSync(sentinelEnv,'PORT=3999\n');fs.writeFileSync(aiEnv,'HOME=/tmp\n');fs.writeFileSync(aiConfig,'model:\n  default: OldModel\nproviders:\n  hcnsec:\n    name: Old\n    base_url: https://old.example/v1\n    key_env: HCNSEC_API_KEY\n    default_model: OldModel\n',{mode:0o640});
  const server=startIntegrationConfigBroker({socketPath:socket,sentinelEnv,aiEnv,aiConfig,restartService:async()=>{}});await new Promise(resolve=>server.once('listening',resolve));
  const request=payload=>new Promise((resolve,reject)=>{const body=JSON.stringify(payload),req=http.request({socketPath:socket,path:'/configure',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>res.statusCode===200?resolve(JSON.parse(raw)):reject(new Error(raw)))});req.on('error',reject);req.end(body)});
  await request({kind:'telegram',botToken:'123456:abcdefghijklmnopqrstuvwxyz_ABC',chatId:'-100123456'});await request({kind:'ai',providerLabel:'Provider',baseUrl:'https://api.example.com/v1',model:'Model-1',apiKey:'primary-key-1234567890',backupKeys:['backup-key-1234567890']});
  const summary=integrationSummary({sentinelEnv,aiEnv,aiConfig});assert.equal(summary.telegram.configured,true);assert.equal(summary.ai.model,'Model-1');assert.equal(summary.ai.backupKeys,1);assert.ok(!JSON.stringify(summary).includes('primary-key'));
  assert.match(fs.readFileSync(aiConfig,'utf8'),/base_url: https:\/\/api\.example\.com\/v1/);await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});
});

test('setup policy controls are present before options are accessed',()=>{const source=fs.readFileSync('public/setup.js','utf8');assert.match(source,/id="confidenceSelect"/);assert.match(source,/if\(select\)/);assert.match(source,/id="monitorNew"/)});


test('discovery calibration auto-enables app services but not distribution services or archives',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'sentinel-calibration-'));fs.mkdirSync(path.join(root,'app','.git'),{recursive:true});fs.mkdirSync(path.join(root,'app','backups'));fs.mkdirSync(path.join(root,'config-archive'));const result=discoverHost({roots:[root]});rmSync(root,{recursive:true,force:true});const backup=result.items.find(x=>x.path?.endsWith('/backups')),archive=result.items.find(x=>x.path?.endsWith('/config-archive'));assert.equal(backup.defaultEnabled,true);assert.equal(archive.defaultEnabled,false);assert.ok(backup.confidence>archive.confidence)});

test('settings and setup pages are authenticated application surfaces',async()=>{await withServer(createApp({sessionResolver:()=>({sid:'test'})}),async base=>{assert.equal((await fetch(`${base}/setup`)).status,200);assert.equal((await fetch(`${base}/settings`)).status,200)})});


test('full installer bundles pinned isolated Forge automation',()=>{
  const install=fs.readFileSync('deploy/install.sh','utf8'),forge=fs.readFileSync('deploy/install-forge.sh','utf8'),bridge=fs.readFileSync('deploy/forge/server.mjs','utf8'),context=fs.readFileSync('deploy/forge/context.sh','utf8');
  assert.match(install,/INSTALL_FORGE=1/);assert.match(install,/\.\/deploy\/install-forge\.sh/);assert.match(install,/--without-forge/);assert.match(forge,/v2026\.7\.30/);assert.match(forge,/cc4cab2f592e60a197e796506de9168f74baf3ea/);assert.match(forge,/sentinel-ai-bridge\.service/);assert.match(bridge,/projectFile/);assert.match(context,/discovery-settings\.json/);
  for(const file of ['deploy/install.sh','deploy/install-forge.sh','deploy/forge/context.sh','deploy/forge/sentinel-hermes'])assert.equal(spawnSync('bash',['-n',file]).status,0,file);
});

test('Forge project API is Discovery-managed instead of hardcoded',()=>{const source=fs.readFileSync('src/routes/api/agent.js','utf8');assert.match(source,/buildProjectGraph/);assert.match(source,/allowedScopes=new Set\(forgeProjects/);assert.doesNotMatch(source,/browser-mmo-90s/)});
