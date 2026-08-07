/**
 * Anthropic Messages API 相容端點（規畫書 10，Claude Code 串接）。
 *
 * Base URL: http://<AI主機IP>:8787
 *   —— 注意「不含 /v1」。Anthropic SDK 會自己補上 /v1/messages，
 *      若把 /v1 寫進 ANTHROPIC_BASE_URL 會變成 /v1/v1/messages。
 *      為了少一個踩雷點，這裡兩種路徑都收。
 *
 * 走的是與 OpenAI 端點完全相同的 gateway.admit() 管線：
 * 驗證 → 時間權限 → 配額 → 佇列 → 路由 → Failover → 用量與紀錄。
 * 轉譯只發生在管線的兩端，不影響任何配額歸屬。
 */
import {
  Router, HttpError, json, anthropicError, readJsonBody, bearerToken, clientIp,
  sseStart, sseEvent,
} from '../core/http.mjs';
import { log } from '../core/logger.mjs';
import { authenticateApiKey } from '../services/apikeys.mjs';
import { getModel, listModels } from '../services/models.mjs';
import { resolveRouteChain } from '../services/routes.mjs';
import * as quota from '../services/quota.mjs';
import * as gw from '../services/gateway.mjs';
import {
  requestToOpenAI, responseToAnthropic, messagesToOpenAI, systemToText,
  AnthropicStreamTranslator, newMessageId,
} from '../services/anthropic-compat.mjs';

export const anthropicRouter = new Router();

/** Anthropic 客戶端習慣送 x-api-key；bearerToken() 兩種都吃。 */
function requireApiKey(req) {
  const token = bearerToken(req);
  if (!token) {
    throw new HttpError(401, 'missing_api_key', '缺少 API Key，請以 x-api-key 或 Authorization: Bearer 提供');
  }
  const auth = authenticateApiKey(token);
  if (!auth) throw new HttpError(401, 'invalid_api_key', 'API Key 無效');
  return auth;
}

/** 同時註冊正確路徑與「多打一層 /v1」的常見誤設。 */
function addBoth(method, path, handler) {
  anthropicRouter.add(method, path, handler);
  anthropicRouter.add(method, path.replace(/^\/v1/, '/v1/v1'), handler);
}

// ------------------------------------------------- POST /v1/messages

