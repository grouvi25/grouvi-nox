import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { createApp } from '../../src/app.js';

const app=createApp({sessionResolver:()=>({sid:'visual'}),apiAuth:(req,res,next)=>{req.session={sid:'visual',exp:Date.now()+3600000};next()}});
const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
async function pageAt(width=1440,height=900){const context=await browser.newContext({viewport:{width,height}});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(base,{waitUntil:'networkidle'});await page.waitForTimeout(350);assert.deepEqual(errors,[]);assert.ok(!(await page.locator('#incidentList').textContent()).includes('Ошибка загрузки'));return{page,context}}
try {
  const {page,context}=await pageAt();
  const chrome=await page.evaluate(()=>['.topbar','.forge-pane-head','.notify-pane-head','.detail-head'].map(selector=>document.querySelector(selector).getBoundingClientRect().height));
  assert.deepEqual(chrome,[56,56,56,56]);
  const kpis=await page.locator('.kpi').evaluateAll(items=>items.map(x=>Math.round(x.getBoundingClientRect().top)));
  assert.equal(new Set(kpis).size,1,'six KPI blocks must share one desktop row');
  await page.click('#forgeOpen');await page.waitForTimeout(420);
  assert.equal(await page.locator('#forgePane').evaluate(x=>x.classList.contains('open')),true);
  await context.close();

  const narrow=await pageAt(1280,900);await narrow.page.click('#forgeOpen');await narrow.page.evaluate(()=>{const pane=document.querySelector('#forgePane');pane.style.setProperty('--pane-width','640px');window.dispatchEvent(new Event('resize'))});await narrow.page.waitForTimeout(420);
  const geometry=await narrow.page.evaluate(()=>{const content=document.querySelector('.content');return{width:content.clientWidth,overflow:content.scrollWidth-content.clientWidth,headers:['#s-incidents','#s-filesystem','#s-ops'].map(s=>document.querySelector(s).getBoundingClientRect().width),pane:document.querySelector('#forgePane').getBoundingClientRect().width}});
  assert.equal(Math.round(geometry.pane),640);assert.ok(geometry.width>=400);assert.ok(geometry.overflow<=1,`workspace horizontal overflow ${geometry.overflow}`);assert.ok(geometry.headers.every(x=>x<=geometry.width));
  await narrow.context.close();
  console.log('visual layout contract: ok');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve))}
