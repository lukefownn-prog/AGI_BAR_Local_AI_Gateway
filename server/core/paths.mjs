/**
 * 專案內所有路徑的唯一來源。
 * Portable 原則：一切相對於專案根目錄，不依賴使用者的目前工作目錄。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url)); // server/core
export const ROOT = path.resolve(here, '..', '..');

/**
 * AGIBAR_DATA_DIR / AGIBAR_CONFIG_FILE 讓測試與多實例部署能各自隔離；
 * 一般 Portable 使用不需設定，預設就在專案資料夾內。
 */
const DATA = process.env.AGIBAR_DATA_DIR
  ? path.resolve(process.env.AGIBAR_DATA_DIR)
  : path.join(ROOT, 'data');

const CONFIG_FILE = process.env.AGIBAR_CONFIG_FILE
  ? path.resolve(process.env.AGIBAR_CONFIG_FILE)
  : path.join(ROOT, 'config', 'config.json');

export const paths = {
  root: ROOT,
  web: path.join(ROOT, 'web'),
  server: path.join(ROOT, 'server'),
  scripts: path.join(ROOT, 'scripts'),
  config: path.join(ROOT, 'config'),
  configFile: CONFIG_FILE,
  configExample: path.join(ROOT, 'config', 'config.example.json'),
  data: DATA,
  db: path.join(DATA, 'agibar.db'),
  logs: path.join(DATA, 'logs'),
  backups: path.join(DATA, 'backups'),
  runtime: path.join(ROOT, 'runtime'),
  models: path.join(ROOT, 'models'),
  sessionSecret: path.join(DATA, 'session.secret'),
  pidFile: path.join(DATA, 'agibar.pid'),
};

/** 確保執行期需要的資料夾存在（data/ 不進 Git，第一次啟動要自己建）。 */
export function ensureRuntimeDirs() {
  for (const dir of [paths.data, paths.logs, paths.backups, paths.models]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
