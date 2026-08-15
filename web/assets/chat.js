/* 網頁聊天：人員以自己的 API Key 連線，走與外部工具相同的 /v1 管線。 */
import { esc, el, fmtTokens, modal, toast } from './api.js';
import { initI18n, onLangChange, t } from './i18n.js';

initI18n({ docTitleKey: 'chat.pageTitle' });

const KEY_STORE = 'agibar_api_key';
const messagesEl = document.getElementById('messages');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('sendBtn');
const whoLabel = document.getElementById('whoLabel');
const quotaTag = document.getElementById('quotaTag');

let history = [];
let busy = false;

const getKey = () => localStorage.getItem(KEY_STORE) || '';

document.getElementById('keyBtn').addEventListener('click', openKeyDialog);
document.getElementById('clearBtn').addEventListener('click', () => {
  history = [];
  messagesEl.innerHTML = '<div class="empty"><p class="muted small" data-i18n="chat.cleared"></p></div>';
  messagesEl.querySelector('p').textContent = t('chat.cleared');
});

promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(180, promptEl.scrollHeight) + 'px';
});

promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', send);

// 切換語言後，已送出的對話內容保留，只重新翻譯介面上的固定文字。
onLangChange(() => {
  if (getKey()) refreshMe();
  messagesEl.querySelectorAll('.msg .avatar').forEach((a) => {
    a.textContent = a.parentElement.classList.contains('user') ? t('chat.avatarUser') : t('chat.avatarAi');
  });
});

if (getKey()) refreshMe(); else openKeyDialog();

async function refreshMe() {
  try {
    const res = await fetch('/v1/me', { headers: { Authorization: `Bearer ${getKey()}` } });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      whoLabel.textContent = e?.error?.message || t('chat.keyInvalid');
      return false;
    }
    const d = await res.json();
    whoLabel.textContent = `${d.user.username}（${d.key.prefix}…）`;
    quotaTag.hidden = false;
    quotaTag.textContent = t('chat.remaining', { n: fmtTokens(d.usage.remainingDay) });
    quotaTag.className = 'tag ' + (d.usage.remainingDay <= 0 ? 'danger' : 'ok');
    return true;
  } catch (err) {
    whoLabel.textContent = t('chat.cannotConnect', { msg: err.message });
    return false;
  }
}

function openKeyDialog() {
  modal({
    title: t('chat.keyTitle'),
    width: 500,
    bodyHtml: `
      <p class="small muted">${esc(t('chat.keyDesc'))}</p>
      <label class="field"><span>API Key</span>
        <input type="text" id="k" class="mono" placeholder="agi-bar-…" value="${esc(getKey())}"></label>
      <div class="alert info small">
        ${t('chat.keyInfo')}<br>
        ${esc(t('key.baseUrl'))}：<span class="mono">${esc(location.origin)}/v1</span>
      </div>`,
    footerHtml: `<button data-close>${esc(t('common.cancel'))}</button>`
      + `<button class="primary" data-save>${esc(t('common.save'))}</button>`,
    onMount: (node, close) => {
      node.querySelector('[data-save]').addEventListener('click', async () => {
        localStorage.setItem(KEY_STORE, node.querySelector('#k').value.trim());
        close();
        if (await refreshMe()) toast('ok', t('chat.connected')); else toast('error', t('chat.keyFailed'));
      });
    },
  });
}

function addMessage(role, text, cls = '') {
  document.getElementById('welcome')?.remove();
  messagesEl.querySelector('.empty')?.remove();
  const node = el(`
    <div class="msg ${role} ${cls}">
      <div class="avatar"></div>
      <div><div class="text"></div><div class="meta"></div></div>
    </div>`);
  node.querySelector('.avatar').textContent = role === 'user' ? t('chat.avatarUser') : t('chat.avatarAi');
  node.querySelector('.text').textContent = text;
  messagesEl.appendChild(node);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return node;
}

async function send() {
  if (busy) return;
  const text = promptEl.value.trim();
  if (!text) return;
  if (!getKey()) return openKeyDialog();

  busy = true;
  sendBtn.disabled = true;
  promptEl.value = '';
  promptEl.style.height = 'auto';

  addMessage('user', text);
  history.push({ role: 'user', content: text });

  const node = addMessage('assistant', '');
  const textEl = node.querySelector('.text');
  const metaEl = node.querySelector('.meta');
  textEl.classList.add('cursor');

  const t0 = Date.now();
  let answer = '';

  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getKey()}` },
      body: JSON.stringify({ model: 'agi-bar-default', messages: history, stream: true }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          if (obj.error) throw new Error(obj.error.message);
          const delta = obj?.choices?.[0]?.delta?.content;
          if (delta) {
            answer += delta;
            textEl.textContent = answer;
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }

    textEl.classList.remove('cursor');
    history.push({ role: 'assistant', content: answer });
    metaEl.textContent = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
    refreshMe();
  } catch (err) {
    textEl.classList.remove('cursor');
    node.classList.add('error');
    textEl.textContent = t('chat.error', { msg: err.message });
    history.pop(); // 失敗的一輪不進上下文
  } finally {
    busy = false;
    sendBtn.disabled = false;
    promptEl.focus();
  }
}
