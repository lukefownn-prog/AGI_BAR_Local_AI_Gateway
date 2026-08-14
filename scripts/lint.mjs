#!/usr/bin/env node
/**
 * 程式語法檢查（CI 第 1 關）。
 * 零相依專案不引入 ESLint，改用 Node 內建的語法解析 + 幾條專案自訂規則。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'data', 'models', 'runtime', 'dist', '.git', 'backups']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const errors = [];
let checked = 0;

// ---- 1. JS 語法 ----
for (const file of files.filter((f) => /\.m?js$/.test(f))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    checked++;
  } catch (err) {
    errors.push(`語法錯誤：${path.relative(ROOT, file)}\n${err.stderr?.toString().split('\n').slice(0, 3).join('\n')}`);
  }
}

// ---- 2. JSON 可解析 ----
for (const file of files.filter((f) => f.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    checked++;
  } catch (err) {
    errors.push(`JSON 錯誤：${path.relative(ROOT, file)} — ${err.message}`);
  }
}

// ---- 3. 專案規則：不得引入 npm 相依 ----
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (Object.keys(pkg.dependencies ?? {}).length) {
  errors.push('Portable 原則：package.json 不應有 dependencies');
}
for (const file of files.filter((f) => /\.mjs$/.test(f))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    errors.push(`外部相依：${path.relative(ROOT, file)} 匯入了 "${spec}"（僅允許 node: 內建與相對路徑）`);
  }
}

// ---- 4. 專案規則：.cmd 必須是純 ASCII 且 CRLF ----
//
// cmd.exe 用「主控台編碼」而非 UTF-8 解析批次檔（台灣預設 CP950）。
// 存成 UTF-8 的中文會被當成 Big5 讀成亂碼；更糟的是 chcp 65001 會在中途
// 改變解碼方式，讓 cmd 失去解析位置，後面的行被切成無意義的碎片。
// 因此批次檔一律純 ASCII，中文由 Node 輸出（chcp 65001 之後就正確）。
for (const file of files.filter((f) => /\.(cmd|bat)$/i.test(f))) {
  const buf = fs.readFileSync(file);
  const rel = path.relative(ROOT, file);

  const badBytes = [];
  for (let i = 0; i < buf.length && badBytes.length < 3; i++) {
    if (buf[i] > 127) badBytes.push(i);
  }
  if (badBytes.length) {
    errors.push(`批次檔含非 ASCII 位元組：${rel}（位置 ${badBytes.join(', ')}…）\n`
      + '  cmd.exe 以主控台編碼解析批次檔，非 ASCII 會造成亂碼與解析錯位。\n'
      + '  請改用英文訊息，中文交給 Node 輸出。');
  }

  const lf = (buf.toString('latin1').match(/(?<!\r)\n/g) ?? []).length;
  if (lf) errors.push(`批次檔含 ${lf} 個純 LF 換行（需 CRLF）：${rel}`);

  checked++;
}

// ---- 5. 專案規則：web/ 不得引用外部資源 ----
for (const file of files.filter((f) => /web[\\/].*\.(html|js|css)$/.test(f))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/g)) {
    errors.push(`外部資源：${path.relative(ROOT, file)} 引用了 ${m[1]}（離線環境會失效）`);
  }
}

if (errors.length) {
  console.error('\n✖ 語法檢查未通過：\n');
  for (const e of errors) console.error('  ' + e.replace(/\n/g, '\n  ') + '\n');
  process.exit(1);
}

console.log(`✓ 語法檢查通過（${checked} 個檔案）`);
