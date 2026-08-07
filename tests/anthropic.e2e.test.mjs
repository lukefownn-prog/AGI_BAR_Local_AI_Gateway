/**
 * /v1/messages 端對端測試。
 * 重點不只是格式正確，而是確認它走的是同一條配額/佇列/路由管線，沒有旁路。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockModel } from './helpers/mock-model.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agibar-anthropic-'));
process.env.AGIBAR_DATA_DIR = path.join(tmp, 'data');
process.env.AGIBAR_CONFIG_FILE = path.join(tmp, 'config.json');
process.env.AGIBAR_NO_BROWSER = '1';

const ADMIN_PW = 'test-admin-password';
let primary, secondary, server, base, cookie = '';
let userKey, userId, keyId;

before(async () => {
  primary = await startMockModel({ name: 'primary' });
  secondary = await startMockModel({ name: 'secondary' });

  const example = JSON.parse(
    fs.readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8')
      .replace(/^\s*\/\/.*$/gm, ''),
  );
  delete example.$schema;
  example.server.port = 0;
  example.server.openBrowserOnStart = false;
  example.admin.initialPassword = ADMIN_PW;
  example.backup.enabled = false;
  example.logging.toFile = false;
  example.models.healthCheckIntervalMs = 3600000;
  example.models.catalog = [
    { id: 'local-primary', displayName: '主力', endpoint: primary.endpoint, model: 'primary', enabled: true, isLocal: true, contextWindow: 8192, vramMb: 8000 },
    { id: 'local-secondary', displayName: '備援', endpoint: secondary.endpoint, model: 'secondary', enabled: true, isLocal: true, contextWindow: 4096, vramMb: 4000 },
  ];
  example.models.defaultRoute = ['local-primary', 'local-secondary'];
  Object.assign(example.limits.defaultUserLimits, {
    dailyWindowStart: '00:00', dailyWindowEnd: '23:59', weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  fs.writeFileSync(process.env.AGIBAR_CONFIG_FILE, JSON.stringify(example, null, 2));

  const { main } = await import('../server/index.mjs');
  server = await main();
  base = `http://127.0.0.1:${server.address().port}`;

  const { checkAllModels } = await import('../server/services/models.mjs');
  const { loadConfig } = await import('../server/core/config.mjs');
  await checkAllModels(loadConfig());

  await admin('/api/auth/login', { method: 'POST', body: { username: 'admin', password: ADMIN_PW } });
  const created = await admin('/api/users', {
    method: 'POST',
    body: {
      username: 'claude-code-user',
      limits: { tokensPerDay: 500000, rpm: 120, concurrent: 4, dailyWindowStart: '00:00', dailyWindowEnd: '23:59', weekdays: [0, 1, 2, 3, 4, 5, 6] },
    },
  });
  userKey = created.body.key.plaintext;
  userId = created.body.user.id;
  keyId = created.body.key.id;
});

after(async () => {
  server?.close();
  await primary?.close();
  await secondary?.close();
  const { closeDb } = await import('../server/core/db.mjs');
  closeDb();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
});

async function admin(p, { method = 'GET', body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** 模擬 Anthropic SDK：x-api-key + anthropic-version。 */
function anthropic(p, body, extraHeaders = {}) {
  return fetch(base + p, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': userKey,
      'anthropic-version': '2023-06-01',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

/** 解析 Anthropic SSE：回傳 [{event, data}]。 */
function parseSse(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const dt = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
    if (!ev || !dt) continue;
    out.push({ event: ev, data: JSON.parse(dt) });
  }
  return out;
}

// ---------------- 基本 ----------------

test('未帶 Key 時回 Anthropic 格式的錯誤', async () => {
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 401);
  const err = await res.json();
  assert.equal(err.type, 'error');
  assert.equal(err.error.type, 'authentication_error');
  assert.ok(err.error.message);
});

test('x-api-key 與 Authorization Bearer 都能通過驗證', async () => {
  const body = { model: 'agi-bar-default', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };

  assert.equal((await anthropic('/v1/messages', body)).status, 200);

  const bearer = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userKey}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  assert.equal(bearer.status, 200);
});

