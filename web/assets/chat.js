/* 網頁聊天：人員以自己的 API Key 連線，走與外部工具相同的 /v1 管線。 */
import { esc, el, fmtTokens, modal, toast } from './api.js';

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
  messagesEl.innerHTML = '<div class="empty"><p class="muted small">對話已清除。</p></div>';
});

promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(180, promptEl.scrollHeight) + 'px';
});

promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', send);

if (getKey()) refreshMe(); else openKeyDialog();

async function refreshMe() {
  try {
    const res = await fetch('/v1/me', { headers: { Authorization: `Bearer ${getKey()}` } });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      whoLabel.textContent = e?.error?.message || 'API Key 無效';
      return false;
    }
    const d = await res.json();
    whoLabel.textContent = `${d.user.username}（${d.key.prefix}…）`;
    quotaTag.hidden = false;
    quotaTag.textContent = `今日剩餘 ${fmtTokens(d.usage.remainingDay)} Token`;
    quotaTag.className = 'tag ' + (d.usage.remainingDay <= 0 ? 'danger' : 'ok');
    return true;
  } catch (err) {
    whoLabel.textContent = '無法連線：' + err.message;
    return false;
  }
}

function openKeyDialog() {
  modal({
    title: '設定 API Key',
    width: 500,
    bodyHtml: `
      <p class="small muted">請輸入管理員配發給你的 API Key。Key 只會保存在這台瀏覽器的 localStorage。</p>
      <label class="field"><span>API Key</span>
        <input type="text" id="k" class="mono" placeholder="agi-bar-…" value="${esc(getKey())}"></label>
      <div class="alert info small">
        同一把 Key 也可用於 Cursor / Claude Code / Codex 等工具。<br>
        Base URL：<span class="mono">${esc(location.origin)}/v1</span>
      </div>`,
    footerHtml: '<button data-close>取消</button><button class="primary" data-save>儲存</button>',
    onMount: (node, close) => {
      node.querySelector('[data-save]').addEventListener('click', async () => {
        localStorage.setItem(KEY_STORE, node.querySelector('#k').value.trim());
        close();
        if (await refreshMe()) toast('ok', '已連線'); else toast('error', 'API Key 驗證失敗');
      });
    },
  });
}

function addMessage(role, text, cls = '') {
  document.getElementById('welcome')?.remove();
  messagesEl.querySelector('.empty')?.remove();
  const node = el(`
    <div class="msg ${role} ${cls}">
      <div class="avatar">${role === 'user' ? '我' : 'AI'}</div>
      <div><div class="text"></div><div class="meta"></div></div>
    </div>`);
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
    textEl.textContent = '錯誤：' + err.message;
    history.pop(); // 失敗的一輪不進上下文
  } finally {
    busy = false;
    sendBtn.disabled = false;
    promptEl.focus();
  }
}
