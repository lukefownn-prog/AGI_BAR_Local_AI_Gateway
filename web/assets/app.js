/* AGI BAR 管理台。Hash 路由 + 逐頁渲染，無建置流程。 */
import { api, esc, el, fmtNum, fmtTokens, fmtTime, fmtMs, statusTag, healthTag,
         priorityText, weekdaysText, WEEKDAY_NAMES, modal, toast, confirmDialog } from './api.js';

const content = document.getElementById('content');
const pageTitle = document.getElementById('pageTitle');

const PAGES = {
  dashboard: { title: '儀表板', render: renderDashboard },
  users: { title: '人員管理', render: renderUsers },
  keys: { title: 'API Key', render: renderKeys },
  models: { title: 'AI 模型', render: renderModels },
  internet: { title: '網路與安全上網', render: renderInternet },
  logs: { title: '使用紀錄', render: renderLogs },
  settings: { title: '系統設定', render: renderSettings },
};

let dashboardTimer = null;
let modelCache = [];

// ---------------- 啟動 ----------------

(async function boot() {
  const me = await api('/api/auth/me');
  if (!me.authenticated) return location.replace('/');
  document.getElementById('whoami').textContent = `${me.user.displayName || me.user.username}（管理員）`;

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.replace('/');
  });

  window.addEventListener('hashchange', route);
  route();

  if (sessionStorage.getItem('agibar_must_change_pw')) {
    sessionStorage.removeItem('agibar_must_change_pw');
    setTimeout(openPasswordDialog, 400);
  }
})();

function route() {
  const page = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  const def = PAGES[page] ?? PAGES.dashboard;
  pageTitle.textContent = def.title;
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.page === (PAGES[page] ? page : 'dashboard'));
  });
  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  content.innerHTML = '<div class="empty">載入中…</div>';
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
        <div class="stat"><div class="label">人員數</div>
          <div class="value">${d.users.total}<small> / ${d.users.max}</small></div>
          <div class="hint">在線 ${d.users.online} 位（近 5 分鐘）</div></div>
        <div class="stat"><div class="label">今日 API 請求</div>
          <div class="value">${fmtNum(d.requests.today)}</div>
          <div class="hint">失敗 ${d.requests.errorsToday} 次</div></div>
        <div class="stat"><div class="label">今日 Token</div>
          <div class="value">${fmtTokens(d.tokens.today)}</div>
          <div class="hint">Input + Output 合計</div></div>
        <div class="stat"><div class="label">目前 Queue</div>
          <div class="value">${d.queue.waiting}<small> 等待 / ${d.queue.running} 執行中</small></div>
          <div class="hint">平均等待 ${fmtMs(d.queue.avgWaitMs)}</div></div>
        <div class="stat"><div class="label">GPU / VRAM</div>
          <div class="value">${d.gpu.vramPercent}<small>%</small></div>
          <div class="bar mt" style="margin-top:6px"><i class="${vramClass}" style="width:${Math.min(100, d.gpu.vramPercent)}%"></i></div>
          <div class="hint">${fmtNum(d.gpu.vramUsedMb)} / ${fmtNum(d.gpu.vramTotalMb)} MB</div></div>
        <div class="stat"><div class="label">目前主要模型</div>
          <div class="value" style="font-size:17px;padding-top:6px">${esc(d.primaryModel?.name || '（無）')}</div>
          <div class="hint">${d.primaryModel ? healthTag(d.primaryModel.state) : '尚未設定模型'}</div></div>
        <div class="stat"><div class="label">Internet 狀態</div>
          <div class="value" style="font-size:17px;padding-top:6px">
            ${d.internet.enabled ? '<span class="tag warn">已開放</span>' : '<span class="tag ok">未開放</span>'}
          </div>
          <div class="hint">${d.internet.blockPrivateNetworks ? '內網位址封鎖中' : '⚠ 內網封鎖已關閉'}</div></div>
        <div class="stat"><div class="label">服務運行時間</div>
          <div class="value" style="font-size:20px">${uptimeText(d.system.uptimeSec)}</div>
          <div class="hint">記憶體剩餘 ${fmtNum(d.system.memFreeMb)} MB</div></div>
      </div>

      <div class="panel">
        <header><h3>模型池狀態</h3>
          <button class="sm" id="hcBtn">立即健康檢查</button></header>
        <div class="body flush table-scroll">
          <table>
            <thead><tr>
              <th>模型</th><th>來源</th><th>狀態</th><th class="num">Queue</th>
              <th class="num">首 Token</th><th class="num">Token/s</th><th class="num">錯誤率</th><th>最後錯誤</th>
            </tr></thead>
            <tbody>${d.models.map((m) => `
              <tr>
                <td><b>${esc(m.name)}</b><div class="small muted mono">${esc(m.id)}</div></td>
                <td>${m.isLocal ? '<span class="tag ok">本地</span>' : '<span class="tag warn">外部</span>'}</td>
                <td>${m.enabled ? healthTag(m.state) : '<span class="tag">已停用</span>'}</td>
                <td class="num">${m.queueDepth}</td>
                <td class="num">${m.firstTokenMs ? fmtMs(m.firstTokenMs) : '—'}</td>
                <td class="num">${m.tokensPerSec || '—'}</td>
                <td class="num">${m.errorRate}%</td>
                <td class="small muted">${esc((m.lastError || '').slice(0, 60))}</td>
              </tr>`).join('') || '<tr><td colspan="8" class="empty">尚未設定任何模型</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <header><h3>連線資訊</h3></header>
        <div class="body">
          <p class="small muted">人員可用下列位址連接。API Key 由「人員」頁面個別配發。</p>
          <table>
            <tr><th style="width:140px">Web UI</th><td class="mono">${d.system.lanUrls.map(esc).join('<br>') || `http://localhost:${d.system.port}`}</td></tr>
            <tr><th>API Base URL</th><td class="mono">${(d.system.lanUrls.length ? d.system.lanUrls : [`http://localhost:${d.system.port}`]).map((u) => esc(u + '/v1')).join('<br>')}</td></tr>
            <tr><th>API Key</th><td>每位人員自己的 <span class="mono">agi-bar-xxxxxxxx</span></td></tr>
            <tr><th>主機</th><td>${esc(d.system.hostname)}　<span class="muted small">${esc(d.system.platform)}</span></td></tr>
          </table>
        </div>
      </div>`;

    document.getElementById('hcBtn').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await api('/api/models/healthcheck', { method: 'POST' }); await draw(); toast('ok', '健康檢查完成'); }
      catch (err) { toast('error', err.message); }
    });
  };

  await draw();
  dashboardTimer = setInterval(() => { draw().catch(() => {}); }, 10000);
}

function uptimeText(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} 天 ${h} 時`;
  if (h) return `${h} 時 ${m} 分`;
  return `${m} 分`;
}

