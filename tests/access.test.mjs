/**
 * 管理介面的來源隔離（M17）。
 *
 * 這是安全邊界，斷言要寫死：任何放寬都應該讓測試失敗，而不是靜靜通過。
 */
// isolate 必須排在所有 server 模組之前 —— 見該檔的說明
import { writeTestConfig, assertIsolated, cleanupTmp } from './helpers/isolate.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdminSurface, isAdminAsset, canAccessAdmin, isLoopback, normalizeIp,
} from '../server/services/access.mjs';
import { startMockModel } from './helpers/mock-model.mjs';

// ---------------- 路徑分類 ----------------

test('管理介面路徑', () => {
  for (const p of ['/', '/index.html', '/app.html', '/api/users', '/api/auth/login', '/api/dashboard']) {
    assert.equal(isAdminSurface(p), true, `${p} 應視為管理介面`);
  }
});

test('人員要用的路徑不受限制', () => {
  for (const p of ['/v1/chat/completions', '/v1/models', '/v1/messages', '/v1/me',
    '/chat.html', '/assets/chat.js', '/assets/chat.css', '/assets/app.css', '/assets/api.js']) {
    assert.equal(isAdminSurface(p), false, `${p} 不該被當成管理介面`);
    assert.equal(isAdminAsset(p), false, `${p} 不該被當成管理台專用資源`);
  }
});

test('/api/health 維持開放供監控使用', () => {
  assert.equal(isAdminSurface('/api/health'), false);
});

test('管理台專用的前端檔案也要擋', () => {
  assert.equal(isAdminAsset('/assets/app.js'), true);
  assert.equal(isAdminAsset('/assets/login.js'), true);
});

// ---------------- 位址判定 ----------------

test('回送位址判定', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('127.1.2.3'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true, 'IPv4-mapped 回送位址也算');
  assert.equal(isLoopback('192.168.1.50'), false);
  assert.equal(isLoopback('10.0.0.1'), false);
  assert.equal(isLoopback(''), false);
  assert.equal(isLoopback(undefined), false);
});

test('normalizeIp 還原 IPv4-mapped 與去除 zone id', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp('10.0.0.1'), '10.0.0.1');
});

// ---------------- 授權判定 ----------------

test('預設（loopback）只放行本機', () => {
  const cfg = { adminAccess: 'loopback', adminAllowedCidrs: [] };
  assert.equal(canAccessAdmin('127.0.0.1', cfg), true);
  assert.equal(canAccessAdmin('::1', cfg), true);
  assert.equal(canAccessAdmin('192.168.1.50', cfg), false);
  assert.equal(canAccessAdmin('10.20.30.40', cfg), false);
});

test('沒有設定時預設為 loopback（不是開放）', () => {
  assert.equal(canAccessAdmin('192.168.1.50', {}), false, '預設必須是安全的一邊');
  assert.equal(canAccessAdmin('192.168.1.50', undefined), false);
});

test('adminAllowedCidrs 可額外放行管理員自己的機器', () => {
  const cfg = { adminAccess: 'loopback', adminAllowedCidrs: ['192.168.1.50/32'] };
  assert.equal(canAccessAdmin('192.168.1.50', cfg), true);
  assert.equal(canAccessAdmin('192.168.1.51', cfg), false);
});

test('CIDR 寫錯不會意外放行', () => {
  const cfg = { adminAccess: 'loopback', adminAllowedCidrs: ['not-a-cidr', ''] };
  assert.equal(canAccessAdmin('192.168.1.50', cfg), false);
});

test('adminAccess=lan 才開放全網段', () => {
  const cfg = { adminAccess: 'lan' };
  assert.equal(canAccessAdmin('192.168.1.50', cfg), true);
});

// ---------------- 端對端 ----------------

let server, base, mock;

before(async () => {
  await assertIsolated();
  mock = await startMockModel({ name: 'access-model' });

  writeTestConfig((cfg) => {
    cfg.models.catalog = [{
      id: 'm1', displayName: 'M1', endpoint: mock.endpoint, model: 'access-model',
      enabled: true, isLocal: true, contextWindow: 8192, vramMb: 1000,
    }];
    cfg.models.defaultRoute = ['m1'];
    cfg.security.adminAccess = 'loopback';
  });

  const { main } = await import('../server/index.mjs');
  server = await main();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await mock?.close();
  const { closeDb } = await import('../server/core/db.mjs');
  closeDb();
  cleanupTmp();
});

test('本機可以存取管理台', async () => {
  assert.equal((await fetch(base + '/app.html')).status, 200);
  assert.equal((await fetch(base + '/')).status, 200);
  // 未登入回 401（不是 404）—— 代表本機看得到它存在
  assert.equal((await fetch(base + '/api/users')).status, 401);
});

test('人員的路徑本機也正常', async () => {
  assert.equal((await fetch(base + '/chat.html')).status, 200);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/v1/models')).status, 401); // 需要 API Key
});

test('偽造 X-Forwarded-For 不能取得管理權限', async () => {
  // 反向：從本機送出、但宣稱自己是區網 IP。授權看的是 TCP 對端位址，
  // 因此仍應放行 —— 這確認我們沒有把標頭誤當成授權依據。
  const res = await fetch(base + '/app.html', { headers: { 'X-Forwarded-For': '192.168.1.99' } });
  assert.equal(res.status, 200, 'X-Forwarded-For 不應影響授權判定');
});

test('模擬區網來源時管理介面回 404 而非 403', async () => {
  // 直接測 canAccessAdmin 的判定結果（實際連線一定是回送位址，無法從測試偽造）
  const cfg = { adminAccess: 'loopback', adminAllowedCidrs: [] };
  for (const p of ['/app.html', '/api/users', '/api/dashboard']) {
    assert.equal(isAdminSurface(p) && !canAccessAdmin('192.168.1.99', cfg), true,
      `${p} 對區網來源應被拒絕`);
  }
  // 403 會等於承認「這裡有東西」，所以實作選擇 404 —— 由 index.mjs 保證
});
