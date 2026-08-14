#!/usr/bin/env node
/**
 * 客戶端串接驗證（M11、Issue #1）。
 *
 *   node tests/integration/client-compat.mjs --self-test
 *   node tests/integration/client-compat.mjs --url http://192.168.1.100:8787 --key agi-bar-xxx
 *   node tests/integration/client-compat.mjs --url … --admin-pass … --client codex
 *
 * Cursor 與 Codex 是 GUI / CLI 工具，沒辦法自動化點擊。這支腳本驗的是
 * 「它們實際會送出的請求形狀」—— 把人工步驟縮到最小，並在動手設定之前
 * 先找出會卡住的地方，最後印出可直接貼上的設定與剩餘的人工清單。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROBES, CLIENT_LABELS, probesFor } from './probes.mjs';
import {
  codexConfigToml, codexEnv, cursorSteps, claudeCodeEnv, curlChecks,
  maskKey, MANUAL_STEPS,
} from './configs.mjs';
import { pad } from '../load/stats.mjs';

const DEFAULTS = {
  url: 'http://127.0.0.1:8787',
  key: '',
  adminUser: 'admin',
  adminPass: '',
  client: 'all',
  selfTest: false,
  showSecrets: false,
  emit: '',
  json: '',
  quiet: false,
};

export function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const alias = {
    'admin-user': 'adminUser', 'admin-pass': 'adminPass',
    'self-test': 'selfTest', 'show-secrets': 'showSecrets',
  };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const raw = argv[i].slice(2);
    const [nameRaw, inline] = raw.includes('=') ? raw.split(/=(.*)/s) : [raw, undefined];
    const key = alias[nameRaw] ?? nameRaw;
    if (!(key in opts)) throw new Error(`未知參數：--${nameRaw}`);
    if (typeof opts[key] === 'boolean') {
      opts[key] = inline === undefined ? true : inline !== 'false';
      continue;
    }
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined) throw new Error(`--${nameRaw} 缺少值`);
    opts[key] = value;
  }
  return opts;
}

// ---------------------------------------------------------------- 探針環境

function makeCtx(base, key) {
  const url = (p) => base.replace(/\/+$/, '') + p;

  const raw = (p, { method = 'GET', body, headers = {}, key: overrideKey } = {}) => fetch(url(p), {
    method,
    headers: {
      Authorization: `Bearer ${overrideKey ?? key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const api = async (p, opts = {}) => {
    const res = await raw(p, opts);
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
    return { status: res.status, body: parsed, headers: res.headers };
  };

  return { base: base.replace(/\/+$/, ''), key, api, raw };
}

// ---------------------------------------------------------------- 臨時人員

const PROBE_USER = 'compat-probe';

async function adminFetch(base, cookieRef, p, { method = 'GET', body } = {}) {
  const res = await fetch(base.replace(/\/+$/, '') + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookieRef.value ? { Cookie: cookieRef.value } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookieRef.value = sc.map((s) => s.split(';')[0]).join('; ');
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * 建立探測用人員。
 * 刻意沿用 config 的預設配額（只放寬時間窗），這樣「大型上下文」那項探針
 * 反映的才是真實人員會遇到的限制，而不是我們自己調大的數字。
 */
