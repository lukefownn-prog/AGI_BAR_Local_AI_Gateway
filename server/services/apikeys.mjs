/**
 * API Key 與其限制（規畫書 5）。
 * 明文 Key 只在建立/重新產生的當下回傳一次，資料庫僅保存 SHA-256 雜湊與識別前綴。
 */
import { all, get, run, transaction, audit } from '../core/db.mjs';
import { generateApiKey, hashApiKey } from '../core/crypto.mjs';
import { HttpError } from '../core/http.mjs';
import { log } from '../core/logger.mjs';

export const PRIORITIES = ['admin', 'high', 'normal', 'guest'];
export const KEY_STATUSES = ['active', 'paused', 'revoked'];

const LIMIT_COLUMNS = {
  tokensPerRequest: 'tokens_per_request',
  tokensPerHour: 'tokens_per_hour',
  tokensPerDay: 'tokens_per_day',
  tokensPerMonth: 'tokens_per_month',
  rpm: 'rpm',
  concurrent: 'concurrent',
  priority: 'priority',
  internetAllowed: 'internet_allowed',
  validFrom: 'valid_from',
  validUntil: 'valid_until',
  dailyWindowStart: 'daily_window_start',
  dailyWindowEnd: 'daily_window_end',
  weekdays: 'weekdays',
  overQuotaPolicy: 'over_quota_policy',
};

function defaultsToRow(d) {
  return {
    tokens_per_request: d.tokensPerRequest,
    tokens_per_hour: d.tokensPerHour,
    tokens_per_day: d.tokensPerDay,
    tokens_per_month: d.tokensPerMonth,
    rpm: d.rpm,
    concurrent: d.concurrent,
    priority: d.priority,
    internet_allowed: d.internetAllowed ? 1 : 0,
    valid_from: d.validFrom ?? null,
    valid_until: d.validUntil ?? null,
    daily_window_start: d.dailyWindowStart ?? '00:00',
    daily_window_end: d.dailyWindowEnd ?? '23:59',
    weekdays: Array.isArray(d.weekdays) ? d.weekdays.join(',') : (d.weekdays ?? '0,1,2,3,4,5,6'),
    over_quota_policy: d.overQuotaPolicy ?? 'hard',
  };
}

export function listKeys(userId = null) {
  const sql = `
    SELECT k.*, u.username, u.display_name, u.status AS user_status, u.role,
           l.tokens_per_request, l.tokens_per_hour, l.tokens_per_day, l.tokens_per_month,
           l.rpm, l.concurrent, l.priority, l.internet_allowed,
           l.valid_from, l.valid_until, l.daily_window_start, l.daily_window_end,
           l.weekdays, l.over_quota_policy
    FROM api_keys k
    JOIN users u ON u.id = k.user_id
    LEFT JOIN api_key_limits l ON l.api_key_id = k.id
    ${userId ? 'WHERE k.user_id = ?' : ''}
    ORDER BY k.id DESC`;
  return all(sql, userId ? [userId] : []);
}

export function getKey(id) {
  return listKeys().find((k) => k.id === Number(id)) ?? null;
}

/** 建立 API Key。回傳物件內的 plaintext 只此一次可見。 */
export function createKey(userId, { name = 'default', limits = {} } = {}, ctx = {}) {
  const user = get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new HttpError(404, 'user_not_found', '找不到人員');

  const prefix = ctx.apiKeyPrefix || 'agi-bar-';
  const key = generateApiKey(prefix);
  const merged = { ...(ctx.defaultLimits || {}), ...limits };
  const row = defaultsToRow(merged);

  const id = transaction(() => {
    const info = run(
      'INSERT INTO api_keys (user_id, name, key_prefix, key_hash, last4) VALUES (?, ?, ?, ?, ?)',
      [userId, name, key.keyPrefix, key.hash, key.last4],
    );
    const keyId = Number(info.lastInsertRowid);
    const cols = Object.keys(row);
    run(
      `INSERT INTO api_key_limits (api_key_id, ${cols.join(', ')})
       VALUES (?, ${cols.map(() => '?').join(', ')})`,
      [keyId, ...cols.map((c) => row[c])],
    );
    return keyId;
  });

  audit(ctx.actorId, 'apikey.create', `key:${id}`, { userId, name }, ctx.clientIp);
  log.info('建立 API Key', { id, userId, prefix: key.keyPrefix });
  return { ...getKey(id), plaintext: key.plaintext };
}

/** 撤銷舊 Key 並發新的（同一組限制沿用）。 */
export function rotateKey(keyId, ctx = {}) {
  const old = getKey(keyId);
  if (!old) throw new HttpError(404, 'key_not_found', '找不到 API Key');
  const limits = rowToLimits(old);
  revokeKey(keyId, ctx);
  return createKey(old.user_id, { name: old.name, limits }, ctx);
}

