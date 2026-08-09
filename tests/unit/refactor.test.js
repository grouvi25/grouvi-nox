import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { bytes, clamp, dur, esc, lvl } from '../../public/js/utils.js';
import { renderMarkdown } from '../../public/js/markdown.js';
import { isNewer } from '../../src/updates.js';

test('semantic update visibility only accepts a genuinely newer version',()=>{assert.equal(isNewer('1.24.3','1.24.2'),true);assert.equal(isNewer('1.24.2','1.24.2'),false);assert.equal(isNewer('1.23.9','1.24.2'),false);assert.equal(isNewer('2.0.0','1.99.99'),true)});
test('formatters and thresholds preserve dashboard behavior',()=>{assert.equal(bytes(1024),'1.0 КБ');assert.equal(dur(3660),'1ч 1м');assert.equal(esc('<x>'),'&lt;x&gt;');assert.equal(clamp(120,0,100),100);assert.equal(lvl(95,80,90),'crit')});
test('markdown preserves supported structures and escaping',()=>{const html=renderMarkdown('## Заголовок\n\n**жирный**\n\n```js\nconst x=1;\n```');assert.match(html,/<h4>Заголовок<\/h4>/);assert.match(html,/<strong>жирный<\/strong>/);assert.match(html,/data-copy-code/);assert.match(renderMarkdown('<script>x<\/script>'),/&lt;script&gt;/)});
test('modular CSS stays pinned to the approved refactor baseline',()=>{const dir='public/css',text=fs.readdirSync(dir).filter(x=>x.endsWith('.css')).sort().map(x=>fs.readFileSync(path.join(dir,x),'utf8')).join('');assert.equal(crypto.createHash('sha256').update(text).digest('hex'),'ed9a972882e0b18d52affaf95b1f62e2440b7f5736dc36d1b483e6d4457adc1b')});
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

test('setup is authenticated and legacy settings route redirects into dashboard drawer',async()=>{await withServer(createApp({sessionResolver:()=>({sid:'test'})}),async base=>{assert.equal((await fetch(`${base}/setup`)).status,200);const settings=await fetch(`${base}/settings`,{redirect:'manual'});assert.equal(settings.status,302);assert.equal(settings.headers.get('location'),'/#settings')})});


test('full installer bundles pinned isolated Forge automation',()=>{
  const install=fs.readFileSync('deploy/install.sh','utf8'),forge=fs.readFileSync('deploy/install-forge.sh','utf8'),bridge=fs.readFileSync('deploy/forge/server.mjs','utf8'),context=fs.readFileSync('deploy/forge/context.sh','utf8');
  assert.match(install,/INSTALL_FORGE=1/);assert.match(install,/\.\/deploy\/install-forge\.sh/);assert.match(install,/--without-forge/);assert.match(forge,/v2026\.7\.30/);assert.match(forge,/cc4cab2f592e60a197e796506de9168f74baf3ea/);assert.match(forge,/sentinel-ai-bridge\.service/);assert.match(bridge,/projectFile/);assert.match(context,/discovery-settings\.json/);
  for(const file of ['deploy/install.sh','deploy/install-forge.sh','deploy/forge/context.sh','deploy/forge/sentinel-hermes'])assert.equal(spawnSync('bash',['-n',file]).status,0,file);
});

