#!/usr/bin/env node
/**
 * 安全掃描（CI 第 4 關），對應規畫書 16.1。
 * 目的：在 PR 合併前擋下誤入版本庫的機密，並確認 .gitignore 涵蓋度。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const warnings = [];

/** 只掃 Git 追蹤中的檔案 —— 沒被追蹤的東西本來就不會上傳。 */
function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    warnings.push('不在 Git repository 中，改為掃描工作目錄');
    return null;
  }
}

// ---------- 1. 不該被追蹤的路徑 ----------
const FORBIDDEN_PATTERNS = [
  { re: /(^|\/)config\/config\.json$/, why: '真實設定檔' },
  { re: /(^|\/)\.env($|\.)/, why: '環境變數檔' },
  { re: /\.(db|sqlite3?|db-wal|db-shm)$/, why: '資料庫' },
  { re: /\.(gguf|safetensors|onnx|pt)$/, why: '模型檔' },
  { re: /\.(pem|key|pfx|p12|crt)$/, why: '憑證/私鑰' },
  { re: /(^|\/)data\//, why: '執行期資料' },
  { re: /(^|\/)backups?\//, why: '備份' },
  { re: /session\.secret$/, why: 'Session 祕鑰' },
  { re: /\.log$/, why: '紀錄檔' },
];

const tracked = trackedFiles();
if (tracked) {
  for (const f of tracked) {
    for (const p of FORBIDDEN_PATTERNS) {
      if (p.re.test(f)) problems.push(`版本庫中不應存在${p.why}：${f}`);
    }
  }
}

// ---------- 2. 原始碼中的疑似機密 ----------
const SECRET_RULES = [
  { re: /\bagi-bar-[A-Za-z0-9_-]{24,}/, why: '真實的 AGI BAR API Key' },
  { re: /\bsk-[A-Za-z0-9]{20,}/, why: 'OpenAI/DeepSeek 風格金鑰' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, why: 'GitHub Token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS Access Key' },
  { re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, why: '私鑰內容' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, why: 'Slack Token' },
];

const SCANNABLE = /\.(mjs|js|json|md|yml|yaml|cmd|sh|html|css|sql)$/;
const SKIP_FILES = new Set(['scripts/security-scan.mjs']);

const filesToScan = (tracked ?? walkAll(ROOT))
  .filter((f) => SCANNABLE.test(f))
  .filter((f) => !SKIP_FILES.has(f.replace(/\\/g, '/')));

function walkAll(dir, out = [], base = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', 'models', 'runtime', 'dist'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkAll(full, out, base);
    else out.push(path.relative(base, full));
  }
  return out;
}

for (const rel of filesToScan) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of SECRET_RULES) {
      if (rule.re.test(line)) problems.push(`疑似${rule.why}：${rel}:${i + 1}`);
    }
  });
}

// ---------- 3. 內網位址外洩 ----------
const PRIVATE_IP = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/;
const IP_OK = new Set(['docs/整合設定.md', 'docs/部署.md', 'docs/安全須知.md', 'README.md',
  'config/config.example.json', 'tests/websafe.test.mjs', 'server/services/websafe.mjs',
  'scripts/security-scan.mjs', 'CHANGELOG.md']);

for (const rel of filesToScan) {
  const norm = rel.replace(/\\/g, '/');
  if (IP_OK.has(norm)) continue;
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (PRIVATE_IP.test(line)) warnings.push(`內網位址：${norm}:${i + 1} — 確認是否為範例`);
  });
}

// ---------- 4. .gitignore 涵蓋度 ----------
const REQUIRED_IGNORES = ['.env', 'config/config.json', 'data/', 'models/', '*.db',
  '*.gguf', '*.pem', '*.key', 'node_modules/', 'runtime/'];
const gitignore = fs.existsSync(path.join(ROOT, '.gitignore'))
  ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';

for (const need of REQUIRED_IGNORES) {
  if (!gitignore.includes(need)) problems.push(`.gitignore 缺少必要規則：${need}`);
}

// ---------- 5. 預設密碼不得出現在非範例處 ----------
const example = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config/config.example.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
);
if (example.security?.sessionSecret && !/CHANGE-ME/i.test(example.security.sessionSecret)) {
  problems.push('config.example.json 的 sessionSecret 看起來不是佔位字串');
}

// ---------- 結果 ----------
if (warnings.length) {
  console.log('\n⚠ 提醒：');
  for (const w of warnings) console.log('  ' + w);
}

if (problems.length) {
  console.error('\n✖ 安全掃描未通過：\n');
  for (const p of problems) console.error('  ' + p);
  console.error('\n請參考 docs/安全須知.md。若機密已被提交過，改 .gitignore 不足以補救，必須輪換憑證。\n');
  process.exit(1);
}

console.log(`\n✓ 安全掃描通過（檢查 ${filesToScan.length} 個檔案）`);
