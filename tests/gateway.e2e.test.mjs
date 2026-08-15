/**
 * 端對端測試：涵蓋 V1 驗收標準的主要條目（規畫書 14）。
 * 每次執行使用獨立的暫存 data/ 與 config，不會動到正式資料。
 */
// isolate 必須排在所有 server 模組之前 —— 見該檔的說明
import { assertIsolated, writeTestConfig, cleanupTmp } from './helpers/isolate.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockModel } from './helpers/mock-model.mjs';

let primary, secondary, server, base, cookie = '';
let ADMIN_PW = 'test-admin-password';

before(async () => {
  await assertIsolated();
  primary = await startMockModel({ name: 'primary' });
  secondary = await startMockModel({ name: 'secondary' });

  writeTestConfig((cfg) => {
    cfg.admin.initialPassword = ADMIN_PW;
    cfg.models.catalog = [
      { id: 'local-primary', displayName: '主力', provider: 'openai-compatible', endpoint: primary.endpoint, model: 'primary', enabled: true, isLocal: true, contextWindow: 8192, vramMb: 8000 },
      { id: 'local-secondary', displayName: '備援', provider: 'openai-compatible', endpoint: secondary.endpoint, model: 'secondary', enabled: true, isLocal: true, contextWindow: 4096, vramMb: 4000 },
    ];
    cfg.models.defaultRoute = ['local-primary', 'local-secondary'];
    Object.assign(cfg.limits.defaultUserLimits, {
      dailyWindowStart: '00:00', dailyWindowEnd: '23:59', weekdays: [0, 1, 2, 3, 4, 5, 6],
    });
  });

  const { main } = await import('../server/index.mjs');
  server = await main();
  base = `http://127.0.0.1:${server.address().port}`;

  // 讓路由起點是「線上」狀態
  const { checkAllModels } = await import('../server/services/models.mjs');
  const { loadConfig } = await import('../server/core/config.mjs');
  await checkAllModels(loadConfig());
});

after(async () => {
  server?.close();
  await primary?.close();
  await secondary?.close();
  const { closeDb } = await import('../server/core/db.mjs');
  closeDb();
  cleanupTmp();
});

