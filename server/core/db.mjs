/**
 * SQLite 存取層（node:sqlite，Node 內建，無需編譯原生模組）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { paths, ensureRuntimeDirs } from './paths.mjs';

const SCHEMA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

let db = null;

export function getDb() {
  if (db) return db;
  ensureRuntimeDirs();
  db = new DatabaseSync(paths.db);
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  return db;
}

export function closeDb() {
  if (db) {
    try { db.close(); } catch { /* 已關閉 */ }
    db = null;
  }
}

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

export function get(sql, params = []) {
  return getDb().prepare(sql).get(...params) ?? null;
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

export function transaction(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

// ---------- system_settings 便利函式 ----------

export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM system_settings WHERE key = ?', [key]);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setSetting(key, value) {
  run(
    `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [key, JSON.stringify(value)],
  );
}

export function audit(actorId, action, target = '', detail = '', clientIp = '') {
  run(
    'INSERT INTO audit_logs (actor_id, action, target, detail, client_ip) VALUES (?, ?, ?, ?, ?)',
    [actorId ?? null, action, target, typeof detail === 'string' ? detail : JSON.stringify(detail), clientIp],
  );
}
