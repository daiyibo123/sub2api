-- Sub2API 精简版 D1 Schema
-- 适用于 Cloudflare Pages + Functions

-- 管理员（仅你一人）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 分组
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  error_threshold REAL DEFAULT 0.5,
  error_count_threshold INTEGER DEFAULT 5,
  window_seconds INTEGER DEFAULT 300,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 渠道
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  base_url TEXT,
  api_key TEXT,
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  error_rate REAL DEFAULT 0,
  last_error_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 上游账号
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','xai')),
  api_key TEXT NOT NULL,
  base_url TEXT,
  group_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  enabled INTEGER DEFAULT 1,
  error_count INTEGER DEFAULT 0,
  error_rate REAL DEFAULT 0,
  last_error_at TEXT,
  last_error_msg TEXT,
  priority INTEGER DEFAULT 0,
  client_spoofing TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 模型映射
CREATE TABLE IF NOT EXISTS model_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_model TEXT NOT NULL,
  provider TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0
);

-- API Key
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  key_ciphertext TEXT,
  name TEXT,
  enabled INTEGER DEFAULT 1,
  balance REAL DEFAULT 0,
  quota_limit REAL DEFAULT 0,
  group_id INTEGER,
  fallback_group_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 使用记录
CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  base_cost REAL DEFAULT 0,
  rate_multiplier REAL DEFAULT 1,
  cost_estimated INTEGER DEFAULT 0,
  cache_status TEXT,
  status INTEGER DEFAULT 200,
  error_message TEXT,
  latency_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 请求日志（用于错误统计）
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  status INTEGER NOT NULL,
  error_message TEXT,
  latency_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 运行时设置（例如未配置 JWT_SECRET 时自动生成的会话密钥）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_req_logs_account_created ON request_logs(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_req_logs_channel_created ON request_logs(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_req_logs_group_created ON request_logs(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at);
CREATE INDEX IF NOT EXISTS idx_accounts_group ON accounts(group_id);
CREATE INDEX IF NOT EXISTS idx_accounts_channel ON accounts(channel_id);

-- The first administrator is created through POST /api/v1/auth/setup.
-- Applying this file is optional: POST /api/v1/auth/setup runs the same
-- statements from functions/src/schema.ts when tables are missing.