async function provisionProbeUser(base, cookieRef, { adminUser, adminPass }) {
  const login = await adminFetch(base, cookieRef, '/api/auth/login', {
    method: 'POST', body: { username: adminUser, password: adminPass },
  });
  if (login.status === 404) {
    throw new Error('管理 API 回 404。管理台預設限制為本機存取，從其他機器連不到。'
      + '請改在 AI 主機上執行，或改用 --key 直接指定既有的 API Key（探針本身不需要管理權限）。');
  }
  if (login.status !== 200) {
    throw new Error(`管理員登入失敗（HTTP ${login.status}）：${login.body?.error?.message ?? ''}`);
  }

  const existing = (await adminFetch(base, cookieRef, '/api/users')).body?.users ?? [];
  for (const u of existing.filter((x) => x.username === PROBE_USER)) {
    await adminFetch(base, cookieRef, `/api/users/${u.id}`, { method: 'DELETE' });
  }

  const created = await adminFetch(base, cookieRef, '/api/users', {
    method: 'POST',
    body: {
      username: PROBE_USER,
      displayName: '串接探測',
      note: '由 tests/integration/client-compat.mjs 建立，可安全刪除',
      limits: {
        // 只放寬時間窗，其餘沿用設定檔預設值
        validFrom: null, validUntil: null,
        dailyWindowStart: '00:00', dailyWindowEnd: '23:59',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      },
    },
  });
  if (created.status !== 201) {
    throw new Error(`建立探測人員失敗（HTTP ${created.status}）：${created.body?.error?.message ?? ''}`);
  }
  return { id: created.body.user.id, key: created.body.key.plaintext };
}

// ---------------------------------------------------------------- 自我測試環境

/**
 * 在本行程內起一台 Gateway 與假模型農場。
 *
 * 限制：一個行程只能有一套自我測試環境。core/paths.mjs 在模組載入時就固定
 * AGIBAR_DATA_DIR，core/config.mjs 也會快取設定，因此第二次呼叫會沿用第一次的
 * 環境（指向已關閉的假模型）。需要多組情境時請分行程執行。
 */
async function startSelfTestEnv() {
  const { startFarm } = await import('../load/mock-farm.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agibar-compat-'));

  process.env.AGIBAR_DATA_DIR = path.join(tmp, 'data');
  process.env.AGIBAR_CONFIG_FILE = path.join(tmp, 'config.json');
  process.env.AGIBAR_NO_BROWSER = '1';

  const farm = await startFarm([{ name: 'compat-model', firstTokenMs: 20, msPerToken: 0, maxConcurrent: 16 }]);
  const adminPass = 'compat-admin-pw';

  const cfg = JSON.parse(
    fs.readFileSync(new URL('../../config/config.example.json', import.meta.url), 'utf8')
      .replace(/^\s*\/\/.*$/gm, ''),
  );
  delete cfg.$schema;
  cfg.server.port = 0;
  cfg.server.openBrowserOnStart = false;
  cfg.admin.initialPassword = adminPass;
  cfg.backup.enabled = false;
  cfg.logging.toFile = false;
  cfg.logging.level = 'warn';
  cfg.models.healthCheckIntervalMs = 3600000;
  cfg.models.catalog = farm.catalog;
  cfg.models.defaultRoute = farm.catalog.map((m) => m.id);
  fs.writeFileSync(process.env.AGIBAR_CONFIG_FILE, JSON.stringify(cfg, null, 2));

  const { main } = await import('../../server/index.mjs');
  const server = await main();

  const { checkAllModels } = await import('../../server/services/models.mjs');
  const { loadConfig } = await import('../../server/core/config.mjs');
  await checkAllModels(loadConfig());

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    adminPass,
    async close() {
      server.close();
      await farm.closeAll();
      const { closeDb } = await import('../../server/core/db.mjs');
      closeDb();
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
    },
  };
}

// ---------------------------------------------------------------- 執行

