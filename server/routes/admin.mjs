/**
 * Web 管理 API（規畫書 4-6、12）。
 * 所有端點皆需管理員 Session；一般人員無法呼叫。
 */
import os from 'node:os';
import { Router, HttpError, json, readJsonBody, clientIp } from '../core/http.mjs';
import { all, get, getSetting, setSetting } from '../core/db.mjs';
import { loadConfig, saveConfig } from '../core/config.mjs';
import * as sessions from '../services/session.mjs';
import * as users from '../services/users.mjs';
import * as keys from '../services/apikeys.mjs';
import * as models from '../services/models.mjs';
import * as routes from '../services/routes.mjs';
import * as quota from '../services/quota.mjs';
import { queue } from '../services/queue.mjs';
import { createBackup, listBackups } from '../services/backup.mjs';
import { lanUrls as netLanUrls } from '../core/net.mjs';

export const adminRouter = new Router();

function ctxOf(req, config, session) {
  return {
    actorId: session?.user?.id ?? null,
    clientIp: clientIp(req, config.server.trustProxy),
    maxUsers: config.limits?.maxUsers ?? 50,
    apiKeyPrefix: config.security?.apiKeyPrefix ?? 'agi-bar-',
    defaultLimits: config.limits?.defaultUserLimits ?? {},
  };
}

// ---------------- 認證 ----------------

adminRouter.post('/api/auth/login', async (req, res, ctx) => {
  const body = await readJsonBody(req, 8192);
  const result = sessions.login({
    username: body.username,
    password: body.password,
    clientIp: clientIp(req, ctx.config.server.trustProxy),
    userAgent: req.headers['user-agent'],
    config: ctx.config,
  });
  sessions.applySessionCookie(res, result.sessionId, {
    ttlHours: result.ttlHours,
    secure: ctx.config.security?.forceHttpsCookies,
  });
  json(res, 200, {
    ok: true,
    user: { id: result.user.id, username: result.user.username, displayName: result.user.display_name },
    mustChangePassword: isDefaultPassword(ctx.config, body.password),
  });
});

function isDefaultPassword(config, submitted) {
  return submitted === config.admin?.initialPassword;
}

adminRouter.post('/api/auth/logout', async (req, res) => {
  sessions.logout(req, res);
  json(res, 200, { ok: true });
});

adminRouter.get('/api/auth/me', async (req, res) => {
  const s = sessions.currentSession(req);
  if (!s) return json(res, 200, { authenticated: false });
  json(res, 200, { authenticated: true, user: s.user });
});

adminRouter.post('/api/auth/password', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  const body = await readJsonBody(req, 8192);
  if (!body.newPassword || String(body.newPassword).length < 8) {
    throw new HttpError(400, 'weak_password', '新密碼至少需 8 個字元');
  }
  users.updateUser(s.user.id, { password: body.newPassword }, ctxOf(req, ctx.config, s));
  json(res, 200, { ok: true });
});

// ---------------- Dashboard（規畫書 4）----------------

adminRouter.get('/api/dashboard', async (req, res, ctx) => {
  sessions.requireAdmin(req);
  const config = ctx.config;

  const userCount = get("SELECT COUNT(*) AS n FROM users WHERE role <> 'admin'").n;
  const onlineCount = get(
    "SELECT COUNT(DISTINCT user_id) AS n FROM request_logs WHERE ts >= datetime('now', '-5 minutes')").n;
  const requestsToday = get(
    "SELECT COUNT(*) AS n FROM request_logs WHERE date(ts, 'localtime') = date('now', 'localtime')").n;
  const tokensToday = get(
    "SELECT COALESCE(SUM(total_tokens), 0) AS n FROM usage_logs WHERE date(ts, 'localtime') = date('now', 'localtime')").n;
  const errorsToday = get(
    "SELECT COUNT(*) AS n FROM request_logs WHERE status_code >= 400 AND date(ts, 'localtime') = date('now', 'localtime')").n;

  const modelRows = models.listModels();
  const primary = modelRows.find((m) => m.enabled && m.health_state === 'online') ?? modelRows[0] ?? null;

  const totalVram = modelRows.reduce((a, m) => a + (m.enabled ? m.vram_mb : 0), 0);
  const usedVram = modelRows.reduce((a, m) => a + m.vram_used_mb, 0);

  json(res, 200, {
    users: { total: userCount, online: onlineCount, max: config.limits?.maxUsers ?? 50 },
    requests: { today: requestsToday, errorsToday },
    tokens: { today: tokensToday },
    queue: queue.snapshot(),
    concurrency: { inFlight: quota.totalInFlight() },
    gpu: {
      vramTotalMb: totalVram,
      vramUsedMb: usedVram,
      vramPercent: totalVram ? Math.round((usedVram / totalVram) * 100) : 0,
    },
    primaryModel: primary ? { id: primary.id, name: primary.display_name, state: primary.health_state } : null,
    models: modelRows.map((m) => ({
      id: m.id, name: m.display_name, enabled: !!m.enabled, isLocal: !!m.is_local,
      state: m.health_state, queueDepth: m.queue_depth,
      firstTokenMs: Math.round(m.avg_first_token_ms), tokensPerSec: Number(m.avg_tokens_per_sec.toFixed(1)),
      errorRate: Number((m.error_rate * 100).toFixed(1)), lastError: m.last_error,
    })),
    system: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      uptimeSec: Math.round(process.uptime()),
      memFreeMb: Math.round(os.freemem() / 1048576),
      memTotalMb: Math.round(os.totalmem() / 1048576),
      nodeVersion: process.version,
      port: config.server.port,
      lanUrls: netLanUrls(config.server.port).map((a) => a.url),
    },
  });
});

