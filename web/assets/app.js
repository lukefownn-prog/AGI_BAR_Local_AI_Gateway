/* AGI BAR 管理台。Hash 路由 + 逐頁渲染，無建置流程。 */
import { api, esc, el, fmtNum, fmtTokens, fmtTime, fmtMs, statusTag, healthTag, healthText,
         priorityText, weekdaysText, weekdayLabel, modal, toast, confirmDialog } from './api.js';
import { initI18n, onLangChange, t } from './i18n.js';

initI18n({ docTitleKey: 'app.pageTitle' });

const content = document.getElementById('content');
const pageTitle = document.getElementById('pageTitle');

const PAGES = {
  dashboard: { titleKey: 'page.dashboard', render: renderDashboard },
  users: { titleKey: 'page.users', render: renderUsers },
  keys: { titleKey: 'page.keys', render: renderKeys },
  models: { titleKey: 'page.models', render: renderModels },
  internet: { titleKey: 'page.internet', render: renderInternet },
  logs: { titleKey: 'page.logs', render: renderLogs },
  settings: { titleKey: 'page.settings', render: renderSettings },
};

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

let dashboardTimer = null;
let modelCache = [];
let currentUser = null;

// ---------------- 啟動 ----------------

(async function boot() {
  const me = await api('/api/auth/me');
  if (!me.authenticated) return location.replace('/');
  currentUser = me.user;
  renderWhoami();

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.replace('/');
  });

  window.addEventListener('hashchange', route);

  // 換語言時整頁重新渲染 —— 每個頁面都是純函式，直接重跑最單純也最不會漏翻。
  onLangChange(() => { renderWhoami(); route(); });

  route();

  if (sessionStorage.getItem('agibar_must_change_pw')) {
    sessionStorage.removeItem('agibar_must_change_pw');
    setTimeout(openPasswordDialog, 400);
  }
})();

function renderWhoami() {
  if (!currentUser) return;
  document.getElementById('whoami').textContent =
    t('app.whoami', { name: currentUser.displayName || currentUser.username });
}

function route() {
  const page = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  const def = PAGES[page] ?? PAGES.dashboard;
  pageTitle.textContent = t(def.titleKey);
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.page === (PAGES[page] ? page : 'dashboard'));
  });
  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  content.innerHTML = `<div class="empty">${esc(t('common.loading'))}</div>`;
  def.render().catch((e) => {
    content.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  });
}

// ================= 儀表板（規畫書 4）=================

