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

// ---- 4. 專案規則：web/ 不得引用外部資源 ----
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