// ---------------- 人員 ----------------

adminRouter.get('/api/users', async (req, res) => {
  sessions.requireAdmin(req);
  json(res, 200, { users: users.listUsers() });
});

adminRouter.post('/api/users', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  const body = await readJsonBody(req, 65536);
  const c = ctxOf(req, ctx.config, s);
  const user = users.createUser(body, c);

  // 建立人員時自動配發第一把 Key（規畫書 5：每位人員擁有獨立 API Key）
  let key = null;
  if (body.createKey !== false) {
    key = keys.createKey(user.id, { name: 'default', limits: body.limits ?? {} }, c);
  }
  if (Array.isArray(body.route) && body.route.length) {
    routes.setUserRoute(user.id, body.route, c);
  }
  json(res, 201, { user, key });
});

adminRouter.get('/api/users/:id', async (req, res, ctx) => {
  sessions.requireAdmin(req);
  const id = Number(ctx.params.id);
  const user = users.getUser(id);
  if (!user) throw new HttpError(404, 'user_not_found', '找不到人員');
  json(res, 200, {
    user,
    keys: keys.listKeys(id),
    route: routes.getUserRoute(id),
    usage: get(`
      SELECT COALESCE(SUM(CASE WHEN date(ts,'localtime')=date('now','localtime') THEN total_tokens END),0) AS today,
             COALESCE(SUM(CASE WHEN strftime('%Y-%m',ts,'localtime')=strftime('%Y-%m','now','localtime') THEN total_tokens END),0) AS month,
             COALESCE(SUM(total_tokens),0) AS total
      FROM usage_logs WHERE user_id = ?`, [id]),
  });
});

adminRouter.patch('/api/users/:id', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  const body = await readJsonBody(req, 65536);
  json(res, 200, { user: users.updateUser(Number(ctx.params.id), body, ctxOf(req, ctx.config, s)) });
});

adminRouter.delete('/api/users/:id', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  users.deleteUser(Number(ctx.params.id), ctxOf(req, ctx.config, s));
  json(res, 200, { ok: true });
});

// ---------------- API Key ----------------

adminRouter.get('/api/keys', async (req, res) => {
  sessions.requireAdmin(req);
  json(res, 200, { keys: keys.listKeys() });
});

adminRouter.post('/api/users/:id/keys', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  const body = await readJsonBody(req, 65536);
  const key = keys.createKey(Number(ctx.params.id), body, ctxOf(req, ctx.config, s));
  json(res, 201, { key, notice: '請立即複製明文 Key，關閉後將無法再次顯示。' });
});

adminRouter.post('/api/keys/:id/rotate', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  const key = keys.rotateKey(Number(ctx.params.id), ctxOf(req, ctx.config, s));
  json(res, 200, { key, notice: '舊 Key 已撤銷，請立即複製新的明文 Key。' });
});

adminRouter.patch('/api/keys/:id', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  const body = await readJsonBody(req, 65536);
  const c = ctxOf(req, ctx.config, s);
  const id = Number(ctx.params.id);
  if (body.status) keys.setKeyStatus(id, body.status, c);
  if (body.limits) keys.updateLimits(id, body.limits, c);
  json(res, 200, { key: keys.getKey(id) });
});

adminRouter.delete('/api/keys/:id', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  keys.deleteKey(Number(ctx.params.id), ctxOf(req, ctx.config, s));
  json(res, 200, { ok: true });
});

