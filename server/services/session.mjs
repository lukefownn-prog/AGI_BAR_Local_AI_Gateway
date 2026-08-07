/**
 * 管理員 Session：HttpOnly + SameSite=Lax Cookie，值經 HMAC 簽章，狀態存於資料庫。
 */
import { get, run, audit } from '../core/db.mjs';
import { getSessionSecret, sign, unsign, randomId, verifyPassword } from '../core/crypto.mjs';
import { parseCookies, setCookie, HttpError } from '../core/http.mjs';
import { getUserByUsername, touchLastSeen } from './users.mjs';
import { log } from '../core/logger.mjs';

export const COOKIE_NAME = 'agibar_session';

const loginAttempts = new Map(); // ip -> 時間戳陣列

function rateLimitLogin(ip, perMin) {
  const now = Date.now();
  const list = (loginAttempts.get(ip) || []).filter((t) => now - t < 60000);
  if (list.length >= perMin) return false;
  list.push(now);
  loginAttempts.set(ip, list);
  return true;
}

export function login({ username, password, clientIp, userAgent, config }) {
  if (!rateLimitLogin(clientIp, config.security?.adminLoginRateLimitPerMin ?? 10)) {
    throw new HttpError(429, 'too_many_attempts', '登入嘗試過於頻繁，請稍後再試');
  }
  const user = getUserByUsername(String(username || '').trim());
  // 帳號錯誤與密碼錯誤回傳相同訊息，避免帳號列舉
  if (!user || !user.password_hash || !verifyPassword(String(password || ''), user.password_hash)) {
    log.warn('登入失敗', { username, clientIp });
    throw new HttpError(401, 'invalid_credentials', '帳號或密碼錯誤');
  }
  if (user.role !== 'admin') throw new HttpError(403, 'not_admin', '此帳號無管理權限');
  if (user.status !== 'active') throw new HttpError(403, 'user_inactive', '此帳號目前無法登入');

  const id = randomId(24);
  const ttlHours = config.security?.sessionTtlHours ?? 12;
  run(
    `INSERT INTO admin_sessions (id, user_id, expires_at, client_ip, user_agent)
     VALUES (?, ?, datetime('now', ?), ?, ?)`,
    [id, user.id, `+${ttlHours} hours`, clientIp, String(userAgent || '').slice(0, 200)],
  );
  touchLastSeen(user.id);
  audit(user.id, 'auth.login', `user:${user.id}`, '', clientIp);
  log.info('管理員登入', { username: user.username, clientIp });
  return { sessionId: id, user, ttlHours };
}

export function applySessionCookie(res, sessionId, { ttlHours = 12, secure = false } = {}) {
  setCookie(res, COOKIE_NAME, sign(sessionId, getSessionSecret()), {
    maxAge: ttlHours * 3600,
    secure,
  });
}

export function clearSessionCookie(res) {
  setCookie(res, COOKIE_NAME, '', { maxAge: 0 });
}

export function currentSession(req) {
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) return null;
  const sessionId = unsign(raw, getSessionSecret());
  if (!sessionId) return null;
  const row = get(
    `SELECT s.*, u.username, u.role, u.status, u.display_name
     FROM admin_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > datetime('now')`,
    [sessionId],
  );
  if (!row) return null;
  if (row.role !== 'admin' || row.status !== 'active') return null;
  return { sessionId, user: { id: row.user_id, username: row.username, role: row.role, displayName: row.display_name } };
}

export function requireAdmin(req) {
  const session = currentSession(req);
  if (!session) throw new HttpError(401, 'unauthenticated', '請先登入管理介面');
  return session;
}

export function logout(req, res) {
  const session = currentSession(req);
  if (session) {
    run('DELETE FROM admin_sessions WHERE id = ?', [session.sessionId]);
    audit(session.user.id, 'auth.logout', `user:${session.user.id}`);
  }
  clearSessionCookie(res);
}

export function purgeExpiredSessions() {
  run("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')");
}
