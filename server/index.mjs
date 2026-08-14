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
import { adminRouter } from './routes/admin.mjs';
import { openaiRouter } from './routes/openai.mjs';
import { anthropicRouter, anthropicModelList, requireApiKey } from './routes/anthropic.mjs';
import { anthropicErrorType } from './services/anthropic-compat.mjs';
import { serveStatic } from './routes/static.mjs';

export const VERSION = '1.2.0';

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
      if (req.method === 'GET') return serveStatic(req, res, '/index.html') || res.writeHead(404).end('Not Found');
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
  console.log(`   Web 管理介面 : ${localUrl}`);
  console.log(`   API Base URL : ${localUrl}/v1`);
  console.log(`   資料庫       : ${paths.db}`);
  if (admin) {
    console.log('');
    console.log(`   初始管理員   : ${config.admin.username} / ${config.admin.initialPassword}`);
    console.log('   ⚠  請登入後立即於「設定」頁修改密碼。');
  }
  console.log('');
  console.log('   按 Ctrl+C 結束服務。');
  console.log('');

  if (config.server.openBrowserOnStart) openBrowser(localUrl);

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
  main().catch((err) => {
    console.error('');
    console.error('  啟動失敗：', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error('  連接埠已被占用，請於 config/config.json 修改 server.port 後再試。');
    }
    console.error('');
    process.exit(1);
  });
}
