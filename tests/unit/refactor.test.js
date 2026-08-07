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
