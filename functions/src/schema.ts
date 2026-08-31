/**
 * Schema DDL kept in code so a fresh deployment can bootstrap itself.
 *
 * Cloudflare Pages users often have no local wrangler access, so requiring
 * `wrangler d1 execute` before the first login makes the app unusable. Every
 * statement is idempotent (`IF NOT EXISTS`) and additive, so applying this to an
 * existing database never drops or rewrites stored rows.
 *
 * Keep in sync with functions/schema.sql.
 */
/**
 * Bumped whenever SCHEMA_STATEMENTS or ADDITIVE_COLUMNS change.
 *
 * Applying the whole schema costs roughly 30 D1 round trips (creates, PRAGMA
 * reads, ALTERs, backfill). Cloudflare caps a request at 50 subrequests and D1
 * queries count toward it, so doing that on every login threw "Worker threw
 * exception". The version is recorded in `settings` once the work succeeds, and
 * later requests spend a single cheap read confirming there is nothing to do.
 */
export const SCHEMA_VERSION = '8';

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0,
    error_threshold REAL DEFAULT 0.5,
    error_count_threshold INTEGER DEFAULT 5,
    window_seconds INTEGER DEFAULT 300,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS channels (
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
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','xai')),
    api_key TEXT NOT NULL,
    base_url TEXT,
    group_id INTEGER NOT NULL,
    -- Retired: the channel layer was folded into accounts. Kept with a default
    -- so one INSERT statement works against databases created before the
    -- change, where this column still carries a NOT NULL constraint.
    channel_id INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    error_count INTEGER DEFAULT 0,
    error_rate REAL DEFAULT 0,
    last_error_at TEXT,
    last_error_msg TEXT,
    priority INTEGER DEFAULT 0,
    client_spoofing TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS model_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requested_model TEXT NOT NULL,
    provider TEXT NOT NULL,
    upstream_model TEXT NOT NULL,
    group_id INTEGER NOT NULL,
    enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
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
  )`,
  `CREATE TABLE IF NOT EXISTS usage_records (
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
  )`,
  `CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    status INTEGER NOT NULL,
    error_message TEXT,
    latency_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  // Internal key/value store. Holds the auto-generated JWT signing secret so a
  // deployment that never set the JWT_SECRET variable still signs sessions with
  // a value unique to that database rather than a constant from the repository.
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_req_logs_account_created ON request_logs(account_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_req_logs_channel_created ON request_logs(channel_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_req_logs_group_created ON request_logs(group_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_group ON accounts(group_id)`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_channel ON accounts(channel_id)`
];

/**
 * Columns added after the first release.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, and a failed ALTER aborts the whole
 * statement, so the migrator reads `PRAGMA table_info` first and adds only what
 * is missing. Every entry must be nullable or carry a DEFAULT, otherwise adding
 * it to a table that already holds rows fails.
 */
export const ADDITIVE_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  // Time to first byte. Latency alone hides whether a slow response was slow to
  // start or merely long, which is the number that matters for streaming.
  // setSetting stamps this on conflict. SQLite validates the whole statement at
  // prepare time, so a missing column makes every settings write fail rather
  // than just the update path.
  { table: 'settings', column: 'updated_at', definition: 'TEXT' },

  { table: 'usage_records', column: 'ttft_ms', definition: 'INTEGER' },
  { table: 'request_logs', column: 'ttft_ms', definition: 'INTEGER' },

  // Upstream billing weight. Scheduling prefers cheaper accounts, so a 0.5x
  // reseller is chosen ahead of a 2x one when both are healthy.
  { table: 'accounts', column: 'rate_multiplier', definition: 'REAL DEFAULT 1' },
  { table: 'channels', column: 'rate_multiplier', definition: 'REAL DEFAULT 1' },

  // Health probe results, kept on the row so the console can show liveness
  // without re-testing every upstream on each page load.
  { table: 'accounts', column: 'last_check_at', definition: 'TEXT' },
  { table: 'accounts', column: 'last_check_ok', definition: 'INTEGER' },
  { table: 'accounts', column: 'last_check_latency_ms', definition: 'INTEGER' },
  { table: 'accounts', column: 'last_check_message', definition: 'TEXT' },

  // Attribution for a usage row. Without these the records page can only group
  // by model or provider, so an operator cannot tell which upstream account or
  // scheduling group served a request.
  { table: 'usage_records', column: 'group_id', definition: 'INTEGER' },
  { table: 'usage_records', column: 'account_id', definition: 'INTEGER' },

  // The plaintext is never stored. New keys keep a versioned AES-GCM payload so
  // an authenticated administrator can copy them later; old hash-only rows stay
  // valid for gateway auth but are not recoverable.
  { table: 'api_keys', column: 'key_ciphertext', definition: 'TEXT' },

  // A client key may be pinned to one group. NULL keeps the previous behaviour
  // of allowing every group, while fallback_group_id is an optional same-provider
  // pool used only after the primary group has no healthy account.
  { table: 'api_keys', column: 'group_id', definition: 'INTEGER' },
  { table: 'api_keys', column: 'fallback_group_id', definition: 'INTEGER' },

  // Cost and routing observability. These columns are nullable so existing rows
  // remain valid and old deployments can migrate without rewriting history.
  { table: 'usage_records', column: 'rate_multiplier', definition: 'REAL DEFAULT 1' },
  { table: 'usage_records', column: 'base_cost', definition: 'REAL DEFAULT 0' },
  { table: 'usage_records', column: 'cost_estimated', definition: 'INTEGER DEFAULT 0' },
  { table: 'usage_records', column: 'cache_status', definition: 'TEXT' }
];
