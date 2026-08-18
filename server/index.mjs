#!/usr/bin/env node
/**
 * AGI BAR - Local AI Gateway Management System
 * 進入點：啟動 HTTP 服務、初始化資料庫、同步模型、啟動健康檢查與備份排程。
 *
 * Web UI : http://<AI主機IP>:8787
 * API    : http://<AI主機IP>:8787/v1
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { paths, ensureRuntimeDirs } from './core/paths.mjs';
import { loadConfig } from './core/config.mjs';
import { configureLogger, closeLogger, log } from './core/logger.mjs';
import { getDb, closeDb, setSetting } from './core/db.mjs';
import { HttpError, json, openaiError, anthropicError, clientIp } from './core/http.mjs';
import { bootstrapAdmin } from './services/users.mjs';
import { syncCatalog, startHealthLoop, stopHealthLoop } from './services/models.mjs';
import { queue } from './services/queue.mjs';
import { purgeExpiredSessions } from './services/session.mjs';
import { startBackupSchedule, stopBackupSchedule } from './services/backup.mjs';
import { startRetentionSchedule, stopRetentionSchedule } from './services/retention.mjs';
import { adminRouter } from './routes/admin.mjs';
import { openaiRouter } from './routes/openai.mjs';
import { anthropicRouter, anthropicModelList, requireApiKey } from './routes/anthropic.mjs';
import { anthropicErrorType } from './services/anthropic-compat.mjs';
import { serveStatic } from './routes/static.mjs';
import { lanAddresses, primaryLanAddress } from './core/net.mjs';
import { isAdminSurface, isAdminAsset, canAccessAdmin, normalizeIp } from './services/access.mjs';
import { VERSION } from './core/version.mjs';

export { VERSION };

/**
 * 本次執行的唯一識別。
 *
 * 用途是啟動後的自我檢查：確認「使用者打開那個網址時，回應的真的是這個行程」。
 * 在 Windows 上，另一個綁 `::` 的服務可以和我們綁 `0.0.0.0` 的 socket 並存，
 * 而瀏覽器的 localhost 會優先走 IPv6 —— 結果就是 AGI BAR 明明在跑，
 * 打開網頁卻是別的程式在回應。沒有這個檢查，那種狀況極難察覺。
 */
const INSTANCE_ID = randomUUID();