async function renderDashboard() {
  const draw = async () => {
    const d = await api('/api/dashboard');
    document.getElementById('sideVersion').textContent = 'Node ' + d.system.nodeVersion;

    const vramClass = d.gpu.vramPercent > 85 ? 'danger' : d.gpu.vramPercent > 65 ? 'warn' : '';

    content.innerHTML = `
      <div class="cards">
        <div class="stat"><div class="label">${esc(t('dash.users'))}</div>
          <div class="value">${d.users.total}<small> / ${d.users.max}</small></div>
          <div class="hint">${esc(t('dash.usersHint', { n: d.users.online }))}</div></div>
        <div class="stat"><div class="label">${esc(t('dash.requests'))}</div>
          <div class="value">${fmtNum(d.requests.today)}</div>
          <div class="hint">${esc(t('dash.requestsHint', { n: d.requests.errorsToday }))}</div></div>
        <div class="stat"><div class="label">${esc(t('dash.tokens'))}</div>
          <div class="value">${fmtTokens(d.tokens.today)}</div>
          <div class="hint">${esc(t('dash.tokensHint'))}</div></div>
        <div class="stat"><div class="label">${esc(t('dash.queue'))}</div>
          <div class="value">${d.queue.waiting}<small>${esc(t('dash.queueUnit', { running: d.queue.running }))}</small></div>
          <div class="hint">${esc(t('dash.queueHint', { ms: fmtMs(d.queue.avgWaitMs) }))}</div></div>
        <div class="stat"><div class="label">${esc(t('dash.gpu'))}</div>
          <div class="value">${d.gpu.vramPercent}<small>%</small></div>
          <div class="bar mt" style="margin-top:6px"><i class="${vramClass}" style="width:${Math.min(100, d.gpu.vramPercent)}%"></i></div>
          <div class="hint">${fmtNum(d.gpu.vramUsedMb)} / ${fmtNum(d.gpu.vramTotalMb)} MB</div></div>
        <div class="stat"><div class="label">${esc(t('dash.primaryModel'))}</div>
          <div class="value" style="font-size:17px;padding-top:6px">${esc(d.primaryModel?.name || t('dash.noPrimary'))}</div>
          <div class="hint">${d.primaryModel ? healthTag(d.primaryModel.state) : esc(t('dash.noModelSet'))}</div></div>
        <div class="stat"><div class="label">${esc(t('dash.internet'))}</div>
          <div class="value" style="font-size:17px;padding-top:6px">
            ${d.internet.enabled
              ? `<span class="tag warn">${esc(t('dash.internetOpen'))}</span>`
              : `<span class="tag ok">${esc(t('dash.internetClosed'))}</span>`}
          </div>
          <div class="hint">${esc(d.internet.blockPrivateNetworks ? t('dash.privateBlocked') : t('dash.privateUnblocked'))}</div></div>
        <div class="stat"><div class="label">${esc(t('dash.uptime'))}</div>
          <div class="value" style="font-size:20px">${esc(uptimeText(d.system.uptimeSec))}</div>
          <div class="hint">${esc(t('dash.memFree', { n: fmtNum(d.system.memFreeMb) }))}</div></div>
      </div>

      <div class="panel">
        <header><h3>${esc(t('dash.modelPool'))}</h3>
          <button class="sm" id="hcBtn">${esc(t('dash.healthcheck'))}</button></header>
        <div class="body flush table-scroll">
          <table>
            <thead><tr>
              <th>${esc(t('th.model'))}</th><th>${esc(t('th.source'))}</th><th>${esc(t('th.state'))}</th>
              <th class="num">${esc(t('th.queue'))}</th>
              <th class="num">${esc(t('th.firstToken'))}</th><th class="num">${esc(t('th.tokensPerSec'))}</th>
              <th class="num">${esc(t('th.errorRate'))}</th><th>${esc(t('th.lastError'))}</th>
            </tr></thead>
            <tbody>${d.models.map((m) => `
              <tr>
                <td><b>${esc(m.name)}</b><div class="small muted mono">${esc(m.id)}</div></td>
                <td>${m.isLocal
                  ? `<span class="tag ok">${esc(t('tag.local'))}</span>`
                  : `<span class="tag warn">${esc(t('tag.external'))}</span>`}</td>
                <td>${m.enabled ? healthTag(m.state) : `<span class="tag">${esc(t('tag.disabledModel'))}</span>`}</td>
                <td class="num">${m.queueDepth}</td>
                <td class="num">${m.firstTokenMs ? fmtMs(m.firstTokenMs) : t('common.dash')}</td>
                <td class="num">${m.tokensPerSec || t('common.dash')}</td>
                <td class="num">${m.errorRate}%</td>
                <td class="small muted">${esc((m.lastError || '').slice(0, 60))}</td>
              </tr>`).join('') || `<tr><td colspan="8" class="empty">${esc(t('dash.noModels'))}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <header><h3>${esc(t('dash.connInfo'))}</h3></header>
        <div class="body">
          <p class="small muted">${esc(t('dash.connNote'))}</p>
          <table>
            <tr><th style="width:140px">${esc(t('dash.webui'))}</th><td class="mono">${d.system.lanUrls.map(esc).join('<br>') || `http://localhost:${d.system.port}`}</td></tr>
            <tr><th>${esc(t('dash.apiBase'))}</th><td class="mono">${(d.system.lanUrls.length ? d.system.lanUrls : [`http://localhost:${d.system.port}`]).map((u) => esc(u + '/v1')).join('<br>')}</td></tr>
            <tr><th>${esc(t('th.apiKey'))}</th><td>${t('dash.apiKeyRow')}</td></tr>
            <tr><th>${esc(t('dash.host'))}</th><td>${esc(d.system.hostname)}　<span class="muted small">${esc(d.system.platform)}</span></td></tr>
          </table>

          <div class="mt">
            <b class="small">${esc(t('dash.fwTitle'))}</b>
            <p class="small muted" style="margin:4px 0 8px">${t('dash.fwDesc')}</p>
            <div class="keybox" id="fwCmd">${esc(firewallCommand(d.system.port))}</div>
            <div class="btn-row mt">
              <button class="sm" id="copyFwBtn">${esc(t('dash.fwCopy'))}</button>
            </div>
            <p class="small muted mt mb0">${t('dash.fwNote')}</p>
          </div>
        </div>
      </div>`;

    document.getElementById('copyFwBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(firewallCommand(d.system.port));
        toast('ok', t('dash.fwCopied'));
      } catch { toast('warn', t('common.copyFailed')); }
    });

    document.getElementById('hcBtn').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await api('/api/models/healthcheck', { method: 'POST' }); await draw(); toast('ok', t('dash.healthcheckDone')); }
      catch (err) { toast('error', err.message); }
    });
  };

  await draw();
  dashboardTimer = setInterval(() => { draw().catch(() => {}); }, 10000);
}

/**
 * 放行連接埠的防火牆指令。
 *
 * 這是區網連不上時最常見、也最不容易自己想到的原因 —— 服務跑得好好的、
 * IP 也對，就是連不進來，而畫面上沒有任何線索。把指令直接放在連線資訊旁邊，
 * 管理員複製貼上就能解決。
 */
function firewallCommand(port) {
  return `New-NetFirewallRule -DisplayName "AGI BAR" -Direction Inbound -LocalPort ${port} -Protocol TCP -Action Allow -Profile Private`;
}

function uptimeText(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return t('uptime.dh', { d, h });
  if (h) return t('uptime.hm', { h, m });
  return t('uptime.m', { m });
}

// ================= 人員（規畫書 5）=================

async function renderUsers() {
  const { users } = await api('/api/users');
  const nonAdmin = users.filter((u) => u.role !== 'admin').length;

  content.innerHTML = `
    <div class="panel">
      <header>
        <h3>${esc(t('users.title'))}　<span class="muted small">${esc(t('users.count', { n: nonAdmin }))}</span></h3>
        <button class="primary" id="addUser">${esc(t('users.add'))}</button>
      </header>
      <div class="body flush table-scroll">
        <table>
          <thead><tr>
            <th>${esc(t('th.account'))}</th><th>${esc(t('th.name'))}</th><th>${esc(t('th.role'))}</th>
            <th>${esc(t('th.state'))}</th>
            <th class="num">${esc(t('th.apiKey'))}</th><th class="num">${esc(t('th.tokensToday'))}</th>
            <th>${esc(t('th.lastUsed'))}</th><th></th>
          </tr></thead>
          <tbody>${users.map((u) => `
            <tr>
              <td class="mono">${esc(u.username)}</td>
              <td>${esc(u.display_name || t('common.dash'))}</td>
              <td>${u.role === 'admin'
                ? `<span class="tag info">${esc(t('role.admin'))}</span>`
                : esc(t('role.user'))}</td>
              <td>${statusTag(u.status)}</td>
              <td class="num">${u.active_keys}</td>
              <td class="num">${fmtTokens(u.tokens_today)}</td>
              <td class="small muted nowrap">${fmtTime(u.last_seen_at)}</td>
              <td class="right nowrap">
                <button class="sm" data-detail="${u.id}">${esc(t('common.manage'))}</button>
                ${u.role === 'admin' ? '' : `<button class="sm danger" data-del="${u.id}">${esc(t('common.delete'))}</button>`}
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  document.getElementById('addUser').addEventListener('click', () => openUserDialog(nonAdmin));
  content.querySelectorAll('[data-detail]').forEach((b) =>
    b.addEventListener('click', () => openUserDetail(Number(b.dataset.detail))));
  content.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!await confirmDialog(t('users.delConfirm'))) return;
      try { await api(`/api/users/${b.dataset.del}`, { method: 'DELETE' }); toast('ok', t('common.deleted')); renderUsers(); }
      catch (e) { toast('error', e.message); }
    }));
}

async function openUserDialog(currentCount) {
  if (currentCount >= 50) return toast('error', t('users.limitReached'));
  await ensureModels();

  modal({
    title: t('users.newTitle'),
    width: 680,
    bodyHtml: `
      <div class="grid-2">
        <label class="field"><span>${esc(t('form.username'))}</span>
          <input type="text" id="f_username" placeholder="${esc(t('form.usernamePh'))}"></label>
        <label class="field"><span>${esc(t('form.displayName'))}</span><input type="text" id="f_display"></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>${esc(t('form.email'))}</span><input type="email" id="f_email"></label>
        <label class="field"><span>${esc(t('form.status'))}</span>
          <select id="f_status">
            <option value="active">${esc(t('status.active'))}</option>
            <option value="paused">${esc(t('status.paused'))}</option>
            <option value="disabled">${esc(t('status.disabled'))}</option>
          </select>
        </label>
      </div>
      ${limitsFormHtml()}
      <label class="field"><span>${esc(t('form.route'))}</span>
        <div id="routePicker"></div>
        <span class="small muted">${esc(t('form.routeHint'))}</span>
      </label>
      <div class="alert info small">${esc(t('users.createNote'))}</div>`,
    footerHtml: `<button data-close>${esc(t('common.cancel'))}</button>`
      + `<button class="primary" data-save>${esc(t('users.createBtn'))}</button>`,
    onMount: (node, close) => {
      mountRoutePicker(node.querySelector('#routePicker'), []);
      node.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          const res = await api('/api/users', {
            method: 'POST',
            body: {
              username: node.querySelector('#f_username').value.trim(),
              displayName: node.querySelector('#f_display').value.trim(),
              email: node.querySelector('#f_email').value.trim(),
              status: node.querySelector('#f_status').value,
              limits: readLimitsForm(node),
              route: readRoutePicker(node.querySelector('#routePicker')),
              createKey: true,
            },
          });
          close();
          if (res.key?.plaintext) showKeyOnce(res.key.plaintext, res.user.username);
          renderUsers();
        } catch (e) { toast('error', e.message); }
      });
    },
  });
}

async function openUserDetail(userId) {
  await ensureModels();
  const d = await api(`/api/users/${userId}`);
  const u = d.user;

  modal({
    title: t('detail.title', { name: u.username }),
    width: 780,
    bodyHtml: `
      <div class="cards" style="grid-template-columns:repeat(3,1fr)">
        <div class="stat"><div class="label">${esc(t('detail.tokensToday'))}</div><div class="value">${fmtTokens(d.usage.today)}</div></div>
        <div class="stat"><div class="label">${esc(t('detail.tokensMonth'))}</div><div class="value">${fmtTokens(d.usage.month)}</div></div>
        <div class="stat"><div class="label">${esc(t('detail.tokensTotal'))}</div><div class="value">${fmtTokens(d.usage.total)}</div></div>
      </div>

      <div class="grid-2">
        <label class="field"><span>${esc(t('form.displayName'))}</span><input type="text" id="u_display" value="${esc(u.display_name)}"></label>
        <label class="field"><span>${esc(t('form.status'))}</span>
          <select id="u_status">
            <option value="active" ${u.status === 'active' ? 'selected' : ''}>${esc(t('status.active'))}</option>
            <option value="paused" ${u.status === 'paused' ? 'selected' : ''}>${esc(t('status.paused'))}</option>
            <option value="disabled" ${u.status === 'disabled' ? 'selected' : ''}>${esc(t('status.disabled'))}</option>
          </select></label>
      </div>
      <label class="field"><span>${esc(t('form.note'))}</span><input type="text" id="u_note" value="${esc(u.note)}"></label>

      <label class="field"><span>${esc(t('form.route'))}</span><div id="routePicker"></div></label>

      <div class="panel" style="margin-top:8px">
        <header><h3>${esc(t('th.apiKey'))}</h3>
          <button class="sm primary" data-newkey>${esc(t('detail.newKey'))}</button></header>
        <div class="body flush table-scroll">
          <table><thead><tr>
            <th>${esc(t('th.ident'))}</th><th>${esc(t('th.keyName'))}</th><th>${esc(t('th.state'))}</th>
            <th>${esc(t('th.priority'))}</th><th>${esc(t('th.perDay'))}</th><th></th>
          </tr></thead>
          <tbody>${d.keys.map((k) => `
            <tr>
              <td class="mono small">${esc(k.key_prefix)}…${esc(k.last4)}</td>
              <td>${esc(k.name)}</td>
              <td>${statusTag(k.status)}</td>
              <td class="small">${esc(priorityText(k.priority))}</td>
              <td class="num small">${fmtTokens(k.tokens_per_day)}</td>
              <td class="right nowrap">
                <button class="sm" data-limits="${k.id}">${esc(t('btn.quota'))}</button>
                <button class="sm" data-rotate="${k.id}">${esc(t('btn.rotate'))}</button>
                ${k.status === 'revoked' ? '' : `<button class="sm danger" data-revoke="${k.id}">${esc(t('btn.revoke'))}</button>`}
              </td>
            </tr>`).join('') || `<tr><td colspan="6" class="empty">${esc(t('detail.noKeys'))}</td></tr>`}
          </tbody></table>
        </div>
      </div>`,
    footerHtml: `<button data-close>${esc(t('common.close'))}</button>`
      + `<button class="primary" data-save>${esc(t('detail.saveChanges'))}</button>`,
    onMount: (node, close) => {
      mountRoutePicker(node.querySelector('#routePicker'), d.route.map((r) => r.model_id));

      node.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          await api(`/api/users/${userId}`, {
            method: 'PATCH',
            body: {
              displayName: node.querySelector('#u_display').value,
              status: node.querySelector('#u_status').value,
              note: node.querySelector('#u_note').value,
            },
          });
          await api(`/api/users/${userId}/route`, {
            method: 'PUT',
            body: { route: readRoutePicker(node.querySelector('#routePicker')) },
          });
          close(); toast('ok', t('common.saved')); renderUsers();
        } catch (e) { toast('error', e.message); }
      });

      node.querySelector('[data-newkey]').addEventListener('click', async () => {
        try {
          const r = await api(`/api/users/${userId}/keys`, { method: 'POST', body: { name: 'key-' + Date.now().toString(36) } });
          close(); showKeyOnce(r.key.plaintext, u.username);
        } catch (e) { toast('error', e.message); }
      });

      node.querySelectorAll('[data-rotate]').forEach((b) => b.addEventListener('click', async () => {
        if (!await confirmDialog(t('detail.rotateConfirm'))) return;
        try {
          const r = await api(`/api/keys/${b.dataset.rotate}/rotate`, { method: 'POST' });
          close(); showKeyOnce(r.key.plaintext, u.username);
        } catch (e) { toast('error', e.message); }
      }));

      node.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
        if (!await confirmDialog(t('detail.revokeConfirm'))) return;
        try {
          await api(`/api/keys/${b.dataset.revoke}`, { method: 'PATCH', body: { status: 'revoked' } });
          close(); toast('ok', t('common.revoked')); openUserDetail(userId);
        } catch (e) { toast('error', e.message); }
      }));

      node.querySelectorAll('[data-limits]').forEach((b) => b.addEventListener('click', () => {
        const key = d.keys.find((k) => k.id === Number(b.dataset.limits));
        close(); openLimitsDialog(key, () => openUserDetail(userId));
      }));
    },
  });
}

function showKeyOnce(plaintext, username) {
  modal({
    title: t('key.createdTitle'),
    width: 560,
    bodyHtml: `
      <div class="alert warn">${t('key.onceWarn')}</div>
      <p class="small muted">${esc(t('key.forUser', { name: username }))}</p>
      <div class="keybox" id="keyText">${esc(plaintext)}</div>
      <div class="btn-row mt"><button class="primary" id="copyKey">${esc(t('key.copyBtn'))}</button></div>
      <div class="mt small muted">
        <b>${esc(t('key.clientSetup'))}</b><br>
        ${esc(t('key.baseUrl'))}：<span class="mono">${esc(location.origin)}/v1</span><br>
        ${esc(t('key.keyIsAbove'))}
      </div>`,
    footerHtml: `<button class="primary" data-close>${esc(t('key.doneBtn'))}</button>`,
    onMount: (node) => {
      node.querySelector('#copyKey').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(plaintext); toast('ok', t('common.copied')); }
        catch { toast('warn', t('common.copyFailed')); }
      });
    },
  });
}

// ---------------- 配額表單（規畫書 5 / 6）----------------

function limitsFormHtml(v = {}) {
  const g = (k, d) => (v[k] !== undefined && v[k] !== null ? v[k] : d);
  const wd = Array.isArray(v.weekdays) ? v.weekdays
    : String(v.weekdays ?? '1,2,3,4,5').split(',').filter(Boolean).map(Number);
  return `
    <div class="grid-3">
      <label class="field"><span>${esc(t('lim.perRequest'))}</span><input type="number" id="l_perReq" value="${g('tokensPerRequest', 8192)}"></label>
      <label class="field"><span>${esc(t('lim.perHour'))}</span><input type="number" id="l_hour" value="${g('tokensPerHour', 100000)}"></label>
      <label class="field"><span>${esc(t('lim.perDay'))}</span><input type="number" id="l_day" value="${g('tokensPerDay', 500000)}"></label>
    </div>
    <div class="grid-3">
      <label class="field"><span>${esc(t('lim.perMonth'))}</span><input type="number" id="l_month" value="${g('tokensPerMonth', 5000000)}"></label>
      <label class="field"><span>${esc(t('lim.rpm'))}</span><input type="number" id="l_rpm" value="${g('rpm', 20)}"></label>
      <label class="field"><span>${esc(t('lim.concurrent'))}</span><input type="number" id="l_conc" value="${g('concurrent', 2)}"></label>
    </div>
    <div class="grid-3">
      <label class="field"><span>${esc(t('lim.priority'))}</span>
        <select id="l_priority">
          ${['admin', 'high', 'normal', 'guest'].map((p) =>
            `<option value="${p}" ${g('priority', 'normal') === p ? 'selected' : ''}>${esc(priorityText(p))}</option>`).join('')}
        </select></label>
      <label class="field"><span>${esc(t('lim.overQuota'))}</span>
        <select id="l_policy">
          <option value="hard" ${g('overQuotaPolicy', 'hard') === 'hard' ? 'selected' : ''}>${esc(t('lim.hard'))}</option>
          <option value="soft" ${g('overQuotaPolicy', 'hard') === 'soft' ? 'selected' : ''}>${esc(t('lim.soft'))}</option>
        </select></label>
      <label class="field"><span>${esc(t('lim.internet'))}</span>
        <select id="l_internet">
          <option value="0" ${!g('internetAllowed', false) ? 'selected' : ''}>${esc(t('lim.internetDeny'))}</option>
          <option value="1" ${g('internetAllowed', false) ? 'selected' : ''}>${esc(t('lim.internetAllow'))}</option>
        </select></label>
    </div>
    <div class="grid-2">
      <label class="field"><span>${esc(t('lim.validFrom'))}</span><input type="date" id="l_from" value="${g('validFrom', '') ?? ''}"></label>
      <label class="field"><span>${esc(t('lim.validUntil'))}</span><input type="date" id="l_until" value="${g('validUntil', '') ?? ''}"></label>
    </div>
    <div class="grid-2">
      <label class="field"><span>${esc(t('lim.windowStart'))}</span><input type="time" id="l_ws" value="${g('dailyWindowStart', '08:00')}"></label>
      <label class="field"><span>${esc(t('lim.windowEnd'))}</span><input type="time" id="l_we" value="${g('dailyWindowEnd', '22:00')}"></label>
    </div>
    <label class="field"><span>${esc(t('lim.weekdays'))}</span>
      <div class="checks">${WEEKDAYS.map((i) =>
        `<label><input type="checkbox" class="l_wd" value="${i}" ${wd.includes(i) ? 'checked' : ''}>${esc(weekdayLabel(i))}</label>`).join('')}</div>
    </label>`;
}

function readLimitsForm(node) {
  const q = (id) => node.querySelector('#' + id);
  return {
    tokensPerRequest: Number(q('l_perReq').value),
    tokensPerHour: Number(q('l_hour').value),
    tokensPerDay: Number(q('l_day').value),
    tokensPerMonth: Number(q('l_month').value),
    rpm: Number(q('l_rpm').value),
    concurrent: Number(q('l_conc').value),
    priority: q('l_priority').value,
    overQuotaPolicy: q('l_policy').value,
    internetAllowed: q('l_internet').value === '1',
    validFrom: q('l_from').value || null,
    validUntil: q('l_until').value || null,
    dailyWindowStart: q('l_ws').value || '00:00',
    dailyWindowEnd: q('l_we').value || '23:59',
    weekdays: [...node.querySelectorAll('.l_wd:checked')].map((c) => Number(c.value)),
  };
}

function openLimitsDialog(key, onDone) {
  const current = {
    tokensPerRequest: key.tokens_per_request, tokensPerHour: key.tokens_per_hour,
    tokensPerDay: key.tokens_per_day, tokensPerMonth: key.tokens_per_month,
    rpm: key.rpm, concurrent: key.concurrent, priority: key.priority,
    internetAllowed: !!key.internet_allowed, validFrom: key.valid_from, validUntil: key.valid_until,
    dailyWindowStart: key.daily_window_start, dailyWindowEnd: key.daily_window_end,
    weekdays: String(key.weekdays || '').split(',').filter(Boolean).map(Number),
    overQuotaPolicy: key.over_quota_policy,
  };
  modal({
    title: t('lim.dialogTitle', { key: `${key.key_prefix}…${key.last4}` }),
    width: 720,
    bodyHtml: limitsFormHtml(current),
    footerHtml: `<button data-close>${esc(t('common.cancel'))}</button>`
      + `<button class="primary" data-save>${esc(t('common.save'))}</button>`,
    onMount: (node, close) => {
      node.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          await api(`/api/keys/${key.id}`, { method: 'PATCH', body: { limits: readLimitsForm(node) } });
          close(); toast('ok', t('lim.updated')); onDone?.();
        } catch (e) { toast('error', e.message); }
      });
    },
  });
}

// ---------------- 模型路由選擇器 ----------------

async function ensureModels() {
  if (!modelCache.length) modelCache = (await api('/api/models')).models;
  return modelCache;
}

function mountRoutePicker(host, selected) {
  const chain = [...selected];
  const draw = () => {
    host.innerHTML = `
      <div style="border:1px solid var(--line);border-radius:8px;padding:10px">
        ${chain.map((id, i) => {
          const m = modelCache.find((x) => x.id === id);
          return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0">
            <span class="tag info">${esc(t('route.rank', { n: i + 1 }))}</span>
            <span style="flex:1">${esc(m?.display_name || id)}</span>
            <button class="sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="sm" data-down="${i}" ${i === chain.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="sm danger" data-rm="${i}">${esc(t('route.remove'))}</button>
          </div>`;
        }).join('') || `<div class="small muted" style="padding:4px 0">${esc(t('route.empty'))}</div>`}
        <div style="display:flex;gap:8px;margin-top:8px">
          <select data-add style="flex:1">
            <option value="">${esc(t('route.addPlaceholder'))}</option>
            ${modelCache.filter((m) => !chain.includes(m.id)).map((m) =>
              `<option value="${esc(m.id)}">${esc(m.display_name)}${m.is_local ? '' : esc(t('route.suffixExternal'))}${m.enabled ? '' : esc(t('route.suffixDisabled'))}</option>`).join('')}
          </select>
        </div>
      </div>`;
    host.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { chain.splice(Number(b.dataset.rm), 1); draw(); }));
    host.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.up); [chain[i - 1], chain[i]] = [chain[i], chain[i - 1]]; draw();
    }));
    host.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.down); [chain[i + 1], chain[i]] = [chain[i], chain[i + 1]]; draw();
    }));
    host.querySelector('[data-add]').addEventListener('change', (e) => {
      if (e.target.value) { chain.push(e.target.value); draw(); }
    });
  };
  host._chain = chain;
  draw();
}