export async function run(opts) {
  let env = null;
  let base = opts.url;
  let key = opts.key;
  let adminPass = opts.adminPass;
  let provisioned = null;
  const cookieRef = { value: '' };

  if (opts.selfTest) {
    env = await startSelfTestEnv();
    base = env.url;
    adminPass = env.adminPass;
  }

  try {
    if (!key) {
      if (!adminPass) {
        throw new Error('需要 --key（現有 API Key）或 --admin-pass（自動建立探測人員）其中之一。');
      }
      provisioned = await provisionProbeUser(base, cookieRef, { adminUser: opts.adminUser, adminPass });
      key = provisioned.key;
    }

    const ctx = makeCtx(base, key);
    const list = probesFor(opts.client);
    const results = [];

    for (const probe of list) {
      const started = Date.now();
      let outcome;
      try {
        outcome = await probe.run(ctx);
      } catch (err) {
        outcome = { ok: false, detail: `探針執行錯誤：${err.message}` };
      }
      results.push({
        ...probe,
        ...outcome,
        // downgrade：有明確解法（設定一行就好）的失敗不算致命
        fatal: probe.severity === 'required' && !outcome.ok && !outcome.downgrade,
        ms: Date.now() - started,
      });
    }

    const report = { base, client: opts.client, results, key };
    if (!opts.quiet) printReport(report, opts);

    if (opts.emit) writeConfigs(opts.emit, base, key, opts);
    if (opts.json) {
      fs.writeFileSync(opts.json, JSON.stringify({
        base, client: opts.client,
        results: results.map(({ run: _run, ...r }) => r),
      }, null, 2), 'utf8');
      if (!opts.quiet) console.log(`  原始資料已寫入 ${opts.json}\n`);
    }

    return { report, pass: !results.some((r) => r.fatal) };
  } finally {
    if (provisioned) {
      await adminFetch(base, cookieRef, `/api/users/${provisioned.id}`, { method: 'DELETE' }).catch(() => {});
      if (!opts.quiet) console.log('  已清除探測人員\n');
    }
    if (env) await env.close();
  }
}

// ---------------------------------------------------------------- 報表

function printReport(report, opts) {
  const { base, results, key } = report;
  const masked = !opts.showSecrets;
  const line = (s = '') => console.log(s);

  line();
  line('═'.repeat(78));
  line('  AGI BAR 客戶端串接驗證（M11）');
  line('═'.repeat(78));
  line();
  line(`  目標 : ${base}`);
  line(`  Key  : ${masked ? maskKey(key) : key}`);
  line();

  const byClient = new Map();
  for (const r of results) {
    if (!byClient.has(r.client)) byClient.set(r.client, []);
    byClient.get(r.client).push(r);
  }

  for (const [client, rows] of byClient) {
    line(`  ── ${CLIENT_LABELS[client] ?? client} ${'─'.repeat(Math.max(0, 70 - (CLIENT_LABELS[client] ?? client).length))}`);
    for (const r of rows) {
      const mark = r.ok ? '✓' : (r.fatal ? '✗' : (r.severity === 'info' ? 'ℹ' : '!'));
      line(`  ${mark} ${pad(r.name, 36)} ${r.detail}`);
      if (r.hint) line(`      → ${r.hint}`);
    }
    line();
  }

  // ---- 設定 ----
  const want = (c) => opts.client === 'all' || opts.client === c;

  if (want('cursor')) {
    line('  ── Cursor 設定 ' + '─'.repeat(62));
    cursorSteps(base, key, { masked }).forEach((s, i) => line(`  ${i + 1}. ${s}`));
    line();
  }

  if (want('codex')) {
    line('  ── Codex 設定 ' + '─'.repeat(63));
    line(codexConfigToml(base).split('\n').map((l) => '  ' + l).join('\n'));
    const envs = codexEnv(base, key, { masked });
    line('  # bash / zsh');
    line(envs.bash.split('\n').map((l) => '  ' + l).join('\n'));
    line('  # PowerShell');
    line(envs.powershell.split('\n').map((l) => '  ' + l).join('\n'));
    line();
  }

  if (want('claude-code')) {
    line('  ── Claude Code 設定 ' + '─'.repeat(57));
    const cc = claudeCodeEnv(base, key, { masked });
    line(cc.bash.split('\n').map((l) => '  ' + l).join('\n'));
    line(`  # ${cc.note}`);
    line();
  }

  // ---- 人工步驟 ----
  line('  ── 仍需人工完成 ' + '─'.repeat(61));
  for (const [client, steps] of Object.entries(MANUAL_STEPS)) {
    if (!want(client)) continue;
    line(`  【${CLIENT_LABELS[client] ?? client}】`);
    steps.forEach((s) => line(`    □ ${s}`));
  }
  line();

  // ---- 結論 ----
  const fatal = results.filter((r) => r.fatal);
  const warn = results.filter((r) => !r.ok && !r.fatal && r.severity !== 'info');

  line('═'.repeat(78));
  if (fatal.length) {
    line(`  結果：${fatal.length} 項必要條件未通過`);
    fatal.forEach((r) => line(`    ✗ ${r.name}｜${r.why}`));
  } else {
    line('  結果：API 層面全部通過，可以進行人工設定');
    if (warn.length) {
      line(`  另有 ${warn.length} 項提醒：`);
      warn.forEach((r) => line(`    ! ${r.name} — ${r.hint ?? r.detail}`));
    }
  }
  line('═'.repeat(78));
  line();
}

