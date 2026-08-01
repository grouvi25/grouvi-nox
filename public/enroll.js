import { supported, platformAvailable, register, postJson } from '/webauthn.js';

const $ = (id) => document.getElementById(id);
const msg = $('msg');
const show = (kind, text) => { msg.className = `msg show ${kind}`; msg.textContent = text; };

const token = decodeURIComponent(location.hash.replace(/^#/, ''));

const ERRORS = {
  invalid_enrollment_token: 'Ссылка недействительна или уже использована. Сгенерируйте новую: npm run enroll',
  challenge_expired: 'Время ожидания истекло. Обновите страницу и попробуйте снова.',
  credential_already_registered: 'Этот ключ уже привязан к серверу.',
  verification_failed: 'Не удалось проверить ключ.',
  rate_limited: 'Слишком много попыток. Подождите немного.',
};

if (!token) {
  show('err', 'В ссылке нет кода приглашения. Сгенерируйте новую ссылку на сервере: npm run enroll');
  $('enrollBtn').disabled = true;
}

$('enrollBtn').addEventListener('click', async () => {
  const btn = $('enrollBtn');
  if (!supported()) {
    show('err', 'Браузер не поддерживает ключи доступа.');
    return;
  }
  btn.disabled = true;
  show('info', 'Ожидаю подтверждение Windows…');
  try {
    const options = await postJson('/auth/register/options', { token });
    const attestation = await register(options);
    await postJson('/auth/register/verify', {
      token,
      response: attestation,
      label: $('label').value.trim() || 'Ключ доступа',
    });
    show('ok', 'Ключ привязан. Открываю дашборд…');
    setTimeout(() => { location.href = '/'; }, 900);
  } catch (e) {
    if (e.name === 'NotAllowedError') show('err', 'Создание ключа отменено или истекло время.');
    else if (e.name === 'InvalidStateError') show('err', 'На этом устройстве ключ уже создан. Просто войдите через страницу входа.');
    else show('err', ERRORS[e.message] || `Ошибка: ${e.message}`);
    btn.disabled = false;
  }
});

(async () => {
  if (supported() && !(await platformAvailable())) {
    show('info', 'Встроенный аутентификатор Windows не найден. Можно использовать телефон или аппаратный ключ.');
  }
})();