export async function createServer(bootConfig) {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    // 每次請求重新取得設定（loadConfig 有快取），這樣管理台改完政策就立即生效，
    // 不必重啟服務 —— 若沿用啟動時捕捉的物件，saveConfig 產生的新物件會被忽略。
    const config = loadConfig();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return res.writeHead(400).end('Bad Request');
    }
    const pathname = url.pathname;
    const isApiPath = pathname.startsWith('/v1/');
    // Anthropic 客戶端一律帶 anthropic-version；用它決定錯誤與模型清單的格式
    const isAnthropicClient = !!req.headers['anthropic-version'] || pathname.includes('/messages');

    // 基本安全標頭（Web UI 為本機/LAN 使用，不引用任何外部資源）
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-AGI-BAR-Instance', INSTANCE_ID);
    if (!isApiPath) {
      res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    }

    // CORS：只放行管理員設定的來源，供自製 App / 網頁前端使用
    const origin = req.headers.origin;
    const allowed = config.security?.allowedOrigins ?? [];
    if (origin && (allowed.includes('*') || allowed.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers',
        'Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    // 管理介面的來源隔離。必須在路由之前，且只看 TCP 對端位址 ——
    // 用 X-Forwarded-For 這類標頭做授權等於沒有授權（見 services/access.mjs）。
    if (isAdminSurface(pathname) || isAdminAsset(pathname)) {
      if (!canAccessAdmin(req.socket?.remoteAddress, config.security)) {
        log.warn('拒絕非本機存取管理介面', {
          path: pathname, ip: normalizeIp(req.socket?.remoteAddress),
        });
        // 區網人員打根路徑時導向聊天頁，而不是丟一個死路
        if (pathname === '/' || pathname === '/index.html') {
          res.writeHead(302, { Location: '/chat.html' });
          return res.end();
        }
        // 其餘一律 404：403 等於承認「這裡有東西」，404 讓管理台看起來不存在
        if (isApiPath) return openaiError(res, 404, 'unknown_endpoint', '不支援的 API 路徑');
        return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      }
    }

    const ctx = { config, query: url.searchParams, params: {} };

    try {
      // 同一條 /v1/models 依客戶端型別回不同格式：Anthropic SDK 解不了 OpenAI 的 list 結構
      if (req.method === 'GET' && pathname === '/v1/models' && req.headers['anthropic-version']) {
        return json(res, 200, anthropicModelList(requireApiKey(req), config));
      }

      // Anthropic 路由排在最前面，因為它同時收 /v1/messages 與誤設的 /v1/v1/messages
      for (const router of [anthropicRouter, openaiRouter, adminRouter]) {
        const hit = router.match(req.method, pathname);
        if (!hit) continue;
        if (hit.methodNotAllowed) throw new HttpError(405, 'method_not_allowed', '不支援的 HTTP 方法');
        ctx.params = hit.params;
        await hit.handler(req, res, ctx);
        return;
      }

      if (req.method === 'GET' && serveStatic(req, res, pathname)) return;

      // 未知的 /v1 路徑要回 OpenAI 風格錯誤，客戶端才看得懂
      if (isApiPath) throw new HttpError(404, 'unknown_endpoint', `不支援的 API 路徑：${pathname}`);

      if (req.method === 'GET') {
        // SPA 退回首頁時也要經過管理介面的來源判定。少了這一層，任何未知路徑
        // （例如有人直接打 /v1 或隨手輸入的網址）都會把登入頁送給區網 ——
        // 前面辛苦擋掉 /index.html 就白費了。
        if (!canAccessAdmin(req.socket?.remoteAddress, config.security)) {
          res.writeHead(302, { Location: '/chat.html' });
          return res.end();
        }
        return serveStatic(req, res, '/index.html') || res.writeHead(404).end('Not Found');
      }
      throw new HttpError(404, 'not_found', '找不到資源');
    } catch (err) {
      const status = err.status || 500;
      const code = err.code || 'internal_error';
      const message = status === 500 ? '伺服器內部錯誤' : (err.message || '請求失敗');

      if (status >= 500) {
        log.error('未處理的錯誤', { path: pathname, code, error: err.message, stack: err.stack?.split('\n')[1]?.trim() });
      } else {
        log.debug('請求被拒', { path: pathname, status, code, ip: clientIp(req, config.server.trustProxy) });
      }

      if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
      if (isApiPath && isAnthropicClient) {
        anthropicError(res, status, anthropicErrorType(status), message);
      } else if (isApiPath) {
        openaiError(res, status, code, message);
      } else {
        json(res, status, { error: { code, message } });
      }
    } finally {
      if (Date.now() - started > 10000) {
        log.debug('慢請求', { path: pathname, ms: Date.now() - started });
      }
    }
  });

  server.requestTimeout = bootConfig.server.requestTimeoutMs ?? 300000;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;
  return server;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    log.warn('無法自動開啟瀏覽器，請手動前往', { url, error: e.message });
  }
}

/** 這個埠現在能不能綁？用來在啟動前就給出清楚的訊息，而不是丟出 EADDRINUSE。 */
export function probePort(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', (err) => resolve(err.code || 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(null)));
    probe.listen(port, host);
  });
}

/** 從 start 往上找第一個可用的埠，供錯誤訊息給出可行建議。 */
async function findFreePort(start, host = '0.0.0.0', tries = 20) {
  for (let p = start; p < start + tries; p++) {
    if (await probePort(p, host) === null) return p;
  }
  return null;
}

/**
 * 確認使用者實際會連到的位址，回應的是本行程。
 * 回傳 null 表示正常，否則回傳問題描述。
 */
async function verifyReachable(port) {
  for (const host of ['localhost', '127.0.0.1']) {
    let res;
    try {
      res = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(4000) });
    } catch (err) {
      return { host, problem: 'unreachable', detail: err.message };
    }
    const id = res.headers.get('x-agi-bar-instance');
    if (id !== INSTANCE_ID) {
      return { host, problem: id ? 'other-agibar' : 'foreign-service', detail: `HTTP ${res.status}` };
    }
  }
  return null;
}

