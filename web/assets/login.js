/* 管理員登入。CSP 禁用 inline script，故獨立成檔。 */
import { initI18n, t } from './i18n.js';

initI18n({ docTitleKey: 'login.pageTitle' });

const form = document.getElementById('loginForm');
const msg = document.getElementById('msg');
const btn = document.getElementById('submitBtn');

function show(kind, text) {
  msg.innerHTML = `<div class="alert ${kind}"></div>`;
  msg.firstElementChild.textContent = text;
}

// 已登入就直接進管理台
fetch('/api/auth/me')
  .then((r) => r.json())
  .then((d) => { if (d.authenticated) location.replace('/app.html'); })
  .catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  btn.disabled = true;
  msg.innerHTML = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      show('error', data?.error?.message || t('login.failed'));
      btn.disabled = false;
      return;
    }
    if (data.mustChangePassword) sessionStorage.setItem('agibar_must_change_pw', '1');
    location.replace('/app.html');
  } catch (err) {
    show('error', t('login.netError', { msg: err.message }));
    btn.disabled = false;
  }
});
