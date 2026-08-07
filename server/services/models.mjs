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

export function setModelEnabled(id, enabled, ctx = {}) {
  const m = getModel(id);
  if (!m) throw new HttpError(404, 'model_not_found', '找不到模型');
  run("UPDATE models SET enabled = ?, updated_at = datetime('now') WHERE id = ?", [enabled ? 1 : 0, id]);
  audit(ctx.actorId, 'model.enabled', `model:${id}`, String(!!enabled), ctx.clientIp);
  return getModel(id);
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