// ================= 人員（規畫書 5）=================

async function renderUsers() {
  const { users } = await api('/api/users');
  const nonAdmin = users.filter((u) => u.role !== 'admin').length;

  content.innerHTML = `
    <div class="panel">
      <header>
        <h3>人員清單　<span class="muted small">${nonAdmin} 位（上限 50）</span></h3>
        <button class="primary" id="addUser">＋ 新增人員</button>
      </header>
      <div class="body flush table-scroll">
        <table>
          <thead><tr>
            <th>帳號</th><th>姓名</th><th>角色</th><th>狀態</th>
            <th class="num">API Key</th><th class="num">今日 Token</th><th>最後使用</th><th></th>
          </tr></thead>
          <tbody>${users.map((u) => `
            <tr>
              <td class="mono">${esc(u.username)}</td>
              <td>${esc(u.display_name || '—')}</td>
              <td>${u.role === 'admin' ? '<span class="tag info">管理員</span>' : '人員'}</td>
              <td>${statusTag(u.status)}</td>
              <td class="num">${u.active_keys}</td>
              <td class="num">${fmtTokens(u.tokens_today)}</td>
              <td class="small muted nowrap">${fmtTime(u.last_seen_at)}</td>
              <td class="right nowrap">
                <button class="sm" data-detail="${u.id}">管理</button>
                ${u.role === 'admin' ? '' : `<button class="sm danger" data-del="${u.id}">刪除</button>`}
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
      if (!await confirmDialog('確定刪除此人員？其 API Key 與路由設定會一併刪除，使用紀錄則會保留。')) return;
      try { await api(`/api/users/${b.dataset.del}`, { method: 'DELETE' }); toast('ok', '已刪除'); renderUsers(); }
      catch (e) { toast('error', e.message); }
    }));
}

