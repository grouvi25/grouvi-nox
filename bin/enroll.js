#!/usr/bin/env node
/**
 * Thin client for the running service.
 *
 * This process never touches state.json. It asks the service to do the work,
 * so there is exactly one writer and no chance of clobbering.
 */
import net from 'node:net';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = () => line('─'.repeat(72));

function ask(payload, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(config.adminSocket);
    let buf = '';
    const fail = (m) => { sock.destroy(); reject(new Error(m)); };

    sock.setTimeout(timeout, () => fail('timeout talking to vps-sentinel'));
    sock.on('error', (e) => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
        fail('service is not running (systemctl start vps-sentinel)');
      } else if (e.code === 'EACCES') {
        fail('permission denied - run as root');
      } else {
        fail(e.message);
      }
    });
    sock.on('connect', () => sock.write(`${JSON.stringify(payload)}\n`));
    sock.setEncoding('utf8');
    sock.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      sock.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
    });
    sock.on('close', () => { if (!buf) reject(new Error('no response from service')); });
  });
}

try {
  if (args.includes('--status')) {
    const r = await ask({ cmd: 'status' });
    rule();
    line('  VPS SENTINEL — состояние доступа');
    rule();
    line(`  Passkey-ключей:      ${r.credentials.length}`);
    for (const c of r.credentials) {
      line(`    • ${c.label} — создан ${c.createdAt}, вход ${c.lastUsedAt || 'ни разу'}`);
    }
    line(`  Активных сессий:     ${r.sessions}`);
    line(`  Кодов восстановления: ${r.recoveryLeft}`);
    line(`  Активных приглашений: ${r.pendingInvites}`);
    rule();
  } else if (args.includes('--revoke-sessions')) {
    const r = await ask({ cmd: 'revoke-sessions' });
    line(`Сброшено сессий: ${r.revoked}`);
  } else if (args.includes('--recovery')) {
    const r = await ask({ cmd: 'recovery' });
    rule();
    line('  КОДЫ ВОССТАНОВЛЕНИЯ (показываются один раз)');
    rule();
    for (const c of r.codes) line(`    ${c}`);
    rule();
    line('  Распечатай или положи в менеджер паролей.');
    line('  Каждый код одноразовый и позволяет привязать новый passkey.');
    rule();
  } else {
    const note = args.find(a => !a.startsWith('--')) || 'cli';
    const r = await ask({ cmd: 'enroll', note });
    rule();
    line('  ССЫЛКА ДЛЯ ПРИВЯЗКИ PASSKEY');
    rule();
    line(`  ${r.url}`);
    rule();
    line(`  Действует ${r.expiresInMin} минут, одноразовая.`);
    line(`  Уже привязано ключей: ${r.credentials}`);
    line('  Открой ссылку в браузере на том компьютере, с которого будешь заходить.');
    rule();
  }
} catch (e) {
  line(`Ошибка: ${e.message}`);
  process.exit(1);
}
