/**
 * 每位人員的 Model Routing Chain（規畫書 7）。
 * 使用者不需知道後端實際模型名稱，Gateway 依管理員設定自動路由。
 */
import { all, get, run, transaction, audit } from '../core/db.mjs';
import { getModel } from './models.mjs';
import { HttpError } from '../core/http.mjs';

export function getUserRoute(userId) {
  return all(
    `SELECT r.rank, r.model_id, r.enabled, m.display_name, m.health_state, m.queue_depth,
            m.is_local, m.enabled AS model_enabled, m.context_window
     FROM model_routes r JOIN models m ON m.id = r.model_id
     WHERE r.user_id = ? ORDER BY r.rank ASC`,
    [userId],
  );
}

/** 沒有個人設定時，回退到 config.models.defaultRoute。 */
export function resolveRouteChain(userId, config) {
  const personal = getUserRoute(userId).filter((r) => r.enabled && r.model_enabled);
  if (personal.length) return personal.map((r) => r.model_id);
  return (config.models?.defaultRoute ?? []).filter((id) => getModel(id)?.enabled);
}

export function setUserRoute(userId, modelIds, ctx = {}) {
  if (!Array.isArray(modelIds)) throw new HttpError(400, 'invalid_route', '路由需為模型 ID 陣列');
  if (modelIds.length > 8) throw new HttpError(400, 'route_too_long', '單一人員最多設定 8 個順位');
  for (const id of modelIds) {
    if (!getModel(id)) throw new HttpError(400, 'model_not_found', `模型不存在：${id}`);
  }
  if (new Set(modelIds).size !== modelIds.length) {
    throw new HttpError(400, 'duplicate_model', '同一模型不可重複出現在路由中');
  }

  transaction(() => {
    run('DELETE FROM model_routes WHERE user_id = ?', [userId]);
    modelIds.forEach((modelId, i) => {
      run('INSERT INTO model_routes (user_id, model_id, rank, enabled) VALUES (?, ?, ?, 1)',
        [userId, modelId, i + 1]);
    });
  });
  audit(ctx.actorId, 'route.set', `user:${userId}`, modelIds.join('>'), ctx.clientIp);
  return getUserRoute(userId);
}

export function clearUserRoute(userId, ctx = {}) {
  run('DELETE FROM model_routes WHERE user_id = ?', [userId]);
  audit(ctx.actorId, 'route.clear', `user:${userId}`, '', ctx.clientIp);
  return [];
}

/** 依 VRAM 由小到大排序，供 soft limit 降級用。 */
export function smallestModelIn(chain) {
  const rows = chain.map(getModel).filter(Boolean).filter((m) => m.enabled);
  if (!rows.length) return null;
  rows.sort((a, b) => (a.vram_mb || 0) - (b.vram_mb || 0) || (a.context_window || 0) - (b.context_window || 0));
  return rows[0].id;
}

export function routeSummary(userId) {
  const rows = getUserRoute(userId);
  return rows.length ? rows.map((r) => r.display_name || r.model_id).join(' → ') : '（使用預設路由）';
}

export function userHasRoute(userId) {
  return !!get('SELECT 1 AS x FROM model_routes WHERE user_id = ? LIMIT 1', [userId]);
}
