/* 管理台共用工具：API 呼叫、DOM 輔助、格式化。 */
import { t, locale } from './i18n.js';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.replace('/');
    throw new Error(t('common.notLoggedIn'));
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
  return Number(n || 0).toLocaleString(locale());
}

export function fmtTokens(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
}

export function fmtTime(ts) {
  if (!ts) return t('common.dash');
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

const STATUS_KEYS = { active: 'status.active', paused: 'status.paused', disabled: 'status.disabled', revoked: 'status.revoked' };
const STATUS_CLASS = { active: 'ok', paused: 'warn', disabled: '', revoked: 'danger' };

export function statusTag(status) {
  const label = STATUS_KEYS[status] ? esc(t(STATUS_KEYS[status])) : esc(status);
  return `<span class="tag ${STATUS_CLASS[status] ?? ''}">${label}</span>`;
}

const HEALTH_KEYS = { online: 'health.online', offline: 'health.offline', degraded: 'health.degraded', unknown: 'health.unknown' };
const HEALTH_CLASS = { online: 'ok', offline: 'danger', degraded: 'warn', unknown: '' };

export function healthText(state) {
  return HEALTH_KEYS[state] ? t(HEALTH_KEYS[state]) : String(state ?? '');
}

export function healthTag(state) {
  return `<span class="tag ${HEALTH_CLASS[state] ?? ''}">${esc(healthText(state))}</span>`;
}

const PRIORITY_KEYS = { admin: 'priority.admin', high: 'priority.high', normal: 'priority.normal', guest: 'priority.guest' };
export function priorityText(p) { return PRIORITY_KEYS[p] ? t(PRIORITY_KEYS[p]) : p; }

/** 星期的短名（表格用）與核取方塊標籤，兩者在不同語言長度不同，因此分開。 */
export function weekdayNames() {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => t('weekday.' + i));
}
export function weekdayLabel(i) { return t('weekdayLabel.' + i); }

export function weekdaysText(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(',').filter(Boolean).map(Number);
  if (arr.length === 7) return t('common.everyday');
  if (!arr.length) return t('common.notSet');
  const names = weekdayNames();
  return arr.sort((a, b) => a - b).map((d) => names[d]).join(t('common.listSep'));
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
      title: t('common.confirmTitle'),
      bodyHtml: `<p>${esc(text)}</p>`,
      footerHtml: `<button data-close>${esc(t('common.cancel'))}</button>`
        + `<button class="primary" data-ok>${esc(t('common.ok'))}</button>`,
      width: 440,
      onMount: (node, close) => {
        node.querySelector('[data-ok]').addEventListener('click', () => { close(); resolve(true); });
        node.querySelector('[data-close]').addEventListener('click', () => resolve(false));
      },
    });
  });
}
