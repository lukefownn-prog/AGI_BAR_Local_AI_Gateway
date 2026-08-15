/**
 * 模型註冊與 Health Check（規畫書 7）。
 * 至少記錄 Online/Offline、平均首 Token 延遲、Token/s、Queue、錯誤率與 VRAM 狀態。
 */
import { all, get, run, audit } from '../core/db.mjs';
import { resolveModelApiKey } from '../core/config.mjs';
import { HttpError } from '../core/http.mjs';
import { log } from '../core/logger.mjs';

let healthTimer = null;

/** 以 config.models.catalog 為準同步進資料庫（設定檔是唯一來源，DB 保留觀測值）。 */
export function syncCatalog(config) {
  const catalog = config.models?.catalog ?? [];
  const ids = new Set();
  for (const m of catalog) {
    ids.add(m.id);
    run(
      `INSERT INTO models (id, display_name, provider, endpoint, model_name, is_local, enabled,
                           capabilities, context_window, vram_mb, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         provider = excluded.provider,
         endpoint = excluded.endpoint,
         model_name = excluded.model_name,
         is_local = excluded.is_local,
         enabled = excluded.enabled,
         capabilities = excluded.capabilities,
         context_window = excluded.context_window,
         vram_mb = excluded.vram_mb,
         updated_at = datetime('now')`,
      [m.id, m.displayName ?? m.id, m.provider ?? 'openai-compatible', m.endpoint ?? '',
       m.model ?? '', m.isLocal === false ? 0 : 1, m.enabled === false ? 0 : 1,
       JSON.stringify(m.capabilities ?? ['chat']), Number(m.contextWindow ?? 8192), Number(m.vramMb ?? 0)],
    );
  }
  // 設定檔已移除的模型：停用而非刪除，避免破壞既有 model_routes 與歷史紀錄
  for (const row of all('SELECT id FROM models')) {
    if (!ids.has(row.id)) run("UPDATE models SET enabled = 0, health_state = 'offline' WHERE id = ?", [row.id]);
  }
  log.info('模型清單已同步', { count: catalog.length });
}

export function listModels({ onlyEnabled = false } = {}) {
  return all(`SELECT * FROM models ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY is_local DESC, id ASC`);
}

export function getModel(id) {
  return get('SELECT * FROM models WHERE id = ?', [id]);
}

/**
 * 向一個 OpenAI 相容端點探索可用模型。
 *
 * 給管理台的「新增模型」用：管理員只要填端點（Ollama 是
 * http://localhost:11434/v1），就能把已安裝的模型列出來勾選，
 * 不必自己去查模型名稱、也不必手寫設定檔。
 */
export async function discoverModels(endpoint, { timeoutMs = 8000, apiKey = null } = {}) {
  let url;
  try {
    url = new URL(`${String(endpoint).replace(/\/+$/, '')}/models`);
  } catch {
    throw new HttpError(400, 'invalid_endpoint', '端點網址格式不正確');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(400, 'invalid_endpoint', '端點只支援 http 或 https');
  }

  let res;
  try {
    res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new HttpError(502, 'endpoint_unreachable',
      `無法連線到 ${url.origin}：${err?.cause?.code || err.message}。請確認該服務正在執行。`);
  }
  if (!res.ok) {
    throw new HttpError(502, 'endpoint_error', `端點回應 HTTP ${res.status}`);
  }

  let data;
  try { data = await res.json(); } catch {
    throw new HttpError(502, 'endpoint_error', '端點回應不是 JSON，可能不是 OpenAI 相容服務');
  }

  const list = Array.isArray(data?.data) ? data.data : [];
  if (!list.length) {
    throw new HttpError(404, 'no_models', '端點可連線，但沒有回報任何模型');
  }

  const existing = new Set(listModels().map((m) => m.model_name));
  return list
    .filter((m) => typeof m?.id === 'string')
    .map((m) => ({ model: m.id, suggestedId: slugifyModelId(m.id), alreadyAdded: existing.has(m.id) }));
}