export function setKeyStatus(keyId, status, ctx = {}) {
  if (!KEY_STATUSES.includes(status)) throw new HttpError(400, 'invalid_status', 'Key 狀態不正確');
  const key = getKey(keyId);
  if (!key) throw new HttpError(404, 'key_not_found', '找不到 API Key');
  run(
    `UPDATE api_keys SET status = ?, revoked_at = CASE WHEN ? = 'revoked' THEN datetime('now') ELSE revoked_at END WHERE id = ?`,
    [status, status, keyId],
  );
  audit(ctx.actorId, 'apikey.status', `key:${keyId}`, status, ctx.clientIp);
  return getKey(keyId);
}

export function revokeKey(keyId, ctx = {}) {
  return setKeyStatus(keyId, 'revoked', ctx);
}

export function deleteKey(keyId, ctx = {}) {
  run('DELETE FROM api_keys WHERE id = ?', [keyId]);
  audit(ctx.actorId, 'apikey.delete', `key:${keyId}`, '', ctx.clientIp);
  return true;
}

export function updateLimits(keyId, patch, ctx = {}) {
  const key = getKey(keyId);
  if (!key) throw new HttpError(404, 'key_not_found', '找不到 API Key');

  const fields = [];
  const params = [];
  for (const [name, col] of Object.entries(LIMIT_COLUMNS)) {
    if (patch[name] === undefined) continue;
    let value = patch[name];
    if (col === 'priority' && !PRIORITIES.includes(value)) {
      throw new HttpError(400, 'invalid_priority', '優先級不正確');
    }
    if (col === 'over_quota_policy' && !['hard', 'soft'].includes(value)) {
      throw new HttpError(400, 'invalid_policy', '超額政策僅支援 hard / soft');
    }
    if (col === 'internet_allowed') value = value ? 1 : 0;
    if (col === 'weekdays' && Array.isArray(value)) value = value.join(',');
    if ((col === 'daily_window_start' || col === 'daily_window_end') && !/^\d{2}:\d{2}$/.test(value)) {
      throw new HttpError(400, 'invalid_time', '時段格式需為 HH:MM');
    }
    if ((col === 'valid_from' || col === 'valid_until') && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new HttpError(400, 'invalid_date', '日期格式需為 YYYY-MM-DD');
    }
    fields.push(`${col} = ?`);
    params.push(value === '' ? null : value);
  }
  if (!fields.length) return key;

  fields.push("updated_at = datetime('now')");
  run(
    `INSERT INTO api_key_limits (api_key_id) VALUES (?)
     ON CONFLICT(api_key_id) DO NOTHING`, [keyId],
  );
  run(`UPDATE api_key_limits SET ${fields.join(', ')} WHERE api_key_id = ?`, [...params, keyId]);
  audit(ctx.actorId, 'apikey.limits', `key:${keyId}`, Object.keys(patch).join(','), ctx.clientIp);
  return getKey(keyId);
}

export function rowToLimits(row) {
  return {
    tokensPerRequest: row.tokens_per_request,
    tokensPerHour: row.tokens_per_hour,
    tokensPerDay: row.tokens_per_day,
    tokensPerMonth: row.tokens_per_month,
    rpm: row.rpm,
    concurrent: row.concurrent,
    priority: row.priority,
    internetAllowed: !!row.internet_allowed,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    dailyWindowStart: row.daily_window_start,
    dailyWindowEnd: row.daily_window_end,
    weekdays: String(row.weekdays || '').split(',').filter(Boolean).map(Number),
    overQuotaPolicy: row.over_quota_policy,
  };
}

/**
 * 驗證 Bearer Token。只比對雜湊，永不將明文寫入紀錄。
 * 回傳 { key, user, limits } 或 null。
 */
export function authenticateApiKey(plaintext) {
  if (!plaintext) return null;
  const row = get(
    `SELECT k.*, u.username, u.role, u.status AS user_status, u.display_name,
            l.tokens_per_request, l.tokens_per_hour, l.tokens_per_day, l.tokens_per_month,
            l.rpm, l.concurrent, l.priority, l.internet_allowed,
            l.valid_from, l.valid_until, l.daily_window_start, l.daily_window_end,
            l.weekdays, l.over_quota_policy
     FROM api_keys k
     JOIN users u ON u.id = k.user_id
     LEFT JOIN api_key_limits l ON l.api_key_id = k.id
     WHERE k.key_hash = ?`,
    [hashApiKey(plaintext)],
  );
  if (!row) return null;
  return { key: row, user: { id: row.user_id, username: row.username, role: row.role, status: row.user_status }, limits: rowToLimits(row) };
}

export function markKeyUsed(keyId) {
  run("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?", [keyId]);
}
