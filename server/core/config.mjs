/**
 * 設定載入：config/config.json（不進 Git）優先，缺項由 config.example.json 補齊。
 * 敏感值（外部 API Key）只從環境變數讀取，永不寫入設定檔或資料庫。
 */
import fs from 'node:fs';
import { paths, ensureRuntimeDirs } from './paths.mjs';

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (typeof base !== 'object' || base === null) return override ?? base;
  if (typeof override !== 'object' || override === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
  return out;
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  // 容許 // 與 /* */ 註解，方便管理員手改設定檔
  const stripped = raw
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(stripped);
}

let cached = null;

export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;
  ensureRuntimeDirs();

  const defaults = readJson(paths.configExample);
  let config = defaults;

  if (fs.existsSync(paths.configFile)) {
    config = deepMerge(defaults, readJson(paths.configFile));
  } else {
    // 首次啟動：由範例產生一份可編輯的本機設定檔
    const seed = { ...defaults };
    delete seed.$schema;
    fs.writeFileSync(paths.configFile, JSON.stringify(seed, null, 2), 'utf8');
    config = seed;
  }

  config.server.port = Number(process.env.AGIBAR_PORT || config.server.port);
  config.server.host = process.env.AGIBAR_HOST || config.server.host;
  if (process.env.AGIBAR_NO_BROWSER === '1') config.server.openBrowserOnStart = false;

  cached = config;
  return config;
}

export function saveConfig(patch) {
  const current = loadConfig();
  const next = deepMerge(current, patch);
  delete next.$schema;
  fs.writeFileSync(paths.configFile, JSON.stringify(next, null, 2), 'utf8');
  cached = next;
  return next;
}

/** 外部模型憑證只走環境變數；設定檔內僅保存變數名稱。 */
export function resolveModelApiKey(modelDef) {
  if (!modelDef?.apiKeyEnv) return null;
  return process.env[modelDef.apiKeyEnv] || null;
}
