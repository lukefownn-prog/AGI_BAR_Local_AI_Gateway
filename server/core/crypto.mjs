/**
 * 密碼、API Key 與 Session 簽章。全部使用 node:crypto，無外部相依。
 *
 * 安全原則（規畫書 5 / 16.1）：
 *  - 管理員密碼：scrypt + 隨機 salt，資料庫只存雜湊。
 *  - API Key：只在建立當下回傳明文一次；資料庫存 SHA-256 雜湊 + 可辨識前綴。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { paths } from './paths.mjs';

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, n, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** 產生 agi-bar-xxxxxxxx… 格式的 API Key。回傳明文僅此一次。 */
export function generateApiKey(prefix = 'agi-bar-') {
  const body = crypto.randomBytes(24).toString('base64url'); // 32 chars
  const plaintext = `${prefix}${body}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, prefix.length + 6),
    last4: plaintext.slice(-4),
  };
}

export function hashApiKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** 讀取或建立 session 簽章祕鑰，保存在 data/（不進 Git）。 */
export function getSessionSecret() {
  if (fs.existsSync(paths.sessionSecret)) {
    const s = fs.readFileSync(paths.sessionSecret, 'utf8').trim();
    if (s.length >= 32) return s;
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(paths.sessionSecret, secret, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

export function sign(value, secret) {
  const mac = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function unsign(signed, secret) {
  const idx = String(signed).lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 不記錄原始 Prompt 時，用雜湊做問題追蹤。 */
export function shortHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}
