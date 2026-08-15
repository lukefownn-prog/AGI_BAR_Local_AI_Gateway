/**
 * Gateway 核心流程（規畫書 2）：
 *   API 驗證 → 時間權限 → Token Quota → Priority Queue → Model Router → 本地模型池
 */
import { randomUUID } from 'node:crypto';
import { run } from '../core/db.mjs';
import { resolveModelApiKey } from '../core/config.mjs';
import { HttpError } from '../core/http.mjs';
import { log } from '../core/logger.mjs';
import { shortHash } from '../core/crypto.mjs';
import { getModel, isUsable, recordModelStats, adjustQueueDepth } from './models.mjs';
import { resolveRouteChain, smallestModelIn } from './routes.mjs';
import { queue } from './queue.mjs';
import * as quota from './quota.mjs';
import { markKeyUsed } from './apikeys.mjs';

export function newRequestId() {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** 把 Gateway 對外的模型別名解析成該人員的路由鏈。 */
export function buildChain(auth, config, requestedModel) {
  let chain = resolveRouteChain(auth.user.id, config);

  // 允許管理員/進階使用者直接指定後端模型 ID；否則一律走管理員設定的路由
  if (requestedModel && getModel(requestedModel)) {
    if (chain.includes(requestedModel)) {
      chain = [requestedModel, ...chain.filter((id) => id !== requestedModel)];
    } else if (auth.user.role === 'admin') {
      chain = [requestedModel, ...chain];
    }
  }
  if (!chain.length) {
    throw new HttpError(503, 'no_model_available', '管理員尚未為此人員設定任何可用模型');
  }
  return chain;
}

function upstreamHeaders(modelRow, config) {
  const def = (config.models?.catalog ?? []).find((c) => c.id === modelRow.id);
  const apiKey = resolveModelApiKey(def);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** 外部雲端模型需管理員明確啟用，避免未授權把內部 Prompt 送出（規畫書 10）。 */
function assertExternalAllowed(modelRow, config) {
  if (modelRow.is_local) return;
  const def = (config.models?.catalog ?? []).find((c) => c.id === modelRow.id);
  if (def?.requiresExplicitConsent && def.enabled !== true) {
    throw new HttpError(403, 'external_model_not_authorized',
      `外部模型 ${modelRow.id} 未經管理員授權，拒絕將內容送往外部服務`);
  }
}

/**
 * 依路由鏈嘗試呼叫上游，失敗自動切換下一順位（規畫書 7）。
 * @returns {{ response: Response, modelRow: object, attempts: string[], firstTokenMs: number }}
 */
export async function callWithFailover({ chain, body, stream, config, signal }) {
  const attempts = [];
  let lastError = null;

  for (const modelId of chain) {
    const modelRow = getModel(modelId);
    if (!modelRow) { attempts.push(`${modelId}:missing`); continue; }

    const usable = isUsable(modelRow, config);
    if (!usable.ok) { attempts.push(`${modelId}:${usable.reason}`); continue; }

    try {
      assertExternalAllowed(modelRow, config);
    } catch (err) {
      attempts.push(`${modelId}:not_authorized`);
      lastError = err;
      continue;
    }

    const url = `${String(modelRow.endpoint).replace(/\/+$/, '')}/chat/completions`;
    const payload = { ...body, model: modelRow.model_name || body.model, stream: !!stream };
    const started = Date.now();

    adjustQueueDepth(modelId, +1);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: upstreamHeaders(modelRow, config),
        body: JSON.stringify(payload),
        signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        adjustQueueDepth(modelId, -1);
        recordModelStats(modelId, { ok: false });
        attempts.push(`${modelId}:http_${res.status}`);
        lastError = new HttpError(502, 'upstream_error',
          `模型 ${modelRow.display_name || modelId} 回應 HTTP ${res.status}`, { detail: detail.slice(0, 300) });
        // 4xx 多半是請求本身有問題，換模型也不會好 —— 但 429/408 例外，值得換
        if (res.status >= 400 && res.status < 500 && ![408, 409, 425, 429].includes(res.status)) {
          throw lastError;
        }
        continue;
      }

      attempts.push(`${modelId}:ok`);
      return { response: res, modelRow, attempts, firstTokenMs: Date.now() - started };
    } catch (err) {
      adjustQueueDepth(modelId, -1);
      if (err instanceof HttpError && err.code === 'upstream_error') throw err;
      if (err?.name === 'AbortError') throw new HttpError(499, 'client_closed', '客戶端已中斷連線');
      recordModelStats(modelId, { ok: false });
      attempts.push(`${modelId}:${err?.cause?.code || err?.name || 'error'}`);
      lastError = err;
    }
  }

  log.warn('所有順位模型皆不可用', { attempts });
  if (lastError instanceof HttpError) throw lastError;
  throw new HttpError(503, 'all_models_unavailable',
    `路由中的模型全數不可用（${attempts.join(', ')}）`);
}