export async function main() {
  ensureRuntimeDirs();
  const config = loadConfig();
  configureLogger(config.logging);

  log.info('AGI BAR 啟動中', { version: VERSION, node: process.version });

  getDb();
  setSetting('version', VERSION);
  purgeExpiredSessions();

  const admin = bootstrapAdmin(config);
  syncCatalog(config);
  queue.configure(config.queue);
  startHealthLoop(config);
  // 先清逾期紀錄再備份 —— 反過來的話啟動備份會把正要刪掉的資料一起收進快照
  startRetentionSchedule(config);
  startBackupSchedule(config);

  const server = await createServer(config);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, resolve);
  });

  fs.writeFileSync(paths.pidFile, String(process.pid), 'utf8');

  // 用實際綁定的 port，而不是設定值 —— 設 0 時才不會印出 http://localhost:0
  const boundPort = server.address()?.port ?? config.server.port;
  const localUrl = `http://localhost:${boundPort}`;
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║   AGI BAR - Local AI Gateway Management System       ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  const adminLoopbackOnly = (config.security?.adminAccess ?? 'loopback') !== 'lan';
  const lanIp = primaryLanAddress();
  const lanBase = lanIp ? `http://${lanIp}:${boundPort}` : localUrl;
  const others = lanAddresses().filter((a) => a.address !== lanIp);

  console.log(`   Web 管理介面 : ${localUrl}${adminLoopbackOnly ? '   （僅限本機）' : ''}`);
  console.log(`   資料庫       : ${paths.db}`);
  console.log('');
  console.log('   給人員的位址（手機／其他電腦用這個，不是 localhost）：');
  console.log(`     網頁聊天     : ${lanBase}/chat.html`);
  console.log(`     API Base URL : ${lanBase}/v1`);
  if (others.length) {
    console.log('');
    console.log('     本機還有其他位址，若上面那個連不到可改試：');
    for (const a of others) {
      console.log(`       http://${a.address}:${boundPort}   （${a.name}${a.virtual ? '，虛擬介面，多半不通' : ''}）`);
    }
  }
  console.log('');
  console.log('     手機或其他電腦連不到的話，多半是 Windows 防火牆沒放行。');
  console.log('     以系統管理員身分開 PowerShell 執行：');
  console.log(`       New-NetFirewallRule -DisplayName "AGI BAR" -Direction Inbound -LocalPort ${boundPort} -Protocol TCP -Action Allow -Profile Private`);
  if (adminLoopbackOnly) {
    console.log('');
    console.log('   管理台已限制為本機存取：區網人員連 / 會被導向聊天頁，');
    console.log('   /app.html 與 /api/* 一律回 404。要開放請改 config 的');
    console.log('   security.adminAccess 或 security.adminAllowedCidrs。');
  }
  if (admin) {
    console.log('');
    console.log(`   初始管理員   : ${config.admin.username} / ${config.admin.initialPassword}`);
    console.log('   ⚠  請登入後立即於「設定」頁修改密碼。');
  }
  console.log('');
  console.log('   按 Ctrl+C 結束服務。');
  console.log('');

  // 綁定成功不代表使用者連得到我們。Windows 上另一個綁 `::` 的服務可以與
  // 我們綁 `0.0.0.0` 的 socket 並存，而 localhost 優先走 IPv6 —— 服務明明在跑，
  // 打開網頁卻是別的程式在回應。這裡先確認一次，有問題就講清楚。
  const conflict = await verifyReachable(boundPort);
  if (conflict) {
    const what = {
      'foreign-service': '另一個程式',
      'other-agibar': '另一個 AGI BAR 實例',
      unreachable: '無法連線',
    }[conflict.problem];

    console.log('  ┌──────────────────────────────────────────────────────────┐');
    console.log('  │  ⚠  警告：這個位址上回應的不是本服務                     │');
    console.log('  └──────────────────────────────────────────────────────────┘');
    console.log('');
    console.log(`   用 http://${conflict.host}:${boundPort} 連線時，回應的是${what}（${conflict.detail}）。`);
    console.log('   AGI BAR 本身有在執行，但你在瀏覽器看到的畫面不是它。');
    console.log('');
    console.log(`   常見原因：另一個服務綁在 IPv6（::）的同一個連接埠上，`);
    console.log('   而 localhost 會優先解析成 IPv6，因此被它接走。');
    console.log('');
    console.log('   查出是誰（PowerShell）：');
    console.log(`     Get-NetTCPConnection -LocalPort ${boundPort} -State Listen |`);
    console.log('       ForEach-Object { Get-Process -Id $_.OwningProcess | Select Id,ProcessName,Path }');
    console.log('');
    console.log('   解法擇一：關閉那個程式，或改用其他連接埠');
    console.log('   （編輯 config/config.json 的 server.port，客戶端 Base URL 也要一起改）。');
    console.log('');

    log.warn('連接埠被其他服務攔截', {
      port: boundPort, host: conflict.host, problem: conflict.problem, detail: conflict.detail,
    });
  } else if (config.server.openBrowserOnStart) {
    openBrowser(localUrl);
  }

  // 停止腳本會建立哨兵檔（見 paths.shutdownRequest 的說明）
  try { fs.rmSync(paths.shutdownRequest, { force: true }); } catch { /* 不存在就算了 */ }
  const shutdownWatcher = setInterval(() => {
    if (!fs.existsSync(paths.shutdownRequest)) return;
    try { fs.rmSync(paths.shutdownRequest, { force: true }); } catch { /* 下一輪再試 */ }
    shutdown('stop-script');
  }, 1000);
  shutdownWatcher.unref?.();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('收到關閉訊號，正在停止服務', { signal });
    clearInterval(shutdownWatcher);
    stopHealthLoop();
    stopBackupSchedule();
    stopRetentionSchedule();
    queue.drain();
    server.close(async () => {
      closeDb();
      try { fs.unlinkSync(paths.pidFile); } catch { /* 已刪除 */ }
      try { fs.rmSync(paths.shutdownRequest, { force: true }); } catch { /* 已刪除 */ }
      log.info('AGI BAR 已停止');
      await closeLogger();   // 等紀錄寫完再離開，否則最後幾行會消失
      process.exit(0);
    });
    setTimeout(async () => { await closeLogger(); process.exit(0); }, 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('未攔截的 Promise 拒絕', { reason: String(reason) }));

  return server;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.mjs')) {
  main().catch(async (err) => {
    console.error('');
    if (err.code === 'EADDRINUSE') {
      // 這是最常見的啟動失敗。訊息要能直接告訴管理員下一步怎麼做，
      // 否則他們會打開瀏覽器、看到「另一個程式」的回應，然後以為是 AGI BAR 壞了。
      const cfg = loadConfig();
      const port = cfg.server.port;
      const free = await findFreePort(port + 1, cfg.server.host).catch(() => null);

      console.error('  ╔══════════════════════════════════════════════════════════╗');
      console.error('  ║  啟動失敗：連接埠已被其他程式占用                        ║');
      console.error('  ╚══════════════════════════════════════════════════════════╝');
      console.error('');
      console.error(`   連接埠 ${port} 上已經有別的程式在執行。`);
      console.error('   AGI BAR 沒有啟動 —— 此時用瀏覽器打開該位址，看到的是');
      console.error('   那個程式的畫面，不是 AGI BAR。');
      console.error('');
      console.error('   查出是誰占用（PowerShell）：');
      console.error(`     Get-NetTCPConnection -LocalPort ${port} -State Listen |`);
      console.error('       ForEach-Object { Get-Process -Id $_.OwningProcess }');
      console.error('');
      console.error('   解法擇一：');
      console.error('     A. 關閉占用該連接埠的程式，再重新啟動 AGI BAR');
      if (free) {
        console.error(`     B. 改用其他連接埠 —— 目前 ${free} 是空的：`);
        console.error(`        編輯 config/config.json，把 "port": ${port} 改成 "port": ${free}`);
        console.error(`        （臨時測試可用：set AGIBAR_PORT=${free}）`);
        console.error('');
        console.error('     注意：改了連接埠之後，所有客戶端的 Base URL 也要一起改。');
      } else {
        console.error('     B. 編輯 config/config.json 的 server.port 換一個連接埠');
      }
    } else {
      console.error('  啟動失敗：', err.message);
      if (err.code === 'EACCES') {
        console.error('  沒有權限綁定該連接埠。1024 以下的連接埠需要系統管理員權限。');
      }
    }
    console.error('');
    await closeLogger().catch(() => {});
    process.exit(1);
  });
}
