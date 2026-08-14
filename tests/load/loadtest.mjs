#!/usr/bin/env node
/**
 * AGI BAR 壓力測試與驗收腳本（規畫書 14 / M14、Issue #2）。
 *
 *   node tests/load/loadtest.mjs --self-test
 *   node tests/load/loadtest.mjs --url http://192.168.1.100:8787 --admin-pass '…'
 *
 * 兩種模式：
 *   --self-test  在本行程內起一台 Gateway + 假模型農場，不需要 GPU。
 *                用途是「驗證這支腳本本身沒壞」，CI 會跑。
 *   一般模式     對真實部署加壓，這才是 M14 的正式驗收。
 *
 * 設計重點：
 *   - 收尾一定清乾淨（刪除測試人員、關閉伺服器），中途 Ctrl+C 也會清
 *   - 每筆請求都取回 X-Request-Id，結束後與伺服器的 request_logs 對帳，
 *     這是「無請求遺失」唯一可信的驗證方式
 *   - Token 用量同時從客戶端與伺服器兩邊統計，比對誤差
 *   - 效能類判定不列為 fatal —— 換一台機器數字就不同，不該卡驗收
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize, groupBy, evaluate, table, histogram, fmtMs, fmtNum, pad } from './stats.mjs';

// ---------------------------------------------------------------- 參數

const DEFAULTS = {
  url: 'http://127.0.0.1:8787',
  adminUser: 'admin',
  adminPass: '',
  scenario: 'all',
  users: 10,
  duration: 30,
  maxTokens: 64,
  promptChars: 400,
  stream: false,
  protocol: 'openai',      // openai | anthropic
  keepUsers: false,
  json: '',
  selfTest: false,
  quiet: false,
};

export function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const alias = {
    'admin-user': 'adminUser', 'admin-pass': 'adminPass', 'max-tokens': 'maxTokens',
    'prompt-chars': 'promptChars', 'keep-users': 'keepUsers', 'self-test': 'selfTest',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const raw = arg.slice(2);
    const [nameRaw, inlineValue] = raw.includes('=') ? raw.split(/=(.*)/s) : [raw, undefined];
    const key = alias[nameRaw] ?? nameRaw;
    if (!(key in opts)) throw new Error(`未知參數：--${nameRaw}`);

    if (typeof opts[key] === 'boolean') {
      opts[key] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : argv[++i];
    if (value === undefined) throw new Error(`--${nameRaw} 缺少值`);
    opts[key] = typeof opts[key] === 'number' ? Number(value) : value;
  }
  return opts;
}

// ---------------------------------------------------------------- 用戶端

class Client {
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
    this.cookie = '';
  }

  async admin(p, { method = 'GET', body } = {}) {
    const res = await fetch(this.base + p, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) this.cookie = sc.map((s) => s.split(';')[0]).join('; ');
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
  }

  async login(username, password) {
    const r = await this.admin('/api/auth/login', { method: 'POST', body: { username, password } });
    if (r.status !== 200) {
      throw new Error(`管理員登入失敗（HTTP ${r.status}）：${r.body?.error?.message ?? ''}`);
    }
    return r.body;
  }
}

// ---------------------------------------------------------------- 佈署測試人員

const PRIORITY_PLAN = ['admin', 'high', 'normal', 'guest'];
const USER_PREFIX = 'loadtest-';

async function provisionUsers(client, { count, protocol }) {
  const existing = (await client.admin('/api/users')).body?.users ?? [];
  const stale = existing.filter((u) => u.username.startsWith(USER_PREFIX));
  for (const u of stale) await client.admin(`/api/users/${u.id}`, { method: 'DELETE' });
  if (stale.length) console.log(`  清除上次殘留的測試人員 ${stale.length} 位`);

  const room = 50 - existing.filter((u) => u.role !== 'admin' && !u.username.startsWith(USER_PREFIX)).length;
  if (count > room) {
    throw new Error(`人員上限 50 位，目前僅剩 ${room} 個名額，無法建立 ${count} 位測試人員。`
      + '請先清理既有人員，或以 --users 降低數量。');
  }

  const users = [];
  for (let i = 0; i < count; i++) {
    const priority = PRIORITY_PLAN[i % PRIORITY_PLAN.length];
    const username = `${USER_PREFIX}${priority}-${i + 1}`;
    const r = await client.admin('/api/users', {
      method: 'POST',
      body: {
        username,
        displayName: `壓測 ${priority} #${i + 1}`,
        note: '由 tests/load/loadtest.mjs 建立，可安全刪除',
        limits: {
          priority,
          // 配額開大，避免壓測撞到額度而非撞到佇列 —— 那是另一個場景要驗的
          tokensPerRequest: 32768,
          tokensPerHour: 100000000,
          tokensPerDay: 100000000,
          tokensPerMonth: 1000000000,
          rpm: 100000,
          concurrent: 8,
          validFrom: null,
          validUntil: null,
          dailyWindowStart: '00:00',
          dailyWindowEnd: '23:59',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          overQuotaPolicy: 'hard',
          internetAllowed: false,
        },
      },
    });
    if (r.status !== 201) {
      throw new Error(`建立測試人員 ${username} 失敗（HTTP ${r.status}）：${r.body?.error?.message ?? ''}`);
    }
    users.push({
      id: r.body.user.id,
      keyId: r.body.key.id,
      username,
      priority,
      key: r.body.key.plaintext,
      protocol,
    });
  }
  return users;
}

async function cleanupUsers(client, users) {
  let removed = 0;
  for (const u of users) {
    const r = await client.admin(`/api/users/${u.id}`, { method: 'DELETE' });
    if (r.status === 200) removed++;
  }
  return removed;
}

// ---------------------------------------------------------------- 發送請求

function buildPrompt(chars) {
  const base = '請簡短回答以下問題。這是壓力測試用的填充內容，用來讓輸入達到指定長度。';
  return base.repeat(Math.ceil(chars / base.length)).slice(0, chars);
}

/** 送一次請求，回傳觀測值。任何失敗都轉成一筆有狀態的紀錄，不丟例外。 */
async function sendOne(base, user, { maxTokens, prompt, stream, signal }) {
  const started = Date.now();
  const isAnthropic = user.protocol === 'anthropic';
  const url = base + (isAnthropic ? '/v1/messages' : '/v1/chat/completions');

  const headers = isAnthropic
    ? { 'Content-Type': 'application/json', 'x-api-key': user.key, 'anthropic-version': '2023-06-01' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${user.key}` };

  const body = isAnthropic
    ? { model: 'agi-bar-default', max_tokens: maxTokens, stream, messages: [{ role: 'user', content: prompt }] }
    : { model: 'agi-bar-default', max_tokens: maxTokens, stream, messages: [{ role: 'user', content: prompt }] };

  const record = {
    user: user.username, priority: user.priority, protocol: user.protocol,
    startedAt: started, status: null, errorCode: '', requestId: '',
    totalMs: 0, firstTokenMs: 0, queueWaitMs: null,
    inputTokens: 0, outputTokens: 0,
  };

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    record.status = res.status;
    record.requestId = res.headers.get('x-request-id') ?? '';

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      record.errorCode = err?.error?.code ?? err?.error?.type ?? `http_${res.status}`;
      record.totalMs = Date.now() - started;
      return record;
    }

    if (stream) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let chars = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!record.firstTokenMs) record.firstTokenMs = Date.now() - started;
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
            const delta = isAnthropic ? obj?.delta?.text : obj?.choices?.[0]?.delta?.content;
            if (delta) chars += delta.length;
            const usage = obj?.usage;
            if (usage) {
              record.inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? record.inputTokens;
              record.outputTokens = usage.completion_tokens ?? usage.output_tokens ?? record.outputTokens;
            }
          } catch { /* 非 JSON 的 keep-alive，略過 */ }
        }
      }
      if (!record.outputTokens) record.outputTokens = chars;
    } else {
      const data = await res.json();
      record.firstTokenMs = Date.now() - started;
      if (isAnthropic) {
        record.inputTokens = data?.usage?.input_tokens ?? 0;
        record.outputTokens = data?.usage?.output_tokens ?? 0;
      } else {
        record.inputTokens = data?.usage?.prompt_tokens ?? 0;
        record.outputTokens = data?.usage?.completion_tokens ?? 0;
      }
    }
  } catch (err) {
    record.status = err.name === 'AbortError' ? 499 : 0;
    record.errorCode = err.name === 'AbortError' ? 'client_aborted' : (err.cause?.code ?? err.name ?? 'network_error');
  }

  record.totalMs = Date.now() - started;
  return record;
}

// ---------------------------------------------------------------- 佇列取樣

/**
 * 等佇列排空。
 *
 * 必要性：Gateway 是先把回應寫出去、才在 finally 釋放佇列名額
 * （順序是對的 —— 提早釋放會讓下一筆在本筆還在寫入時就被放行，造成超額併發）。
 * 因此客戶端的 fetch resolve 時，伺服器可能還算它在執行中。
 * 若不等就判定，會把這個競態誤報成「請求卡住」。
 *
 * 反過來說，等了還是排不空，那就是真的有名額沒被釋放，值得判定失敗。
 */
async function waitForDrain(base, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const d = await res.json();
        last = { t: Date.now(), waiting: d.queue.waiting, running: d.queue.running };
        if (last.waiting === 0 && last.running === 0) return { drained: true, sample: last };
      }
    } catch { /* 取樣失敗就再試 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { drained: false, sample: last ?? { t: Date.now(), waiting: -1, running: -1 } };
}

function startQueueSampler(base, intervalMs = 500) {
  const samples = [];
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const d = await res.json();
        samples.push({ t: Date.now(), waiting: d.queue.waiting, running: d.queue.running });
      }
    } catch { /* 取樣失敗不影響壓測 */ }
  };

  const timer = setInterval(tick, intervalMs);
  tick();

  return {
    samples,
    async stop({ drainTimeoutMs = 5000 } = {}) {
      stopped = true;
      clearInterval(timer);
      const drain = await waitForDrain(base, drainTimeoutMs);
      samples.push(drain.sample);
      return drain;
    },
  };
}

// ---------------------------------------------------------------- 情境

/**
 * 封閉迴圈：每位虛擬使用者完成一次才送下一次。
 * 對應「N 人同時使用」，是 M14 的主場景。
 */
async function scenarioSteady(ctx, { label, users, durationSec, stream, maxTokens }) {
  const prompt = buildPrompt(ctx.opts.promptChars);
  const deadline = Date.now() + durationSec * 1000;
  const records = [];

  await Promise.all(users.map(async (user) => {
    while (Date.now() < deadline) {
      const r = await sendOne(ctx.base, user, { maxTokens, prompt, stream });
      r.scenario = label;
      records.push(r);
      if (ctx.aborted) break;
    }
  }));

  return records;
}

/**
 * 開放迴圈突發：不管前一筆完成沒有，硬灌進去。
 * 用來確認佇列滿載時是乾淨地回 503，而不是崩潰或吃掉請求。
 */
async function scenarioBurst(ctx, { label, users, count, maxTokens }) {
  const prompt = buildPrompt(ctx.opts.promptChars);
  const inflight = [];
  for (let i = 0; i < count; i++) {
    const user = users[i % users.length];
    inflight.push(sendOne(ctx.base, user, { maxTokens, prompt, stream: false })
      .then((r) => { r.scenario = label; return r; }));
  }
  return Promise.all(inflight);
}

/** 長回應：確認不會被 server.requestTimeoutMs 中途切斷。 */
async function scenarioLongRun(ctx, { label, user, maxTokens }) {
  const prompt = buildPrompt(ctx.opts.promptChars);
  const r = await sendOne(ctx.base, user, { maxTokens, prompt, stream: true });
  r.scenario = label;
  return [r];
}

/** 配額：把限制調到極小，確認真的擋得住。 */
async function scenarioQuota(ctx, { label, client, user }) {
  const prompt = buildPrompt(64);
  const out = [];

  // RPM
  await client.admin(`/api/keys/${user.keyId}`, { method: 'PATCH', body: { limits: { rpm: 2, concurrent: 8 } } });
  for (let i = 0; i < 5; i++) {
    const r = await sendOne(ctx.base, user, { maxTokens: 16, prompt, stream: false });
    r.scenario = `${label}:rpm`;
    out.push(r);
  }

  // 單次上限
  await client.admin(`/api/keys/${user.keyId}`, { method: 'PATCH', body: { limits: { rpm: 100000, tokensPerRequest: 5 } } });
  const big = await sendOne(ctx.base, user, { maxTokens: 4096, prompt: buildPrompt(2000), stream: false });
  big.scenario = `${label}:per_request`;
  out.push(big);

  // 每日額度
  await client.admin(`/api/keys/${user.keyId}`, { method: 'PATCH', body: { limits: { tokensPerRequest: 32768, tokensPerDay: 1 } } });
  const over = await sendOne(ctx.base, user, { maxTokens: 16, prompt, stream: false });
  over.scenario = `${label}:daily`;
  out.push(over);

  // 還原
  await client.admin(`/api/keys/${user.keyId}`, {
    method: 'PATCH',
    body: { limits: { tokensPerDay: 100000000, rpm: 100000, tokensPerRequest: 32768 } },
  });

  return out;
}

// ---------------------------------------------------------------- 對帳

async function reconcile(client, users, records) {
  const clientRequestIds = records.filter((r) => r.requestId).map((r) => r.requestId);

  const logs = (await client.admin('/api/logs/requests?limit=500')).body?.logs ?? [];
  const serverRequestIds = new Set(logs.map((l) => l.request_id));

  // 把伺服器記錄的實際排隊時間回填，比客戶端量的準
  const byId = new Map(logs.map((l) => [l.request_id, l]));
  for (const r of records) {
    const log = byId.get(r.requestId);
    if (log) r.queueWaitMs = log.queue_wait_ms;
  }

  const usernames = new Set(users.map((u) => u.username));
  const usage = (await client.admin('/api/logs/usage?days=1')).body?.byUser ?? [];
  const serverTokens = usage
    .filter((u) => usernames.has(u.username))
    .reduce((a, u) => a + u.total_tokens, 0);

  const clientTokens = records.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0);
  const tokenDrift = serverTokens - clientTokens;
  const tokenDriftPct = clientTokens ? (tokenDrift / clientTokens) * 100 : 0;

  return {
    clientRequestIds, serverRequestIds, serverLogged: logs.length,
    serverTokens, clientTokens, tokenDrift, tokenDriftPct,
  };
}

// ---------------------------------------------------------------- 報表

function buildResult(records, queueSamples, accounting, meta) {
  const okRecords = records.filter((r) => r.status === 200);

  const byPriority = {};
  for (const [priority, rows] of groupBy(okRecords, 'priority')) {
    byPriority[priority] = {
      count: rows.length,
      total: summarize(rows.map((r) => r.totalMs)),
      wait: summarize(rows.map((r) => r.queueWaitMs ?? 0)),
      firstToken: summarize(rows.map((r) => r.firstTokenMs)),
    };
  }

  const byScenario = {};
  for (const [scenario, rows] of groupBy(records, 'scenario')) {
    byScenario[scenario] = {
      count: rows.length,
      ok: rows.filter((r) => r.status === 200).length,
      errors: Object.fromEntries(
        [...groupBy(rows.filter((r) => r.status !== 200), 'errorCode')].map(([k, v]) => [k, v.length]),
      ),
      total: summarize(rows.filter((r) => r.status === 200).map((r) => r.totalMs)),
    };
  }

  return { meta, requests: records, queueSamples, accounting, byPriority, byScenario };
}

function printReport(result, verdict) {
  const { meta, requests, queueSamples, accounting, byPriority, byScenario } = result;
  const ok = requests.filter((r) => r.status === 200);
  const wallSec = meta.wallMs / 1000;

  const line = (s = '') => console.log(s);

  line();
  line('═'.repeat(78));
  line('  AGI BAR 壓力測試報告（M14）');
  line('═'.repeat(78));
  line();
  line(`  目標      : ${meta.url}`);
  line(`  情境      : ${meta.scenario}`);
  line(`  虛擬人員  : ${meta.userCount} 位　協定：${meta.protocol}`);
  line(`  執行時間  : ${wallSec.toFixed(1)} 秒`);
  line(`  總請求數  : ${fmtNum(requests.length)}　成功 ${fmtNum(ok.length)}　`
    + `失敗 ${fmtNum(requests.length - ok.length)}`);
  line(`  吞吐量    : ${(requests.length / wallSec).toFixed(2)} req/s　`
    + `${fmtNum(Math.round(ok.reduce((a, r) => a + r.outputTokens, 0) / wallSec))} output token/s`);
  line();

  // ---- 延遲 ----
  const totals = summarize(ok.map((r) => r.totalMs));
  const waits = summarize(ok.map((r) => r.queueWaitMs ?? 0));
  const firsts = summarize(ok.map((r) => r.firstTokenMs));

  line('  ── 延遲 ' + '─'.repeat(68));
  line(table(
    [
      { key: 'name', label: '指標', width: 14 },
      { key: 'p50', label: 'p50', width: 9, right: true },
      { key: 'p90', label: 'p90', width: 9, right: true },
      { key: 'p95', label: 'p95', width: 9, right: true },
      { key: 'p99', label: 'p99', width: 9, right: true },
      { key: 'max', label: 'max', width: 9, right: true },
    ],
    [
      { name: '總耗時', ...fmtRow(totals) },
      { name: '佇列等待', ...fmtRow(waits) },
      { name: '首 Token', ...fmtRow(firsts) },
    ],
  ).split('\n').map((l) => '  ' + l).join('\n'));
  line();

  if (ok.length > 4) {
    line('  ── 總耗時分布 ' + '─'.repeat(61));
    line(histogram(ok.map((r) => r.totalMs)));
    line();
  }

  // ---- 優先權 ----
  if (Object.keys(byPriority).length > 1) {
    line('  ── 優先權（驗證 P0>P1>P2>P3 與 anti-starvation）' + '─'.repeat(28));
    const order = ['admin', 'high', 'normal', 'guest'];
    const labels = { admin: 'P0 管理員', high: 'P1 高', normal: 'P2 一般', guest: 'P3 訪客' };
    line(table(
      [
        { key: 'name', label: '優先權', width: 12 },
        { key: 'count', label: '完成', width: 7, right: true },
        { key: 'waitP50', label: '等待 p50', width: 10, right: true },
        { key: 'waitP95', label: '等待 p95', width: 10, right: true },
        { key: 'waitMax', label: '等待 max', width: 10, right: true },
        { key: 'totalP50', label: '總耗時 p50', width: 12, right: true },
      ],
      order.filter((p) => byPriority[p]).map((p) => ({
        name: labels[p],
        count: fmtNum(byPriority[p].count),
        waitP50: fmtMs(byPriority[p].wait.p50),
        waitP95: fmtMs(byPriority[p].wait.p95),
        waitMax: fmtMs(byPriority[p].wait.max),
        totalP50: fmtMs(byPriority[p].total.p50),
      })),
    ).split('\n').map((l) => '  ' + l).join('\n'));
    line();
  }

  // ---- 情境 ----
  line('  ── 各情境 ' + '─'.repeat(66));
  line(table(
    [
      { key: 'name', label: '情境', width: 22 },
      { key: 'count', label: '請求', width: 7, right: true },
      { key: 'ok', label: '成功', width: 7, right: true },
      { key: 'p50', label: 'p50', width: 9, right: true },
      { key: 'errors', label: '錯誤分布', width: 30 },
    ],
    Object.entries(byScenario).map(([name, s]) => ({
      name,
      count: fmtNum(s.count),
      ok: fmtNum(s.ok),
      p50: s.ok ? fmtMs(s.total.p50) : '—',
      errors: Object.entries(s.errors).map(([k, v]) => `${k}×${v}`).join(' ') || '—',
    })),
  ).split('\n').map((l) => '  ' + l).join('\n'));
  line();

  // ---- 佇列 ----
  if (queueSamples.length) {
    const maxWaiting = Math.max(...queueSamples.map((s) => s.waiting));
    const maxRunning = Math.max(...queueSamples.map((s) => s.running));
    const tail = queueSamples.at(-1);
    line('  ── 佇列 ' + '─'.repeat(68));
    line(`  尖峰等待 ${maxWaiting} 筆　尖峰執行中 ${maxRunning} 筆　`
      + `結束時 等待 ${tail.waiting} / 執行中 ${tail.running}`);
    line();
  }

  // ---- 對帳 ----
  if (accounting) {
    line('  ── 對帳 ' + '─'.repeat(68));
    line(`  伺服器 request_logs : ${fmtNum(accounting.serverRequestIds.size)} 筆`);
    line(`  客戶端 X-Request-Id : ${fmtNum(accounting.clientRequestIds.length)} 筆`);
    line(`  Token（伺服器/客戶端）: ${fmtNum(accounting.serverTokens)} / ${fmtNum(accounting.clientTokens)}`
      + `　差 ${accounting.tokenDriftPct.toFixed(2)}%`);
    line();
  }

  // ---- 驗收 ----
  line('  ── 驗收判定 ' + '─'.repeat(64));
  for (const c of verdict.checks) {
    const mark = c.pass ? '✓' : (c.fatal ? '✗' : '!');
    line(`  ${mark} ${pad(c.name, 30)} ${c.detail}`);
  }
  line();
  line('═'.repeat(78));
  line(verdict.pass ? '  結果：通過' : '  結果：未通過（✗ 為必須修正，! 為觀察值僅供參考）');
  line('═'.repeat(78));
  line();
}

function fmtRow(s) {
  return { p50: fmtMs(s.p50), p90: fmtMs(s.p90), p95: fmtMs(s.p95), p99: fmtMs(s.p99), max: fmtMs(s.max) };
}

// ---------------------------------------------------------------- 自我測試環境

async function startSelfTestEnv() {
  const { startFarm } = await import('./mock-farm.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agibar-load-'));

  process.env.AGIBAR_DATA_DIR = path.join(tmp, 'data');
  process.env.AGIBAR_CONFIG_FILE = path.join(tmp, 'config.json');
  process.env.AGIBAR_NO_BROWSER = '1';

  const farm = await startFarm();
  const adminPass = 'loadtest-admin-pw';

  const exampleUrl = new URL('../../config/config.example.json', import.meta.url);
  const cfg = JSON.parse(fs.readFileSync(exampleUrl, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  delete cfg.$schema;
  cfg.server.port = 0;
  cfg.server.openBrowserOnStart = false;
  cfg.admin.initialPassword = adminPass;
  cfg.backup.enabled = false;
  cfg.logging.toFile = false;
  cfg.logging.level = 'warn';
  cfg.models.healthCheckIntervalMs = 3600000;
  cfg.models.catalog = farm.catalog;
  cfg.models.defaultRoute = farm.catalog.map((m) => m.id);
  cfg.queue.maxGlobalConcurrent = 4;
  cfg.queue.maxQueueLength = 50;
  cfg.queue.queueTimeoutMs = 30000;
  fs.writeFileSync(process.env.AGIBAR_CONFIG_FILE, JSON.stringify(cfg, null, 2));

  const { main } = await import('../../server/index.mjs');
  const server = await main();

  const { checkAllModels } = await import('../../server/services/models.mjs');
  const { loadConfig } = await import('../../server/core/config.mjs');
  await checkAllModels(loadConfig());

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    adminPass,
    farm,
    async close() {
      server.close();
      await farm.closeAll();
      const { closeDb } = await import('../../server/core/db.mjs');
      closeDb();
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
    },
  };
}

// ---------------------------------------------------------------- 主流程

export async function run(opts) {
  let env = null;
  let base = opts.url;
  let adminPass = opts.adminPass;

  if (opts.selfTest) {
    env = await startSelfTestEnv();
    base = env.url;
    adminPass = env.adminPass;
  }
  if (!adminPass) {
    throw new Error('需要管理員密碼才能建立測試人員。請用 --admin-pass，或改用 --self-test。');
  }

  const client = new Client(base);
  const ctx = { base, opts, aborted: false };
  let users = [];
  const sampler = startQueueSampler(base, opts.selfTest ? 200 : 500);
  const startedAt = Date.now();

  const cleanup = async () => {
    await sampler.stop().catch(() => {});
    if (users.length && !opts.keepUsers) {
      const n = await cleanupUsers(client, users).catch(() => 0);
      if (!opts.quiet) console.log(`\n  已清除測試人員 ${n}/${users.length} 位`);
    }
    if (env) await env.close();
  };

  const onSignal = () => { ctx.aborted = true; };
  process.once('SIGINT', onSignal);

  try {
    if (!opts.quiet) console.log(`\n  連線到 ${base} …`);
    await client.login(opts.adminUser, adminPass);

    users = await provisionUsers(client, { count: opts.users, protocol: opts.protocol });
    if (!opts.quiet) console.log(`  已建立測試人員 ${users.length} 位（P0/P1/P2/P3 輪流分配）\n`);

    const records = [];
    const want = (name) => opts.scenario === 'all' || opts.scenario === name;

    if (want('steady')) {
      if (!opts.quiet) console.log(`  [1] steady：${users.length} 人持續加壓 ${opts.duration} 秒 …`);
      records.push(...await scenarioSteady(ctx, {
        label: 'steady', users, durationSec: opts.duration,
        stream: opts.stream, maxTokens: opts.maxTokens,
      }));
    }

    if (want('burst') && !ctx.aborted) {
      const count = Math.max(20, users.length * 12);
      if (!opts.quiet) console.log(`  [2] burst：瞬間灌入 ${count} 筆，確認佇列滿載時乾淨回 503 …`);
      records.push(...await scenarioBurst(ctx, { label: 'burst', users, count, maxTokens: 16 }));
    }

    if (want('longrun') && !ctx.aborted) {
      if (!opts.quiet) console.log('  [3] longrun：單筆長回應，確認不被 requestTimeoutMs 切斷 …');
      records.push(...await scenarioLongRun(ctx, {
        label: 'longrun', user: users[0], maxTokens: opts.selfTest ? 2000 : 4096,
      }));
    }

    if (want('quota') && !ctx.aborted) {
      if (!opts.quiet) console.log('  [4] quota：確認 RPM / 單次上限 / 每日額度真的擋得住 …');
      records.push(...await scenarioQuota(ctx, { label: 'quota', client, user: users.at(-1) }));
    }

    const drain = await sampler.stop({ drainTimeoutMs: 8000 });
    const wallMs = Date.now() - startedAt;
    if (!opts.quiet && !drain.drained) {
      console.log(`\n  ⚠ 佇列在 8 秒內未排空：等待 ${drain.sample.waiting} / 執行中 ${drain.sample.running}`);
    }

    const accounting = await reconcile(client, users, records);
    const result = buildResult(records, sampler.samples, accounting, {
      url: base, scenario: opts.scenario, userCount: users.length,
      protocol: opts.protocol, wallMs, startedAt,
    });

    const verdict = evaluate(result, {
      tokenDriftPct: 5,
      maxGuestWaitMs: (opts.selfTest ? 30000 : 60000),
      minSuccessRatePct: 0,
    });

    if (!opts.quiet) printReport(result, verdict);

    if (opts.json) {
      const dump = {
        ...result,
        accounting: { ...accounting, serverRequestIds: [...accounting.serverRequestIds] },
        verdict,
      };
      fs.writeFileSync(opts.json, JSON.stringify(dump, null, 2), 'utf8');
      if (!opts.quiet) console.log(`  原始資料已寫入 ${opts.json}\n`);
    }

    return { result, verdict };
  } finally {
    process.off('SIGINT', onSignal);
    await cleanup();
  }
}

// ---------------------------------------------------------------- CLI

const HELP = `
AGI BAR 壓力測試與驗收（M14）

用法：
  node tests/load/loadtest.mjs --self-test
  node tests/load/loadtest.mjs --url http://192.168.1.100:8787 --admin-pass '你的密碼'

參數：
  --url <網址>          Gateway 位址（預設 http://127.0.0.1:8787）
  --admin-user <帳號>   管理員帳號（預設 admin）
  --admin-pass <密碼>   管理員密碼（建立測試人員用；--self-test 時免填）
  --scenario <名稱>     all | steady | burst | longrun | quota（預設 all）
  --users <N>           虛擬人員數，會依 P0/P1/P2/P3 輪流分配（預設 10）
  --duration <秒>       steady 情境的持續時間（預設 30）
  --max-tokens <N>      每次請求的輸出上限（預設 64）
  --prompt-chars <N>    輸入長度（預設 400）
  --stream              使用 SSE 串流
  --protocol <名稱>     openai | anthropic（預設 openai）
  --self-test           內建 Gateway + 假模型，不需 GPU；用於驗證腳本本身
  --keep-users          結束後保留測試人員（預設會刪除）
  --json <檔案>         輸出原始資料
  --quiet               不印報表

離開碼：0 通過，1 未通過，2 執行錯誤。
測試人員一律以 loadtest- 開頭，結束時自動刪除。
`;

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).endsWith(path.join('load', 'loadtest.mjs'));

if (invokedDirectly) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { verdict } = await run(opts);
    process.exitCode = verdict.pass ? 0 : 1;
    await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.().catch(() => {});
  } catch (err) {
    console.error(`\n  執行失敗：${err.message}\n`);
    process.exitCode = 2;
    await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.().catch(() => {});
  }
}
