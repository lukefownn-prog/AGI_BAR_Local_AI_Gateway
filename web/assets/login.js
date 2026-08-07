/* 管理員登入。CSP 禁用 inline script，故獨立成檔。 */
const form = document.getElementById('loginForm');
const msg = document.getElementById('msg');
const btn = document.getElementById('submitBtn');

function show(kind, text) {
  msg.innerHTML = `<div class="alert ${kind}">${text}</div>`;
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
      show('error', data?.error?.message || '登入失敗');
      btn.disabled = false;
      return;
    }
    if (data.mustChangePassword) sessionStorage.setItem('agibar_must_change_pw', '1');
    location.replace('/app.html');
  } catch (err) {
    show('error', '無法連線到伺服器：' + err.message);
    btn.disabled = false;
  }
});