function readRoutePicker(host) { return host._chain ?? []; }

// ================= API Key 總表 =================

async function renderKeys() {
  const [{ keys }, net] = await Promise.all([api('/api/keys'), api('/api/network')]);
  content.innerHTML = `
    <div class="panel" id="netPanel"></div>
    <div class="panel">
      <header><h3>${esc(t('keys.allTitle'))}</h3></header>
      <div class="body flush table-scroll">
        <table>
          <thead><tr>
            <th>${esc(t('th.prefix'))}</th><th>${esc(t('th.user'))}</th><th>${esc(t('th.keyName'))}</th>
            <th>${esc(t('th.state'))}</th><th>${esc(t('th.priority'))}</th>
            <th class="num">${esc(t('th.tokensPerDay'))}</th><th class="num">${esc(t('th.rpm'))}</th>
            <th>${esc(t('th.window'))}</th><th>${esc(t('th.expiry'))}</th><th>${esc(t('th.internet'))}</th>
            <th>${esc(t('th.lastUsed'))}</th>
          </tr></thead>
          <tbody>${keys.map((k) => `
            <tr>
              <td class="mono small">${esc(k.key_prefix)}…${esc(k.last4)}</td>
              <td>${esc(k.display_name || k.username)}<div class="small muted mono">${esc(k.username)}</div></td>
              <td class="small">${esc(k.name)}</td>
              <td>${statusTag(k.status)}</td>
              <td class="small">${esc(priorityText(k.priority))}</td>
              <td class="num">${fmtTokens(k.tokens_per_day)}</td>
              <td class="num">${k.rpm}</td>
              <td class="small nowrap">${esc(k.daily_window_start)}-${esc(k.daily_window_end)}<div class="muted">${esc(weekdaysText(k.weekdays))}</div></td>
              <td class="small nowrap">${k.valid_until ? esc(k.valid_until) : esc(t('keys.noExpiry'))}</td>
              <td>${k.internet_allowed
                ? `<span class="tag warn">${esc(t('keys.allow'))}</span>`
                : `<span class="tag">${esc(t('keys.deny'))}</span>`}</td>
              <td class="small muted nowrap">${fmtTime(k.last_used_at)}</td>
            </tr>`).join('') || `<tr><td colspan="11" class="empty">${esc(t('keys.empty'))}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;

  renderNetworkPanel(document.getElementById('netPanel'), net);
}

