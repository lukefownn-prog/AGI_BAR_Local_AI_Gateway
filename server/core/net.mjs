/**
 * 找出「其他裝置真正連得到」的本機位址。
 *
 * 這件事沒有看起來簡單。一台開發機上 os.networkInterfaces() 常常同時列出：
 *
 *   vEthernet (WSL)              172.26.96.1     ← 虛擬，手機連不到
 *   vEthernet (Default Switch)   192.168.64.1    ← Hyper-V 虛擬，連不到
 *   Wi-Fi                        192.168.2.124   ← 這才是區網位址
 *   乙太網路                       169.254.132.206 ← 沒拿到 DHCP，等於沒接
 *
 * 直接取第一個會告訴管理員一個永遠連不上的網址，而且錯得很難察覺 ——
 * 本機測都正常，只有拿手機試才會發現。
 */
import os from 'node:os';
import net from 'node:net';

/** Windows 上常見的虛擬介面名稱。這些位址對區網上的其他裝置無意義。 */
const VIRTUAL_NAME = /vethernet|hyper-?v|vmware|virtualbox|vbox|docker|wsl|loopback|bluetooth|藍牙|tap-|tunnel|teredo|npcap/i;

/**
 * 回傳候選位址，最可能可用的排在前面。
 * @returns {{ name: string, address: string, virtual: boolean }[]}
 */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      // 169.254.x.x 是 APIPA：代表沒取得 DHCP 位址，那條線實際上不通
      if (ni.address.startsWith('169.254.')) continue;
      out.push({ name, address: ni.address, virtual: VIRTUAL_NAME.test(name) });
    }
  }
  // 實體介面優先；同類則維持系統列出的順序
  return out.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

/** 最適合拿去給其他裝置用的位址，沒有就回 null。 */
export function primaryLanAddress() {
  return lanAddresses().find((a) => !a.virtual)?.address
    ?? lanAddresses()[0]?.address
    ?? null;
}

export function lanUrls(port) {
  return lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${port}` }));
}

// ---------------- CIDR 判斷 ----------------
//
// 管理台的存取隔離（services/access.mjs）靠這組函式判斷來源位址是否為
// loopback 或管理員自行放行的網段。判定對象是 TCP 連線的對端位址，
// 不是任何可偽造的標頭 —— 詳見 access.mjs 的說明。

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8 >>> 0) + Number(o), 0) >>> 0;
}

function inIpv4Cidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw ?? 32);
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function expandIpv6(ip) {
  const clean = ip.split('%')[0];
  const [head, tail = ''] = clean.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - h.length - t.length;
  const parts = [...h, ...Array(clean.includes('::') ? Math.max(0, missing) : 0).fill('0'), ...t];
  return parts.map((p) => parseInt(p || '0', 16));
}

function inIpv6Cidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw ?? 128);
  const a = expandIpv6(ip);
  const b = expandIpv6(base);
  if (a.length !== 8 || b.length !== 8) return false;
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 0 ? 0 : (0xffff << (16 - take)) & 0xffff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

export function ipInCidr(ip, cidr) {
  const v6 = cidr.includes(':');
  const ipIsV6 = net.isIPv6(ip);
  if (v6 !== ipIsV6) {
    // ::ffff:10.0.0.1 這類對映位址要還原成 IPv4 再比對
    if (ipIsV6 && !v6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.test(ip)) {
      return inIpv4Cidr(RegExp.$1, cidr);
    }
    return false;
  }
  return v6 ? inIpv6Cidr(ip, cidr) : inIpv4Cidr(ip, cidr);
}
