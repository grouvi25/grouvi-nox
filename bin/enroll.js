#!/usr/bin/env node
import { config } from '../src/config.js';
import { load, get, save } from '../src/store.js';
import { createEnrollToken, generateRecoveryCodes, listCredentials } from '../src/auth.js';

const args = process.argv.slice(2);
load();

const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = () => line('─'.repeat(72));

if (args.includes('--status')) {
  const st = get();
  rule();
  line('  VPS SENTINEL — состояние доступа');
  rule();
  line(`  Passkey-ключей:      ${st.credentials.length}`);
  for (const c of st.credentials) {
    line(`    • ${c.label} — создан ${c.createdAt}, последний вход ${c.lastUsedAt || 'никогда'}`);
  }
  line(`  Активных сессий:     ${Object.keys(st.sessions).length}`);
  line(`  Кодов восстановления неиспользованных: ${st.recoveryCodes.filter(r => !r.usedAt).length}`);
  line(`  Активных приглашений: ${st.enrollTokens.filter(t => !t.usedAt && t.expiresAt > Date.now()).length}`);
  rule();
  process.exit(0);
}

if (args.includes('--revoke-sessions')) {
  const st = get();
  st.sessions = {};
  save();
  line('Все сессии сброшены.');
  process.exit(0);
}

if (args.includes('--recovery')) {
  const codes = generateRecoveryCodes(10);
  rule();
  line('  КОДЫ ВОССТАНОВЛЕНИЯ (показываются один раз)');
  rule();
  for (const c of codes) line(`    ${c}`);
  rule();
  line('  Распечатай или положи в менеджер паролей.');
  line('  Каждый код одноразовый и позволяет привязать новый passkey.');
  rule();
  process.exit(0);
}

const note = args.find(a => !a.startsWith('--')) || 'cli';
const token = createEnrollToken(note);
const minutes = Math.round(config.enrollTokenTtlMs / 60000);

rule();
line('  ССЫЛКА ДЛЯ ПРИВЯЗКИ PASSKEY');
rule();
line(`  ${config.origin}/enroll#${token}`);
rule();
line(`  Действует ${minutes} минут, одноразовая.`);
line(`  Уже привязано ключей: ${listCredentials().length}`);
line('  Открой ссылку в браузере на том компьютере, с которого будешь заходить.');
rule();