const ADDR_PREF = 'agibar_preferred_address';

/**
 * 連線資訊面板。
 *
 * 存在的理由：管理員要把網址給人員，但這台機器可能有好幾個 IP
 * （Wi-Fi、有線、WSL、Hyper-V），而且換個網路環境就會變。
 * 每次進來重新偵測，並讓管理員自己挑一個，避免把虛擬網卡的位址發出去。
 */
function renderNetworkPanel(host, net) {
  const saved = localStorage.getItem(ADDR_PREF);
  const chosen = net.addresses.find((a) => a.address === saved) ?? net.addresses.find((a) => !a.virtual) ?? net.addresses[0];

  if (!chosen) {
    host.innerHTML = `
      <header><h3>${esc(t('net.title'))}</h3>
        <button class="sm" id="redetectBtn">${esc(t('net.redetectShort'))}</button></header>
      <div class="body"><div class="alert warn">${esc(t('net.noAddress'))}</div></div>`;
    host.querySelector('#redetectBtn').addEventListener('click', () => renderKeys());
    return;
  }

  const base = chosen.url;
  const rows = [
    { label: t('net.rowChat'), url: `${base}/chat.html`, hint: t('net.rowChatHint') },
    { label: t('net.rowApi'), url: `${base}/v1`, hint: t('net.rowApiHint') },
    { label: t('net.rowClaude'), url: base, hint: t('net.rowClaudeHint') },
  ];

  host.innerHTML = `
    <header>
      <h3>${esc(t('net.title'))}　<span class="muted small">${esc(t('net.subtitle'))}</span></h3>
      <button class="primary" id="redetectBtn">${esc(t('net.redetect'))}</button>
    </header>
    <div class="body">
      ${net.addresses.length > 1 ? `
        <label class="field"><span>${esc(t('net.pick', { n: net.addresses.length }))}</span>
          <select id="addrPick">
            ${net.addresses.map((a) => `
              <option value="${esc(a.address)}" ${a.address === chosen.address ? 'selected' : ''}>
                ${esc(a.address)} — ${esc(a.name)}${a.virtual ? esc(t('net.virtualSuffix')) : ''}
              </option>`).join('')}
          </select>
        </label>` : ''}
      ${chosen.virtual ? `<div class="alert warn small">${t('net.virtualWarn')}</div>` : ''}

      <div class="table-scroll">
        <table>
          <thead><tr><th style="width:190px">${esc(t('th.purpose'))}</th><th>${esc(t('th.url'))}</th><th style="width:80px"></th></tr></thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr>
                <td>${esc(r.label)}<div class="small muted">${esc(r.hint)}</div></td>
                <td class="mono" style="word-break:break-all">${esc(r.url)}</td>
                <td class="right"><button class="sm" data-copy="${i}">${esc(t('common.copy'))}</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="btn-row mt">
        <button id="copyAllBtn">${esc(t('net.copyAll'))}</button>
        <a class="btn" href="${esc(base)}/chat.html" target="_blank">${esc(t('net.openChat'))}</a>
      </div>
      <p class="small muted mt mb0">
        ${esc(t('net.footer', { host: net.hostname, port: net.port, time: fmtTime(net.detectedAt) }))}
        <br>${esc(t('net.footer2'))}
      </p>
    </div>`;

  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast('ok', t('net.copiedX', { label })); }
    catch { toast('warn', t('common.copyFailed')); }
  };

  host.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    copy(rows[Number(b.dataset.copy)].url, rows[Number(b.dataset.copy)].label);
  }));

  host.querySelector('#copyAllBtn').addEventListener('click', () => {
    copy([
      t('net.sheetTitle'),
      '',
      t('net.sheetChat', { url: `${base}/chat.html` }),
      t('net.sheetApi', { url: `${base}/v1` }),
      '',
      t('net.sheetCursor'),
      t('net.sheetCodex'),
      t('net.sheetClaude', { url: base }),
      '',
      t('net.sheetFooter'),
    ].join('\n'), t('net.sheetLabel'));
  });

  host.querySelector('#redetectBtn').addEventListener('click', (e) => {
    e.target.disabled = true;
    renderKeys();
  });

  host.querySelector('#addrPick')?.addEventListener('change', (e) => {
    localStorage.setItem(ADDR_PREF, e.target.value);
    renderKeys();
  });
}

// ================= AI 模型 =================

