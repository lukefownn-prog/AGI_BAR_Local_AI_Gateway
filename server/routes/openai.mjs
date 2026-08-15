/**
 * OpenAI-compatible API（規畫書 10）。
 * Base URL: http://<AI主機IP>:8787/v1
 * 讓 Cursor / Claude Code / Codex / 自製 App 共用同一個入口，各自使用自己的 API Key。
 */
import {
  Router, HttpError, json, openaiError, readJsonBody, bearerToken, clientIp,
  sseStart, sseSend, sseDone,
} from '../core/http.mjs';
import { log } from '../core/logger.mjs';
import { authenticateApiKey } from '../services/apikeys.mjs';
import { getModel, listModels } from '../services/models.mjs';
import { resolveRouteChain } from '../services/routes.mjs';
import * as quota from '../services/quota.mjs';
import * as gw from '../services/gateway.mjs';

export const openaiRouter = new Router();

/** Bearer 驗證；失敗以 OpenAI 錯誤格式回應，讓客戶端能正確顯示。 */
function requireApiKey(req) {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, 'missing_api_key', '缺少 API Key，請於 Authorization: Bearer 提供');
  const auth = authenticateApiKey(token);
  if (!auth) throw new HttpError(401, 'invalid_api_key', 'API Key 無效');
  return auth;
}

// ---------------- GET /v1/models ----------------

openaiRouter.get('/v1/models', async (req, res, ctx) => {
  const auth = requireApiKey(req);
  const chain = resolveRouteChain(auth.user.id, ctx.config);
  const aliases = ctx.config.models?.publicAliases ?? {};

  // 對一般人員只揭露別名，不洩漏後端實際模型名稱（規畫書 7）
  const data = [];
  for (const alias of Object.keys(aliases)) {
    data.push({ id: alias, object: 'model', created: 0, owned_by: 'agi-bar' });
  }
  if (auth.user.role === 'admin') {
    for (const m of listModels({ onlyEnabled: true })) {
      data.push({ id: m.id, object: 'model', created: 0, owned_by: m.is_local ? 'local' : 'external' });
    }
  } else {
    for (const id of chain) {
      const m = getModel(id);
      if (m) data.push({ id, object: 'model', created: 0, owned_by: 'agi-bar' });
    }
  }
  json(res, 200, { object: 'list', data });
});

openaiRouter.get('/v1/models/:id', async (req, res, ctx) => {
  requireApiKey(req);
  const id = ctx.params.id;
  const aliases = ctx.config.models?.publicAliases ?? {};
  if (aliases[id] || getModel(id)) {
    return json(res, 200, { id, object: 'model', created: 0, owned_by: 'agi-bar' });
  }
  throw new HttpError(404, 'model_not_found', `找不到模型：${id}`);
});

// ---------------- POST /v1/chat/completions ----------------

openaiRouter.post('/v1/chat/completions', async (req, res, ctx) => {
  const auth = requireApiKey(req);
  const body = await readJsonBody(req, ctx.config.server.maxBodyBytes);

  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new HttpError(400, 'invalid_request', 'messages 為必填且不可為空');
  }

  const wantStream = !!body.stream;
  const controller = new AbortController();
  req.on('close', () => { if (!res.writableEnded) controller.abort(); });

  const admission = await gw.admit({ auth, config: ctx.config, body, signal: controller.signal });
  const startedAt = Date.now();
  // 讓客戶端能與 request_logs 對帳（壓力測試與客訴追查都需要）
  res.setHeader('X-Request-Id', admission.requestId);
  let served = null;
  let statusCode = 200;
  let errorCode = '';
  let errorMessage = '';
  let inputTokens = admission.estimatedInput;
  let outputTokens = 0;
  let firstTokenMs = 0;

  try {
    const upstream = await gw.callWithFailover({
      chain: admission.chain,
      body,
      stream: wantStream,
      config: ctx.config,
      signal: controller.signal,
    });
    served = upstream.modelRow;

    if (!wantStream) {
      const data = await upstream.response.json();
      firstTokenMs = upstream.firstTokenMs;
      inputTokens = data?.usage?.prompt_tokens ?? inputTokens;
      outputTokens = data?.usage?.completion_tokens
        ?? quota.estimateTokens(data?.choices?.[0]?.message?.content ?? '');
      gw.finishUpstream(served.id, {
        ok: true, firstTokenMs, outputTokens, durationMs: Date.now() - startedAt,
      });
      // 對外一律回報別名/路由 ID，不揭露後端真實模型名稱
      json(res, 200, { ...data, model: body.model || served.id });
    } else {
      firstTokenMs = await pipeSse(upstream.response, res, {
        onOutputTokens: (n) => { outputTokens = n; },
        modelLabel: body.model || served.id,
      });
      gw.finishUpstream(served.id, {
        ok: true, firstTokenMs, outputTokens, durationMs: Date.now() - startedAt,
      });
    }
  } catch (err) {
    statusCode = err.status || 500;
    errorCode = err.code || 'internal_error';
    errorMessage = err.message || String(err);
    if (served) gw.finishUpstream(served.id, { ok: false });
    if (!res.headersSent) {
      openaiError(res, statusCode, errorCode, errorMessage,
        statusCode === 429 ? 'rate_limit_error' : 'api_error');
    } else if (!res.writableEnded) {
      sseSend(res, { error: { message: errorMessage, code: errorCode } });
      res.end();
    }
    log.warn('請求失敗', { requestId: admission.requestId, code: errorCode, message: errorMessage });
  } finally {
    admission.release();
    quota.recordUsage({
      userId: auth.user.id,
      keyId: auth.key.id,
      modelId: served?.id ?? null,
      inputTokens,
      outputTokens,
      requestId: admission.requestId,
    });
    gw.logRequest({
      requestId: admission.requestId,
      userId: auth.user.id,
      keyId: auth.key.id,
      route: admission.chain.join('>'),
      requestedModel: body.model || '',
      servedModel: served?.id || '',
      failoverFrom: admission.chain[0] !== served?.id ? admission.chain[0] : '',
      priority: auth.limits.priority,
      queueWaitMs: admission.queueWaitMs,
      inferenceMs: Date.now() - startedAt,
      firstTokenMs,
      statusCode,
      errorCode,
      errorMessage,
      usedInternet: false,
      promptHash: admission.promptHash,
      clientIp: clientIp(req, ctx.config.server.trustProxy),
      userAgent: req.headers['user-agent'] || '',
    });
  }
});

