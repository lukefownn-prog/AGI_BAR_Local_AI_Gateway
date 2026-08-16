/**
 * 管理介面的存取隔離。
 *
 * 目的：讓區網人員只看得到 /v1 與網頁聊天，管理台完全碰不到。
 *
 * 做法是「真正隔離」而不是「換一個猜不到的網址」——
 * 後者只要有人看過一次網址、或掃過瀏覽紀錄就破功。這裡改用來源位址判定：
 *
 *  - 判定依據是 TCP 連線的對端位址（req.socket.remoteAddress）。
 *    這個值不可能偽造：要讓 TCP 三向交握完成，封包必須真的回得到該位址。
 *  - **絕對不能**改用 X-Forwarded-For。那是請求標頭，任何人都能自己填；
 *    用它做存取控制等於沒有控制。即使 trustProxy 開著也一樣 ——
 *    那個設定只影響「紀錄裡寫哪個 IP」，不影響這裡的授權判定。
 *  - 未授權一律回 404 而非 403。403 等於告訴對方「這裡有東西，只是你不能進」，
 *    404 則讓管理台看起來根本不存在。
 */
import { ipInCidr } from '../core/net.mjs';

/** 管理介面的路徑。其餘（/v1、/chat.html、靜態資源）視為人員可用。 */
export function isAdminSurface(pathname) {
  if (pathname === '/' || pathname === '/index.html' || pathname === '/app.html') return true;
  if (pathname.startsWith('/api/')) {
    // /api/health 是給監控與部署腳本用的，不含任何敏感資訊，維持開放
    return pathname !== '/api/health';
  }
  return false;
}

/** 管理台前端會用到、但人員的聊天頁不需要的靜態檔。 */
export function isAdminAsset(pathname) {
  return pathname === '/assets/app.js' || pathname === '/assets/login.js';
}

const LOOPBACK = ['127.0.0.0/8', '::1/128'];

export function isLoopback(ip) {
  if (!ip) return false;
  const clean = normalizeIp(ip);
  return LOOPBACK.some((cidr) => {
    try { return ipInCidr(clean, cidr); } catch { return false; }
  });
}

/** ::ffff:127.0.0.1 這類對映位址要還原成 IPv4 才比得出來。 */
export function normalizeIp(ip) {
  const s = String(ip || '').split('%')[0];
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

/**
 * 這個連線可以存取管理介面嗎？
 * @param {string} remoteAddress req.socket.remoteAddress（不是任何標頭）
 */
export function canAccessAdmin(remoteAddress, securityConfig = {}) {
  if ((securityConfig.adminAccess ?? 'loopback') === 'lan') return true;

  const ip = normalizeIp(remoteAddress);
  if (isLoopback(ip)) return true;

  for (const cidr of securityConfig.adminAllowedCidrs ?? []) {
    try { if (ipInCidr(ip, cidr)) return true; } catch { /* 設定寫錯不放行 */ }
  }
  return false;
}