/**
 * 目前可用的對外位址。每次呼叫都重新偵測 ——
 * 筆電換 Wi-Fi、插拔網路線、DHCP 續約都會換 IP，快取住只會給出過期的網址。
 */
adminRouter.get('/api/network', async (req, res, ctx) => {
  sessions.requireAdmin(req);
  const port = ctx.config.server.port;
  const addresses = netLanUrls(port);
  const primary = addresses.find((a) => !a.virtual) ?? addresses[0] ?? null;
  json(res, 200, {
    port,
    detectedAt: new Date().toISOString(),
    primary: primary?.address ?? null,
    addresses,
    hostname: os.hostname(),
  });
});

// ---------------- 模型與路由 ----------------

adminRouter.get('/api/models', async (req, res) => {
  sessions.requireAdmin(req);
  json(res, 200, { models: models.listModels() });
});

adminRouter.patch('/api/models/:id', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  const body = await readJsonBody(req, 8192);
  const model = models.setModelEnabled(ctx.params.id, !!body.enabled, {
    ...ctxOf(req, ctx.config, s),
    configModule: { loadConfig, saveConfig },
  });
  json(res, 200, { model });
});

/** 預設路由的順序就是主力→備援（規畫書 7）。 */
adminRouter.get('/api/models/route', async (req, res, ctx) => {
  sessions.requireAdmin(req);
  json(res, 200, { defaultRoute: ctx.config.models?.defaultRoute ?? [] });
});

adminRouter.put('/api/models/route', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  const body = await readJsonBody(req, 16384);
  const order = models.setDefaultRoute(body.defaultRoute ?? [], {
    ...ctxOf(req, ctx.config, s),
    configModule: { loadConfig, saveConfig },
  });
  json(res, 200, { defaultRoute: order });
});

adminRouter.post('/api/models/healthcheck', async (req, res, ctx) => {
  sessions.requireAdmin(req);
  json(res, 200, { results: await models.checkAllModels(ctx.config) });
});

/**
 * 探索端點上有哪些模型。給「新增模型」用 ——
 * 管理員填端點就能勾選，不必自己查模型名稱或手寫設定檔。
 */
adminRouter.post('/api/models/discover', async (req, res) => {
  sessions.requireAdmin(req);
  const body = await readJsonBody(req, 8192);
  const apiKey = body.apiKeyEnv ? process.env[body.apiKeyEnv] : null;
  json(res, 200, {
    endpoint: body.endpoint,
    models: await models.discoverModels(body.endpoint, { apiKey }),
  });
});

/** 常見本地推理服務的端點，讓管理員直接點選而不用背網址。 */
adminRouter.get('/api/models/presets', async (req, res) => {
  sessions.requireAdmin(req);
  json(res, 200, {
    presets: [
      { name: 'Ollama', endpoint: 'http://localhost:11434/v1', hint: '預設埠 11434' },
      { name: 'LM Studio', endpoint: 'http://localhost:1234/v1', hint: '預設埠 1234' },
      { name: 'llama.cpp server', endpoint: 'http://localhost:8080/v1', hint: '預設埠 8080' },
      { name: 'vLLM', endpoint: 'http://localhost:8000/v1', hint: '預設埠 8000' },
    ],
  });
});

adminRouter.post('/api/models', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  const body = await readJsonBody(req, 65536);
  const model = models.addModel(body, {
    ...ctxOf(req, ctx.config, s),
    configModule: { loadConfig, saveConfig },
  });
  json(res, 201, { model });
});

adminRouter.delete('/api/models/:id', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  models.removeModel(ctx.params.id, {
    ...ctxOf(req, ctx.config, s),
    configModule: { loadConfig, saveConfig },
  });
  json(res, 200, { ok: true });
});

adminRouter.put('/api/users/:id/route', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  const body = await readJsonBody(req, 8192);
  json(res, 200, { route: routes.setUserRoute(Number(ctx.params.id), body.route ?? [], ctxOf(req, ctx.config, s)) });
});

adminRouter.delete('/api/users/:id/route', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  routes.clearUserRoute(Number(ctx.params.id), ctxOf(req, ctx.config, s));
  json(res, 200, { ok: true });
});

// ---------------- 紀錄 ----------------

adminRouter.get('/api/logs/requests', async (req, res, ctx) => {
  sessions.requireAdmin(req);
  const limit = Math.min(500, Number(ctx.query.get('limit') || 100));
  const userId = ctx.query.get('userId');
  json(res, 200, {
    logs: all(
      `SELECT r.*, u.username FROM request_logs r LEFT JOIN users u ON u.id = r.user_id
       ${userId ? 'WHERE r.user_id = ?' : ''} ORDER BY r.id DESC LIMIT ?`,
      userId ? [Number(userId), limit] : [limit],
    ),
  });
});

