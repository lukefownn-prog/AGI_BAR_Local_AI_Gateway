/**
 * 管理台的模型新增／探索／移除。
 *
 * 這條路徑會寫回 config.json 再重新同步，資料庫與設定檔必須保持一致 ——
 * 若只改資料庫，下次重啟就會被設定檔覆蓋，是很難察覺的迴歸。
 */
// isolate 必須排在所有 server 模組之前 —— 見該檔的說明
import { assertIsolated, writeTestConfig, cleanupTmp } from './helpers/isolate.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startMockModel } from './helpers/mock-model.mjs';

const ADMIN_PW = 'model-admin-pw';
let server, base, mock, cookie = '';

before(async () => {
  await assertIsolated();
  mock = await startMockModel({ name: 'discovered-model' });

  writeTestConfig((cfg) => {
    cfg.admin.initialPassword = ADMIN_PW;
    cfg.models.catalog = [];       // 從零開始，全部靠新增功能建立
    cfg.models.defaultRoute = [];
  });

  const { main } = await import('../server/index.mjs');
  server = await main();
  base = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: ADMIN_PW } });
});

after(async () => {
  server?.close();
  await mock?.close();
  const { closeDb } = await import('../server/core/db.mjs');
  closeDb();
  cleanupTmp();
});

async function api(p, { method = 'GET', body } = {}) {
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

function readConfigFile() {
  return JSON.parse(fs.readFileSync(process.env.AGIBAR_CONFIG_FILE, 'utf8'));
}

// ---------------- slug ----------------

test('模型代號會從上游名稱安全地產生', async () => {
  const { slugifyModelId } = await import('../server/services/models.mjs');
  assert.equal(slugifyModelId('hf.co/Qwen/Qwen3-8B-GGUF:Q5_0'), 'hf-co-qwen-qwen3-8b-gguf-q5-0');
  assert.equal(slugifyModelId('llama3.2:3b'), 'llama3-2-3b');
  assert.equal(slugifyModelId('!!!'), 'model');
  assert.ok(slugifyModelId('x'.repeat(200)).length <= 60);
});

// ---------------- 探索 ----------------

test('可探索 OpenAI 相容端點上的模型', async () => {
  const r = await api('/api/models/discover', { method: 'POST', body: { endpoint: mock.endpoint } });
  assert.equal(r.status, 200);
  assert.equal(r.body.models.length, 1);
  assert.equal(r.body.models[0].model, 'discovered-model');
  assert.equal(r.body.models[0].alreadyAdded, false);
});

test('端點連不上時給的是可行動的訊息，不是堆疊追蹤', async () => {
  const r = await api('/api/models/discover', { method: 'POST', body: { endpoint: 'http://127.0.0.1:1/v1' } });
  assert.equal(r.status, 502);
  assert.match(r.body.error.message, /無法連線/);
  assert.match(r.body.error.message, /請確認該服務正在執行/);
});

test('端點格式錯誤會被擋下', async () => {
  assert.equal((await api('/api/models/discover', { method: 'POST', body: { endpoint: 'not a url' } })).status, 400);
  assert.equal((await api('/api/models/discover', { method: 'POST', body: { endpoint: 'file:///etc' } })).status, 400);
});

test('提供常用本地服務的端點預設值', async () => {
  const r = await api('/api/models/presets');
  assert.equal(r.status, 200);
  const names = r.body.presets.map((p) => p.name);
  assert.ok(names.includes('Ollama'));
  assert.ok(r.body.presets.find((p) => p.name === 'Ollama').endpoint.includes('11434'));
});

// ---------------- 新增 ----------------

test('新增模型會同時寫入設定檔與資料庫', async () => {
  const r = await api('/api/models', {
    method: 'POST',
    body: {
      id: 'ollama-test', displayName: 'Ollama 測試', endpoint: mock.endpoint,
      model: 'discovered-model', contextWindow: 32768, vramMb: 8000,
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.model.id, 'ollama-test');
  assert.equal(r.body.model.context_window, 32768);

  // 設定檔是唯一來源 —— 只寫資料庫的話重啟就消失了
  const onDisk = readConfigFile().models.catalog.find((m) => m.id === 'ollama-test');
  assert.ok(onDisk, '模型必須寫進 config.json 的 catalog');
  assert.equal(onDisk.model, 'discovered-model');

  const listed = (await api('/api/models')).body.models.find((m) => m.id === 'ollama-test');
  assert.ok(listed, '模型必須出現在清單中');
});

test('新增的模型會排進預設路由，否則加了也不會被選到', async () => {
  assert.ok(readConfigFile().models.defaultRoute.includes('ollama-test'));
});

test('已加入的模型在探索結果中會標記', async () => {
  const r = await api('/api/models/discover', { method: 'POST', body: { endpoint: mock.endpoint } });
  assert.equal(r.body.models[0].alreadyAdded, true);
});

test('代號重複會被拒絕', async () => {
  const r = await api('/api/models', {
    method: 'POST',
    body: { id: 'ollama-test', endpoint: mock.endpoint, model: 'x' },
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /已存在/);
});

test('代號格式與必填欄位會被驗證', async () => {
  const cases = [
    [{ id: 'Has Space', endpoint: 'http://x/v1', model: 'm' }, 400],
    [{ id: 'has/slash', endpoint: 'http://x/v1', model: 'm' }, 400],
    [{ id: '', endpoint: 'http://x/v1', model: 'm' }, 400],
    [{ id: 'no-endpoint', model: 'm' }, 400],
    [{ id: 'no-model', endpoint: 'http://x/v1' }, 400],
  ];
  for (const [body, expected] of cases) {
    assert.equal((await api('/api/models', { method: 'POST', body })).status, expected,
      `應拒絕：${JSON.stringify(body)}`);
  }
});

test('新增後健康檢查看得到它', async () => {
  const r = await api('/api/models/healthcheck', { method: 'POST' });
  const hit = r.body.results.find((x) => x.id === 'ollama-test');
  assert.ok(hit);
  assert.equal(hit.state, 'online');
});

// ---------------- 移除 ----------------

test('移除模型會一併清掉設定檔與預設路由', async () => {
  const r = await api('/api/models/ollama-test', { method: 'DELETE' });
  assert.equal(r.status, 200);

  const cfg = readConfigFile();
  assert.equal(cfg.models.catalog.find((m) => m.id === 'ollama-test'), undefined);
  assert.equal(cfg.models.defaultRoute.includes('ollama-test'), false,
    '殘留在路由中會導致請求指向不存在的模型');

  assert.equal((await api('/api/models')).body.models.find((m) => m.id === 'ollama-test'), undefined);
});

test('移除不存在的模型回 404', async () => {
  assert.equal((await api('/api/models/never-existed', { method: 'DELETE' })).status, 404);
});

test('模型管理需要管理員身分', async () => {
  const saved = cookie;
  cookie = '';
  assert.equal((await api('/api/models/discover', { method: 'POST', body: { endpoint: mock.endpoint } })).status, 401);
  assert.equal((await api('/api/models', { method: 'POST', body: { id: 'x', endpoint: 'http://x/v1', model: 'm' } })).status, 401);
  assert.equal((await api('/api/models/x', { method: 'DELETE' })).status, 401);
  cookie = saved;
});
