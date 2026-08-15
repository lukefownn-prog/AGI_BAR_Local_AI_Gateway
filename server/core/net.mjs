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
