/**
 * 對外位址的挑選（core/net.mjs）。
 *
 * 這段錯了的話症狀很難察覺：管理員在本機測一切正常，只有拿手機連才會發現
 * 給出去的是虛擬網卡位址、永遠連不上。所以把排序規則釘死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { lanAddresses, primaryLanAddress, lanUrls, ipInCidr } from '../server/core/net.mjs';

/** 暫時替換 os.networkInterfaces，模擬各種機器組態。 */
function withInterfaces(fake, fn) {
  const real = os.networkInterfaces;
  os.networkInterfaces = () => fake;
  try { return fn(); } finally { os.networkInterfaces = real; }
}

const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal });

test('實體介面排在虛擬介面前面', () => {
  withInterfaces({
    'vEthernet (WSL)': [v4('172.26.96.1')],
    'vEthernet (Default Switch)': [v4('192.168.64.1')],
    'Wi-Fi': [v4('192.168.2.124')],
  }, () => {
    assert.equal(primaryLanAddress(), '192.168.2.124',
      '應選 Wi-Fi 而不是 WSL —— 手機連不到虛擬網卡');
    assert.deepEqual(lanAddresses().map((a) => a.address),
      ['192.168.2.124', '172.26.96.1', '192.168.64.1']);
  });
});

test('各種虛擬介面名稱都能辨識', () => {
  const virtualNames = [
    'vEthernet (WSL)', 'Hyper-V Virtual Ethernet', 'VMware Network Adapter VMnet1',
    'VirtualBox Host-Only Network', 'Docker Desktop', '藍牙網路連線',
  ];
  for (const name of virtualNames) {
    withInterfaces({ [name]: [v4('10.1.2.3')], 'Wi-Fi': [v4('192.168.1.5')] }, () => {
      assert.equal(primaryLanAddress(), '192.168.1.5', `${name} 應被視為虛擬介面`);
    });
  }
});

test('169.254.x（APIPA）完全排除', () => {
  // 沒拿到 DHCP 位址代表那條線實際上不通，列出來只會誤導
  withInterfaces({
    '乙太網路': [v4('169.254.132.206')],
    'Wi-Fi': [v4('192.168.2.124')],
  }, () => {
    assert.deepEqual(lanAddresses().map((a) => a.address), ['192.168.2.124']);
  });
});

test('回送位址不列入', () => {
  withInterfaces({
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
    'Wi-Fi': [v4('192.168.2.124')],
  }, () => {
    assert.deepEqual(lanAddresses().map((a) => a.address), ['192.168.2.124']);
  });
});

test('只有虛擬介面時仍給得出答案，不是回 null', () => {
  withInterfaces({ 'vEthernet (WSL)': [v4('172.26.96.1')] }, () => {
    assert.equal(primaryLanAddress(), '172.26.96.1');
    assert.equal(lanAddresses()[0].virtual, true, '但要標記為虛擬，讓橫幅可以提醒');
  });
});

test('完全沒有對外介面時回 null 而不是丟例外', () => {
  withInterfaces({ 'Loopback': [v4('127.0.0.1', true)] }, () => {
    assert.equal(primaryLanAddress(), null);
    assert.deepEqual(lanAddresses(), []);
  });
});

test('lanUrls 帶上埠號', () => {
  withInterfaces({ 'Wi-Fi': [v4('192.168.2.124')] }, () => {
    assert.deepEqual(lanUrls(8788), [
      { name: 'Wi-Fi', address: '192.168.2.124', virtual: false, url: 'http://192.168.2.124:8788' },
    ]);
  });
});

test('IPv6 不列入（人員設定用的是 IPv4 位址）', () => {
  withInterfaces({
    'Wi-Fi': [v4('192.168.2.124'), { address: 'fe80::1', family: 'IPv6', internal: false }],
  }, () => {
    assert.deepEqual(lanAddresses().map((a) => a.address), ['192.168.2.124']);
  });
});

// ---------------- CIDR 判斷 ----------------
//
// 管理台的存取隔離（services/access.mjs）完全靠這組判斷決定誰進得來。
// 判錯的方向只有一個是致命的：把不該放行的來源判成 true，
// 等於區網任何人都能開管理台。所以規則釘死在測試裡。

test('IPv4 CIDR 判斷正確', () => {
  assert.equal(ipInCidr('127.0.0.1', '127.0.0.0/8'), true);
  assert.equal(ipInCidr('10.20.30.40', '10.0.0.0/8'), true);
  assert.equal(ipInCidr('172.16.5.4', '172.16.0.0/12'), true);
  assert.equal(ipInCidr('172.32.5.4', '172.16.0.0/12'), false);
  assert.equal(ipInCidr('192.168.1.1', '192.168.0.0/16'), true);
  assert.equal(ipInCidr('192.168.1.50', '192.168.1.50/32'), true);
  assert.equal(ipInCidr('192.168.1.51', '192.168.1.50/32'), false);
  assert.equal(ipInCidr('8.8.8.8', '10.0.0.0/8'), false);
});

test('IPv6 CIDR 判斷正確', () => {
  assert.equal(ipInCidr('::1', '::1/128'), true);
  assert.equal(ipInCidr('fd00::1', 'fc00::/7'), true);
  assert.equal(ipInCidr('fe80::1', 'fe80::/10'), true);
  assert.equal(ipInCidr('2001:4860:4860::8888', 'fc00::/7'), false);
});

test('IPv4-mapped IPv6 會還原成 IPv4 比對', () => {
  assert.equal(ipInCidr('::ffff:127.0.0.1', '127.0.0.0/8'), true);
  assert.equal(ipInCidr('::ffff:8.8.8.8', '127.0.0.0/8'), false);
});

test('位址族不符時不誤判為命中', () => {
  assert.equal(ipInCidr('8.8.8.8', '::1/128'), false);
  assert.equal(ipInCidr('2001:db8::1', '10.0.0.0/8'), false);
});
