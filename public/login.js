import { supported, authenticate, postJson } from '/webauthn.js';

const $ = (id) => document.getElementById(id);
const msg = $('msg');

function show(kind, text) {
  msg.className = `msg show ${kind}`;
  msg.textContent = text;
}

const ERRORS = {
  no_credentials_enrolled: 'На сервере ещё нет ни одного ключа. Выполните на сервере: npm run enroll',
  challenge_expired: 'Время ожидания истекло. Попробуйте ещё раз.',
  unknown_credential: 'Этот ключ не зарегистрирован на сервере.',
  verification_failed: 'Не удалось проверить подпись ключа.',
  counter_regression: 'Подозрительный ключ (счётчик откатился). Вход заблокирован.',
  rate_limited: 'Слишком много попыток. Подождите минуту.',
  invalid_code: 'Неверный или уже использованный код восстановления.',
};

async function doLogin() {
  const btn = $('loginBtn');
  if (!supported()) {
    show('err', 'Браузер не поддерживает ключи доступа. Нужен Chrome, Edge или Firefox свежей версии.');
    return;
  }
  btn.disabled = true;
  show('info', 'Ожидаю подтверждение Windows…');
  try {
    const options = await postJson('/auth/login/options');
    const assertion = await authenticate(options);
    await postJson('/auth/login/verify', { response: assertion });
    show('ok', 'Готово, открываю дашборд…');
    location.href = '/';
  } catch (e) {
    if (e.name === 'NotAllowedError') show('err', 'Подтверждение отменено или истекло время.');
    else show('err', ERRORS[e.message] || `Ошибка входа: ${e.message}`);
    btn.disabled = false;
  }
}

async function doRecover() {
  const btn = $('recoverBtn');
  const code = $('recoverCode').value.trim();
  if (!code) { show('err', 'Введите код восстановления.'); return; }
  btn.disabled = true;
  try {
    const r = await postJson('/auth/recover', { code });
    show('ok', 'Код принят. Открываю страницу привязки нового ключа…');
    setTimeout(() => { location.href = `/enroll#${r.token}`; }, 800);
  } catch (e) {
    show('err', ERRORS[e.message] || `Ошибка: ${e.message}`);
    btn.disabled = false;
  }
}

$('loginBtn').addEventListener('click', doLogin);
$('recoverBtn').addEventListener('click', doRecover);
$('recoverLink').addEventListener('click', () => {
  $('recoverBox').classList.toggle('hidden');
  $('recoverCode').focus();
});
$('recoverCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRecover(); });

(async () => {
  try {
    const r = await fetch('/auth/state', { credentials: 'same-origin' });
    const s = await r.json();
    if (s.authenticated) { location.href = '/'; return; }
    if (!s.enrolled) {
      show('info', 'Ни одного ключа ещё не привязано. На сервере выполните: cd /opt/vps-sentinel && npm run enroll');
      $('loginBtn').disabled = true;
    }
  } catch { /* ignore */ }
})();