addBoth('POST', '/v1/messages', async (req, res, ctx) => {
  const auth = requireApiKey(req);
  const body = await readJsonBody(req, ctx.config.server.maxBodyBytes);

  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new HttpError(400, 'invalid_request', 'messages 為必填且不可為空');
  }
  if (body.max_tokens == null) {
    throw new HttpError(400, 'invalid_request', 'max_tokens 為必填（Anthropic Messages API 規範）');
  }

  const wantStream = !!body.stream;
  const controller = new AbortController();
  req.on('close', () => { if (!res.writableEnded) controller.abort(); });

  // 轉成 OpenAI 格式後才進管線 —— 配額估算與路由都以轉換後的內容為準
  const openaiBody = requestToOpenAI(body);

  const admission = await gw.admit({ auth, config: ctx.config, body: openaiBody, signal: controller.signal });
  const messageId = newMessageId();
  const startedAt = Date.now();

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
      body: openaiBody,
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

      gw.finishUpstream(served.id, { ok: true, firstTokenMs, outputTokens, durationMs: Date.now() - startedAt });

      // 對外回報客戶端送來的模型名稱，不揭露後端真實模型
      json(res, 200, responseToAnthropic(data, { model: body.model || served.id, messageId }));
    } else {
      const result = await pipeAnthropicSse(upstream.response, res, {
        model: body.model || served.id,
        messageId,
        inputTokens,
      });
      firstTokenMs = result.firstTokenMs;
      outputTokens = result.outputTokens;
      if (result.inputTokens) inputTokens = result.inputTokens;

      gw.finishUpstream(served.id, { ok: true, firstTokenMs, outputTokens, durationMs: Date.now() - startedAt });
    }
  } catch (err) {
    statusCode = err.status || 500;
    errorCode = err.code || 'internal_error';
    errorMessage = err.message || String(err);
    if (served) gw.finishUpstream(served.id, { ok: false });

    if (!res.headersSent) {
      anthropicError(res, statusCode, anthropicTypeFor(statusCode), errorMessage);
    } else if (!res.writableEnded) {
      // 已經開始串流，只能用 error 事件通知
      sseEvent(res, 'error', { type: 'error', error: { type: anthropicTypeFor(statusCode), message: errorMessage } });
      res.end();
    }
    log.warn('Anthropic 請求失敗', { requestId: admission.requestId, code: errorCode, message: errorMessage });
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

function anthropicTypeFor(status) {
  // 與 anthropic-compat.anthropicErrorType 同一份對應，這裡就地展開避免多一次 import
  const map = {
    400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
    404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error',
    500: 'api_error', 502: 'api_error', 503: 'overloaded_error', 504: 'overloaded_error',
  };
  return map[status] ?? (status >= 500 ? 'api_error' : 'invalid_request_error');
}

/** 逐 chunk 把上游的 OpenAI SSE 翻成 Anthropic 事件序列。 */
async function pipeAnthropicSse(upstreamRes, res, { model, messageId, inputTokens }) {
  sseStart(res);

  const translator = new AnthropicStreamTranslator({
    model,
    messageId,
    inputTokens,
    emit: (event, data) => { if (!res.writableEnded) sseEvent(res, event, data); },
  });
  translator.start(inputTokens);

  const decoder = new TextDecoder();
  let buffer = '';
  let firstTokenMs = 0;
  let reportedInput = 0;
  const t0 = Date.now();

  for await (const chunk of upstreamRes.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }

      if (!firstTokenMs && obj?.choices?.[0]?.delta?.content) firstTokenMs = Date.now() - t0;
      if (obj?.usage?.prompt_tokens) reportedInput = obj.usage.prompt_tokens;

      translator.push(obj);
    }
  }

  const outputTokens = translator.usage?.completion_tokens ?? quota.estimateTokens(translator.text);
  translator.finish({ outputTokens });
  if (!res.writableEnded) res.end();

  return {
    firstTokenMs: firstTokenMs || (Date.now() - t0),
    outputTokens,
    inputTokens: reportedInput,
  };
}

// ------------------------------------- POST /v1/messages/count_tokens

addBoth('POST', '/v1/messages/count_tokens', async (req, res, ctx) => {
  const auth = requireApiKey(req);
  const body = await readJsonBody(req, ctx.config.server.maxBodyBytes);

  const converted = messagesToOpenAI(body.messages ?? [], body.system);
  let tokens = quota.estimateMessagesTokens(converted);

  // 工具定義也會進上下文，一併計入才不會低估
  for (const t of body.tools ?? []) {
    tokens += quota.estimateTokens(JSON.stringify(t));
  }

  json(res, 200, { input_tokens: tokens });
  log.debug('count_tokens', { user: auth.user.username, tokens });
});

// ------------------------------------------------------ 模型清單

/**
 * Anthropic 格式的模型清單。
 * 只有帶 anthropic-version 標頭的請求才會走到這裡（見 index.mjs 的分派），
 * 一般 OpenAI 客戶端仍拿到 OpenAI 格式。
 */
export function anthropicModelList(auth, config) {
  const aliases = Object.keys(config.models?.publicAliases ?? {});
  const data = aliases.map((id) => ({
    type: 'model',
    id,
    display_name: config.models.publicAliases[id],
    created_at: new Date(0).toISOString(),
  }));

  if (auth.user.role === 'admin') {
    for (const m of listModels({ onlyEnabled: true })) {
      data.push({ type: 'model', id: m.id, display_name: m.display_name, created_at: new Date(0).toISOString() });
    }
  } else {
    for (const id of resolveRouteChain(auth.user.id, config)) {
      const m = getModel(id);
      if (m) data.push({ type: 'model', id, display_name: m.display_name, created_at: new Date(0).toISOString() });
    }
  }

  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  };
}

anthropicRouter.get('/v1/v1/models', async (req, res, ctx) => {
  const auth = requireApiKey(req);
  json(res, 200, anthropicModelList(auth, ctx.config));
});

export { requireApiKey };