test('Forge project API is Discovery-managed instead of hardcoded',()=>{const source=fs.readFileSync('src/routes/api/agent.js','utf8');assert.match(source,/buildProjectGraph/);assert.match(source,/allowedScopes=new Set\(forgeProjects/);assert.doesNotMatch(source,/browser-mmo-90s/)});


test('Git activity collector and UI expose rich repository state',()=>{const collector=fs.readFileSync('bin/privileged-collector.js','utf8'),app=fs.readFileSync('public/app.js','utf8'),html=fs.readFileSync('public/index.html','utf8');for(const field of ['authorEmail','committedAt','parents','refs','dirtyCount','ahead','behind','upstream','remote'])assert.ok(collector.includes(field),field);assert.match(app,/openCommitDetail/);assert.match(app,/githubCommitUrl/);assert.match(html,/id="deployProject"/);assert.match(html,/id="deploySearch"/);assert.match(html,/id="deployMore"/)});


test('filesystem storage chart uses collector-backed distributions',()=>{const collector=fs.readFileSync('bin/privileged-collector.js','utf8'),service=fs.readFileSync('src/metrics/services/privileged.js','utf8'),ui=fs.readFileSync('public/js/filesystem.js','utf8'),html=fs.readFileSync('public/index.html','utf8');assert.match(collector,/distribution:\{roots:distributionRows\(rootUsage\),types:distributionRows\(typeUsage\)\}/);assert.match(service,/distribution: clean === '\/'/);assert.match(ui,/function renderStorage/);assert.match(html,/id="storageDonut"/);assert.match(html,/data-storage-mode="types"/)});


test('filesystem desktop layout is balanced and avoids the old right-side stack',()=>{const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/css/03-data.css','utf8');assert.doesNotMatch(html,/class="fs-aside"/);assert.match(html,/class="fs-support"/);assert.ok(html.indexOf('storage-panel')<html.indexOf('fs-browser-panel'));assert.match(css,/#s-filesystem \.storage-legend\{display:grid;grid-template-columns:repeat\(2/);assert.match(css,/#s-filesystem \.fs-support\{display:grid;grid-template-columns:/);assert.match(css,/#s-filesystem \.fs-browser-panel\{min-height:0\}/)});


test('metric drawers merge websocket history and redraw on every live render',()=>{const app=fs.readFileSync('public/app.js','utf8');assert.match(app,/function liveMetricRows/);assert.match(app,/function metricDetailRows/);assert.match(app,/function refreshMetricDetail/);assert.match(app,/renderKpis\(d\);\n  refreshMetricDetail\(\)/);assert.match(app,/обновление каждые 2 секунды/)});

test('filesystem indexing is low priority and no longer runs every ten minutes',()=>{const unit=fs.readFileSync('deploy/vps-sentinel-agent.service','utf8'),install=fs.readFileSync('deploy/install.sh','utf8');assert.match(unit,/Nice=10/);assert.match(unit,/IOSchedulingClass=idle/);assert.match(unit,/CPUWeight=10/);assert.match(unit,/IOWeight=10/);assert.match(install,/FS_INDEX_INTERVAL_MS=1800000/)});


test('operations layout fills full rows and all custom controls expose active states',()=>{const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/css/06-enhancements.css','utf8');assert.match(html,/ops-summary-wide/);assert.match(css,/#s-ops \.deploy-panel\{grid-column:1\/-1\}/);assert.match(css,/#s-ops \.ops-summary-wide\{grid-column:1\/-1\}/);assert.match(css,/:active:not\(:disabled\)/);assert.match(css,/:focus-visible/);assert.match(css,/:disabled/)});


test('Security odd row spans full width and pressed states never move controls',()=>{const html=fs.readFileSync('public/index.html','utf8'),dashboard=fs.readFileSync('public/css/06-enhancements.css','utf8'),setup=fs.readFileSync('public/setup.css','utf8');assert.match(html,/class="panel security-wide"/);assert.match(dashboard,/#s-sec \.security-wide\{grid-column:1\/-1\}/);assert.match(dashboard,/button:active:not\(:disabled\),a:active,\[role="button"\]:active\{transform:none!important/);assert.match(setup,/Complete interaction states/);assert.match(setup,/\.ui-button:active:not\(:disabled\)/);assert.match(setup,/transform:none!important/)});


test('design contract and in-dashboard settings drawer are bundled',()=>{const design=fs.readFileSync('design.md','utf8'),html=fs.readFileSync('public/index.html','utf8'),app=fs.readFileSync('public/app.js','utf8'),css=fs.readFileSync('public/css/08-settings-drawer.css','utf8');assert.match(design,/Pressed or active/);assert.match(design,/must never change position/);assert.match(fs.readFileSync('scripts/build-release.sh','utf8'),/README.md design.md LICENSE/);assert.match(html,/id="settingsPane"/);assert.match(html,/id="navScrim"/);assert.match(app,/createSettingsController/);assert.match(css,/Press feedback is color only|button:active/);assert.doesNotMatch(css,/active[^}]*translateY/)});


test('settings pane has width limits and its rail overlays the original sidebar',()=>{const panes=fs.readFileSync('public/js/panes.js','utf8'),html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/css/08-settings-drawer.css','utf8'),controller=fs.readFileSync('public/js/settings-pane.js','utf8');assert.match(panes,/settings: \{ min: 560, max: 920, fallback: 780 \}/);assert.ok(html.indexOf('id="settingsRail"')<html.indexOf('id="settingsPane"'));assert.match(html,/data-pane-kind="settings"/);assert.match(css,/\.settings-rail\{position:fixed;z-index:99;inset:0 auto 0 0;width:var\(--sidebar\)/);assert.match(css,/@media\(min-width:1101px\)\{\.settings-pane\{position:relative/);assert.doesNotMatch(css,/\.sidebar\{position:fixed!important/);assert.match(controller,/setRail\(true\)/)});


test('settings rail stays paired with pane, has icons, and never dims content',()=>{const html=fs.readFileSync('public/index.html','utf8'),controller=fs.readFileSync('public/js/settings-pane.js','utf8'),css=fs.readFileSync('public/css/08-settings-drawer.css','utf8');assert.match(html,/class="btn-icon side-settings-icon"/);assert.ok((html.match(/data-settings-nav=/g)||[]).length===6);assert.ok((html.match(/settings-rail[\s\S]*?<svg/g)||[]).length>=1);assert.match(controller,/function navigate\(id\).*highlight\(id\).*content\.scrollTo/);assert.doesNotMatch(controller,/function navigate\(id\).*setRail\(false\)/);assert.match(css,/settings-rail-scrim\{display:none!important\}/);assert.match(css,/nav-scrim\{background:transparent!important\}/)});


test('settings rail has no independent close path and gear matches logout geometry',()=>{const html=fs.readFileSync('public/index.html','utf8'),app=fs.readFileSync('public/app.js','utf8'),controller=fs.readFileSync('public/js/settings-pane.js','utf8'),css=fs.readFileSync('public/css/08-settings-drawer.css','utf8');assert.doesNotMatch(html,/settingsRailClose/);assert.doesNotMatch(html,/settingsRailToggle/);assert.doesNotMatch(app,/settingsRailClose|settingsRailToggle/);assert.match(controller,/async function open\(\).*setRail\(true\)/);assert.match(controller,/function close\(\)\{setRail\(false\);setWorkspacePane/);assert.match(css,/\.side-settings-icon\{box-sizing:border-box;width:29px;height:29px;[^}]*padding:6px/);assert.match(css,/\.side-settings-icon svg\{width:15px;height:15px\}/);assert.match(html,/class="brand settings-brand"/)});


test('settings motion matches ordinary panes and rail follows every pane switch',()=>{const panes=fs.readFileSync('public/js/panes.js','utf8'),css=fs.readFileSync('public/css/08-settings-drawer.css','utf8');assert.match(css,/settings-pane\{[^}]*flex-basis 340ms cubic-bezier\(\.16,1,\.3,1\)[^}]*transform 340ms/);assert.match(css,/settings-rail\{transition:transform 340ms cubic-bezier\(\.16,1,\.3,1\),opacity 180ms/);assert.match(css,/@media\(max-width:1100px\)[\s\S]*settings-pane\{transition:transform 280ms/);assert.match(panes,/if\(activeId!==['"]settingsPane['"]\)/);assert.match(panes,/rail\?\.classList\.remove\(['"]open['"]\)/);assert.match(panes,/setTimeout\(\(\) => window\.dispatchEvent\(new Event\(['"]resize['"]\)\), 360\)/)});


test('settings sidebar shares exact structural classes and active marker with main sidebar',()=>{const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/css/08-settings-drawer.css','utf8');assert.match(html,/class="settings-rail sidebar"/);assert.ok((html.match(/class="nav"/g)||[]).length>=2);assert.ok((html.match(/class="nav-item/g)||[]).length>=10);assert.match(html,/class="brand settings-brand"/);assert.match(html,/class="side-label">Разделы/);assert.match(html,/class="side-foot"/);assert.match(css,/settings-rail \.nav-item\.active\{color:var\(--accent\);background:rgba\(244,237,228,\.05\)\}/);assert.match(css,/settings-rail \.nav-item\.active::before/);assert.match(css,/settings-rail\.sidebar\{transition:transform 340ms/)});


test('settings sidebar scroll spy mirrors the dashboard navigation contract',()=>{const source=fs.readFileSync('public/js/settings-pane.js','utf8');assert.match(source,/function syncScrollSpy/);assert.match(source,/settingsDrawerContent.*addEventListener\('scroll'/);assert.match(source,/requestAnimationFrame/);assert.match(source,/navLockUntil/);assert.match(source,/scrollHeight-content\.clientHeight-content\.scrollTop<8/);assert.match(source,/function navigate\(id\).*content\.scrollTo/)});


test('storage chart is CSP-safe and realtime transport has a bounded polling fallback',()=>{const fsUi=fs.readFileSync('public/js/filesystem.js','utf8'),html=fs.readFileSync('public/index.html','utf8'),app=fs.readFileSync('public/app.js','utf8');assert.doesNotMatch(fsUi,/style=|\.style\./);assert.match(fsUi,/function drawStorageChart/);assert.match(html,/id="storageCanvas"/);assert.match(app,/function startSnapshotPolling/);assert.match(app,/pollTimer=setInterval\(pollSnapshot,2000\)/);assert.match(app,/retry<=3/);assert.match(app,/live · polling/)});

test('fleet and update UI ship clean UTF-8 copy and complete wiring',()=>{const paths=['public/index.html','public/setup.js','public/js/settings-pane.js','public/js/updates.js','bin/integration-config-broker.js'],files=paths.map(file=>fs.readFileSync(file,'utf8')).join('\n');assert.doesNotMatch(files,/\?{3,}/);assert.match(files,/id="updateOpen"/);assert.match(files,/data-pane-kind="update"/);assert.match(files,/configureFleet/);assert.match(files,/drawerFleetForm/);for(const stage of ['downloading','verifying','backup','installing','restarting','healthcheck','rollback','completed'])assert.match(files,new RegExp(stage));const lifecycle=fs.readFileSync('bin/sentinelctl','utf8'),updateRoute=fs.readFileSync('src/routes/api/updates.js','utf8');assert.doesNotMatch(lifecycle,/api\.github\.com\/repos\/\$repo\/releases\/latest/);assert.match(lifecycle,/github\.com\/\$repo\/releases\/latest/);assert.match(updateRoute,/if\(!release\.checkedAt\)release=await checkForUpdates\(\)/);const html=fs.readFileSync('public/index.html','utf8'),version=JSON.parse(fs.readFileSync('package.json','utf8')).version;assert.match(html,new RegExp(`style\\.css\\?v=${version}`));assert.match(html,new RegExp(`app\\.js\\?v=${version}`));const panes=fs.readFileSync('public/js/panes.js','utf8');assert.match(panes,/['"]updatePane['"]/);});
