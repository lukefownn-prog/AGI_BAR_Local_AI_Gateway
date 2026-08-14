/**
 * 客戶端相容性探針自身的測試。
 *
 * 同壓測腳本的理由：M11 的探針平常不會執行（要有真實部署與各家客戶端），
 * 很容易在兩次驗收之間隨程式改動而爛掉。CI 每次跑一輪，確保驗收當天可用。
 *
 * 這裡也順便把「哪些端點存在、哪些沒有」釘住 —— 例如 /v1/responses 之後
 * 若真的實作了，這裡會失敗，提醒去更新 Codex 的 wire_api 說明。
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { PROBES, probesFor, CLIENT_LABELS } from './integration/probes.mjs';
import { parseArgs, run } from './integration/client-compat.mjs';
import { codexConfigToml, codexEnv, claudeCodeEnv, cursorSteps, maskKey, MANUAL_STEPS } from './integration/configs.mjs';

/**
 * 全部端對端斷言共用同一次執行。
 *
 * 不是為了省時間：paths.mjs 在模組載入時就決定 AGIBAR_DATA_DIR，
 * 同一個行程內起第二個 --self-test 環境會沿用第一個（且已關閉）的資料目錄，
 * 導致模型指向死掉的埠。一個行程只能有一套自我測試環境。
 */
let report = null;
let overallPass = false;
let byId = new Map();

before(async () => {
  const r = await run({ ...parseArgs([]), selfTest: true, quiet: true });
  report = r.report;
  overallPass = r.pass;
  byId = new Map(report.results.map((x) => [x.id, x]));
}, { timeout: 180000 });

// ---------------- 探針定義 ----------------

test('每個探針都有 id / client / why / severity', () => {
  for (const p of PROBES) {
    assert.ok(p.id, '缺少 id');
    assert.ok(CLIENT_LABELS[p.client], `${p.id} 的 client 未定義標籤：${p.client}`);
    assert.ok(p.why && p.why.length > 10, `${p.id} 缺少足夠的 why 說明`);
    assert.ok(['required', 'recommended', 'info'].includes(p.severity), `${p.id} 的 severity 不正確`);
    assert.equal(typeof p.run, 'function');
  }
});

