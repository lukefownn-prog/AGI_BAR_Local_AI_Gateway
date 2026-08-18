#!/usr/bin/env node
/**
 * Portable 結構檢查（CI 第 5 關）。
 * 確認解壓後真的能跑：必要檔案齊全、無 npm 相依、啟動腳本完整。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 有帶參數 = 檢查打包產物；沒帶 = 檢查開發中的專案本身。 */
const PACKAGE_MODE = !!process.argv[2];
const ROOT = PACKAGE_MODE
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];

// 只有版本庫需要的檔案，不隨 Portable ZIP 發佈
const REPO_ONLY_FILES = ['.gitignore'];

const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  '啟動 AGI BAR.cmd',
  '關閉 AGI BAR.cmd',
  'config/config.example.json',
  'server/index.mjs',
  'server/core/schema.sql',
  'server/core/config.mjs',
  'server/core/db.mjs',
  'server/core/crypto.mjs',
  'server/core/http.mjs',
  'server/core/paths.mjs',
  'server/core/logger.mjs',
  'server/core/version.mjs',
  'server/services/users.mjs',
  'server/services/apikeys.mjs',
  'server/services/quota.mjs',
  'server/services/models.mjs',
  'server/services/routes.mjs',
  'server/services/queue.mjs',
  'server/services/gateway.mjs',
  'server/services/session.mjs',
  'server/services/backup.mjs',
  'server/services/retention.mjs',
  'server/services/anthropic-compat.mjs',
  'server/routes/admin.mjs',
  'server/routes/openai.mjs',
  'server/routes/anthropic.mjs',
  'server/routes/static.mjs',
  'web/index.html',
  'web/app.html',
  'web/chat.html',
  'web/assets/app.css',
  'web/assets/app.js',
  'web/assets/api.js',
  'web/assets/i18n.js',
  'web/assets/login.js',
  'web/assets/chat.js',
  'web/assets/chat.css',
];

const REQUIRED_DIRS = ['server', 'web', 'config', 'scripts', 'docs'];

const expected = PACKAGE_MODE ? REQUIRED_FILES : [...REQUIRED_FILES, ...REPO_ONLY_FILES];
for (const f of expected) {
  if (!fs.existsSync(path.join(ROOT, f))) problems.push(`缺少必要檔案：${f}`);
}
for (const d of REQUIRED_DIRS) {
  const full = path.join(ROOT, d);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) problems.push(`缺少必要目錄：${d}/`);
}

// package.json 檢查
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (Object.keys(pkg.dependencies ?? {}).length) {
  problems.push('package.json 有 dependencies，違反 Portable 零相依原則');
}
if (pkg.type !== 'module') problems.push('package.json 的 type 應為 "module"');
if (!pkg.engines?.node) problems.push('package.json 缺少 engines.node（需標示 Node 版本需求）');

// 不該出現在 ZIP 裡的東西（開發目錄允許存在，只有檢查打包產物時才算問題）
if (PACKAGE_MODE) {
  for (const bad of ['node_modules', 'data/agibar.db', 'config/config.json', '.git',
                     'data/session.secret', 'data/logs', 'data/backups']) {
    if (fs.existsSync(path.join(ROOT, bad))) problems.push(`打包內容不應包含：${bad}`);
  }
}

// 啟動腳本必須做版本檢查，否則舊 Node 會噴難懂的錯誤
const startCmd = path.join(ROOT, '啟動 AGI BAR.cmd');
if (fs.existsSync(startCmd)) {
  const src = fs.readFileSync(startCmd, 'latin1');
  if (!src.includes('NODE_MAJOR')) problems.push('啟動腳本缺少 Node 版本檢查');
  if (!src.includes('runtime')) problems.push('啟動腳本未支援內附 runtime\\node.exe');
}

// schema.sql 必須含規畫書列出的資料表
const schema = fs.readFileSync(path.join(ROOT, 'server/core/schema.sql'), 'utf8');
for (const t of ['users', 'api_keys', 'api_key_limits', 'models', 'model_routes',
                 'usage_logs', 'request_logs', 'system_settings']) {
  if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(schema)) {
    problems.push(`schema.sql 缺少規畫書要求的資料表：${t}`);
  }
}

if (problems.length) {
  console.error('\n✖ Portable 結構檢查未通過：\n');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

console.log(`✓ Portable 結構檢查通過（${REQUIRED_FILES.length} 個必要檔案齊全，零 npm 相依）`);
