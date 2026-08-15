import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

/* Every host in a fleet reports into the same Telegram chat, so a message that
   does not name its origin is guesswork. The label is applied once, centrally,
   so a send site added later cannot ship unlabelled. */

process.env.STATE_DIR = fs.mkdtempSync(path.join(tmpdir(), 'nox-notify-'));
process.env.SENTINEL_TELEGRAM_BOT_TOKEN = `1234567:${'A'.repeat(35)}`;
process.env.SENTINEL_TELEGRAM_CHAT_ID = '1045744857';
process.env.FLEET_NODE_NAME = 'Kooperativ MMO';
process.env.RP_ID = 'vps.kooperativ.space';

const {initDatabase} = await import('../../src/database.js');
initDatabase();
const {sendTelegramText, hostLine} = await import('../../src/notifier.js');

async function capture(text){
  const sent=[],realFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{sent.push(JSON.parse(init.body));return{ok:true,json:async()=>({ok:true})}};
  try{await sendTelegramText(text,{eventType:'test'})}finally{globalThis.fetch=realFetch}
  return sent;
}

test('every Telegram message names the host it came from',async()=>{
  const sent=await capture('🔴 <b>Новый инцидент</b>\nДиск / заполнен на 91%');
  assert.equal(sent.length,1,'one send, no retry');
  assert.ok(sent[0].text.startsWith('🖥 <b>Kooperativ MMO</b> · <code>vps.kooperativ.space</code>\n'),`message shipped unlabelled: ${sent[0].text}`);
  assert.match(sent[0].text,/Новый инцидент/,'the original body must survive the prefix');
  assert.match(sent[0].text,/Диск \/ заполнен на 91%/);
});

test('the label falls back to the domain and never repeats it',()=>{
  assert.match(hostLine(),/Kooperativ MMO/);
  assert.match(hostLine(),/vps\.kooperativ\.space/);
  const line=hostLine();
  assert.equal(line.indexOf('vps.kooperativ.space'),line.lastIndexOf('vps.kooperativ.space'),'a standalone host whose label is its domain must not print it twice');
});

test('the daily report links to its own dashboard, not to a hardcoded one',()=>{
  const report=fs.readFileSync(new URL('../../bin/daily-report.js',import.meta.url),'utf8');
  assert.match(report,/\$\{config\.origin\}/,'a node used to send a digest linking at the hub');
  assert.doesNotMatch(report,/https:\/\/vps\.grouvi\.online/);
});
