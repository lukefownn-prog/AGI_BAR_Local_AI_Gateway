/**
 * 極簡結構化 logger：主控台 + 每日輪替檔案（data/logs/，不進 Git）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let level = 'info';
let toFile = true;
let retentionDays = 30;
let stream = null;
let streamDay = '';

export function configureLogger(loggingConfig = {}) {
  level = loggingConfig.level || 'info';
  toFile = loggingConfig.toFile !== false;
  retentionDays = Number(loggingConfig.retentionDays ?? 30);
  if (toFile) pruneOldLogs();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getStream() {
  const day = today();
  if (stream && streamDay === day) return stream;
  if (stream) stream.end();
  fs.mkdirSync(paths.logs, { recursive: true });
  stream = fs.createWriteStream(path.join(paths.logs, `agibar-${day}.log`), { flags: 'a' });
  streamDay = day;
  return stream;
}

function pruneOldLogs() {
  try {
    const cutoff = Date.now() - retentionDays * 86400000;
    for (const f of fs.readdirSync(paths.logs)) {
      const full = path.join(paths.logs, f);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch { /* 首次啟動時目錄可能不存在 */ }
}

function emit(lvl, msg, meta) {
  if (LEVELS[lvl] < LEVELS[level]) return;
  const rec = { ts: new Date().toISOString(), level: lvl, msg, ...(meta || {}) };
  const line = JSON.stringify(rec);
  const pretty = `${rec.ts} [${lvl.toUpperCase().padEnd(5)}] ${msg}` +
    (meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '');
  if (lvl === 'error' || lvl === 'warn') console.error(pretty);
  else console.log(pretty);
  if (toFile) {
    try { getStream().write(line + '\n'); } catch { /* 磁碟問題不應中斷服務 */ }
  }
}

export const log = {
  debug: (m, meta) => emit('debug', m, meta),
  info: (m, meta) => emit('info', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  error: (m, meta) => emit('error', m, meta),
};

/**
 * 關機時把緩衝中的紀錄寫完再離開。
 * stream.write 是非同步的，直接 process.exit() 會讓最後幾行紀錄消失 ——
 * 而那幾行（關機原因、錯誤）正是事後查問題最需要的。
 */
export function closeLogger({ timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    if (!stream) return resolve();
    const s = stream;
    stream = null;
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    s.end(done);
  });
}