test('探針 id 不重複', () => {
  const ids = PROBES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('依客戶端篩選時仍包含共通探針', () => {
  const list = probesFor('codex');
  assert.ok(list.some((p) => p.client === 'codex'));
  assert.ok(list.some((p) => p.client === 'common'));
  assert.ok(!list.some((p) => p.client === 'cursor'));
  assert.equal(probesFor('all').length, PROBES.length);
});

// ---------------- 設定產生器 ----------------

test('Codex config.toml 一定帶 wire_api = "chat"', () => {
  // 少了這行，新版 Codex 會去打不存在的 /v1/responses
  const toml = codexConfigToml('http://10.0.0.5:8787');
  assert.match(toml, /wire_api\s*=\s*"chat"/);
  assert.match(toml, /base_url\s*=\s*"http:\/\/10\.0\.0\.5:8787\/v1"/);
});

test('Codex 環境變數的 Base URL 要含 /v1', () => {
  const e = codexEnv('http://10.0.0.5:8787', 'agi-bar-abcdefghijklmnop');
  assert.match(e.bash, /OPENAI_BASE_URL="http:\/\/10\.0\.0\.5:8787\/v1"/);
  assert.match(e.powershell, /OPENAI_BASE_URL = "http:\/\/10\.0\.0\.5:8787\/v1"/);
});

test('Claude Code 的 Base URL 不能含 /v1', () => {
  // SDK 會自己補 /v1/messages；加了會變成 /v1/v1/messages
  const e = claudeCodeEnv('http://10.0.0.5:8787', 'agi-bar-abcdefghijklmnop');
  assert.match(e.bash, /ANTHROPIC_BASE_URL="http:\/\/10\.0\.0\.5:8787"/);
  assert.ok(!/ANTHROPIC_BASE_URL="[^"]*\/v1"/.test(e.bash), 'ANTHROPIC_BASE_URL 不應含 /v1');
});

test('Cursor 步驟包含 Base URL 覆寫', () => {
  const steps = cursorSteps('http://10.0.0.5:8787', 'agi-bar-abcdefghijklmnop');
  assert.ok(steps.some((s) => s.includes('Override OpenAI Base URL')));
  assert.ok(steps.some((s) => s.includes('http://10.0.0.5:8787/v1')));
});

test('預設遮蔽 API Key', () => {
  const key = 'agi-bar-SUPERSECRETVALUE1234';
  const masked = maskKey(key);
  assert.ok(!masked.includes('SUPERSECRETVALUE'), '遮蔽後不應包含金鑰主體');
  assert.ok(masked.startsWith('agi-bar-'));

  const e = codexEnv('http://x:8787', key);
  assert.ok(!e.bash.includes('SUPERSECRETVALUE'));
  assert.ok(codexEnv('http://x:8787', key, { masked: false }).bash.includes(key));
});

test('每個客戶端都有人工步驟清單', () => {
  for (const client of ['cursor', 'codex', 'claude-code', 'deepseek', 'app']) {
    assert.ok(MANUAL_STEPS[client]?.length > 0, `${client} 缺少人工步驟`);
  }
});

// ---------------- CLI ----------------

test('參數解析', () => {
  assert.equal(parseArgs(['--client', 'codex']).client, 'codex');
  assert.equal(parseArgs(['--client=codex']).client, 'codex');
  assert.equal(parseArgs(['--self-test']).selfTest, true);
  assert.equal(parseArgs([]).showSecrets, false, '預設必須遮蔽金鑰');
  assert.throws(() => parseArgs(['--bogus', 'x']), /未知參數/);
});

// ---------------- 端對端 ----------------

test('全部探針執行完成且無致命失敗', () => {
  assert.equal(report.results.length, PROBES.length);
  assert.ok(report.results.every((r) => typeof r.ok === 'boolean' && r.detail),
    '每個探針都要回傳 ok 與 detail');

  const fatal = report.results.filter((r) => r.fatal);
  assert.equal(overallPass, true, `致命失敗：${fatal.map((r) => `${r.name}（${r.detail}）`).join('; ')}`);
});

test('/v1/responses 仍未實作 — Codex 必須設 wire_api="chat"', () => {
  const probe = byId.get('codex.responses-api');
  assert.ok(probe, '找不到 responses 探針');

  // 若這項開始通過，代表有人實作了 /v1/responses —— 那就該回頭移除
  // configs.mjs 與文件中「必須加 wire_api」的說明。
  assert.equal(probe.ok, false,
    '/v1/responses 似乎已實作，請更新 Codex 設定說明與 configs.mjs');
  assert.equal(probe.fatal, false, '有明確解法（加一行設定）的問題不該算致命');
  assert.match(probe.hint, /wire_api/);
});

test('Cursor 的關鍵路徑全通', () => {
  for (const id of ['cursor.verify-probe', 'cursor.arbitrary-model-name', 'cursor.streaming']) {
    assert.equal(byId.get(id)?.ok, true, `${id} 失敗：${byId.get(id)?.detail}`);
  }
});

test('預設配額容得下寫實尺寸的 IDE 請求', () => {
  // 這一項守著 config.example.json 的 tokensPerRequest 預設值。
  // 調回 8192 之類的小數字，Cursor / Codex 會在實際使用時大量 413，
  // 但小型測試請求卻全部會過 —— 是很難察覺的迴歸。
  const probe = byId.get('cursor.large-context');
  assert.equal(probe.ok, true, probe.detail + '｜' + (probe.hint ?? ''));
});

test('Codex 的 agent 路徑（工具定義與結果回填）可用', () => {
  assert.equal(byId.get('codex.tools')?.ok, true, byId.get('codex.tools')?.detail);
  assert.equal(byId.get('codex.tool-result-roundtrip')?.ok, true,
    byId.get('codex.tool-result-roundtrip')?.detail);
});

test('Claude Code 兩種驗證標頭都可用', () => {
  assert.equal(byId.get('claude-code.messages')?.ok, true, byId.get('claude-code.messages')?.detail);
  assert.equal(byId.get('claude-code.x-api-key')?.ok, true, byId.get('claude-code.x-api-key')?.detail);
});

test('共通層：驗證、模型清單、錯誤格式與 X-Request-Id', () => {
  for (const id of ['common.auth-bearer', 'common.auth-rejects-bad-key',
    'common.models-shape', 'common.error-shape', 'common.request-id']) {
    assert.equal(byId.get(id)?.ok, true, `${id} 失敗：${byId.get(id)?.detail}`);
  }
});