function writeConfigs(dir, base, key, opts) {
  fs.mkdirSync(dir, { recursive: true });
  const masked = !opts.showSecrets;

  fs.writeFileSync(path.join(dir, 'codex-config.toml'), codexConfigToml(base), 'utf8');

  const envs = codexEnv(base, key, { masked });
  const cc = claudeCodeEnv(base, key, { masked });
  fs.writeFileSync(path.join(dir, 'env.sh'),
    `# Codex / OpenAI 相容客戶端\n${envs.bash}\n\n# Claude Code\n# ${cc.note}\n${cc.bash}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'env.ps1'),
    `# Codex / OpenAI 相容客戶端\n${envs.powershell}\n\n# Claude Code\n# ${cc.note}\n${cc.powershell}\n`, 'utf8');

  const curls = curlChecks(base, key, { masked });
  fs.writeFileSync(path.join(dir, 'smoke.sh'),
    `#!/usr/bin/env bash\nset -e\n\n${curls.models}\n\n${curls.chat}\n\n${curls.messages}\n`, 'utf8');

  fs.writeFileSync(path.join(dir, 'cursor-steps.md'),
    `# Cursor 設定步驟\n\n${cursorSteps(base, key, { masked }).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`, 'utf8');

  if (!opts.quiet) {
    console.log(`  設定檔已產生於 ${dir}/`);
    console.log(masked ? '  （API Key 已遮蔽；需要完整值請加 --show-secrets）\n' : '  ⚠ 含完整 API Key，請勿提交到版本庫\n');
  }
}

// ---------------------------------------------------------------- CLI

const HELP = `
AGI BAR 客戶端串接驗證（M11）

用法：
  node tests/integration/client-compat.mjs --self-test
  node tests/integration/client-compat.mjs --url http://192.168.1.100:8787 --key agi-bar-xxxxxxxx
  node tests/integration/client-compat.mjs --url http://… --admin-pass "密碼" --client codex

參數：
  --url <網址>         Gateway 位址（預設 http://127.0.0.1:8787）
  --key <API Key>      用既有的 Key 探測
  --admin-pass <密碼>  沒有 Key 時，自動建立探測人員（結束後刪除）
  --admin-user <帳號>  管理員帳號（預設 admin）
  --client <名稱>      all | cursor | codex | claude-code | app | deepseek
  --emit <目錄>        產生設定檔到指定目錄
  --show-secrets       設定中顯示完整 API Key（預設遮蔽）
  --self-test          內建 Gateway + 假模型，用於驗證腳本本身
  --json <檔案>        輸出原始結果
  --quiet              不印報表

離開碼：0 通過，1 有必要條件未通過，2 執行錯誤。
`;

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).endsWith(path.join('integration', 'client-compat.mjs'));

if (invokedDirectly) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { pass } = await run(opts);
    process.exitCode = pass ? 0 : 1;
  } catch (err) {
    console.error(`\n  執行失敗：${err.message}\n`);
    process.exitCode = 2;
  }
  await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.().catch(() => {});
}
