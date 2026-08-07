/** 受控上網的網路政策（規畫書 9）。SSRF 防護是 V1 安全驗收重點。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ipInCidr, isBlockedIp, assertUrlAllowed, htmlToText } from '../server/services/websafe.mjs';

const BLOCKED = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
  '169.254.0.0/16', '0.0.0.0/8', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10',
];

const POLICY = {
  allowedSchemes: ['http', 'https'],
  blockPrivateNetworks: true,
  blockedCidrs: BLOCKED,
  domainBlocklist: ['localhost', '*.local', '*.internal', '*.lan'],
  domainAllowlist: [],
};

test('IPv4 CIDR 判斷正確', () => {
  assert.equal(ipInCidr('127.0.0.1', '127.0.0.0/8'), true);
  assert.equal(ipInCidr('10.20.30.40', '10.0.0.0/8'), true);
  assert.equal(ipInCidr('172.16.5.4', '172.16.0.0/12'), true);
  assert.equal(ipInCidr('172.32.5.4', '172.16.0.0/12'), false);
  assert.equal(ipInCidr('192.168.1.1', '192.168.0.0/16'), true);
  assert.equal(ipInCidr('169.254.169.254', '169.254.0.0/16'), true); // 雲端 metadata
  assert.equal(ipInCidr('8.8.8.8', '10.0.0.0/8'), false);
});

test('IPv6 CIDR 判斷正確', () => {
  assert.equal(ipInCidr('::1', '::1/128'), true);
  assert.equal(ipInCidr('fd00::1', 'fc00::/7'), true);
  assert.equal(ipInCidr('fe80::1', 'fe80::/10'), true);
  assert.equal(ipInCidr('2001:4860:4860::8888', 'fc00::/7'), false);
});

test('IPv4-mapped IPv6 不能繞過內網封鎖', () => {
  assert.ok(isBlockedIp('::ffff:10.0.0.1', BLOCKED));
  assert.ok(isBlockedIp('::ffff:192.168.0.1', BLOCKED));
});

test('公開 IP 不被封鎖', () => {
  assert.equal(isBlockedIp('8.8.8.8', BLOCKED), false);
  assert.equal(isBlockedIp('1.1.1.1', BLOCKED), false);
});

test('內網位址與 localhost 被拒絕', async () => {
  const targets = [
    'http://127.0.0.1:8080/',
    'http://localhost/admin',
    'http://192.168.1.1/',
    'http://10.0.0.5/nas',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:8787/',
  ];
  for (const t of targets) {
    await assert.rejects(assertUrlAllowed(t, POLICY), (err) => err.status === 403, `應封鎖：${t}`);
  }
});

test('非 http/https 協定被拒絕', async () => {
  for (const t of ['file:///C:/Windows/win.ini', 'ftp://example.com/x', 'gopher://example.com']) {
    await assert.rejects(assertUrlAllowed(t, POLICY), (err) => err.status === 403);
  }
});

test('允許清單啟用後，清單外的網域被拒絕', async () => {
  const strict = { ...POLICY, domainAllowlist: ['example.com', '*.wikipedia.org'] };
  await assert.rejects(assertUrlAllowed('https://evil.example.net/', strict),
    (err) => err.code === 'domain_not_allowlisted');
});

test('格式錯誤的網址被拒絕', async () => {
  await assert.rejects(assertUrlAllowed('not a url', POLICY), (err) => err.status === 400);
});

test('HTML 轉純文字會移除 script 與 style', () => {
  const html = '<html><head><style>a{color:red}</style></head><body><script>alert(1)</script><p>你好</p><p>世界</p></body></html>';
  const text = htmlToText(html);
  assert.ok(!text.includes('alert'));
  assert.ok(!text.includes('color:red'));
  assert.ok(text.includes('你好'));
  assert.ok(text.includes('世界'));
});
