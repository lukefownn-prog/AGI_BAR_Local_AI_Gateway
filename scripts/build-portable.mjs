#!/usr/bin/env node
/**
 * 建置 Portable ZIP（規畫書 16.3）。
 * 產出 dist/AGI-BAR-v<版本>-win64.zip 與對應的 .sha256。
 *
 * 只打包程式，不含 data/、config/config.json、models/ 與 runtime/ ——
 * 這些由管理員在部署端保留或另行放入。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const NAME = `AGI-BAR-v${VERSION}-win64`;

const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, NAME);

// ---- 1. 清空暫存區 ----
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// ---- 2. 複製要打包的內容 ----
const INCLUDE_DIRS = ['server', 'web', 'scripts', 'docs'];
const INCLUDE_FILES = [
  'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md',
  '啟動 AGI BAR.cmd', '關閉 AGI BAR.cmd',
];

for (const d of INCLUDE_DIRS) {
  fs.cpSync(path.join(ROOT, d), path.join(STAGE, d), { recursive: true });
}
for (const f of INCLUDE_FILES) {
  fs.copyFileSync(path.join(ROOT, f), path.join(STAGE, f));
}

// config/ 只帶範例，不帶真實設定
fs.mkdirSync(path.join(STAGE, 'config'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'config/config.example.json'), path.join(STAGE, 'config/config.example.json'));

// 建立執行期會用到的空目錄，附說明
for (const [dir, note] of [
  ['data', '執行期資料（資料庫、紀錄、備份）會自動產生於此。更新程式時請保留本目錄。'],
  ['models', '把 GGUF 等模型檔放在這裡。模型不隨程式發佈。'],
  ['runtime', '若主機沒有安裝 Node.js 24+，把 node.exe 放在這裡，啟動腳本會優先使用。'],
]) {
  fs.mkdirSync(path.join(STAGE, dir), { recursive: true });
  fs.writeFileSync(path.join(STAGE, dir, 'README.txt'), note + '\n', 'utf8');
}

// ---- 3. 結構檢查 ----
execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-portable.mjs'), STAGE], { stdio: 'inherit' });

// ---- 4. 壓縮 ----
const zipPath = path.join(DIST, `${NAME}.zip`);
fs.rmSync(zipPath, { force: true });

try {
  // Windows 內建 PowerShell 壓縮，不需額外工具
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zipPath}' -Force`,
  ], { stdio: 'inherit' });
} catch {
  console.log('  PowerShell 壓縮失敗，改用 zip 指令');
  execFileSync('zip', ['-r', zipPath, NAME], { cwd: DIST, stdio: 'inherit' });
}

// ---- 5. SHA-256 ----
const hash = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
const shaFile = `${zipPath}.sha256`;
fs.writeFileSync(shaFile, `${hash}  ${NAME}.zip\n`, 'utf8');

const sizeMb = (fs.statSync(zipPath).size / 1048576).toFixed(2);

console.log('');
console.log(`  ✓ 建置完成`);
console.log(`    檔案     : dist/${NAME}.zip  (${sizeMb} MB)`);
console.log(`    SHA-256  : ${hash}`);
console.log('');
console.log('  發佈指令：');
console.log(`    gh release create v${VERSION} "dist/${NAME}.zip" "${shaFile}" --title "v${VERSION}"`);
console.log('');
