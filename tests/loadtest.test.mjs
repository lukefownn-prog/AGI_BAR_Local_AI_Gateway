/**
 * 壓測腳本自身的測試。
 *
 * 為什麼需要：M14 的壓測腳本平常不會執行（要有 GPU 與 LAN），
 * 很容易在兩次驗收之間隨著程式改動而爛掉。這裡讓 CI 每次都跑一輪迷你壓測，
 * 確保驗收當天腳本是能用的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, groupBy, evaluate, pad, histogram } from './load/stats.mjs';
import { parseArgs, run } from './load/loadtest.mjs';

// ---------------- 統計 ----------------

test('百分位數採最近位次法', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(v, 50), 5);
  assert.equal(percentile(v, 90), 9);
  assert.equal(percentile(v, 100), 10);
  assert.equal(percentile(v, 0), 1);
  assert.equal(percentile([], 50), 0);
});

test('summarize 回傳完整統計', () => {
  const s = summarize([10, 20, 30, 40, 50]);
  assert.equal(s.count, 5);
  assert.equal(s.min, 10);
  assert.equal(s.max, 50);
  assert.equal(s.mean, 30);
  assert.equal(s.p50, 30);
});

test('summarize 處理空陣列', () => {
  assert.equal(summarize([]).count, 0);
  assert.equal(summarize([]).p99, 0);
});

test('groupBy 支援欄位名與函式', () => {
  const rows = [{ p: 'a', n: 1 }, { p: 'b', n: 2 }, { p: 'a', n: 3 }];
  assert.equal(groupBy(rows, 'p').get('a').length, 2);
  assert.equal(groupBy(rows, (r) => r.n > 1).get(true).length, 2);
});

test('pad 把中日韓字元算成兩格寬', () => {
  assert.equal(pad('abc', 6).length, 6);
  assert.equal(pad('中文', 6), '中文  '); // 4 格寬 + 2 空白
});

test('histogram 不會因單一數值而爆掉', () => {
  assert.match(histogram([5, 5, 5]), /全部落在/);
  assert.equal(histogram([]), '（無資料）');
});

// ---------------- 驗收判定 ----------------

function baseResult(overrides = {}) {
  return {
    requests: [{ status: 200, errorCode: '', priority: 'normal', queueWaitMs: 10, inputTokens: 1, outputTokens: 1 }],
    queueSamples: [{ waiting: 0, running: 0 }],
    accounting: null,
    byPriority: {},
    ...overrides,
  };
}

test('全部正常時判定通過', () => {
  const v = evaluate(baseResult());
  assert.equal(v.pass, true);
});

test('佇列類錯誤屬於預期內', () => {
  const v = evaluate(baseResult({
    requests: [{ status: 503, errorCode: 'queue_full', priority: 'normal' }],
  }));
  assert.equal(v.checks.find((c) => c.name === '無非預期錯誤').pass, true);
});

test('quota 情境刻意觸發的 413 屬於預期內', () => {
  const v = evaluate(baseResult({
    requests: [{ status: 413, errorCode: 'request_too_large', priority: 'normal' }],
  }));
  assert.equal(v.checks.find((c) => c.name === '無非預期錯誤').pass, true);
});

test('500 這類非預期錯誤會導致失敗', () => {
  const v = evaluate(baseResult({
    requests: [{ status: 500, errorCode: 'internal_error', priority: 'normal' }],
  }));
  assert.equal(v.pass, false);
  assert.equal(v.checks.find((c) => c.name === '無非預期錯誤').pass, false);
});

test('佇列未排空會導致失敗', () => {
  const v = evaluate(baseResult({ queueSamples: [{ waiting: 0, running: 3 }] }));
  assert.equal(v.pass, false);
  assert.equal(v.checks.find((c) => c.name === '結束時佇列已排空').pass, false);
});

test('低優先權全數失敗代表被餓死，判定失敗', () => {
  const v = evaluate(baseResult({
    requests: [
      { status: 200, errorCode: '', priority: 'admin', queueWaitMs: 1 },
      { status: 504, errorCode: 'queue_timeout', priority: 'guest' },
    ],
  }));
  assert.equal(v.checks.find((c) => c.name === '低優先權未被餓死').pass, false);
});

test('Token 誤差超過容許值會失敗', () => {
  const v = evaluate(baseResult({
    accounting: { serverTokens: 200, clientTokens: 100, tokenDrift: 100, tokenDriftPct: 100, clientRequestIds: [], serverRequestIds: new Set(), serverLogged: 0 },
  }), { tokenDriftPct: 5 });
  assert.equal(v.checks.find((c) => c.name === 'Token 計量相符').pass, false);
});

test('請求未寫入伺服器紀錄會失敗', () => {
  const v = evaluate(baseResult({
    accounting: { clientRequestIds: ['req_a', 'req_b'], serverRequestIds: new Set(['req_a']), serverLogged: 1, tokenDrift: null },
  }));
  assert.equal(v.checks.find((c) => c.name === '請求皆寫入 request_logs').pass, false);
});

test('效能觀察值不列為 fatal', () => {
  const v = evaluate(baseResult({
    byPriority: { admin: { wait: { p50: 5000 } }, guest: { wait: { p50: 10 } } },
  }));
  const check = v.checks.find((c) => c.name === '高優先權等待較短');
  assert.equal(check.pass, false);
  assert.equal(check.fatal, false);
  assert.equal(v.pass, true, '效能觀察值不該讓整體驗收失敗');
});

// ---------------- CLI 參數 ----------------

test('參數解析支援空白與等號兩種寫法', () => {
  assert.equal(parseArgs(['--users', '20']).users, 20);
  assert.equal(parseArgs(['--users=20']).users, 20);
  assert.equal(parseArgs(['--admin-pass', 'p@ss w0rd']).adminPass, 'p@ss w0rd');
  assert.equal(parseArgs(['--self-test']).selfTest, true);
  assert.equal(parseArgs(['--stream']).stream, true);
  assert.equal(parseArgs([]).users, 10);
});

test('未知參數要明確報錯，而不是默默忽略', () => {
  assert.throws(() => parseArgs(['--nope', '1']), /未知參數/);
  assert.throws(() => parseArgs(['--users']), /缺少值/);
});

// ---------------- 迷你端對端 ----------------

test('自我測試模式可完整跑完一輪並通過驗收', { timeout: 120000 }, async () => {
  const { result, verdict } = await run({
    ...parseArgs([]),
    selfTest: true,
    users: 4,
    duration: 3,
    maxTokens: 24,
    promptChars: 100,
    scenario: 'steady',
    quiet: true,
  });

  assert.ok(result.requests.length > 0, '應該有送出請求');
  assert.ok(result.requests.every((r) => r.status != null), '每筆請求都要有終局狀態');
  assert.ok(result.requests.some((r) => r.requestId), '應該取得 X-Request-Id');

  // 對帳是這支腳本的核心價值，一定要成立
  const logged = verdict.checks.find((c) => c.name === '請求皆寫入 request_logs');
  assert.equal(logged.pass, true, logged.detail);

  const drained = verdict.checks.find((c) => c.name === '結束時佇列已排空');
  assert.equal(drained.pass, true, drained.detail);

  assert.equal(verdict.pass, true, verdict.checks.filter((c) => !c.pass).map((c) => c.detail).join('; '));
});

test('burst 情境會打出 queue_full 而不是崩潰', { timeout: 120000 }, async () => {
  const { result } = await run({
    ...parseArgs([]),
    selfTest: true,
    users: 4,
    scenario: 'burst',
    maxTokens: 16,
    promptChars: 50,
    quiet: true,
  });

  const burst = result.requests.filter((r) => r.scenario === 'burst');
  assert.ok(burst.length > 0);
  assert.ok(burst.every((r) => r.status != null));

  // 過載時應該是乾淨的拒絕：429（併發/速率）或 503/504（佇列滿載、等待逾時）。
  // 出現 500、連線被拒（status 0）或請求無聲消失才代表有問題。
  const bad = burst.filter((r) => r.status !== 200 && ![429, 503, 504].includes(r.status));
  assert.equal(bad.length, 0, `非預期狀態：${[...new Set(bad.map((r) => `${r.status} ${r.errorCode}`))].join(', ')}`);

  const rejected = burst.filter((r) => r.status !== 200);
  assert.ok(rejected.length > 0, 'burst 應該要打到某個上限，否則這個情境沒有意義');
});

test('quota 情境確實擋下 RPM、單次上限與每日額度', { timeout: 120000 }, async () => {
  const { result } = await run({
    ...parseArgs([]),
    selfTest: true,
    users: 4,
    scenario: 'quota',
    quiet: true,
  });

  const codes = new Set(result.requests.map((r) => r.errorCode).filter(Boolean));
  assert.ok(codes.has('rate_limit_exceeded'), 'RPM 應該被擋');
  assert.ok(codes.has('request_too_large'), '單次上限應該被擋');
  assert.ok(codes.has('quota_exceeded'), '每日額度應該被擋');
});
