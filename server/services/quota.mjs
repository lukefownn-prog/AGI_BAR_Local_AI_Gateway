/**
 * 配額與時間權限（規畫書 5 / 6）。
 *
 * 檢查順序：Key/人員狀態 → 有效日期 → 星期 → 每日時段 → RPM → Concurrent
 *          → 單次最大 Token → 每小時 → 每日 → 每月
 * 超額處理：hard = 拒絕請求；soft = 允許但要求降級至較小模型。
 */
import { get, run } from '../core/db.mjs';
import { HttpError } from '../core/http.mjs';

/** 同時請求數：以記憶體計數，重啟即歸零（配額統計則落在資料庫）。 */
const inFlight = new Map(); // keyId -> count
/** RPM 滑動視窗：keyId -> 最近請求時間戳陣列 */
const rpmWindow = new Map();

export function acquireSlot(keyId, max) {
  const current = inFlight.get(keyId) || 0;
  if (current >= max) return false;
  inFlight.set(keyId, current + 1);
  return true;
}

export function releaseSlot(keyId) {
  const current = inFlight.get(keyId) || 0;
  if (current <= 1) inFlight.delete(keyId);
  else inFlight.set(keyId, current - 1);
}

export function currentConcurrency(keyId) {
  return inFlight.get(keyId) || 0;
}

export function totalInFlight() {
  let n = 0;
  for (const v of inFlight.values()) n += v;
  return n;
}

function noteRequest(keyId) {
  const now = Date.now();
  const list = (rpmWindow.get(keyId) || []).filter((t) => now - t < 60000);
  list.push(now);
  rpmWindow.set(keyId, list);
  return list.length;
}

function rpmCount(keyId) {
  const now = Date.now();
  const list = (rpmWindow.get(keyId) || []).filter((t) => now - t < 60000);
  rpmWindow.set(keyId, list);
  return list.length;
}

function hhmmToMinutes(s) {
  const [h, m] = String(s || '00:00').split(':').map(Number);
  return h * 60 + m;
}

function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 時間權限：有效日期 + 星期 + 每日時段（皆以主機本地時間判定）。 */
export function checkTimeWindow(limits, now = new Date()) {
  const todayStr = localDateStr(now);
  if (limits.validFrom && todayStr < limits.validFrom) {
    throw new HttpError(403, 'not_yet_valid', `此 API Key 於 ${limits.validFrom} 起生效`);
  }
  if (limits.validUntil && todayStr > limits.validUntil) {
    throw new HttpError(403, 'expired', `此 API Key 已於 ${limits.validUntil} 到期`);
  }
  const weekdays = limits.weekdays?.length ? limits.weekdays : [0, 1, 2, 3, 4, 5, 6];
  if (!weekdays.includes(now.getDay())) {
    throw new HttpError(403, 'weekday_not_allowed', '今日不在允許使用的日期範圍');
  }
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = hhmmToMinutes(limits.dailyWindowStart);
  const end = hhmmToMinutes(limits.dailyWindowEnd);
  const inWindow = start <= end ? cur >= start && cur <= end : cur >= start || cur <= end; // 支援跨午夜
  if (!inWindow) {
    throw new HttpError(403, 'outside_time_window',
      `目前不在允許時段 ${limits.dailyWindowStart}-${limits.dailyWindowEnd}`);
  }
}

/** 讀取已用 Token（Input + Output 皆計入）。 */
export function usageSnapshot(keyId) {
  const row = get(`
    SELECT
      COALESCE(SUM(CASE WHEN ts >= datetime('now', '-1 hour')      THEN total_tokens END), 0) AS hour,
      COALESCE(SUM(CASE WHEN date(ts, 'localtime') = date('now', 'localtime') THEN total_tokens END), 0) AS day,
      COALESCE(SUM(CASE WHEN strftime('%Y-%m', ts, 'localtime') = strftime('%Y-%m', 'now', 'localtime') THEN total_tokens END), 0) AS month
    FROM usage_logs WHERE api_key_id = ?`, [keyId]);
  return { hour: row?.hour ?? 0, day: row?.day ?? 0, month: row?.month ?? 0 };
}

/**
 * 送出請求前的完整檢查。
 * @returns {{ degrade: boolean, reasons: string[], usage: object }}
 *          degrade=true 代表已超額但政策為 soft，應改用較小模型。
 */
export function preflight({ auth, estimatedInputTokens = 0, requestedMaxTokens = 0 }) {
  const { key, user, limits } = auth;

  if (key.status !== 'active') {
    throw new HttpError(403, 'key_inactive', `API Key 目前狀態為 ${key.status}`);
  }
  if (user.status !== 'active') {
    throw new HttpError(403, 'user_inactive', `人員帳號目前狀態為 ${user.status}`);
  }

  checkTimeWindow(limits);

  if (limits.rpm > 0 && rpmCount(key.id) >= limits.rpm) {
    throw new HttpError(429, 'rate_limit_exceeded', `已超過每分鐘 ${limits.rpm} 次請求上限`);
  }

  const perRequest = estimatedInputTokens + (requestedMaxTokens || 0);
  if (limits.tokensPerRequest > 0 && perRequest > limits.tokensPerRequest) {
    throw new HttpError(413, 'request_too_large',
      `單次請求 Token 上限為 ${limits.tokensPerRequest}，本次估計 ${perRequest}`);
  }

  const usage = usageSnapshot(key.id);
  const reasons = [];
  if (limits.tokensPerHour > 0 && usage.hour >= limits.tokensPerHour) reasons.push(`每小時 ${limits.tokensPerHour}`);
  if (limits.tokensPerDay > 0 && usage.day >= limits.tokensPerDay) reasons.push(`每日 ${limits.tokensPerDay}`);
  if (limits.tokensPerMonth > 0 && usage.month >= limits.tokensPerMonth) reasons.push(`每月 ${limits.tokensPerMonth}`);

  if (reasons.length && limits.overQuotaPolicy === 'hard') {
    throw new HttpError(429, 'quota_exceeded', `Token 配額已用盡（${reasons.join('、')}）`);
  }

  noteRequest(key.id);
  return { degrade: reasons.length > 0, reasons, usage };
}

/** 實際用量寫回（規畫書 6：Input 與 Output 都需計入）。 */
export function recordUsage({ userId, keyId, modelId, inputTokens = 0, outputTokens = 0, requestId = '' }) {
  const total = (inputTokens || 0) + (outputTokens || 0);
  run(
    `INSERT INTO usage_logs (user_id, api_key_id, model_id, input_tokens, output_tokens, total_tokens, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId ?? null, keyId ?? null, modelId ?? null, inputTokens, outputTokens, total, requestId],
  );
  return total;
}

/** 沒有 tokenizer 時的粗估：中日韓字元約 1 token，其餘約 4 字元 1 token。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
  }
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

export function estimateMessagesTokens(messages = []) {
  let n = 0;
  for (const m of messages) {
    n += 4; // role / 分隔符成本
    if (typeof m?.content === 'string') n += estimateTokens(m.content);
    else if (Array.isArray(m?.content)) {
      for (const part of m.content) if (part?.type === 'text') n += estimateTokens(part.text);
    }
  }
  return n;
}

/** 測試與重啟用：清空記憶體計數。 */
export function resetRuntimeCounters() {
  inFlight.clear();
  rpmWindow.clear();
}
