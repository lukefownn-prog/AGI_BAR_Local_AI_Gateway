/* 管理台共用工具：API 呼叫、DOM 輔助、格式化。 */

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.replace('/');
    throw new Error('未登入');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

/** 一律以 textContent 寫入使用者資料，避免 XSS。 */
export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString('zh-TW');
}

export function fmtTokens(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
}

export function fmtTime(ts) {
  if (!ts) return '—';
  // SQLite 的 datetime('now') 是 UTC，補上 Z 才會正確轉本地時間
  const iso = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts;
  const d = new Date(iso);
  if (isNaN(d)) return ts;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtMs(ms) {
  const v = Number(ms || 0);
  if (v >= 1000) return (v / 1000).toFixed(1) + 's';
  return Math.round(v) + 'ms';
}

const STATUS_TEXT = { active: '啟用', paused: '暫停', disabled: '停用', revoked: '已撤銷' };
const STATUS_CLASS = { active: 'ok', paused: 'warn', disabled: '', revoked: 'danger' };

export function statusTag(status) {
  return `<span class="tag ${STATUS_CLASS[status] ?? ''}">${STATUS_TEXT[status] ?? esc(status)}</span>`;
}

const HEALTH_TEXT = { online: '線上', offline: '離線', degraded: '壅塞', unknown: '未檢查' };
const HEALTH_CLASS = { online: 'ok', offline: 'danger', degraded: 'warn', unknown: '' };

export function healthTag(state) {
  return `<span class="tag ${HEALTH_CLASS[state] ?? ''}">${HEALTH_TEXT[state] ?? esc(state)}</span>`;
}

const PRIORITY_TEXT = { admin: 'P0 管理員', high: 'P1 高', normal: 'P2 一般', guest: 'P3 訪客' };
export function priorityText(p) { return PRIORITY_TEXT[p] ?? p; }

export const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

export function weekdaysText(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(',').filter(Boolean).map(Number);
  if (arr.length === 7) return '每天';
  if (!arr.length) return '（未設定）';
  return arr.sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d]).join('、');
}

/** 通用對話框。回傳 { close() }。 */
export function modal({ title, bodyHtml, footerHtml = '', onMount, width }) {
  const host = document.getElementById('modalHost');
  const node = el(`
    <div class="modal-backdrop">
      <div class="modal" ${width ? `style="max-width:${width}px"` : ''}>
        <header><h3>${esc(title)}</h3><button class="sm" data-close>✕</button></header>
        <div class="body">${bodyHtml}</div>
        ${footerHtml ? `<footer>${footerHtml}</footer>` : ''}
      </div>
    </div>`);
  host.appendChild(node);

  const close = () => node.remove();
  node.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  node.addEventListener('click', (e) => { if (e.target === node) close(); });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });

  onMount?.(node, close);
  return { node, close };
}

export function toast(kind, text) {
  const box = el(`<div class="alert ${kind}" style="position:fixed;top:16px;right:16px;z-index:100;max-width:420px;box-shadow:0 6px 20px rgba(0,0,0,.15)">${esc(text)}</div>`);
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 4000);
}

export function confirmDialog(text) {
  return new Promise((resolve) => {
    modal({
      title: '請確認',
      bodyHtml: `<p>${esc(text)}</p>`,
      footerHtml: '<button data-close>取消</button><button class="primary" data-ok>確定</button>',
      width: 440,
      onMount: (node, close) => {
        node.querySelector('[data-ok]').addEventListener('click', () => { close(); resolve(true); });
        node.querySelector('[data-close]').addEventListener('click', () => resolve(false));
      },
    });
  });
}
