import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';
import { createApp } from '../../src/app.js';
import {discoveryPath,writeDiscoverySettings} from '../../src/discovery/store.js';
import {candidate} from '../../src/discovery/model.js';

const fixture=candidate({type:'project',key:'/srv/example',name:'example',path:'/srv/example',source:'fixture',confidence:.95,reasons:['git repository']});fs.mkdirSync(process.env.STATE_DIR,{recursive:true});fs.writeFileSync(discoveryPath,JSON.stringify({schema:1,generatedAt:Date.now(),summary:{project:1},items:[fixture],suggested:{},diagnostics:{itemCount:1}}));writeDiscoverySettings({complete:true,enabledIds:[fixture.id]});
const app=createApp({sessionResolver:()=>({sid:'visual'}),apiAuth:(req,res,next)=>{req.session={sid:'visual',exp:Date.now()+3600000};next()}});
const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
async function pageAt(width=1440,height=900){const context=await browser.newContext({viewport:{width,height}});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&message.text().includes('Content Security Policy'))errors.push(message.text())});await page.goto(base,{waitUntil:'networkidle'});await page.waitForTimeout(350);assert.deepEqual(errors,[]);assert.ok(!(await page.locator('#incidentList').textContent()).includes('Ошибка загрузки'));return{page,context}}
try {
  const {page,context}=await pageAt();
  const chrome=await page.evaluate(()=>['.topbar','.forge-pane-head','.notify-pane-head','.detail-head'].map(selector=>document.querySelector(selector).getBoundingClientRect().height));
  assert.deepEqual(chrome,[56,56,56,56]);
  const kpis=await page.locator('.kpi').evaluateAll(items=>items.map(x=>Math.round(x.getBoundingClientRect().top)));
  assert.equal(new Set(kpis).size,1,'six KPI blocks must share one desktop row');assert.equal(await page.locator('#s-discovery').count(),1);assert.ok(await page.locator('.project-workspace').count()>0);await page.locator('[data-project-id]').first().click();await page.waitForTimeout(250);assert.equal(await page.locator('#detailPane').evaluate(x=>x.classList.contains('open')),true);assert.equal(await page.locator('#detailType').textContent(),'Project workspace');
  await page.goto(`${base}/setup`,{waitUntil:'networkidle'});assert.equal(await page.locator('.setup-app').count(),1);await page.click('#nextBtn');await page.click('#nextBtn');assert.equal(await page.locator('#confidenceSelect').count(),1);assert.equal(await page.locator('#monitorNew').count(),1);await page.goto(`${base}/settings`,{waitUntil:'networkidle'});await page.waitForTimeout(350);assert.equal(await page.locator('#settingsPane').evaluate(x=>x.classList.contains('open')),true);assert.equal(await page.locator('#settingsRail').evaluate(x=>x.classList.contains('open')),true);assert.equal(await page.locator('.drawer-settings-section').count(),5);await page.locator('#drawer-ai').evaluate(x=>x.scrollIntoView({block:'start'}));await page.waitForTimeout(180);assert.equal(await page.locator('[data-settings-nav="ai"]').evaluate(x=>x.classList.contains('active')),true);await page.locator('#settingsDrawerContent').evaluate(x=>x.scrollTop=x.scrollHeight);await page.waitForTimeout(180);assert.equal(await page.locator('[data-settings-nav="security"]').evaluate(x=>x.classList.contains('active')),true);await page.click('#settingsClose');await page.waitForTimeout(380);assert.equal(await page.locator('#settingsPane').evaluate(x=>x.classList.contains('open')),false);assert.equal(await page.locator('#settingsRail').evaluate(x=>x.classList.contains('open')),false);await page.click('#forgeOpen');await page.waitForTimeout(420);
  assert.equal(await page.locator('#forgePane').evaluate(x=>x.classList.contains('open')),true);
  await context.close();

  const narrow=await pageAt(1280,900);await narrow.page.click('#forgeOpen');await narrow.page.evaluate(()=>{const pane=document.querySelector('#forgePane');pane.style.setProperty('--pane-width','640px');window.dispatchEvent(new Event('resize'))});await narrow.page.waitForTimeout(420);
  const geometry=await narrow.page.evaluate(()=>{const content=document.querySelector('.content');return{width:content.clientWidth,overflow:content.scrollWidth-content.clientWidth,headers:['#s-incidents','#s-filesystem','#s-ops'].map(s=>document.querySelector(s).getBoundingClientRect().width),pane:document.querySelector('#forgePane').getBoundingClientRect().width}});
  assert.equal(Math.round(geometry.pane),640);assert.ok(geometry.width>=400);assert.ok(geometry.overflow<=1,`workspace horizontal overflow ${geometry.overflow}`);assert.ok(geometry.headers.every(x=>x<=geometry.width));
  await narrow.context.close();
  console.log('visual layout contract: ok');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve))}