export function finishUpstream(modelId, { ok = true, firstTokenMs, outputTokens, durationMs } = {}) {
  adjustQueueDepth(modelId, -1);
  const tokensPerSec = outputTokens && durationMs ? (outputTokens / (durationMs / 1000)) : undefined;
  recordModelStats(modelId, { ok, firstTokenMs, tokensPerSec });
}

/** 寫入 request_logs（規畫書 12）。 */
export function logRequest(entry) {
  run(
    `INSERT INTO request_logs
       (request_id, user_id, api_key_id, route, requested_model, served_model, failover_from,
        priority, queue_wait_ms, inference_ms, first_token_ms, status_code, error_code,
        error_message, prompt_hash, client_ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.requestId, entry.userId ?? null, entry.keyId ?? null, entry.route ?? '',
      entry.requestedModel ?? '', entry.servedModel ?? '', entry.failoverFrom ?? '',
      entry.priority ?? 'normal', entry.queueWaitMs ?? 0, entry.inferenceMs ?? 0,
      entry.firstTokenMs ?? 0, entry.statusCode ?? 200, entry.errorCode ?? '',
      String(entry.errorMessage ?? '').slice(0, 500),
      entry.promptHash ?? '', entry.clientIp ?? '', String(entry.userAgent ?? '').slice(0, 200),
    ],
  );
}

/**
 * 完整前置流程：配額 → 佇列 → 路由鏈。
 * 回傳的 release() 一定要在 finally 呼叫。
 */
export async function admit({ auth, config, body, signal }) {
  const requestId = newRequestId();
  const messages = body?.messages ?? [];
  const estimatedInput = quota.estimateMessagesTokens(messages);

  const pre = quota.preflight({
    auth,
    estimatedInputTokens: estimatedInput,
    requestedMaxTokens: Number(body?.max_tokens || body?.max_completion_tokens || 0),
  });

  if (!quota.acquireSlot(auth.key.id, auth.limits.concurrent || 1)) {
    throw new HttpError(429, 'concurrency_limit',
      `已達同時請求上限 ${auth.limits.concurrent}，請等待前一個請求完成`);
  }

  let slot;
  try {
    slot = await queue.acquire({
      priority: auth.limits.priority || 'normal',
      signal,
      label: `${auth.user.username}#${requestId}`,
    });
  } catch (err) {
    quota.releaseSlot(auth.key.id);
    throw err;
  }

  let chain;
  try {
    chain = buildChain(auth, config, body?.model);
    // soft limit：超額但不拒絕，改走鏈上最小的模型（規畫書 6）
    if (pre.degrade) {
      const small = smallestModelIn(chain);
      if (small) {
        log.info('配額超額，降級至較小模型', { user: auth.user.username, model: small, reasons: pre.reasons });
        chain = [small];
      }
    }
  } catch (err) {
    slot.release();
    quota.releaseSlot(auth.key.id);
    throw err;
  }

  markKeyUsed(auth.key.id);

  return {
    requestId,
    chain,
    estimatedInput,
    degraded: pre.degrade,
    queueWaitMs: slot.waitMs,
    promptHash: config.logging?.logPromptHashOnly !== false
      ? shortHash(JSON.stringify(messages).slice(0, 4000)) : '',
    release: () => { slot.release(); quota.releaseSlot(auth.key.id); },
  };
}