async function openUserDialog(currentCount) {
  if (currentCount >= 50) return toast('error', '人員數已達上限 50 位');
  await ensureModels();

  modal({
    title: '新增人員',
    width: 680,
    bodyHtml: `
      <div class="grid-2">
        <label class="field"><span>帳號 *</span><input type="text" id="f_username" placeholder="例如 rd-alice"></label>
        <label class="field"><span>姓名</span><input type="text" id="f_display"></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>Email</span><input type="email" id="f_email"></label>
        <label class="field"><span>狀態</span>
          <select id="f_status"><option value="active">啟用</option><option value="paused">暫停</option><option value="disabled">停用</option></select>
        </label>
      </div>
      ${limitsFormHtml()}
      <label class="field"><span>模型優先順序（Model Route）</span>
        <div id="routePicker"></div>
        <span class="small muted">留空則沿用系統預設路由。</span>
      </label>
      <div class="alert info small">建立後會自動配發一把 API Key，明文只顯示一次。</div>`,
    footerHtml: '<button data-close>取消</button><button class="primary" data-save>建立人員</button>',
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
    title: `人員：${u.username}`,
    width: 780,
    bodyHtml: `
      <div class="cards" style="grid-template-columns:repeat(3,1fr)">
        <div class="stat"><div class="label">今日 Token</div><div class="value">${fmtTokens(d.usage.today)}</div></div>
        <div class="stat"><div class="label">本月 Token</div><div class="value">${fmtTokens(d.usage.month)}</div></div>
        <div class="stat"><div class="label">累計 Token</div><div class="value">${fmtTokens(d.usage.total)}</div></div>
      </div>

      <div class="grid-2">
        <label class="field"><span>姓名</span><input type="text" id="u_display" value="${esc(u.display_name)}"></label>
        <label class="field"><span>狀態</span>
          <select id="u_status">
            <option value="active" ${u.status === 'active' ? 'selected' : ''}>啟用</option>
            <option value="paused" ${u.status === 'paused' ? 'selected' : ''}>暫停</option>
            <option value="disabled" ${u.status === 'disabled' ? 'selected' : ''}>停用</option>
          </select></label>
      </div>
      <label class="field"><span>備註</span><input type="text" id="u_note" value="${esc(u.note)}"></label>

      <label class="field"><span>模型優先順序（Model Route）</span><div id="routePicker"></div></label>

      <div class="panel" style="margin-top:8px">
        <header><h3>API Key</h3><button class="sm primary" data-newkey>＋ 發新 Key</button></header>
        <div class="body flush table-scroll">
          <table><thead><tr><th>識別</th><th>名稱</th><th>狀態</th><th>優先級</th><th>每日</th><th></th></tr></thead>
          <tbody>${d.keys.map((k) => `
            <tr>
              <td class="mono small">${esc(k.key_prefix)}…${esc(k.last4)}</td>
              <td>${esc(k.name)}</td>
              <td>${statusTag(k.status)}</td>
              <td class="small">${priorityText(k.priority)}</td>
              <td class="num small">${fmtTokens(k.tokens_per_day)}</td>
              <td class="right nowrap">
                <button class="sm" data-limits="${k.id}">配額</button>
                <button class="sm" data-rotate="${k.id}">換發</button>
                ${k.status === 'revoked' ? '' : `<button class="sm danger" data-revoke="${k.id}">撤銷</button>`}
              </td>
            </tr>`).join('') || '<tr><td colspan="6" class="empty">尚無 API Key</td></tr>'}
          </tbody></table>
        </div>
      </div>`,
    footerHtml: '<button data-close>關閉</button><button class="primary" data-save>儲存變更</button>',
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
          close(); toast('ok', '已儲存'); renderUsers();
        } catch (e) { toast('error', e.message); }
      });

      node.querySelector('[data-newkey]').addEventListener('click', async () => {
        try {
          const r = await api(`/api/users/${userId}/keys`, { method: 'POST', body: { name: 'key-' + Date.now().toString(36) } });
          close(); showKeyOnce(r.key.plaintext, u.username);
        } catch (e) { toast('error', e.message); }
      });

      node.querySelectorAll('[data-rotate]').forEach((b) => b.addEventListener('click', async () => {
        if (!await confirmDialog('換發後舊 Key 立即失效，使用該 Key 的工具需要重新設定。要繼續嗎？')) return;
        try {
          const r = await api(`/api/keys/${b.dataset.rotate}/rotate`, { method: 'POST' });
          close(); showKeyOnce(r.key.plaintext, u.username);
        } catch (e) { toast('error', e.message); }
      }));

      node.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
        if (!await confirmDialog('確定撤銷這把 API Key？')) return;
        try {
          await api(`/api/keys/${b.dataset.revoke}`, { method: 'PATCH', body: { status: 'revoked' } });
          close(); toast('ok', '已撤銷'); openUserDetail(userId);
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
    title: 'API Key 已建立',
    width: 560,
    bodyHtml: `
      <div class="alert warn">此明文 Key <b>只會顯示這一次</b>。關閉後系統僅保留雜湊值，無法再次還原。</div>
      <p class="small muted">人員：${esc(username)}</p>
      <div class="keybox" id="keyText">${esc(plaintext)}</div>
      <div class="btn-row mt"><button class="primary" id="copyKey">複製到剪貼簿</button></div>
      <div class="mt small muted">
        <b>客戶端設定：</b><br>
        Base URL：<span class="mono">${esc(location.origin)}/v1</span><br>
        API Key：上方字串
      </div>`,
    footerHtml: '<button class="primary" data-close>我已複製，關閉</button>',
    onMount: (node) => {
      node.querySelector('#copyKey').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(plaintext); toast('ok', '已複製'); }
        catch { toast('warn', '瀏覽器拒絕存取剪貼簿，請手動選取複製'); }
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
      <label class="field"><span>單次最大 Token</span><input type="number" id="l_perReq" value="${g('tokensPerRequest', 8192)}"></label>
      <label class="field"><span>每小時 Token</span><input type="number" id="l_hour" value="${g('tokensPerHour', 100000)}"></label>
      <label class="field"><span>每日 Token</span><input type="number" id="l_day" value="${g('tokensPerDay', 500000)}"></label>
    </div>
    <div class="grid-3">
      <label class="field"><span>每月 Token</span><input type="number" id="l_month" value="${g('tokensPerMonth', 5000000)}"></label>
      <label class="field"><span>RPM（每分鐘請求）</span><input type="number" id="l_rpm" value="${g('rpm', 20)}"></label>
      <label class="field"><span>Concurrent（同時請求）</span><input type="number" id="l_conc" value="${g('concurrent', 2)}"></label>
    </div>
    <div class="grid-3">
      <label class="field"><span>優先級</span>
        <select id="l_priority">
          ${['admin', 'high', 'normal', 'guest'].map((p) =>
            `<option value="${p}" ${g('priority', 'normal') === p ? 'selected' : ''}>${priorityText(p)}</option>`).join('')}
        </select></label>
      <label class="field"><span>超額處理</span>
        <select id="l_policy">
          <option value="hard" ${g('overQuotaPolicy', 'hard') === 'hard' ? 'selected' : ''}>Hard — 拒絕請求</option>
          <option value="soft" ${g('overQuotaPolicy', 'hard') === 'soft' ? 'selected' : ''}>Soft — 降級小模型</option>
        </select></label>
      <label class="field"><span>允許上網</span>
        <select id="l_internet">
          <option value="0" ${!g('internetAllowed', false) ? 'selected' : ''}>禁止</option>
          <option value="1" ${g('internetAllowed', false) ? 'selected' : ''}>允許 Web Search / Fetch</option>
        </select></label>
    </div>
    <div class="grid-2">
      <label class="field"><span>有效日期（起）</span><input type="date" id="l_from" value="${g('validFrom', '') ?? ''}"></label>
      <label class="field"><span>有效日期（迄）</span><input type="date" id="l_until" value="${g('validUntil', '') ?? ''}"></label>
    </div>
    <div class="grid-2">
      <label class="field"><span>每日可用時段（起）</span><input type="time" id="l_ws" value="${g('dailyWindowStart', '08:00')}"></label>
      <label class="field"><span>每日可用時段（迄）</span><input type="time" id="l_we" value="${g('dailyWindowEnd', '22:00')}"></label>
    </div>
    <label class="field"><span>可使用的星期</span>
      <div class="checks">${WEEKDAY_NAMES.map((n, i) =>
        `<label><input type="checkbox" class="l_wd" value="${i}" ${wd.includes(i) ? 'checked' : ''}>週${n}</label>`).join('')}</div>
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
    title: `配額設定：${key.key_prefix}…${key.last4}`,
    width: 720,
    bodyHtml: limitsFormHtml(current),
    footerHtml: '<button data-close>取消</button><button class="primary" data-save>儲存</button>',
    onMount: (node, close) => {
      node.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          await api(`/api/keys/${key.id}`, { method: 'PATCH', body: { limits: readLimitsForm(node) } });
          close(); toast('ok', '配額已更新'); onDone?.();
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
            <span class="tag info">順位 ${i + 1}</span>
            <span style="flex:1">${esc(m?.display_name || id)}</span>
            <button class="sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="sm" data-down="${i}" ${i === chain.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="sm danger" data-rm="${i}">移除</button>
          </div>`;
        }).join('') || '<div class="small muted" style="padding:4px 0">尚未指定，將使用系統預設路由</div>'}
        <div style="display:flex;gap:8px;margin-top:8px">
          <select data-add style="flex:1">
            <option value="">＋ 加入模型…</option>
            ${modelCache.filter((m) => !chain.includes(m.id)).map((m) =>
              `<option value="${esc(m.id)}">${esc(m.display_name)}${m.is_local ? '' : '（外部）'}${m.enabled ? '' : '（已停用）'}</option>`).join('')}
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
  const { keys } = await api('/api/keys');
  content.innerHTML = `
    <div class="alert info small">
      API Base URL：<span class="mono">${esc(location.origin)}/v1</span>　—
      任何支援自訂 Base URL 與 API Key 的 OpenAI 相容客戶端皆可連接（Cursor / Claude Code / Codex / 自製 App）。
      詳細設定請見 <span class="mono">docs/整合設定.md</span>。
    </div>
    <div class="panel">
      <header><h3>所有 API Key</h3></header>
      <div class="body flush table-scroll">
        <table>
          <thead><tr>
            <th>識別前綴</th><th>人員</th><th>名稱</th><th>狀態</th><th>優先級</th>
            <th class="num">每日 Token</th><th class="num">RPM</th><th>時段</th><th>到期</th><th>上網</th><th>最後使用</th>
          </tr></thead>
          <tbody>${keys.map((k) => `
            <tr>
              <td class="mono small">${esc(k.key_prefix)}…${esc(k.last4)}</td>
              <td>${esc(k.display_name || k.username)}<div class="small muted mono">${esc(k.username)}</div></td>
              <td class="small">${esc(k.name)}</td>
              <td>${statusTag(k.status)}</td>
              <td class="small">${priorityText(k.priority)}</td>
              <td class="num">${fmtTokens(k.tokens_per_day)}</td>
              <td class="num">${k.rpm}</td>
              <td class="small nowrap">${esc(k.daily_window_start)}-${esc(k.daily_window_end)}<div class="muted">${weekdaysText(k.weekdays)}</div></td>
              <td class="small nowrap">${k.valid_until ? esc(k.valid_until) : '無期限'}</td>
              <td>${k.internet_allowed ? '<span class="tag warn">允許</span>' : '<span class="tag">禁止</span>'}</td>
              <td class="small muted nowrap">${fmtTime(k.last_used_at)}</td>
            </tr>`).join('') || '<tr><td colspan="11" class="empty">尚無 API Key，請先到「人員」頁建立人員</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
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
        <h3>預設模型順序　<span class="muted small">順位 1 就是主力模型</span></h3>
        <button class="primary" id="saveRouteBtn">儲存順序</button>
      </header>
      <div class="body">
        <p class="small muted">
          請求會依這個順序嘗試：順位 1 離線、壅塞或健康檢查失敗時，自動改用順位 2，依此類推。
          個別人員可在「人員 → 管理」中設定專屬順序，未設定者就用這裡的預設。
        </p>
        <div id="routeEditor"></div>
      </div>
    </div>
    ${models.some((m) => m.enabled && m.health_state === 'offline' && /環境變數/.test(m.last_error)) ? `
      <div class="alert warn small">
        有模型因為<b>缺少 API 金鑰</b>而離線。外部雲端模型的金鑰必須放在環境變數，
        不會存進設定檔。設定方式見下方模型列的錯誤訊息。
      </div>` : ''}`;
  content.innerHTML += `
    <div class="alert info small">
      新增模型後會立即生效，不需重新啟動。設定會寫回
      <span class="mono">config/config.json</span>，那裡仍是唯一的設定來源。
    </div>
    <div class="panel">
      <header><h3>模型池</h3>
        <div class="btn-row">
          <button class="primary" id="addModelBtn">＋ 新增模型</button>
          <button class="sm" id="hcBtn">立即健康檢查</button>
        </div>
      </header>
      <div class="body flush table-scroll">
        <table>
          <thead><tr>
            <th>模型</th><th>Endpoint</th><th>來源</th><th>狀態</th>
            <th class="num">上下文</th><th class="num">VRAM</th><th class="num">Queue</th><th>啟用</th>
          </tr></thead>
          <tbody>${models.map((m) => `
            <tr>
              <td><b>${esc(m.display_name)}</b><div class="small muted mono">${esc(m.id)} → ${esc(m.model_name)}</div></td>
              <td class="small mono">${esc(m.endpoint)}</td>
              <td>${m.is_local ? '<span class="tag ok">本地</span>' : '<span class="tag warn">外部雲端</span>'}</td>
              <td>${healthTag(m.health_state)}${m.last_error ? `<div class="small muted">${esc(m.last_error.slice(0, 40))}</div>` : ''}</td>
              <td class="num">${fmtNum(m.context_window)}</td>
              <td class="num">${m.vram_mb ? fmtNum(m.vram_mb) + ' MB' : '—'}</td>
              <td class="num">${m.queue_depth}</td>
              <td class="nowrap">
                <button class="sm ${m.enabled ? 'danger' : 'primary'}" data-toggle="${esc(m.id)}" data-on="${m.enabled ? 0 : 1}">
                  ${m.enabled ? '停用' : '啟用'}</button>
                <button class="sm danger" data-remove="${esc(m.id)}">移除</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="8" class="empty">尚未新增任何模型。按右上角「＋ 新增模型」開始。</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    <div class="alert warn small">
      <b>外部雲端模型注意：</b>啟用外部模型後，送出的 Prompt 會離開本機網路。
      依規畫書原則，本地開源模型優先，外部 API 僅作為管理員明確授權的備援路由。
    </div>`;

  mountDefaultRouteEditor(document.getElementById('routeEditor'), defaultRoute, models);

  document.getElementById('saveRouteBtn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/models/route', {
        method: 'PUT',
        body: { defaultRoute: document.getElementById('routeEditor')._order },
      });
      toast('ok', '順序已儲存');
      renderModels();
    } catch (err) { e.target.disabled = false; toast('error', err.message); }
  });

  document.getElementById('addModelBtn').addEventListener('click', openAddModelDialog);

  document.getElementById('hcBtn').addEventListener('click', async () => {
    await api('/api/models/healthcheck', { method: 'POST' }); toast('ok', '健康檢查完成'); renderModels();
  });

  content.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/models/${encodeURIComponent(b.dataset.toggle)}`, { method: 'PATCH', body: { enabled: b.dataset.on === '1' } });
      modelCache = []; renderModels();
    } catch (e) { toast('error', e.message); }
  }));

  content.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.remove;
    if (!await confirmDialog(`確定從模型池移除「${id}」？`
      + '該模型會從設定檔與所有人員的路由中刪除，使用紀錄則會保留。')) return;
    try {
      await api(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
      modelCache = []; toast('ok', '已移除'); renderModels();
    } catch (e) { toast('error', e.message); }
  }));
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
            <span class="tag ${i === 0 ? 'info' : ''}">${i === 0 ? '主力' : `備援 ${i}`}</span>
            <span style="flex:1">
              <b>${esc(m.display_name)}</b>
              <span class="small muted mono">${esc(m.id)}</span>
            </span>
            ${stateOk ? '<span class="tag ok">線上</span>' : `<span class="tag danger">${esc(m.health_state)}</span>`}
            <button class="sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="sm" data-down="${i}" ${i === order.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="sm danger" data-rm="${i}">移出</button>
          </div>`;
      }).join('') : '<div class="alert warn small">預設順序是空的 —— 未設定專屬順序的人員將無法使用任何模型。</div>'}
      ${available.length ? `
        <div style="display:flex;gap:8px;margin-top:8px">
          <select data-add style="flex:1">
            <option value="">＋ 把模型加入順序…</option>
            ${available.map((m) => `<option value="${esc(m.id)}">${esc(m.display_name)}${m.is_local ? '' : '（外部雲端）'}</option>`).join('')}
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
    title: '新增模型',
    width: 700,
    bodyHtml: `
      <div class="alert info small">
        <b>AGI BAR 不執行推論，也不存放模型檔。</b>
        它把請求轉給 Ollama / LM Studio / llama.cpp 這類推理服務。<br>
        要用新模型，先安裝到那些服務裡（Ollama 是
        <span class="mono">ollama pull &lt;模型名稱&gt;</span>），再回到這裡探索即可。<br>
        專案的 <span class="mono">models/</span> 資料夾放模型檔<b>沒有作用</b> ——
        那只有在你自行內附 llama.cpp 時才用得到。
      </div>
      <p class="small muted">
        填入本地推理服務的 OpenAI 相容端點，按「探索」列出已安裝的模型。
      </p>
      <label class="field"><span>常用服務</span>
        <div class="btn-row">
          ${presets.map((p) => `<button class="sm" data-preset="${esc(p.endpoint)}">${esc(p.name)}<span class="muted small">（${esc(p.hint)}）</span></button>`).join('')}
        </div>
      </label>
      <label class="field"><span>端點網址</span>
        <div style="display:flex;gap:8px">
          <input type="text" id="m_endpoint" class="mono" style="flex:1" placeholder="http://localhost:11434/v1">
          <button class="primary" id="discoverBtn">探索</button>
        </div>
      </label>
      <div id="discoverResult"></div>

      <details class="mt">
        <summary style="cursor:pointer;font-size:13px">
          手動新增（外部雲端 API，例如 DeepSeek）
        </summary>
        <div class="alert warn small mt">
          <b>外部雲端模型會把 Prompt 送出本機網路。</b>
          依規畫書原則本地模型優先，外部 API 僅作為明確授權的備援。<br>
          金鑰**只能**放環境變數，這裡填變數名稱而不是金鑰本身 ——
          金鑰不會、也不應該寫進設定檔。
        </div>
        <div class="grid-2">
          <label class="field"><span>模型代號 *</span><input type="text" id="c_id" class="mono" placeholder="cloud-deepseek"></label>
          <label class="field"><span>顯示名稱</span><input type="text" id="c_name" placeholder="DeepSeek 雲端備援"></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>端點網址 *</span><input type="text" id="c_endpoint" class="mono" placeholder="https://api.deepseek.com/v1"></label>
          <label class="field"><span>上游模型名稱 *</span><input type="text" id="c_model" class="mono" placeholder="deepseek-chat"></label>
        </div>
        <div class="grid-3">
          <label class="field"><span>金鑰環境變數</span><input type="text" id="c_env" class="mono" placeholder="DEEPSEEK_API_KEY"></label>
          <label class="field"><span>上下文</span><input type="number" id="c_ctx" value="65536"></label>
          <label class="field"><span>來源</span>
            <select id="c_local">
              <option value="0">外部雲端</option>
              <option value="1">本地</option>
            </select></label>
        </div>
        <div class="btn-row"><button class="primary" id="manualAddBtn">新增</button></div>
      </details>`,
    footerHtml: '<button data-close>關閉</button>',
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
          close(); toast('ok', '已新增'); modelCache = []; renderModels();
        } catch (err) { e.target.disabled = false; toast('error', err.message); }
      });

      node.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
        endpointInput.value = b.dataset.preset;
        endpointInput.focus();
      }));

      const discover = async () => {
        const endpoint = endpointInput.value.trim();
        if (!endpoint) return toast('error', '請先填入端點網址');
        resultBox.innerHTML = '<div class="small muted">探索中…</div>';
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
    <div class="alert ok small">找到 ${found.length} 個模型${addable.length < found.length
      ? `（${found.length - addable.length} 個已加入過）` : ''}</div>
    <div class="table-scroll" style="border:1px solid var(--line);border-radius:8px">
      <table>
        <thead><tr><th>上游模型名稱</th><th>顯示名稱</th><th class="num">上下文</th><th class="num">VRAM (MB)</th><th></th></tr></thead>
        <tbody>${found.map((f, i) => `
          <tr data-row="${i}">
            <td class="mono small">${esc(f.model)}</td>
            <td><input type="text" class="d_name" value="${esc(shortModelName(f.model))}" ${f.alreadyAdded ? 'disabled' : ''}></td>
            <td><input type="number" class="d_ctx" value="8192" style="width:90px" ${f.alreadyAdded ? 'disabled' : ''}></td>
            <td><input type="number" class="d_vram" value="8000" style="width:90px" ${f.alreadyAdded ? 'disabled' : ''}></td>
            <td class="right nowrap">${f.alreadyAdded
              ? '<span class="tag">已加入</span>'
              : `<button class="sm primary" data-add="${i}">加入</button>`}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="small muted mt mb0">
      上下文與 VRAM 只影響儀表板顯示與超額降級時的模型選擇，填個大概即可，之後可再調整。
      加入的模型會自動排到預設路由的最後一順位。
    </p>`;

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
      row.querySelector('td:last-child').innerHTML = '<span class="tag ok">已加入</span>';
      toast('ok', `已新增 ${found[i].model}`);
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
      <header><h3>受控上網政策</h3></header>
      <div class="body">
        <div class="alert warn small">
          本地模型不會直接連 Internet。所有外連都必須經過 Gateway 的政策檢查後，
          由 Gateway 擷取文字再送給模型。
        </div>
        <div class="grid-2">
          <label class="field"><span>系統層級上網</span>
            <select id="i_enabled">
              <option value="0" ${!internet.enabled ? 'selected' : ''}>關閉（建議預設）</option>
              <option value="1" ${internet.enabled ? 'selected' : ''}>開放</option>
            </select></label>
          <label class="field"><span>封鎖內網位址</span>
            <select id="i_blockPrivate">
              <option value="1" ${f.blockPrivateNetworks !== false ? 'selected' : ''}>啟用（強烈建議）</option>
              <option value="0" ${f.blockPrivateNetworks === false ? 'selected' : ''}>停用</option>
            </select></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>搜尋服務端點（SearXNG 等，留空為停用）</span>
            <input type="text" id="i_endpoint" value="${esc(internet.searchEndpoint || '')}" placeholder="http://searx.example.com/search"></label>
          <label class="field"><span>搜尋結果上限</span><input type="number" id="i_maxResults" value="${internet.maxResults ?? 5}"></label>
        </div>
        <div class="grid-3">
          <label class="field"><span>最大下載大小（bytes）</span><input type="number" id="i_maxBytes" value="${f.maxBytes ?? 2097152}"></label>
          <label class="field"><span>逾時（ms）</span><input type="number" id="i_timeout" value="${f.timeoutMs ?? 10000}"></label>
          <label class="field"><span>最大重導向次數</span><input type="number" id="i_redirects" value="${f.maxRedirects ?? 3}"></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>網域允許清單（每行一筆，留空代表不限制）</span>
            <textarea id="i_allow">${esc((f.domainAllowlist || []).join('\n'))}</textarea></label>
          <label class="field"><span>網域封鎖清單（每行一筆）</span>
            <textarea id="i_block">${esc((f.domainBlocklist || []).join('\n'))}</textarea></label>
        </div>
        <label class="field"><span>封鎖的 IP 範圍（CIDR，每行一筆）</span>
          <textarea id="i_cidr" style="min-height:120px">${esc((f.blockedCidrs || []).join('\n'))}</textarea></label>
        <label class="field"><span>允許的 Content-Type（每行一筆）</span>
          <textarea id="i_types">${esc((f.allowedContentTypes || []).join('\n'))}</textarea></label>
        <div class="btn-row"><button class="primary" id="saveInternet">儲存政策</button></div>
      </div>
    </div>

    <div class="panel">
      <header><h3>政策測試</h3></header>
      <div class="body">
        <p class="small muted">在開放給人員之前，先確認某個網址會被放行或封鎖。</p>
        <div style="display:flex;gap:8px">
          <input type="text" id="testUrl" placeholder="https://example.com" style="flex:1">
          <button id="testBtn">測試</button>
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
      toast('ok', '網路政策已儲存');
    } catch (e) { toast('error', e.message); }
  });

  document.getElementById('testBtn').addEventListener('click', async () => {
    const box = document.getElementById('testResult');
    box.innerHTML = '<div class="small muted">測試中…</div>';
    try {
      const r = await api('/api/internet/test', { method: 'POST', body: { url: document.getElementById('testUrl').value } });
      box.innerHTML = r.allowed
        ? `<div class="alert ok">✓ 放行　<span class="small">${esc(r.contentType)} · ${fmtNum(r.bytes)} bytes</span></div>
           <div class="small muted mono" style="white-space:pre-wrap;max-height:200px;overflow:auto">${esc(r.preview)}</div>`
        : `<div class="alert error">✕ 已封鎖（${esc(r.code)}）<br>${esc(r.message)}</div>`;
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
      <header><h3>近 14 天 Token 用量</h3></header>
      <div class="body">
        <div class="spark">${usage.byDay.map((d) =>
          `<i class="${d.total_tokens > maxDay * 0.6 ? 'hi' : ''}" style="height:${Math.max(2, (d.total_tokens / maxDay) * 100)}%" title="${esc(d.day)}: ${fmtNum(d.total_tokens)}"></i>`).join('') || ''}</div>
        <div class="small muted mt">${usage.byDay.length ? `${usage.byDay[0].day} ～ ${usage.byDay.at(-1).day}` : '尚無資料'}</div>
      </div>
    </div>

    <div class="panel">
      <header><h3>每人 Token 用量（近 14 天）</h3></header>
      <div class="body flush table-scroll">
        <table><thead><tr><th>人員</th><th class="num">呼叫次數</th><th class="num">Input</th><th class="num">Output</th><th class="num">合計</th></tr></thead>
        <tbody>${usage.byUser.map((u) => `
          <tr><td>${esc(u.display_name || u.username)}<div class="small muted mono">${esc(u.username)}</div></td>
          <td class="num">${fmtNum(u.calls)}</td><td class="num">${fmtNum(u.input_tokens)}</td>
          <td class="num">${fmtNum(u.output_tokens)}</td><td class="num"><b>${fmtNum(u.total_tokens)}</b></td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>

    <div class="panel">
      <header><h3>各模型使用量</h3></header>
      <div class="body flush table-scroll">
        <table><thead><tr><th>模型</th><th class="num">呼叫次數</th><th class="num">Token</th></tr></thead>
        <tbody>${usage.byModel.map((m) => `<tr><td class="mono">${esc(m.model_id)}</td>
          <td class="num">${fmtNum(m.calls)}</td><td class="num">${fmtNum(m.total_tokens)}</td></tr>`).join('')
          || '<tr><td colspan="3" class="empty">尚無資料</td></tr>'}
        </tbody></table>
      </div>
    </div>

    <div class="panel">
      <header><h3>最近請求</h3></header>
      <div class="body flush table-scroll">
        <table><thead><tr>
          <th>時間</th><th>人員</th><th>使用模型</th><th>Failover</th>
          <th class="num">等待</th><th class="num">推理</th><th class="num">首 Token</th><th>結果</th>
        </tr></thead>
        <tbody>${reqs.logs.map((r) => `
          <tr>
            <td class="small nowrap">${fmtTime(r.ts)}</td>
            <td class="small">${esc(r.username || '—')}</td>
            <td class="small mono">${esc(r.served_model || '—')}</td>
            <td class="small">${r.failover_from ? `<span class="tag warn">${esc(r.failover_from)} →</span>` : '—'}</td>
            <td class="num small">${fmtMs(r.queue_wait_ms)}</td>
            <td class="num small">${fmtMs(r.inference_ms)}</td>
            <td class="num small">${r.first_token_ms ? fmtMs(r.first_token_ms) : '—'}</td>
            <td class="small">${r.status_code < 400
              ? '<span class="tag ok">成功</span>'
              : `<span class="tag danger">${r.status_code}</span> <span class="muted">${esc(r.error_code)}</span>`}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="empty">尚無請求紀錄</td></tr>'}
        </tbody></table>
      </div>
    </div>

    <div class="panel">
      <header><h3>受控上網紀錄</h3></header>
      <div class="body flush table-scroll">
        <table><thead><tr><th>時間</th><th>人員</th><th>工具</th><th>目標</th><th>解析 IP</th><th>結果</th></tr></thead>
        <tbody>${web.logs.map((w) => `
          <tr>
            <td class="small nowrap">${fmtTime(w.ts)}</td>
            <td class="small">${esc(w.username || '—')}</td>
            <td class="small">${esc(w.tool)}</td>
            <td class="small mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(w.target)}</td>
            <td class="small mono">${esc(w.resolved_ip || '—')}</td>
            <td class="small">${w.allowed ? '<span class="tag ok">放行</span>' : '<span class="tag danger">封鎖</span>'}
              <div class="muted small">${esc(w.reason)}</div></td>
          </tr>`).join('') || '<tr><td colspan="6" class="empty">尚無上網紀錄</td></tr>'}
        </tbody></table>
      </div>
    </div>`;
}

// ================= 設定 =================

async function renderSettings() {
  const [s, backups] = await Promise.all([api('/api/settings'), api('/api/backups')]);
  content.innerHTML = `
    <div class="panel">
      <header><h3>安全</h3></header>
      <div class="body">
        <div class="btn-row">
          <button class="primary" id="pwBtn">修改管理員密碼</button>
          <a class="btn" href="/api/settings/export">匯出設定（不含祕密）</a>
        </div>
        <p class="small muted mt mb0">API Key、密碼與外部憑證不會出現在匯出檔中。</p>
      </div>
    </div>

    <div class="panel">
      <header><h3>Priority Queue</h3></header>
      <div class="body">
        <div class="grid-3">
          <label class="field"><span>全域同時執行上限</span><input type="number" id="q_conc" value="${s.queue.maxGlobalConcurrent}"></label>
          <label class="field"><span>佇列長度上限</span><input type="number" id="q_len" value="${s.queue.maxQueueLength}"></label>
          <label class="field"><span>排隊逾時（ms）</span><input type="number" id="q_timeout" value="${s.queue.queueTimeoutMs}"></label>
        </div>
        <div class="grid-3">
          <label class="field"><span>Anti-starvation</span>
            <select id="q_anti">
              <option value="1" ${s.queue.antiStarvation?.enabled !== false ? 'selected' : ''}>啟用</option>
              <option value="0" ${s.queue.antiStarvation?.enabled === false ? 'selected' : ''}>停用</option>
            </select></label>
          <label class="field"><span>每等待多久提升一級（ms）</span><input type="number" id="q_boost" value="${s.queue.antiStarvation?.boostEveryMs ?? 10000}"></label>
          <label class="field"><span>最大提升級數</span><input type="number" id="q_maxboost" value="${s.queue.antiStarvation?.maxBoost ?? 3}"></label>
        </div>
        <div class="btn-row"><button class="primary" id="saveQueue">儲存佇列設定</button></div>
      </div>
    </div>

    <div class="panel">
      <header><h3>備份</h3><button class="sm primary" id="backupBtn">立即備份</button></header>
      <div class="body flush table-scroll">
        <table><thead><tr><th>備份檔</th><th class="num">大小</th><th>建立時間</th></tr></thead>
        <tbody>${backups.backups.map((b) => `<tr><td class="mono small">${esc(b.name)}</td>
          <td class="num small">${fmtNum(Math.round(b.sizeBytes / 1024))} KB</td>
          <td class="small muted">${fmtTime(b.createdAt)}</td></tr>`).join('')
          || '<tr><td colspan="3" class="empty">尚無備份</td></tr>'}
        </tbody></table>
      </div>
    </div>

    <div class="panel">
      <header><h3>系統資訊</h3></header>
      <div class="body">
        <table>
          <tr><th style="width:180px">服務連接埠</th><td class="mono">${s.server.port}</td></tr>
          <tr><th>人員上限</th><td>${s.limits.maxUsers}</td></tr>
          <tr><th>健康檢查間隔</th><td>${s.models.healthCheckIntervalMs} ms</td></tr>
          <tr><th>預設模型路由</th><td class="mono">${(s.models.defaultRoute || []).map(esc).join(' → ') || '—'}</td></tr>
          <tr><th>紀錄保留</th><td>${s.logging.retentionDays} 天　${s.logging.logPrompts ? '<span class="tag warn">記錄 Prompt 內容</span>' : '<span class="tag ok">僅記錄 Prompt 雜湊</span>'}</td></tr>
        </table>
        <p class="small muted mt mb0">更完整的設定請直接編輯 <span class="mono">config/config.json</span> 後重新啟動服務。</p>
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
      toast('ok', '佇列設定已套用');
    } catch (e) { toast('error', e.message); }
  });

  document.getElementById('backupBtn').addEventListener('click', async () => {
    try { await api('/api/backups', { method: 'POST' }); toast('ok', '備份完成'); renderSettings(); }
    catch (e) { toast('error', e.message); }
  });
}

function openPasswordDialog() {
  modal({
    title: '修改管理員密碼',
    width: 460,
    bodyHtml: `
      <div class="alert warn small">首次啟動使用的預設密碼寫在設定檔中，請務必更換。</div>
      <label class="field"><span>新密碼（至少 8 字元）</span><input type="password" id="pw1"></label>
      <label class="field"><span>再次輸入</span><input type="password" id="pw2"></label>`,
    footerHtml: '<button data-close>稍後再說</button><button class="primary" data-save>更新密碼</button>',
    onMount: (node, close) => {
      node.querySelector('[data-save]').addEventListener('click', async () => {
        const a = node.querySelector('#pw1').value;
        const b = node.querySelector('#pw2').value;
        if (a !== b) return toast('error', '兩次輸入不一致');
        if (a.length < 8) return toast('error', '密碼至少需 8 個字元');
        try { await api('/api/auth/password', { method: 'POST', body: { newPassword: a } }); close(); toast('ok', '密碼已更新'); }
        catch (e) { toast('error', e.message); }
      });
    },
  });
}