async function admin(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function asUser(key, path, opts = {}) {
  return fetch(base + path, {
    ...opts,
    headers: { Authorization: `Bearer ${key}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
}

// ---------------- 管理台 ----------------

test('未登入時管理 API 回 401', async () => {
  assert.equal((await admin('/api/users')).status, 401);
});

test('管理員可登入', async () => {
  assert.equal((await admin('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  const ok = await admin('/api/auth/login', { method: 'POST', body: { username: 'admin', password: ADMIN_PW } });
  assert.equal(ok.status, 200);
  assert.equal((await admin('/api/auth/me')).body.authenticated, true);
});

test('Dashboard 提供規畫書要求的指標', async () => {
  const { status, body } = await admin('/api/dashboard');
  assert.equal(status, 200);
  for (const k of ['users', 'requests', 'tokens', 'queue', 'gpu', 'internet', 'models']) {
    assert.ok(k in body, `dashboard 缺少 ${k}`);
  }
});

// ---------------- 人員與 API Key ----------------

let userKey, userId, keyId;

test('建立人員時自動配發獨立 API Key', async () => {
  const { status, body } = await admin('/api/users', {
    method: 'POST',
    body: {
      username: 'rd-alice', displayName: 'Alice',
      limits: { tokensPerDay: 5000, rpm: 60, concurrent: 2, priority: 'normal',
                dailyWindowStart: '00:00', dailyWindowEnd: '23:59', weekdays: [0, 1, 2, 3, 4, 5, 6] },
    },
  });
  assert.equal(status, 201);
  assert.match(body.key.plaintext, /^agi-bar-/);
  userKey = body.key.plaintext;
  userId = body.user.id;
  keyId = body.key.id;
});

test('資料庫不保存明文 Key', async () => {
  const { body } = await admin('/api/keys');
  const row = body.keys.find((k) => k.id === keyId);
  assert.ok(row);
  assert.equal(row.plaintext, undefined);
  assert.ok(!JSON.stringify(row).includes(userKey.slice(-8)) || row.last4 === userKey.slice(-4));
  assert.equal(row.key_hash.length, 64); // SHA-256 hex
});

test('人員上限 50 位', async () => {
  const created = [];
  for (let i = 0; i < 49; i++) {
    const r = await admin('/api/users', { method: 'POST', body: { username: `bulk${i}`, createKey: false } });
    assert.equal(r.status, 201, `第 ${i} 位建立失敗`);
    created.push(r.body.user.id);
  }
  const over = await admin('/api/users', { method: 'POST', body: { username: 'overflow', createKey: false } });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'user_limit_reached');

  for (const id of created) await admin(`/api/users/${id}`, { method: 'DELETE' });
});

// ---------------- OpenAI 相容 API ----------------

test('/v1/models 需要有效 API Key', async () => {
  assert.equal((await fetch(base + '/v1/models')).status, 401);
  assert.equal((await asUser('agi-bar-nope', '/v1/models')).status, 401);
  assert.equal((await asUser(userKey, '/v1/models')).status, 200);
});

test('/v1/chat/completions 可正常回覆並計入 Token', async () => {
  const res = await asUser(userKey, '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'agi-bar-default', messages: [{ role: 'user', content: '你好' }] }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.choices[0].message.content, /primary/);

  const me = await (await asUser(userKey, '/v1/me')).json();
  assert.ok(me.usage.day >= 18, `應累計 Input+Output Token，實際 ${me.usage.day}`);
});

test('SSE 串流可用', async () => {
  const res = await asUser(userKey, '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'agi-bar-default', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.ok(text.includes('data: '));
  assert.ok(text.includes('[DONE]'));
});

// ---------------- Failover（規畫書 7）----------------

test('第一順位失效時自動切換到第二順位', async () => {
  primary.setFailure(503);
  const before = secondary.state.calls;

  const res = await asUser(userKey, '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'agi-bar-default', messages: [{ role: 'user', content: 'failover' }] }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.choices[0].message.content, /secondary/);
  assert.equal(secondary.state.calls, before + 1);

  primary.setFailure(null);
});

test('全部模型失效時回 503 且訊息可讀', async () => {
  primary.setFailure(500);
  secondary.setFailure(500);
  const res = await asUser(userKey, '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'agi-bar-default', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.ok(res.status >= 500);
  const data = await res.json();
  assert.ok(data.error.message);
  primary.setFailure(null);
  secondary.setFailure(null);
});

// ---------------- 配額 ----------------

test('超過每日 Token 配額（hard）會拒絕', async () => {
  await admin(`/api/keys/${keyId}`, { method: 'PATCH', body: { limits: { tokensPerDay: 1, overQuotaPolicy: 'hard' } } });
  const res = await asUser(userKey, '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'agi-bar-default', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, 'quota_exceeded');
  await admin(`/api/keys/${keyId}`, { method: 'PATCH', body: { limits: { tokensPerDay: 500000 } } });
});

test('單次請求超過上限會拒絕', async () => {
  await admin(`/api/keys/${keyId}`, { method: 'PATCH', body: { limits: { tokensPerRequest: 5 } } });
  const res = await asUser(userKey, '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'agi-bar-default', messages: [{ role: 'user', content: '這是一段刻意寫得比較長的中文內容用來觸發單次上限' }] }),
  });
  assert.equal(res.status, 413);
  await admin(`/api/keys/${keyId}`, { method: 'PATCH', body: { limits: { tokensPerRequest: 8192 } } });
});

test('超出有效日期會拒絕', async () => {
  await admin(`/api/keys/${keyId}`, { method: 'PATCH', body: { limits: { validUntil: '2020-01-01' } } });
  const res = await asUser(userKey, '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'agi-bar-default', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'expired');
  await admin(`/api/keys/${keyId}`, { method: 'PATCH', body: { limits: { validUntil: '' } } });
});

test('撤銷後的 Key 立即失效', async () => {
  const created = await admin(`/api/users/${userId}/keys`, { method: 'POST', body: { name: 'temp' } });
  const tempKey = created.body.key.plaintext;
  assert.equal((await asUser(tempKey, '/v1/models')).status, 200);

  await admin(`/api/keys/${created.body.key.id}`, { method: 'PATCH', body: { status: 'revoked' } });
  const res = await asUser(tempKey, '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'agi-bar-default', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(res.status, 403);
});

// ---------------- 模型路由 ----------------

test('可為個別人員指定模型優先順序', async () => {
  await admin(`/api/users/${userId}/route`, { method: 'PUT', body: { route: ['local-secondary', 'local-primary'] } });
  const before = secondary.state.calls;
  const res = await asUser(userKey, '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'agi-bar-default', messages: [{ role: 'user', content: 'route' }] }),
  });
  assert.equal(res.status, 200);
  assert.match((await res.json()).choices[0].message.content, /secondary/);
  assert.equal(secondary.state.calls, before + 1);

  await admin(`/api/users/${userId}/route`, { method: 'PUT', body: { route: ['local-primary', 'local-secondary'] } });
});

test('一般人員的 /v1/models 不揭露後端模型真名', async () => {
  const data = await (await asUser(userKey, '/v1/models')).json();
  const ids = data.data.map((d) => d.id);
  assert.ok(ids.includes('agi-bar-default'));
  assert.ok(!ids.includes('primary'), '不應洩漏上游 model_name');
});

// ---------------- 受控上網 ----------------

test('未授權上網的 Key 無法使用工具', async () => {
  const res = await asUser(userKey, '/v1/tools/url_fetch', {
    method: 'POST', body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'internet_not_allowed');
});

test('授權上網後仍封鎖內網位址', async () => {
  await admin(`/api/keys/${keyId}`, { method: 'PATCH', body: { limits: { internetAllowed: true } } });
  await admin('/api/internet', { method: 'PATCH', body: { enabled: true } });

  const res = await asUser(userKey, '/v1/tools/url_fetch', {
    method: 'POST', body: JSON.stringify({ url: 'http://192.168.0.1/router' }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'private_network_blocked');

  await admin('/api/internet', { method: 'PATCH', body: { enabled: false } });
});

// ---------------- 紀錄 ----------------

test('每次請求都留下可稽核的紀錄', async () => {
  const { body } = await admin('/api/logs/requests?limit=50');
  assert.ok(body.logs.length > 0);
  const one = body.logs[0];
  for (const f of ['request_id', 'served_model', 'queue_wait_ms', 'inference_ms', 'status_code']) {
    assert.ok(f in one, `request_logs 缺少 ${f}`);
  }
});

test('用量報表可依人員彙總', async () => {
  const { body } = await admin('/api/logs/usage?days=7');
  const alice = body.byUser.find((u) => u.username === 'rd-alice');
  assert.ok(alice && alice.total_tokens > 0);
});

test('設定匯出不含任何祕密', async () => {
  const { body } = await admin('/api/settings/export');
  const dump = JSON.stringify(body);
  assert.ok(!('admin' in body), '匯出不應含 admin 區段');
  assert.ok(!('security' in body), '匯出不應含 security 區段');
  assert.ok(!dump.includes(ADMIN_PW));
  assert.ok(!dump.includes(userKey));
});
