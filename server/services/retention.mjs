/**
 * 紀錄保留期清理（規畫書 12）。
 *
 * `logging.retentionDays` 原本只清 data/logs/ 底下的日誌檔（core/logger.mjs），
 * 資料庫裡的 usage_logs / request_logs / audit_logs 則是永久成長 ——
 * 而設定頁寫著「紀錄保留 30 天」，管理員會合理地以為兩者都算。
 * 這個模組讓那句話對資料庫也成立。
 *
 * 為什麼重要：備份是 `VACUUM INTO` 整份複製，紀錄無上限成長會讓每次備份
 * 越來越慢、越佔空間。AGI BAR 要能換場所隨開即用，資料庫就不該一直長大。
 *
 * 刪除只掃 ts 欄位，三張表都有 ts 索引（schema.sql），不會全表掃描。
 */
import { run, getSetting, setSetting } from '../core/db.mjs';
import { log } from '../core/logger.mjs';

/** 保留期涵蓋的資料表。人員、API Key、模型、設定都不在其中 —— 那些是狀態不是紀錄。 */
const LOG_TABLES = ['usage_logs', 'request_logs', 'audit_logs'];

const LAST_RUN_KEY = 'retention.lastRunAt';

/**
 * 刪除超過保留期的紀錄列。
 * @returns {{ days: number, deleted: Record<string, number>, total: number } | null}
 *          retentionDays <= 0 時回傳 null（視為永久保留，不刪）
 */
export function purgeOldLogs(config) {
  const days = Number(config?.logging?.retentionDays ?? 30);

  // 0 或負數 = 明確要求不清理。這是唯一的安全閥，不要讓設定寫錯就把紀錄全砍了。
  if (!Number.isFinite(days) || days <= 0) return null;

  const deleted = {};
  let total = 0;

  for (const table of LOG_TABLES) {
    try {
      // 參數化的是天數，資料表名稱來自上面的常數陣列，不接受外部輸入
      const info = run(`DELETE FROM ${table} WHERE ts < datetime('now', ?)`, [`-${days} days`]);
      const n = Number(info.changes ?? 0);
      deleted[table] = n;
      total += n;
    } catch (err) {
      // 單一資料表失敗不該讓其他表也不清，更不該中斷啟動
      log.error('清理紀錄失敗', { table, error: err.message });
      deleted[table] = 0;
    }
  }

  setSetting(LAST_RUN_KEY, new Date().toISOString());

  if (total) log.info('已清理逾期紀錄', { retentionDays: days, total, ...deleted });
  return { days, deleted, total };
}

export function lastPurgeAt() {
  return getSetting(LAST_RUN_KEY, null);
}

let timer = null;

/**
 * 啟動時清一次，之後每 24 小時再清一次。
 *
 * 啟動時就清很重要：這套會被搬到不同場所、關機再開，
 * 只靠常駐排程的話，開機時間不夠長就永遠輪不到清理。
 */
export function startRetentionSchedule(config) {
  stopRetentionSchedule();

  try { purgeOldLogs(config); }
  catch (e) { log.error('啟動時清理紀錄失敗', { error: e.message }); }

  timer = setInterval(() => {
    try { purgeOldLogs(config); }
    catch (e) { log.error('排程清理紀錄失敗', { error: e.message }); }
  }, 24 * 3600 * 1000);
  timer.unref?.();
}

export function stopRetentionSchedule() {
  if (timer) clearInterval(timer);
  timer = null;
}
