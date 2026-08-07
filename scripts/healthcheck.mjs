#!/usr/bin/env node
/**
 * 部署後健康檢查（規畫書 16.3 最後一步）。
 *
 *   node scripts/healthcheck.mjs [baseUrl]
 *
 * 離開碼 0 = 健康，1 = 有問題，可直接串進部署腳本或監控。
 */
import { loadConfig } from '../server/core/config.mjs';

const config = loadConfig();
const base = (process.argv[2] || `http://127.0.0.1:${config.server.port}`).replace(/\/+$/, '');

const results = [];
let failed = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail: detail ?? '' });
  } catch (err) {
    failed++;
    results.push({ ok: false, name, detail: err.message });
  }
}

await check('服務可連線', async () => {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  return `v${d.version}，已運行 ${Math.round(d.uptimeSec / 60)} 分鐘`;
});

await check('Web UI 可載入', async () => {
  const res = await fetch(base + '/', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (!html.includes('AGI BAR')) throw new Error('回應內容不像登入頁');
  return '';
});

await check('未帶 Key 的 API 請求被拒絕', async () => {
  const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
  if (res.status !== 401) throw new Error(`預期 401，實得 ${res.status}`);
  return '';
});

await check('佇列未阻塞', async () => {
  const d = await (await fetch(`${base}/api/health`)).json();
  if (d.queue.waiting > d.queue.maxConcurrent * 10) {
    throw new Error(`佇列積壓 ${d.queue.waiting} 筆`);
  }
  return `等待 ${d.queue.waiting} / 執行中 ${d.queue.running}`;
});

await check('模型端點可達', async () => {
  const enabled = (config.models?.catalog ?? []).filter((m) => m.enabled !== false && m.isLocal !== false);
  if (!enabled.length) throw new Error('設定檔中沒有啟用任何本地模型');

  const states = [];
  for (const m of enabled) {
    try {
      const res = await fetch(`${m.endpoint.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(5000) });
      states.push(`${m.id}=${res.ok ? '線上' : 'HTTP ' + res.status}`);
    } catch {
      states.push(`${m.id}=離線`);
    }
  }
  if (states.every((s) => s.includes('離線') || s.includes('HTTP'))) {
    throw new Error(`所有本地模型皆不可用：${states.join(', ')}`);
  }
  return states.join(', ');
});

console.log('');
console.log(`  AGI BAR 健康檢查 — ${base}`);
console.log('  ' + '─'.repeat(56));
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(28)} ${r.detail}`);
}
console.log('');

if (failed) {
  console.error(`  ${failed} 項未通過。詳細紀錄請看 data/logs/。\n`);
} else {
  console.log('  全部通過。\n');
}

// 設 exitCode 而非呼叫 process.exit()：fetch 的 keep-alive socket 尚未關閉時，
// 強制結束會在 Windows 上觸發 libuv 斷言而覆蓋掉真正的離開碼。
process.exitCode = failed ? 1 : 0;
// 主動結束閒置連線，讓行程立刻退出而不必等 keep-alive 逾時。
await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.().catch(() => {});