adminRouter.get('/api/logs/usage', async (req, res, ctx) => {
  sessions.requireAdmin(req);
  const days = Math.min(90, Number(ctx.query.get('days') || 14));
  json(res, 200, {
    byUser: all(`
      SELECT u.id, u.username, u.display_name,
             COALESCE(SUM(g.input_tokens),0) AS input_tokens,
             COALESCE(SUM(g.output_tokens),0) AS output_tokens,
             COALESCE(SUM(g.total_tokens),0) AS total_tokens,
             COUNT(g.id) AS calls
      FROM users u LEFT JOIN usage_logs g
        ON g.user_id = u.id AND g.ts >= datetime('now', ?)
      GROUP BY u.id ORDER BY total_tokens DESC`, [`-${days} days`]),
    byDay: all(`
      SELECT date(ts,'localtime') AS day,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(total_tokens) AS total_tokens
      FROM usage_logs WHERE ts >= datetime('now', ?)
      GROUP BY day ORDER BY day ASC`, [`-${days} days`]),
    byModel: all(`
      SELECT COALESCE(model_id,'(未知)') AS model_id, SUM(total_tokens) AS total_tokens, COUNT(*) AS calls
      FROM usage_logs WHERE ts >= datetime('now', ?)
      GROUP BY model_id ORDER BY total_tokens DESC`, [`-${days} days`]),
  });
});

adminRouter.get('/api/logs/audit', async (req, res, ctx) => {
  sessions.requireAdmin(req);
  const limit = Math.min(500, Number(ctx.query.get('limit') || 100));
  json(res, 200, {
    logs: all(`SELECT a.*, u.username FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
               ORDER BY a.id DESC LIMIT ?`, [limit]),
  });
});

// ---------------- 設定 / 佇列 / 備份 ----------------

adminRouter.get('/api/settings', async (req, res, ctx) => {
  sessions.requireAdmin(req);
  const c = ctx.config;
  json(res, 200, {
    server: { host: c.server.host, port: c.server.port, openBrowserOnStart: c.server.openBrowserOnStart },
    limits: c.limits,
    queue: c.queue,
    models: { healthCheckIntervalMs: c.models.healthCheckIntervalMs, defaultRoute: c.models.defaultRoute, publicAliases: c.models.publicAliases },
    logging: c.logging,
    backup: c.backup,
    notice: 'API Key、密碼與外部憑證不會出現在此端點，也不會寫入設定檔。',
  });
});

adminRouter.patch('/api/settings', async (req, res) => {
  sessions.requireAdmin(req);
  const body = await readJsonBody(req, 131072);
  // 白名單：避免透過此端點竄改 admin 帳密或祕鑰
  const allowed = {};
  for (const k of ['limits', 'queue', 'logging', 'backup']) if (body[k]) allowed[k] = body[k];
  if (body.models) {
    allowed.models = {};
    for (const k of ['healthCheckIntervalMs', 'defaultRoute', 'publicAliases', 'queueTooLongThreshold', 'unhealthyAfterFailures']) {
      if (body.models[k] !== undefined) allowed.models[k] = body.models[k];
    }
  }
  const next = saveConfig(allowed);
  if (allowed.queue) queue.configure(next.queue);
  json(res, 200, { ok: true });
});

adminRouter.get('/api/queue', async (req, res) => {
  sessions.requireAdmin(req);
  json(res, 200, queue.snapshot());
});

adminRouter.get('/api/backups', async (req, res) => {
  sessions.requireAdmin(req);
  json(res, 200, { backups: listBackups() });
});

adminRouter.post('/api/backups', async (req, res, ctx) => {
  const s = sessions.requireAdmin(req);
  json(res, 201, { backup: createBackup(ctx.config, { actorId: s.user.id, reason: 'manual' }) });
});

/** 設定匯出：僅結構與政策，永不含祕密。 */
adminRouter.get('/api/settings/export', async (req, res, ctx) => {
  sessions.requireAdmin(req);
  const c = loadConfig();
  const safe = JSON.parse(JSON.stringify(c));
  delete safe.admin;
  delete safe.security;
  json(res, 200, safe, {
    'Content-Disposition': `attachment; filename="agibar-settings-${new Date().toISOString().slice(0, 10)}.json"`,
  });
});

adminRouter.get('/api/health', async (req, res) => {
  json(res, 200, {
    ok: true,
    version: getSetting('version', '1.2.0'),
    uptimeSec: Math.round(process.uptime()),
    queue: queue.snapshot(),
  });
});

export { setSetting };