/** 轉送上游 SSE，同時累計輸出 Token 並改寫 model 欄位。 */
async function pipeSse(upstreamRes, res, { onOutputTokens, modelLabel }) {
  sseStart(res);
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let firstTokenMs = 0;
  const t0 = Date.now();
  let reportedUsage = null;

  for await (const chunk of upstreamRes.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta?.content;
        if (delta) {
          if (!firstTokenMs) firstTokenMs = Date.now() - t0;
          text += delta;
        }
        if (obj?.usage) reportedUsage = obj.usage;
        obj.model = modelLabel;
        sseSend(res, obj);
      } catch {
        sseSend(res, payload); // 無法解析就原樣轉送，維持相容性
      }
    }
  }

  onOutputTokens?.(reportedUsage?.completion_tokens ?? quota.estimateTokens(text));
  if (!res.writableEnded) sseDone(res);
  return firstTokenMs || (Date.now() - t0);
}

// ---------------- /v1/completions（舊版相容）----------------

openaiRouter.post('/v1/completions', async (req, res, ctx) => {
  const auth = requireApiKey(req);
  const body = await readJsonBody(req, ctx.config.server.maxBodyBytes);
  if (typeof body.prompt !== 'string') {
    throw new HttpError(400, 'invalid_request', 'prompt 為必填字串');
  }
  // 轉為 chat 格式後複用同一條管線
  req.headers['x-agibar-internal'] = '1';
  const chatBody = { ...body, messages: [{ role: 'user', content: body.prompt }] };
  delete chatBody.prompt;

  const controller = new AbortController();
  req.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const admission = await gw.admit({ auth, config: ctx.config, body: chatBody, signal: controller.signal });
  try {
    const upstream = await gw.callWithFailover({
      chain: admission.chain, body: chatBody, stream: false, config: ctx.config, signal: controller.signal,
    });
    const data = await upstream.response.json();
    gw.finishUpstream(upstream.modelRow.id, { ok: true });
    quota.recordUsage({
      userId: auth.user.id, keyId: auth.key.id, modelId: upstream.modelRow.id,
      inputTokens: data?.usage?.prompt_tokens ?? admission.estimatedInput,
      outputTokens: data?.usage?.completion_tokens ?? 0,
      requestId: admission.requestId,
    });
    json(res, 200, {
      id: admission.requestId,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || upstream.modelRow.id,
      choices: [{
        text: data?.choices?.[0]?.message?.content ?? '',
        index: 0,
        finish_reason: data?.choices?.[0]?.finish_reason ?? 'stop',
      }],
      usage: data?.usage ?? {},
    });
  } finally {
    admission.release();
  }
});

// ---------------- 自我檢視 ----------------

/** 讓使用者查自己的額度剩餘，串接工具可用來顯示狀態。 */
openaiRouter.get('/v1/me', async (req, res) => {
  const auth = requireApiKey(req);
  const usage = quota.usageSnapshot(auth.key.id);
  json(res, 200, {
    user: { username: auth.user.username, role: auth.user.role, status: auth.user.status },
    key: { prefix: auth.key.key_prefix, status: auth.key.status, name: auth.key.name },
    limits: auth.limits,
    usage: {
      hour: usage.hour, day: usage.day, month: usage.month,
      remainingDay: Math.max(0, (auth.limits.tokensPerDay || 0) - usage.day),
      remainingMonth: Math.max(0, (auth.limits.tokensPerMonth || 0) - usage.month),
    },
    concurrency: { current: quota.currentConcurrency(auth.key.id), max: auth.limits.concurrent },
  });
});