async function renderModels() {
  const [{ models }, { defaultRoute }] = await Promise.all([
    api('/api/models'), api('/api/models/route'),
  ]);
  modelCache = models;
  content.innerHTML = `
    <div class="panel">
      <header>
        <h3>${esc(t('models.defaultOrder'))}　<span class="muted small">${esc(t('models.defaultOrderHint'))}</span></h3>
        <button class="primary" id="saveRouteBtn">${esc(t('models.saveOrder'))}</button>
      </header>
      <div class="body">
        <p class="small muted">${esc(t('models.orderDesc'))}</p>
        <div id="routeEditor"></div>
      </div>
    </div>
    ${models.some((m) => m.enabled && m.health_state === 'offline' && /環境變數|environment variable/i.test(m.last_error)) ? `
      <div class="alert warn small">${t('models.missingKeyWarn')}</div>` : ''}`;
  content.innerHTML += `
    <div class="alert info small">${t('models.applyNote')}</div>
    <div class="panel">
      <header><h3>${esc(t('models.pool'))}</h3>
        <div class="btn-row">
          <button class="primary" id="addModelBtn">${esc(t('models.add'))}</button>
          <button class="sm" id="hcBtn">${esc(t('dash.healthcheck'))}</button>
        </div>
      </header>
      <div class="body flush table-scroll">
        <table>
          <thead><tr>
            <th>${esc(t('th.model'))}</th><th>${esc(t('th.endpoint'))}</th><th>${esc(t('th.source'))}</th>
            <th>${esc(t('th.state'))}</th>
            <th class="num">${esc(t('th.context'))}</th><th class="num">${esc(t('th.vram'))}</th>
            <th class="num">${esc(t('th.queue'))}</th><th>${esc(t('th.enabled'))}</th>
          </tr></thead>
          <tbody>${models.map((m) => `
            <tr>
              <td><b>${esc(m.display_name)}</b><div class="small muted mono">${esc(m.id)} → ${esc(m.model_name)}</div></td>
              <td class="small mono">${esc(m.endpoint)}</td>
              <td>${m.is_local
                ? `<span class="tag ok">${esc(t('tag.local'))}</span>`
                : `<span class="tag warn">${esc(t('tag.externalCloud'))}</span>`}</td>
              <td>${healthTag(m.health_state)}${m.last_error ? `<div class="small muted">${esc(m.last_error.slice(0, 40))}</div>` : ''}</td>
              <td class="num">${fmtNum(m.context_window)}</td>
              <td class="num">${m.vram_mb ? fmtNum(m.vram_mb) + ' MB' : t('common.dash')}</td>
              <td class="num">${m.queue_depth}</td>
              <td class="nowrap">
                <button class="sm ${m.enabled ? 'danger' : 'primary'}" data-toggle="${esc(m.id)}" data-on="${m.enabled ? 0 : 1}">
                  ${esc(m.enabled ? t('btn.disable') : t('btn.enable'))}</button>
                <button class="sm danger" data-remove="${esc(m.id)}">${esc(t('btn.remove'))}</button>
              </td>
            </tr>`).join('') || `<tr><td colspan="8" class="empty">${esc(t('models.empty'))}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
    ${modelGuideHtml()}`;

  mountDefaultRouteEditor(document.getElementById('routeEditor'), defaultRoute, models);

  document.getElementById('saveRouteBtn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/models/route', {
        method: 'PUT',
        body: { defaultRoute: document.getElementById('routeEditor')._order },
      });
      toast('ok', t('models.orderSaved'));
      renderModels();
    } catch (err) { e.target.disabled = false; toast('error', err.message); }
  });

  document.getElementById('addModelBtn').addEventListener('click', openAddModelDialog);

  document.getElementById('hcBtn').addEventListener('click', async () => {
    await api('/api/models/healthcheck', { method: 'POST' }); toast('ok', t('dash.healthcheckDone')); renderModels();
  });

  content.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/models/${encodeURIComponent(b.dataset.toggle)}`, { method: 'PATCH', body: { enabled: b.dataset.on === '1' } });
      modelCache = []; renderModels();
    } catch (e) { toast('error', e.message); }
  }));

  content.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.remove;
    if (!await confirmDialog(t('models.removeConfirm', { id }))) return;
    try {
      await api(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
      modelCache = []; toast('ok', t('common.removed')); renderModels();
    } catch (e) { toast('error', e.message); }
  }));
}

/**
 * 頁面下方的新增流程說明。
 *
 * 放在這裡而不是只寫在文件裡，是因為管理員會產生疑問的時間點就是在這一頁 ——
 * 「探索」按鈕假設你已經知道要先在推理服務裡裝好模型，但那正是最常卡住的一步。
 */
function modelGuideHtml() {
  const step = (n, text) => `<div style="display:flex;gap:10px;margin-bottom:6px">
    <span class="tag info" style="flex-shrink:0">${n}</span><div>${text}</div></div>`;
  const code = (s) => `<div class="keybox" style="margin:6px 0;font-size:12px">${esc(s)}</div>`;

  const section = (title, badge, body) => `
    <details style="border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px">
      <summary style="cursor:pointer;font-weight:600">
        ${esc(title)}　<span class="tag ${badge.cls}">${esc(badge.text)}</span>
      </summary>
      <div class="mt">${body}</div>
    </details>`;

  return `
    <div class="panel">
      <header><h3>${esc(t('guide.title'))}</h3></header>
      <div class="body">
        <div class="alert info small">${t('guide.common')}</div>

        ${section('Ollama', { cls: 'ok', text: t('guide.ollama.badge') }, `
          ${step(1, t('guide.ollama.s1'))}
          ${step(2, t('guide.ollama.s2'))}
          ${code('ollama pull qwen2.5:7b')}
          <div class="small muted">${t('guide.ollama.hf')}<br>
            <span class="mono">ollama pull hf.co/Qwen/Qwen3-8B-GGUF:Q5_0</span></div>
          ${step(3, t('guide.ollama.s3'))}
          ${step(4, t('guide.ollama.s4'))}
          <div class="alert warn small mt">${t('guide.ollama.warn')}</div>
          <div class="small muted mt">${t('guide.ollama.store')}</div>`)}

        ${section('LM Studio', { cls: 'info', text: t('guide.lmstudio.badge') }, `
          ${step(1, t('guide.lmstudio.s1'))}
          ${step(2, t('guide.lmstudio.s2'))}
          ${step(3, t('guide.lmstudio.s3'))}
          <div class="alert warn small mt">${t('guide.lmstudio.warn')}</div>`)}

        ${section(t('guide.llamacpp.title'), { cls: '', text: t('guide.llamacpp.badge') }, `
          ${step(1, t('guide.llamacpp.s1'))}
          ${step(2, t('guide.llamacpp.s2'))}
          ${step(3, t('guide.llamacpp.s3'))}
          ${code('llama-server -m models\\qwen2.5-7b-instruct-q4_k_m.gguf -c 32768 --host 127.0.0.1 --port 8080')}
          ${step(4, t('guide.llamacpp.s4'))}
          <div class="small muted mt">${t('guide.llamacpp.note')}</div>`)}

        ${section('vLLM', { cls: '', text: t('guide.vllm.badge') }, `
          ${step(1, t('guide.vllm.s1'))}
          ${step(2, t('guide.vllm.s2'))}
          ${code('vllm serve Qwen/Qwen2.5-7B-Instruct --port 8000')}
          ${step(3, t('guide.vllm.s3'))}
          <div class="alert info small mt">${t('guide.vllm.info')}</div>
          <div class="small muted mt">${t('guide.vllm.note')}</div>`)}

        ${section(t('guide.cloud.title'), { cls: 'warn', text: t('guide.cloud.badge') }, `
          <div class="alert warn small">${t('guide.cloud.warn')}</div>
          ${step(1, t('guide.cloud.s1'))}
          ${code('setx DEEPSEEK_API_KEY "sk-your-key"')}
          ${step(2, t('guide.cloud.s2'))}
          ${step(3, t('guide.cloud.s3'))}
          <table class="mt" style="font-size:12px">
            <tr><th style="width:140px">${esc(t('guide.cloud.thId'))}</th><td class="mono">cloud-deepseek</td></tr>
            <tr><th>${esc(t('guide.cloud.thEndpoint'))}</th><td class="mono">https://api.deepseek.com/v1</td></tr>
            <tr><th>${esc(t('guide.cloud.thModel'))}</th><td class="mono">deepseek-chat</td></tr>
            <tr><th>${esc(t('guide.cloud.thEnv'))}</th><td class="mono">DEEPSEEK_API_KEY</td>
              <td class="small muted">${esc(t('guide.cloud.thEnvNote'))}</td></tr>
            <tr><th>${esc(t('guide.cloud.thSource'))}</th><td>${esc(t('guide.cloud.sourceCloud'))}</td></tr>
          </table>
          ${step(4, t('guide.cloud.s4'))}
          <table style="font-size:12px">
            <tr><td><span class="tag ok">${esc(t('health.online'))}</span></td>
              <td>${esc(t('guide.cloud.stOnlineDone'))}</td></tr>
            <tr><td><span class="tag danger">${esc(t('guide.cloud.stMissingEnv'))}</span></td>
              <td>${esc(t('guide.cloud.stMissingEnvFix'))}</td></tr>
            <tr><td><span class="tag danger">HTTP 401</span></td><td>${esc(t('guide.cloud.st401'))}</td></tr>
          </table>
          ${step(5, t('guide.cloud.s5'))}
          <div class="small muted">${t('guide.cloud.note')}</div>`)}

        <p class="small muted mb0">${t('guide.footer')}</p>
      </div>
    </div>`;
}

