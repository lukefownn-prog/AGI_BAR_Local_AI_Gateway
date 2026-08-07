-- ==========================================================
-- AGI BAR V1 資料庫結構（規畫書 12. 資料庫規劃）
-- SQLite；未來多節點再升級 PostgreSQL。
-- ==========================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- 人員與角色 ----------
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,
  display_name   TEXT    NOT NULL DEFAULT '',
  email          TEXT    NOT NULL DEFAULT '',
  role           TEXT    NOT NULL DEFAULT 'user',      -- admin | user
  status         TEXT    NOT NULL DEFAULT 'active',    -- active | paused | disabled
  password_hash  TEXT,                                  -- 僅 admin / Web Chat 使用者需要
  note           TEXT    NOT NULL DEFAULT '',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT
);

-- ---------- API Key（僅存雜湊與識別前綴）----------
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL DEFAULT 'default',
  key_prefix   TEXT    NOT NULL,                       -- 例如 agi-bar-a1b2c3
  key_hash     TEXT    NOT NULL UNIQUE,                -- SHA-256(明文)
  last4        TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL DEFAULT 'active',      -- active | paused | revoked
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- ---------- 配額 / 時間 / 速率限制 ----------
CREATE TABLE IF NOT EXISTS api_key_limits (
  api_key_id          INTEGER PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
  tokens_per_request  INTEGER NOT NULL DEFAULT 8192,
  tokens_per_hour     INTEGER NOT NULL DEFAULT 100000,
  tokens_per_day      INTEGER NOT NULL DEFAULT 500000,
  tokens_per_month    INTEGER NOT NULL DEFAULT 5000000,
  rpm                 INTEGER NOT NULL DEFAULT 20,
  concurrent          INTEGER NOT NULL DEFAULT 2,
  priority            TEXT    NOT NULL DEFAULT 'normal', -- admin | high | normal | guest
  internet_allowed    INTEGER NOT NULL DEFAULT 0,
  valid_from          TEXT,                              -- YYYY-MM-DD
  valid_until         TEXT,                              -- YYYY-MM-DD
  daily_window_start  TEXT    NOT NULL DEFAULT '00:00',
  daily_window_end    TEXT    NOT NULL DEFAULT '23:59',
  weekdays            TEXT    NOT NULL DEFAULT '0,1,2,3,4,5,6', -- 0=週日
  over_quota_policy   TEXT    NOT NULL DEFAULT 'hard',   -- hard=拒絕 / soft=降級小模型
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------- 模型 ----------
CREATE TABLE IF NOT EXISTS models (
  id            TEXT    PRIMARY KEY,                    -- 對應 config.models.catalog[].id
  display_name  TEXT    NOT NULL DEFAULT '',
  provider      TEXT    NOT NULL DEFAULT 'openai-compatible',
  endpoint      TEXT    NOT NULL DEFAULT '',
  model_name    TEXT    NOT NULL DEFAULT '',
  is_local      INTEGER NOT NULL DEFAULT 1,
  enabled       INTEGER NOT NULL DEFAULT 1,
  capabilities  TEXT    NOT NULL DEFAULT '[]',          -- JSON array
  context_window INTEGER NOT NULL DEFAULT 8192,
  vram_mb       INTEGER NOT NULL DEFAULT 0,
  -- Health Check 觀測值（規畫書 7）
  health_state       TEXT    NOT NULL DEFAULT 'unknown', -- online | offline | degraded | unknown
  last_check_at      TEXT,
  consecutive_fails  INTEGER NOT NULL DEFAULT 0,
  avg_first_token_ms REAL    NOT NULL DEFAULT 0,
  avg_tokens_per_sec REAL    NOT NULL DEFAULT 0,
  queue_depth        INTEGER NOT NULL DEFAULT 0,
  error_rate         REAL    NOT NULL DEFAULT 0,
  vram_used_mb       INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT    NOT NULL DEFAULT '',
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------- 每位人員的模型優先順序 ----------
CREATE TABLE IF NOT EXISTS model_routes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id   TEXT    NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  rank       INTEGER NOT NULL,                          -- 1 = 第一順位
  enabled    INTEGER NOT NULL DEFAULT 1,
  UNIQUE(user_id, rank),
  UNIQUE(user_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_routes_user ON model_routes(user_id, rank);

-- ---------- Token 用量 ----------
CREATE TABLE IF NOT EXISTS usage_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT    NOT NULL DEFAULT (datetime('now')),
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  api_key_id    INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  model_id      TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens  INTEGER NOT NULL DEFAULT 0,
  request_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_user_ts ON usage_logs(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_logs(ts);

-- ---------- 請求紀錄 ----------
CREATE TABLE IF NOT EXISTS request_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id     TEXT    NOT NULL,
  ts             TEXT    NOT NULL DEFAULT (datetime('now')),
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  api_key_id     INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  route          TEXT    NOT NULL DEFAULT '',
  requested_model TEXT   NOT NULL DEFAULT '',
  served_model   TEXT    NOT NULL DEFAULT '',
  failover_from  TEXT    NOT NULL DEFAULT '',
  priority       TEXT    NOT NULL DEFAULT 'normal',
  queue_wait_ms  INTEGER NOT NULL DEFAULT 0,
  inference_ms   INTEGER NOT NULL DEFAULT 0,
  first_token_ms INTEGER NOT NULL DEFAULT 0,
  status_code    INTEGER NOT NULL DEFAULT 200,
  error_code     TEXT    NOT NULL DEFAULT '',
  error_message  TEXT    NOT NULL DEFAULT '',
  used_internet  INTEGER NOT NULL DEFAULT 0,
  prompt_hash    TEXT    NOT NULL DEFAULT '',
  client_ip      TEXT    NOT NULL DEFAULT '',
  user_agent     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_reqlog_ts ON request_logs(ts);
CREATE INDEX IF NOT EXISTS idx_reqlog_user ON request_logs(user_id, ts);

-- ---------- 受控上網紀錄（規畫書 9）----------
CREATE TABLE IF NOT EXISTS web_access_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL DEFAULT (datetime('now')),
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  request_id  TEXT    NOT NULL DEFAULT '',
  tool        TEXT    NOT NULL DEFAULT '',              -- web_search | url_fetch
  target      TEXT    NOT NULL DEFAULT '',
  resolved_ip TEXT    NOT NULL DEFAULT '',
  allowed     INTEGER NOT NULL DEFAULT 0,
  reason      TEXT    NOT NULL DEFAULT '',
  bytes       INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_weblog_ts ON web_access_logs(ts);

-- ---------- 全域設定與安全政策 ----------
CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- 管理員 Session ----------
CREATE TABLE IF NOT EXISTS admin_sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  client_ip  TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON admin_sessions(user_id);

-- ---------- 稽核紀錄（管理操作）----------
CREATE TABLE IF NOT EXISTS audit_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action   TEXT NOT NULL,
  target   TEXT NOT NULL DEFAULT '',
  detail   TEXT NOT NULL DEFAULT '',
  client_ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);