/** hf.co/Qwen/Qwen3-8B-GGUF:Q5_0 → hf-co-qwen-qwen3-8b-gguf-q5-0 */
export function slugifyModelId(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'model';
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * 新增模型到設定檔並立即生效。
 *
 * 設定檔仍是唯一來源（syncCatalog 的前提），所以這裡是寫回 config.json
 * 再重新同步，而不是直接塞資料庫 —— 否則下次重啟就會被設定檔覆蓋掉。
 */
export function addModel(input, ctx = {}) {
  const { loadConfig, saveConfig } = ctx.configModule;
  const config = loadConfig();

  const id = String(input.id || '').trim().toLowerCase();
  if (!ID_PATTERN.test(id)) {
    throw new HttpError(400, 'invalid_id', '模型代號需為英數字、點、底線或連字號開頭的 1-64 字元');
  }
  if ((config.models?.catalog ?? []).some((m) => m.id === id)) {
    throw new HttpError(409, 'id_taken', `模型代號 ${id} 已存在`);
  }
  if (!String(input.endpoint || '').trim()) {
    throw new HttpError(400, 'missing_endpoint', '請填寫端點網址');
  }
  if (!String(input.model || '').trim()) {
    throw new HttpError(400, 'missing_model', '請填寫上游模型名稱');
  }

  const entry = {
    id,
    displayName: String(input.displayName || id).trim(),
    provider: 'openai-compatible',
    endpoint: String(input.endpoint).trim().replace(/\/+$/, ''),
    model: String(input.model).trim(),
    apiKeyEnv: String(input.apiKeyEnv || '').trim(),
    enabled: input.enabled !== false,
    isLocal: input.isLocal !== false,
    capabilities: ['chat', 'stream'],
    contextWindow: Number(input.contextWindow) || 8192,
    vramMb: Number(input.vramMb) || 0,
  };

  const catalog = [...(config.models?.catalog ?? []), entry];
  const patch = { models: { catalog } };

  // 不加進預設路由的話，模型雖然存在卻不會被任何請求選到 ——
  // 管理員多半會困惑「加了為什麼沒用」。預設加在最後一順位。
  if (input.addToDefaultRoute !== false && entry.enabled) {
    const route = [...(config.models?.defaultRoute ?? [])];
    if (!route.includes(id)) route.push(id);
    patch.models.defaultRoute = route;
  }

  saveConfig(patch);
  syncCatalog(loadConfig());
  audit(ctx.actorId, 'model.add', `model:${id}`, { endpoint: entry.endpoint, model: entry.model }, ctx.clientIp);
  log.info('新增模型', { id, endpoint: entry.endpoint, model: entry.model });
  return getModel(id);
}

/** 從設定檔移除模型。歷史紀錄照留，只是不再出現在清單與路由中。 */
export function removeModel(id, ctx = {}) {
  const { loadConfig, saveConfig } = ctx.configModule;
  const config = loadConfig();

  const catalog = (config.models?.catalog ?? []).filter((m) => m.id !== id);
  if (catalog.length === (config.models?.catalog ?? []).length) {
    throw new HttpError(404, 'model_not_found', '設定檔中找不到這個模型');
  }

  saveConfig({
    models: {
      catalog,
      defaultRoute: (config.models?.defaultRoute ?? []).filter((r) => r !== id),
    },
  });
  syncCatalog(loadConfig());
  run('DELETE FROM model_routes WHERE model_id = ?', [id]);
  run('DELETE FROM models WHERE id = ?', [id]);

  audit(ctx.actorId, 'model.remove', `model:${id}`, '', ctx.clientIp);
  log.warn('移除模型', { id });
  return true;
}

export function setModelEnabled(id, enabled, ctx = {}) {
  const m = getModel(id);
  if (!m) throw new HttpError(404, 'model_not_found', '找不到模型');

  // 一定要寫回設定檔。只改資料庫的話，下次啟動 syncCatalog 會用設定檔的
  // enabled 覆蓋回去 —— 管理員會發現「我明明啟用了，重開就不見」。
  if (ctx.configModule) {
    const { loadConfig, saveConfig } = ctx.configModule;
    const config = loadConfig();
    const catalog = (config.models?.catalog ?? []).map(
      (x) => (x.id === id ? { ...x, enabled: !!enabled } : x),
    );
    const patch = { models: { catalog } };

    // 停用的模型留在預設路由裡只會讓每次請求多試一次再失敗
    if (!enabled) {
      patch.models.defaultRoute = (config.models?.defaultRoute ?? []).filter((r) => r !== id);
    } else if (!(config.models?.defaultRoute ?? []).includes(id)) {
      patch.models.defaultRoute = [...(config.models?.defaultRoute ?? []), id];
    }
    saveConfig(patch);
  }

  run("UPDATE models SET enabled = ?, updated_at = datetime('now') WHERE id = ?", [enabled ? 1 : 0, id]);
  audit(ctx.actorId, 'model.enabled', `model:${id}`, String(!!enabled), ctx.clientIp);
  log.info('模型啟用狀態變更', { id, enabled: !!enabled });
  return getModel(id);
}

/** 調整預設路由的順序。順位 1 就是主力模型，其餘依序為備援。 */
export function setDefaultRoute(order, ctx = {}) {
  const { loadConfig, saveConfig } = ctx.configModule;
  if (!Array.isArray(order)) throw new HttpError(400, 'invalid_route', '路由需為模型代號陣列');
  if (new Set(order).size !== order.length) {
    throw new HttpError(400, 'duplicate_model', '同一模型不可重複出現在路由中');
  }
  for (const id of order) {
    const m = getModel(id);
    if (!m) throw new HttpError(400, 'model_not_found', `模型不存在：${id}`);
    if (!m.enabled) throw new HttpError(400, 'model_disabled', `模型已停用，不能加入路由：${id}`);
  }

  saveConfig({ models: { defaultRoute: order } });
  audit(ctx.actorId, 'route.default', 'default', order.join('>'), ctx.clientIp);
  log.info('預設路由已更新', { order });
  return order;
}

export function recordModelStats(id, { firstTokenMs, tokensPerSec, ok = true, vramUsedMb }) {
  const m = getModel(id);
  if (!m) return;
  const alpha = 0.3; // 指數移動平均，讓儀表板反映近期狀況
  const avgFt = firstTokenMs != null
    ? (m.avg_first_token_ms ? m.avg_first_token_ms * (1 - alpha) + firstTokenMs * alpha : firstTokenMs)
    : m.avg_first_token_ms;
  const avgTps = tokensPerSec != null
    ? (m.avg_tokens_per_sec ? m.avg_tokens_per_sec * (1 - alpha) + tokensPerSec * alpha : tokensPerSec)
    : m.avg_tokens_per_sec;
  const errorRate = m.error_rate * (1 - alpha) + (ok ? 0 : 1) * alpha;
  run(
    `UPDATE models SET avg_first_token_ms = ?, avg_tokens_per_sec = ?, error_rate = ?,
       vram_used_mb = COALESCE(?, vram_used_mb), updated_at = datetime('now') WHERE id = ?`,
    [avgFt, avgTps, errorRate, vramUsedMb ?? null, id],
  );
}

export function adjustQueueDepth(id, delta) {
  run('UPDATE models SET queue_depth = MAX(0, queue_depth + ?) WHERE id = ?', [delta, id]);
}

function markHealth(id, state, errorMessage = '') {
  const m = getModel(id);
  if (!m) return;
  const fails = state === 'online' ? 0 : m.consecutive_fails + 1;
  run(
    `UPDATE models SET health_state = ?, consecutive_fails = ?, last_check_at = datetime('now'),
       last_error = ?, updated_at = datetime('now') WHERE id = ?`,
    [state, fails, errorMessage.slice(0, 500), id],
  );
  if (m.health_state !== state) {
    log[state === 'online' ? 'info' : 'warn']('模型健康狀態變更', { id, from: m.health_state, to: state, errorMessage });
  }
}

/** 對單一模型做一次健康檢查（呼叫其 /models 端點）。 */
export async function checkModel(modelRow, config) {
  const timeout = config.models?.healthCheckTimeoutMs ?? 5000;
  const def = (config.models?.catalog ?? []).find((c) => c.id === modelRow.id);
  const apiKey = resolveModelApiKey(def);
  const url = `${String(modelRow.endpoint).replace(/\/+$/, '')}/models`;
  const started = Date.now();

  // 少了金鑰只會拿到一個沒頭沒尾的 HTTP 401，管理員很難看出要去設環境變數。
  // 先明確判斷，把原因直接寫進狀態裡。
  if (def?.apiKeyEnv && !apiKey) {
    markHealth(modelRow.id, 'offline', `缺少環境變數 ${def.apiKeyEnv}，未提供 API 金鑰`);
    return { id: modelRow.id, state: 'offline', latencyMs: 0, reason: 'missing_api_key' };
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      markHealth(modelRow.id, 'offline', `HTTP ${res.status}`);
      return { id: modelRow.id, state: 'offline', latencyMs: Date.now() - started };
    }
    await res.text();
    const tooLong = (config.models?.queueTooLongThreshold ?? 8);
    const state = modelRow.queue_depth >= tooLong ? 'degraded' : 'online';
    markHealth(modelRow.id, state);
    return { id: modelRow.id, state, latencyMs: Date.now() - started };
  } catch (err) {
    markHealth(modelRow.id, 'offline', err?.message || String(err));
    return { id: modelRow.id, state: 'offline', latencyMs: Date.now() - started };
  }
}

export async function checkAllModels(config) {
  const models = listModels({ onlyEnabled: true });
  return Promise.all(models.map((m) => checkModel(m, config)));
}

export function startHealthLoop(config) {
  stopHealthLoop();
  const interval = config.models?.healthCheckIntervalMs ?? 15000;
  const tick = () => { checkAllModels(config).catch((e) => log.error('健康檢查失敗', { error: e.message })); };
  tick();
  healthTimer = setInterval(tick, interval);
  healthTimer.unref?.();
  log.info('模型健康檢查已啟動', { intervalMs: interval });
}

export function stopHealthLoop() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

/** 模型是否可接受新請求（規畫書 7 的 Failover 條件）。 */
export function isUsable(modelRow, config) {
  if (!modelRow || !modelRow.enabled) return { ok: false, reason: 'disabled' };
  const maxFails = config.models?.unhealthyAfterFailures ?? 3;
  if (modelRow.health_state === 'offline' && modelRow.consecutive_fails >= maxFails) {
    return { ok: false, reason: 'offline' };
  }
  const tooLong = config.models?.queueTooLongThreshold ?? 8;
  if (modelRow.queue_depth >= tooLong) return { ok: false, reason: 'queue_too_long' };
  return { ok: true, reason: '' };
}