/**
 * 預設路由編輯器。順位就是 Failover 的嘗試順序（規畫書 7）。
 * 沒有這個介面的話，「哪個是主力、哪個是備援」只能去改設定檔，管理員無從得知。
 */
function mountDefaultRouteEditor(host, initial, models) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const order = initial.filter((id) => byId.get(id)?.enabled);

  const draw = () => {
    const available = models.filter((m) => m.enabled && !order.includes(m.id));
    host.innerHTML = `
      ${order.length ? order.map((id, i) => {
        const m = byId.get(id);
        const stateOk = m.health_state === 'online';
        return `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px">
            <span class="tag ${i === 0 ? 'info' : ''}">${esc(i === 0 ? t('route.primary') : t('route.backup', { n: i }))}</span>
            <span style="flex:1">
              <b>${esc(m.display_name)}</b>
              <span class="small muted mono">${esc(m.id)}</span>
            </span>
            ${stateOk
              ? `<span class="tag ok">${esc(t('health.online'))}</span>`
              : `<span class="tag danger">${esc(healthText(m.health_state))}</span>`}
            <button class="sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="sm" data-down="${i}" ${i === order.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="sm danger" data-rm="${i}">${esc(t('route.moveOut'))}</button>
          </div>`;
      }).join('') : `<div class="alert warn small">${esc(t('route.defaultEmpty'))}</div>`}
      ${available.length ? `
        <div style="display:flex;gap:8px;margin-top:8px">
          <select data-add style="flex:1">
            <option value="">${esc(t('route.addToOrder'))}</option>
            ${available.map((m) => `<option value="${esc(m.id)}">${esc(m.display_name)}${m.is_local ? '' : esc(t('route.suffixExternalCloud'))}</option>`).join('')}
          </select>
        </div>` : ''}`;

    host.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.up); [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw();
    }));
    host.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.down); [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw();
    }));
    host.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
      order.splice(Number(b.dataset.rm), 1); draw();
    }));
    host.querySelector('[data-add]')?.addEventListener('change', (e) => {
      if (e.target.value) { order.push(e.target.value); draw(); }
    });
  };

  host._order = order;
  draw();
}

/**
 * 新增模型：填端點 → 探索 → 勾選 → 加入。
 * 目的是讓管理員不必知道模型的完整名稱，也不必去編輯設定檔。
 */
async function openAddModelDialog() {
  const { presets } = await api('/api/models/presets');

  modal({
    title: t('addm.title'),
    width: 700,
    bodyHtml: `
      <div class="alert info small">${t('addm.intro')}</div>
      <p class="small muted">${esc(t('addm.desc'))}</p>
      <label class="field"><span>${esc(t('addm.presets'))}</span>
        <div class="btn-row">
          ${presets.map((p) => `<button class="sm" data-preset="${esc(p.endpoint)}">${esc(p.name)}<span class="muted small">（${esc(p.hint)}）</span></button>`).join('')}
        </div>
      </label>
      <label class="field"><span>${esc(t('addm.endpoint'))}</span>
        <div style="display:flex;gap:8px">
          <input type="text" id="m_endpoint" class="mono" style="flex:1" placeholder="http://localhost:11434/v1">
          <button class="primary" id="discoverBtn">${esc(t('addm.discover'))}</button>
        </div>
      </label>
      <div id="discoverResult"></div>

      <details class="mt">
        <summary style="cursor:pointer;font-size:13px">${esc(t('addm.manual'))}</summary>
        <div class="alert warn small mt">${t('addm.manualWarn')}</div>
        <div class="grid-2">
          <label class="field"><span>${esc(t('addm.id'))}</span><input type="text" id="c_id" class="mono" placeholder="cloud-deepseek"></label>
          <label class="field"><span>${esc(t('addm.displayName'))}</span><input type="text" id="c_name" placeholder="${esc(t('addm.displayNamePh'))}"></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>${esc(t('addm.endpointReq'))}</span><input type="text" id="c_endpoint" class="mono" placeholder="https://api.deepseek.com/v1"></label>
          <label class="field"><span>${esc(t('addm.upstream'))}</span><input type="text" id="c_model" class="mono" placeholder="deepseek-chat"></label>
        </div>
        <div class="grid-3">
          <label class="field"><span>${esc(t('addm.env'))}</span><input type="text" id="c_env" class="mono" placeholder="DEEPSEEK_API_KEY"></label>
          <label class="field"><span>${esc(t('addm.context'))}</span><input type="number" id="c_ctx" value="65536"></label>
          <label class="field"><span>${esc(t('addm.source'))}</span>
            <select id="c_local">
              <option value="0">${esc(t('addm.sourceCloud'))}</option>
              <option value="1">${esc(t('addm.sourceLocal'))}</option>
            </select></label>
        </div>
        <div class="btn-row"><button class="primary" id="manualAddBtn">${esc(t('addm.addBtn'))}</button></div>
      </details>`,
    footerHtml: `<button data-close>${esc(t('common.close'))}</button>`,
    onMount: (node, close) => {
      const endpointInput = node.querySelector('#m_endpoint');
      const resultBox = node.querySelector('#discoverResult');

      node.querySelector('#manualAddBtn').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          await api('/api/models', {
            method: 'POST',
            body: {
              id: node.querySelector('#c_id').value.trim(),
              displayName: node.querySelector('#c_name').value.trim(),
              endpoint: node.querySelector('#c_endpoint').value.trim(),
              model: node.querySelector('#c_model').value.trim(),
              apiKeyEnv: node.querySelector('#c_env').value.trim(),
              contextWindow: Number(node.querySelector('#c_ctx').value),
              isLocal: node.querySelector('#c_local').value === '1',
              vramMb: 0,
              // 外部模型加進來後預設不進路由 —— 要不要用備援是管理員的明確決定
              addToDefaultRoute: node.querySelector('#c_local').value === '1',
            },
          });
          close(); toast('ok', t('common.added')); modelCache = []; renderModels();
        } catch (err) { e.target.disabled = false; toast('error', err.message); }
      });

      node.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
        endpointInput.value = b.dataset.preset;
        endpointInput.focus();
      }));

      const discover = async () => {
        const endpoint = endpointInput.value.trim();
        if (!endpoint) return toast('error', t('addm.needEndpoint'));
        resultBox.innerHTML = `<div class="small muted">${esc(t('addm.discovering'))}</div>`;
        try {
          const { models: found } = await api('/api/models/discover', { method: 'POST', body: { endpoint } });
          renderDiscovered(resultBox, found, endpoint, close);
        } catch (e) {
          resultBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
        }
      };

      node.querySelector('#discoverBtn').addEventListener('click', discover);
      endpointInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); discover(); } });
    },
  });
}

