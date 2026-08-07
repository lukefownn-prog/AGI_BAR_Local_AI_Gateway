/**
 * 備份與還原（規畫書 13 / 16.5）。
 * 更新程式不應覆蓋 API Key、Token 統計與人員資料，因此備份對象是 data/ 與 config/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../core/paths.mjs';
import { getDb, audit } from '../core/db.mjs';
import { log } from '../core/logger.mjs';

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function listBackups() {
  if (!fs.existsSync(paths.backups)) return [];
  return fs.readdirSync(paths.backups)
    .filter((f) => f.startsWith('agibar-'))
    .map((f) => {
      const full = path.join(paths.backups, f);
      const st = fs.statSync(full);
      return { name: f, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 使用 SQLite VACUUM INTO 產生一致性快照，同時複製 config.json。 */
export function createBackup(config, { actorId = null, reason = 'auto' } = {}) {
  fs.mkdirSync(paths.backups, { recursive: true });
  const name = `agibar-${stamp()}`;
  const dbTarget = path.join(paths.backups, `${name}.db`);

  getDb().exec(`VACUUM INTO '${dbTarget.replace(/'/g, "''")}'`);

  if (fs.existsSync(paths.configFile)) {
    fs.copyFileSync(paths.configFile, path.join(paths.backups, `${name}.config.json`));
  }

  pruneBackups(config.backup?.keepCopies ?? 14);
  audit(actorId, 'backup.create', name, reason);
  log.info('已建立備份', { name, reason });
  return { name, file: `${name}.db`, createdAt: new Date().toISOString(), reason };
}

function pruneBackups(keep) {
  const list = listBackups().filter((b) => b.name.endsWith('.db'));
  for (const old of list.slice(keep)) {
    try {
      fs.unlinkSync(path.join(paths.backups, old.name));
      const cfg = path.join(paths.backups, old.name.replace(/\.db$/, '.config.json'));
      if (fs.existsSync(cfg)) fs.unlinkSync(cfg);
    } catch { /* 檔案可能已被手動刪除 */ }
  }
}

let timer = null;

export function startBackupSchedule(config) {
  stopBackupSchedule();
  if (!config.backup?.enabled) return;
  if (config.backup.onStartup) {
    try { createBackup(config, { reason: 'startup' }); }
    catch (e) { log.error('啟動備份失敗', { error: e.message }); }
  }
  const hours = Number(config.backup.intervalHours ?? 24);
  if (hours > 0) {
    timer = setInterval(() => {
      try { createBackup(config, { reason: 'scheduled' }); }
      catch (e) { log.error('排程備份失敗', { error: e.message }); }
    }, hours * 3600 * 1000);
    timer.unref?.();
  }
}

export function stopBackupSchedule() {
  if (timer) clearInterval(timer);
  timer = null;
}