test('max_tokens 缺漏時回 400', async () => {
  const res = await anthropic('/v1/messages', { model: 'agi-bar-default', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.type, 'invalid_request_error');
});

test('非串流回應是完整的 Anthropic message 物件', async () => {
  const res = await anthropic('/v1/messages', {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 256,
    system: '你是助理',
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.equal(res.status, 200);
  const d = await res.json();

  assert.match(d.id, /^msg_/);
  assert.equal(d.type, 'message');
  assert.equal(d.role, 'assistant');
  assert.equal(d.model, 'claude-sonnet-4-5-20250929'); // 回報客戶端送的名稱
  assert.equal(d.content[0].type, 'text');
  assert.match(d.content[0].text, /primary/);
  assert.equal(d.stop_reason, 'end_turn');
  assert.equal(d.stop_sequence, null);
  assert.ok(d.usage.input_tokens > 0);
  assert.ok(d.usage.output_tokens > 0);
});

test('system 參數確實送達上游', async () => {
  await anthropic('/v1/messages', {
    model: 'agi-bar-default', max_tokens: 64,
    system: '請用台語回答',
    messages: [{ role: 'user', content: 'hi' }],
  });
  const sent = primary.state.lastBody;
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.messages[0].content, '請用台語回答');
});

test('max_tokens 與 stop_sequences 轉送給上游', async () => {
  await anthropic('/v1/messages', {
    model: 'agi-bar-default', max_tokens: 123, temperature: 0.3,
    stop_sequences: ['STOP'],
    messages: [{ role: 'user', content: 'hi' }],
  });
  const sent = primary.state.lastBody;
  assert.equal(sent.max_tokens, 123);
  assert.equal(sent.temperature, 0.3);
  assert.deepEqual(sent.stop, ['STOP']);
});

// ---------------- 串流 ----------------

test('串流事件序列完整且可解析', async () => {
  const res = await anthropic('/v1/messages', {
    model: 'agi-bar-default', max_tokens: 256, stream: true,
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const events = parseSse(await res.text());
  const names = events.map((e) => e.event);

  assert.equal(names[0], 'message_start');
  assert.ok(names.includes('content_block_start'));
  assert.ok(names.includes('content_block_delta'));
  assert.ok(names.includes('content_block_stop'));
  assert.equal(names.at(-2), 'message_delta');
  assert.equal(names.at(-1), 'message_stop');

  const text = events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => e.data.delta.text)
    .join('');
  assert.match(text, /primary/);

  assert.equal(events.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'end_turn');
});

test('串流的 message_start 帶正確的 message id 與模型', async () => {
  const res = await anthropic('/v1/messages', {
    model: 'my-model-alias', max_tokens: 64, stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const events = parseSse(await res.text());
  const start = events[0].data.message;
  assert.match(start.id, /^msg_/);
  assert.equal(start.model, 'my-model-alias');
  assert.equal(start.role, 'assistant');
  assert.deepEqual(start.content, []);
});

// ---------------- 與主管線共用 ----------------

test('用量計入同一組配額（與 OpenAI 端點共用）', async () => {
  const before = await (await fetch(base + '/v1/me', { headers: { Authorization: `Bearer ${userKey}` } })).json();

  await anthropic('/v1/messages', {
    model: 'agi-bar-default', max_tokens: 64, messages: [{ role: 'user', content: '計量測試' }],
  });

  const after = await (await fetch(base + '/v1/me', { headers: { Authorization: `Bearer ${userKey}` } })).json();
  assert.ok(after.usage.day > before.usage.day, 'Anthropic 端點的用量必須計入同一份配額');
});

test('配額用盡時 /v1/messages 也會被擋，且是 Anthropic 錯誤格式', async () => {
  await admin(`/api/keys/${keyId}`, { method: 'PATCH', body: { limits: { tokensPerDay: 1, overQuotaPolicy: 'hard' } } });

  const res = await anthropic('/v1/messages', {
    model: 'agi-bar-default', max_tokens: 64, messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res.status, 429);
  const err = await res.json();
  assert.equal(err.type, 'error');
  assert.equal(err.error.type, 'rate_limit_error');

  await admin(`/api/keys/${keyId}`, { method: 'PATCH', body: { limits: { tokensPerDay: 500000 } } });
});

test('Failover 對 /v1/messages 同樣生效', async () => {
  primary.setFailure(503);
  const before = secondary.state.calls;

  const res = await anthropic('/v1/messages', {
    model: 'agi-bar-default', max_tokens: 64, messages: [{ role: 'user', content: 'failover' }],
  });
  assert.equal(res.status, 200);
  assert.match((await res.json()).content[0].text, /secondary/);
  assert.equal(secondary.state.calls, before + 1);

  primary.setFailure(null);
});

test('請求會留下 request_logs 紀錄', async () => {
  await anthropic('/v1/messages', {
    model: 'agi-bar-default', max_tokens: 64, messages: [{ role: 'user', content: '紀錄測試' }],
  });
  const { body } = await admin('/api/logs/requests?limit=20');
  const hit = body.logs.find((l) => l.username === 'claude-code-user' && l.served_model);
  assert.ok(hit, 'Anthropic 端點的請求必須寫入 request_logs');
  assert.ok(hit.request_id);
});

// ---------------- 其他端點 ----------------

test('count_tokens 可用', async () => {
  const res = await anthropic('/v1/messages/count_tokens', {
    model: 'agi-bar-default',
    system: '你是助理',
    messages: [{ role: 'user', content: '這是一段測試文字' }],
  });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.ok(Number.isInteger(d.input_tokens));
  assert.ok(d.input_tokens > 0);
});

test('/v1/models 依 anthropic-version 回不同格式', async () => {
  const anth = await (await fetch(base + '/v1/models', {
    headers: { 'x-api-key': userKey, 'anthropic-version': '2023-06-01' },
  })).json();
  assert.ok(Array.isArray(anth.data));
  assert.equal(anth.data[0].type, 'model');
  assert.equal(anth.has_more, false);

  const openai = await (await fetch(base + '/v1/models', {
    headers: { Authorization: `Bearer ${userKey}` },
  })).json();
  assert.equal(openai.object, 'list');
  assert.equal(openai.data[0].object, 'model');
});

test('ANTHROPIC_BASE_URL 誤設成含 /v1 時仍可運作', async () => {
  // SDK 會把 base 後面再接 /v1/messages，變成 /v1/v1/messages
  const res = await anthropic('/v1/v1/messages', {
    model: 'agi-bar-default', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).type, 'message');
});

test('停用的 Key 無法使用 /v1/messages', async () => {
  const extra = await admin(`/api/users/${userId}/keys`, { method: 'POST', body: { name: 'temp' } });
  const tempKey = extra.body.key.plaintext;
  await admin(`/api/keys/${extra.body.key.id}`, { method: 'PATCH', body: { status: 'revoked' } });

  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': tempKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'agi-bar-default', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.type, 'permission_error');
});
