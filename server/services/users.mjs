/**
 * 人員管理（規畫書 3 / 5）。V1 規模：1 位 Admin + 1-50 位 User。
 */
import { all, get, run, transaction, audit } from '../core/db.mjs';
import { hashPassword } from '../core/crypto.mjs';
import { HttpError } from '../core/http.mjs';
import { log } from '../core/logger.mjs';

export const USER_STATUSES = ['active', 'paused', 'disabled'];
export const ROLES = ['admin', 'user'];

export function listUsers() {
  return all(`
    SELECT u.*,
           (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id AND k.status = 'active') AS active_keys,
           (SELECT COALESCE(SUM(total_tokens), 0) FROM usage_logs g
             WHERE g.user_id = u.id AND date(g.ts) = date('now')) AS tokens_today
    FROM users u
    ORDER BY (u.role = 'admin') DESC, u.id ASC
  `);
}

export function getUser(id) {
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

export function getUserByUsername(username) {
  return get('SELECT * FROM users WHERE username = ?', [username]);
}

export function countNonAdminUsers() {
  return get("SELECT COUNT(*) AS n FROM users WHERE role <> 'admin'").n;
}

export function createUser({ username, displayName = '', email = '', role = 'user', status = 'active', password = null, note = '' }, ctx = {}) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9._-]{2,32}$/.test(username)) {
    throw new HttpError(400, 'invalid_username', '帳號需為 2-32 字元的英數字、點、底線或連字號');
  }
  if (!ROLES.includes(role)) throw new HttpError(400, 'invalid_role', '角色不正確');
  if (!USER_STATUSES.includes(status)) throw new HttpError(400, 'invalid_status', '狀態不正確');
  if (getUserByUsername(username)) throw new HttpError(409, 'username_taken', '帳號已存在');

  const maxUsers = ctx.maxUsers ?? 50;
  if (role !== 'admin' && countNonAdminUsers() >= maxUsers) {
    throw new HttpError(409, 'user_limit_reached', `人員數已達上限 ${maxUsers} 位`);
  }

  const info = run(
    `INSERT INTO users (username, display_name, email, role, status, password_hash, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [username, displayName, email, role, status, password ? hashPassword(password) : null, note],
  );
  const id = Number(info.lastInsertRowid);
  audit(ctx.actorId, 'user.create', `user:${id}`, { username, role }, ctx.clientIp);
  log.info('建立人員', { id, username, role });
  return getUser(id);
}

export function updateUser(id, patch, ctx = {}) {
  const user = getUser(id);
  if (!user) throw new HttpError(404, 'user_not_found', '找不到人員');

  const fields = [];
  const params = [];
  const map = { displayName: 'display_name', email: 'email', status: 'status', note: 'note', role: 'role' };
  for (const [key, col] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    if (col === 'status' && !USER_STATUSES.includes(patch[key])) {
      throw new HttpError(400, 'invalid_status', '狀態不正確');
    }
    if (col === 'role') {
      if (!ROLES.includes(patch[key])) throw new HttpError(400, 'invalid_role', '角色不正確');
      if (user.role === 'admin' && patch.role !== 'admin' && countAdmins() <= 1) {
        throw new HttpError(409, 'last_admin', '系統至少需保留 1 位管理員');
      }
    }
    fields.push(`${col} = ?`);
    params.push(patch[key]);
  }
  if (patch.password) {
    fields.push('password_hash = ?');
    params.push(hashPassword(patch.password));
  }
  if (!fields.length) return user;

  fields.push("updated_at = datetime('now')");
  run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
  audit(ctx.actorId, 'user.update', `user:${id}`, Object.keys(patch).join(','), ctx.clientIp);
  return getUser(id);
}

export function deleteUser(id, ctx = {}) {
  const user = getUser(id);
  if (!user) throw new HttpError(404, 'user_not_found', '找不到人員');
  if (user.role === 'admin' && countAdmins() <= 1) {
    throw new HttpError(409, 'last_admin', '系統至少需保留 1 位管理員');
  }
  transaction(() => run('DELETE FROM users WHERE id = ?', [id]));
  audit(ctx.actorId, 'user.delete', `user:${id}`, user.username, ctx.clientIp);
  log.warn('刪除人員', { id, username: user.username });
  return true;
}

export function countAdmins() {
  return get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;
}

export function touchLastSeen(userId) {
  run("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?", [userId]);
}

/**
 * V1.2 之前的初始管理員被塞了一個寫死的中文顯示名稱。
 *
 * 那不是管理員自己填的資料，是我們的預設值 —— 但它一旦落進 users.display_name，
 * 介面就只能照實顯示，於是切到英文/日文時整個管理台只剩這一格是中文。
 * 啟動時清掉，之後由介面回退顯示帳號（管理員仍可自行填真正的姓名）。
 *
 * 只比對完全相同的舊預設值，且只動 admin —— 若有人真的把自己命名為這四個字，
 * 那是他自己填的，不該被我們改掉；但那筆會是 role='user'，不在範圍內。
 */
const LEGACY_ADMIN_DISPLAY_NAME = '系統管理員';

function clearLegacyAdminDisplayName() {
  const info = run(
    "UPDATE users SET display_name = '' WHERE role = 'admin' AND display_name = ?",
    [LEGACY_ADMIN_DISPLAY_NAME],
  );
  if (info.changes) {
    log.info('已清除初始管理員的預設顯示名稱（改由介面依語言顯示）', { rows: info.changes });
  }
}

/** 首次啟動：由 config.admin 建立初始管理員。 */
export function bootstrapAdmin(config) {
  clearLegacyAdminDisplayName();
  if (countAdmins() > 0) return null;
  const { username, initialPassword } = config.admin;
  // 不預填顯示名稱：任何寫死的字串都會在其他語言下變成突兀的外語
  const admin = createUser(
    { username, role: 'admin', status: 'active', password: initialPassword },
    { maxUsers: Number.MAX_SAFE_INTEGER, actorId: null },
  );
  log.warn('已建立初始管理員，請立即登入並修改密碼', { username });
  return admin;
}