function renderDiscovered(box, found, endpoint, closeParent) {
  const addable = found.filter((f) => !f.alreadyAdded);

  box.innerHTML = `
    <div class="alert ok small">${esc(t('disc.found', { n: found.length }))}${addable.length < found.length
      ? esc(t('disc.alreadyN', { n: found.length - addable.length })) : ''}</div>
    <div class="table-scroll" style="border:1px solid var(--line);border-radius:8px">
      <table>
        <thead><tr>
          <th>${esc(t('th.upstreamModel'))}</th><th>${esc(t('th.displayName'))}</th>
          <th class="num">${esc(t('th.context'))}</th><th class="num">${esc(t('th.vramMb'))}</th><th></th>
        </tr></thead>
        <tbody>${found.map((f, i) => `
          <tr data-row="${i}">
            <td class="mono small">${esc(f.model)}</td>
            <td><input type="text" class="d_name" value="${esc(shortModelName(f.model))}" ${f.alreadyAdded ? 'disabled' : ''}></td>
            <td><input type="number" class="d_ctx" value="8192" style="width:90px" ${f.alreadyAdded ? 'disabled' : ''}></td>
            <td><input type="number" class="d_vram" value="8000" style="width:90px" ${f.alreadyAdded ? 'disabled' : ''}></td>
            <td class="right nowrap">${f.alreadyAdded
              ? `<span class="tag">${esc(t('disc.already'))}</span>`
              : `<button class="sm primary" data-add="${i}">${esc(t('disc.add'))}</button>`}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="small muted mt mb0">${esc(t('disc.note'))}</p>`;

  box.querySelectorAll('[data-add]').forEach((btn) => btn.addEventListener('click', async () => {
    const i = Number(btn.dataset.add);
    const row = box.querySelector(`[data-row="${i}"]`);
    btn.disabled = true;
    try {
      await api('/api/models', {
        method: 'POST',
        body: {
          id: found[i].suggestedId,
          displayName: row.querySelector('.d_name').value.trim() || found[i].suggestedId,
          endpoint,
          model: found[i].model,
          contextWindow: Number(row.querySelector('.d_ctx').value),
          vramMb: Number(row.querySelector('.d_vram').value),
          isLocal: true,
          enabled: true,
        },
      });
      row.querySelector('td:last-child').innerHTML = `<span class="tag ok">${esc(t('disc.already'))}</span>`;
      toast('ok', t('disc.addedX', { model: found[i].model }));
      modelCache = [];
    } catch (e) {
      btn.disabled = false;
      toast('error', e.message);
    }
  }));
}

/** hf.co/Qwen/Qwen3-8B-GGUF:Q5_0 → Qwen3-8B-GGUF:Q5_0（顯示名稱不需要前面的來源路徑） */
function shortModelName(full) {
  const parts = String(full).split('/');
  return parts[parts.length - 1] || full;
}

// ================= 網路（規畫書 9）=================

async function renderInternet() {
  const { internet } = await api('/api/internet');
  const f = internet.fetch ?? {};
  content.innerHTML = `
    <div class="panel">
      <header><h3>${esc(t('inet.policy'))}</h3></header>
      <div class="body">
        <div class="alert warn small">${esc(t('inet.warn'))}</div>
        <div class="grid-2">
          <label class="field"><span>${esc(t('inet.sysLevel'))}</span>
            <select id="i_enabled">
              <option value="0" ${!internet.enabled ? 'selected' : ''}>${esc(t('inet.off'))}</option>
              <option value="1" ${internet.enabled ? 'selected' : ''}>${esc(t('inet.on'))}</option>
            </select></label>
          <label class="field"><span>${esc(t('inet.blockPrivate'))}</span>
            <select id="i_blockPrivate">
              <option value="1" ${f.blockPrivateNetworks !== false ? 'selected' : ''}>${esc(t('inet.enabledRec'))}</option>
              <option value="0" ${f.blockPrivateNetworks === false ? 'selected' : ''}>${esc(t('inet.disabled'))}</option>
            </select></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>${esc(t('inet.searchEndpoint'))}</span>
            <input type="text" id="i_endpoint" value="${esc(internet.searchEndpoint || '')}" placeholder="http://searx.example.com/search"></label>
          <label class="field"><span>${esc(t('inet.maxResults'))}</span><input type="number" id="i_maxResults" value="${internet.maxResults ?? 5}"></label>
        </div>
        <div class="grid-3">
          <label class="field"><span>${esc(t('inet.maxBytes'))}</span><input type="number" id="i_maxBytes" value="${f.maxBytes ?? 2097152}"></label>
          <label class="field"><span>${esc(t('inet.timeout'))}</span><input type="number" id="i_timeout" value="${f.timeoutMs ?? 10000}"></label>
          <label class="field"><span>${esc(t('inet.maxRedirects'))}</span><input type="number" id="i_redirects" value="${f.maxRedirects ?? 3}"></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>${esc(t('inet.allowlist'))}</span>
            <textarea id="i_allow">${esc((f.domainAllowlist || []).join('\n'))}</textarea></label>
          <label class="field"><span>${esc(t('inet.blocklist'))}</span>
            <textarea id="i_block">${esc((f.domainBlocklist || []).join('\n'))}</textarea></label>
        </div>
        <label class="field"><span>${esc(t('inet.cidrs'))}</span>
          <textarea id="i_cidr" style="min-height:120px">${esc((f.blockedCidrs || []).join('\n'))}</textarea></label>
        <label class="field"><span>${esc(t('inet.types'))}</span>
          <textarea id="i_types">${esc((f.allowedContentTypes || []).join('\n'))}</textarea></label>
        <div class="btn-row"><button class="primary" id="saveInternet">${esc(t('inet.save'))}</button></div>
      </div>
    </div>

    <div class="panel">
      <header><h3>${esc(t('inet.testTitle'))}</h3></header>
      <div class="body">
        <p class="small muted">${esc(t('inet.testDesc'))}</p>
        <div style="display:flex;gap:8px">
          <input type="text" id="testUrl" placeholder="https://example.com" style="flex:1">
          <button id="testBtn">${esc(t('inet.testBtn'))}</button>
        </div>
        <div id="testResult" class="mt"></div>
      </div>
    </div>`;

  const lines = (id) => document.getElementById(id).value.split('\n').map((s) => s.trim()).filter(Boolean);

  document.getElementById('saveInternet').addEventListener('click', async () => {
    try {
      await api('/api/internet', {
        method: 'PATCH',
        body: {
          enabled: document.getElementById('i_enabled').value === '1',
          searchEndpoint: document.getElementById('i_endpoint').value.trim(),
          searchProvider: document.getElementById('i_endpoint').value.trim() ? 'custom' : 'none',
          maxResults: Number(document.getElementById('i_maxResults').value),
          fetch: {
            maxBytes: Number(document.getElementById('i_maxBytes').value),
            timeoutMs: Number(document.getElementById('i_timeout').value),
            maxRedirects: Number(document.getElementById('i_redirects').value),
            blockPrivateNetworks: document.getElementById('i_blockPrivate').value === '1',
            domainAllowlist: lines('i_allow'),
            domainBlocklist: lines('i_block'),
            blockedCidrs: lines('i_cidr'),
            allowedContentTypes: lines('i_types'),
          },
        },
      });
      toast('ok', t('inet.saved'));
    } catch (e) { toast('error', e.message); }
  });

  document.getElementById('testBtn').addEventListener('click', async () => {
    const box = document.getElementById('testResult');
    box.innerHTML = `<div class="small muted">${esc(t('inet.testing'))}</div>`;
    try {
      const r = await api('/api/internet/test', { method: 'POST', body: { url: document.getElementById('testUrl').value } });
      box.innerHTML = r.allowed
        ? `<div class="alert ok">${esc(t('inet.allowed'))}　<span class="small">${esc(r.contentType)} · ${fmtNum(r.bytes)} bytes</span></div>
           <div class="small muted mono" style="white-space:pre-wrap;max-height:200px;overflow:auto">${esc(r.preview)}</div>`
        : `<div class="alert error">${esc(t('inet.blocked', { code: r.code }))}<br>${esc(r.message)}</div>`;
    } catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
  });
}

// ================= 紀錄（規畫書 12）=================

async function renderLogs() {
  const [usage, reqs, web] = await Promise.all([
    api('/api/logs/usage?days=14'),
    api('/api/logs/requests?limit=100'),
    api('/api/logs/web?limit=50'),
  ]);

  const maxDay = Math.max(1, ...usage.byDay.map((d) => d.total_tokens));

  content.innerHTML = `
    <div class="panel">
      <header><h3>${esc(t('logs.tokens14'))}</h3></header>
      <div class="body">
        <div class="spark">${usage.byDay.map((d) =>
          `<i class="${d.total_tokens > maxDay * 0.6 ? 'hi' : ''}" style="height:${Math.max(2, (d.total_tokens / maxDay) * 100)}%" title="${esc(d.day)}: ${fmtNum(d.total_tokens)}"></i>`).join('') || ''}</div>
        <div class="small muted mt">${usage.byDay.length ? `${esc(usage.byDay[0].day)} ～ ${esc(usage.byDay.at(-1).day)}` : esc(t('logs.noData'))}</div>
      </div>
    </div>

    <div class="panel">
      <header><h3>${esc(t('logs.perUser'))}</h3></header>
      <div class="body flush table-scroll">
        <table><thead><tr>
          <th>${esc(t('th.user'))}</th><th class="num">${esc(t('th.calls'))}</th>
          <th class="num">${esc(t('th.input'))}</th><th class="num">${esc(t('th.output'))}</th>
          <th class="num">${esc(t('th.total'))}</th>
        </tr></thead>
        <tbody>${usage.byUser.map((u) => `
          <tr><td>${esc(u.display_name || u.username)}<div class="small muted mono">${esc(u.username)}</div></td>
          <td class="num">${fmtNum(u.calls)}</td><td class="num">${fmtNum(u.input_tokens)}</td>
          <td class="num">${fmtNum(u.output_tokens)}</td><td class="num"><b>${fmtNum(u.total_tokens)}</b></td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>

    <div class="panel">
      <header><h3>${esc(t('logs.perModel'))}</h3></header>
      <div class="body flush table-scroll">
        <table><thead><tr>
          <th>${esc(t('th.model'))}</th><th class="num">${esc(t('th.calls'))}</th><th class="num">${esc(t('th.tokens'))}</th>
        </tr></thead>
        <tbody>${usage.byModel.map((m) => `<tr><td class="mono">${esc(m.model_id)}</td>
          <td class="num">${fmtNum(m.calls)}</td><td class="num">${fmtNum(m.total_tokens)}</td></tr>`).join('')
          || `<tr><td colspan="3" class="empty">${esc(t('logs.noData'))}</td></tr>`}
        </tbody></table>
      </div>
    </div>

    <div class="panel">
      <header><h3>${esc(t('logs.recent'))}</h3></header>
      <div class="body flush table-scroll">
        <table><thead><tr>
          <th>${esc(t('th.time'))}</th><th>${esc(t('th.user'))}</th><th>${esc(t('th.servedModel'))}</th>
          <th>${esc(t('th.failover'))}</th>
          <th class="num">${esc(t('th.wait'))}</th><th class="num">${esc(t('th.inference'))}</th>
          <th class="num">${esc(t('th.firstToken'))}</th><th>${esc(t('th.result'))}</th>
        </tr></thead>
        <tbody>${reqs.logs.map((r) => `
          <tr>
            <td class="small nowrap">${fmtTime(r.ts)}</td>
            <td class="small">${esc(r.username || t('common.dash'))}</td>
            <td class="small mono">${esc(r.served_model || t('common.dash'))}</td>
            <td class="small">${r.failover_from ? `<span class="tag warn">${esc(r.failover_from)} →</span>` : esc(t('common.dash'))}</td>
            <td class="num small">${fmtMs(r.queue_wait_ms)}</td>
            <td class="num small">${fmtMs(r.inference_ms)}</td>
            <td class="num small">${r.first_token_ms ? fmtMs(r.first_token_ms) : t('common.dash')}</td>
            <td class="small">${r.status_code < 400
              ? `<span class="tag ok">${esc(t('logs.success'))}</span>`
              : `<span class="tag danger">${r.status_code}</span> <span class="muted">${esc(r.error_code)}</span>`}</td>
          </tr>`).join('') || `<tr><td colspan="8" class="empty">${esc(t('logs.noRequests'))}</td></tr>`}
        </tbody></table>
      </div>
    </div>

    <div class="panel">
      <header><h3>${esc(t('logs.web'))}</h3></header>
      <div class="body flush table-scroll">
        <table><thead><tr>
          <th>${esc(t('th.time'))}</th><th>${esc(t('th.user'))}</th><th>${esc(t('th.tool'))}</th>
          <th>${esc(t('th.target'))}</th><th>${esc(t('th.resolvedIp'))}</th><th>${esc(t('th.result'))}</th>
        </tr></thead>
        <tbody>${web.logs.map((w) => `
          <tr>
            <td class="small nowrap">${fmtTime(w.ts)}</td>
            <td class="small">${esc(w.username || t('common.dash'))}</td>
            <td class="small">${esc(w.tool)}</td>
            <td class="small mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(w.target)}</td>
            <td class="small mono">${esc(w.resolved_ip || t('common.dash'))}</td>
            <td class="small">${w.allowed
              ? `<span class="tag ok">${esc(t('logs.pass'))}</span>`
              : `<span class="tag danger">${esc(t('logs.block'))}</span>`}
              <div class="muted small">${esc(w.reason)}</div></td>
          </tr>`).join('') || `<tr><td colspan="6" class="empty">${esc(t('logs.noWeb'))}</td></tr>`}
        </tbody></table>
      </div>
    </div>`;
}

// ================= 設定 =================

async function renderSettings() {
  const [s, backups] = await Promise.all([api('/api/settings'), api('/api/backups')]);
  content.innerHTML = `
    <div class="panel">
      <header><h3>${esc(t('set.security'))}</h3></header>
      <div class="body">
        <div class="btn-row">
          <button class="primary" id="pwBtn">${esc(t('set.changePw'))}</button>
          <a class="btn" href="/api/settings/export">${esc(t('set.export'))}</a>
        </div>
        <p class="small muted mt mb0">${esc(t('set.exportNote'))}</p>
      </div>
    </div>

    <div class="panel">
      <header><h3>${esc(t('set.queue'))}</h3></header>
      <div class="body">
        <div class="grid-3">
          <label class="field"><span>${esc(t('set.qConcurrent'))}</span><input type="number" id="q_conc" value="${s.queue.maxGlobalConcurrent}"></label>
          <label class="field"><span>${esc(t('set.qLength'))}</span><input type="number" id="q_len" value="${s.queue.maxQueueLength}"></label>
          <label class="field"><span>${esc(t('set.qTimeout'))}</span><input type="number" id="q_timeout" value="${s.queue.queueTimeoutMs}"></label>
        </div>
        <div class="grid-3">
          <label class="field"><span>${esc(t('set.antiStarvation'))}</span>
            <select id="q_anti">
              <option value="1" ${s.queue.antiStarvation?.enabled !== false ? 'selected' : ''}>${esc(t('set.enable'))}</option>
              <option value="0" ${s.queue.antiStarvation?.enabled === false ? 'selected' : ''}>${esc(t('set.disable'))}</option>
            </select></label>
          <label class="field"><span>${esc(t('set.boostEvery'))}</span><input type="number" id="q_boost" value="${s.queue.antiStarvation?.boostEveryMs ?? 10000}"></label>
          <label class="field"><span>${esc(t('set.maxBoost'))}</span><input type="number" id="q_maxboost" value="${s.queue.antiStarvation?.maxBoost ?? 3}"></label>
        </div>
        <div class="btn-row"><button class="primary" id="saveQueue">${esc(t('set.saveQueue'))}</button></div>
      </div>
    </div>

    <div class="panel">
      <header><h3>${esc(t('set.backup'))}</h3>
        <button class="sm primary" id="backupBtn">${esc(t('set.backupNow'))}</button></header>
      <div class="body flush table-scroll">
        <table><thead><tr>
          <th>${esc(t('th.backupFile'))}</th><th class="num">${esc(t('th.size'))}</th><th>${esc(t('th.createdAt'))}</th>
        </tr></thead>
        <tbody>${backups.backups.map((b) => `<tr><td class="mono small">${esc(b.name)}</td>
          <td class="num small">${fmtNum(Math.round(b.sizeBytes / 1024))} KB</td>
          <td class="small muted">${fmtTime(b.createdAt)}</td></tr>`).join('')
          || `<tr><td colspan="3" class="empty">${esc(t('set.noBackup'))}</td></tr>`}
        </tbody></table>
      </div>
    </div>

    <div class="panel">
      <header><h3>${esc(t('set.sysinfo'))}</h3></header>
      <div class="body">
        <table>
          <tr><th style="width:180px">${esc(t('set.port'))}</th><td class="mono">${s.server.port}</td></tr>
          <tr><th>${esc(t('set.maxUsers'))}</th><td>${s.limits.maxUsers}</td></tr>
          <tr><th>${esc(t('set.hcInterval'))}</th><td>${s.models.healthCheckIntervalMs} ms</td></tr>
          <tr><th>${esc(t('set.defaultRoute'))}</th><td class="mono">${(s.models.defaultRoute || []).map(esc).join(' → ') || t('common.dash')}</td></tr>
          <tr><th>${esc(t('set.retention'))}</th><td>${esc(t('set.retentionDays', { n: s.logging.retentionDays }))}　${s.logging.logPrompts
            ? `<span class="tag warn">${esc(t('set.logPrompts'))}</span>`
            : `<span class="tag ok">${esc(t('set.logHashOnly'))}</span>`}</td></tr>
        </table>
        <p class="small muted mt mb0">${t('set.editNote')}</p>
      </div>
    </div>`;

  document.getElementById('pwBtn').addEventListener('click', openPasswordDialog);

  document.getElementById('saveQueue').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'PATCH',
        body: {
          queue: {
            maxGlobalConcurrent: Number(document.getElementById('q_conc').value),
            maxQueueLength: Number(document.getElementById('q_len').value),
            queueTimeoutMs: Number(document.getElementById('q_timeout').value),
            antiStarvation: {
              enabled: document.getElementById('q_anti').value === '1',
              boostEveryMs: Number(document.getElementById('q_boost').value),
              maxBoost: Number(document.getElementById('q_maxboost').value),
            },
          },
        },
      });
      toast('ok', t('set.queueSaved'));
    } catch (e) { toast('error', e.message); }
  });

  document.getElementById('backupBtn').addEventListener('click', async () => {
    try { await api('/api/backups', { method: 'POST' }); toast('ok', t('set.backupDone')); renderSettings(); }
    catch (e) { toast('error', e.message); }
  });
}

function openPasswordDialog() {
  modal({
    title: t('pw.title'),
    width: 460,
    bodyHtml: `
      <div class="alert warn small">${esc(t('pw.warn'))}</div>
      <label class="field"><span>${esc(t('pw.new'))}</span><input type="password" id="pw1"></label>
      <label class="field"><span>${esc(t('pw.again'))}</span><input type="password" id="pw2"></label>`,
    footerHtml: `<button data-close>${esc(t('pw.later'))}</button>`
      + `<button class="primary" data-save>${esc(t('pw.update'))}</button>`,
    onMount: (node, close) => {
      node.querySelector('[data-save]').addEventListener('click', async () => {
        const a = node.querySelector('#pw1').value;
        const b = node.querySelector('#pw2').value;
        if (a !== b) return toast('error', t('pw.mismatch'));
        if (a.length < 8) return toast('error', t('pw.tooShort'));
        try { await api('/api/auth/password', { method: 'POST', body: { newPassword: a } }); close(); toast('ok', t('pw.updated')); }
        catch (e) { toast('error', e.message); }
      });
    },
  });
}
