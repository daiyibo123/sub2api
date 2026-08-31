// functions/src/schema.ts
var SCHEMA_VERSION = "9";
var SCHEMA_STATEMENTS = [
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
    upstream_models TEXT,
    upstream_models_at TEXT,
    probe_model TEXT,
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
var ADDITIVE_COLUMNS = [
  // Time to first byte. Latency alone hides whether a slow response was slow to
  // start or merely long, which is the number that matters for streaming.
  // setSetting stamps this on conflict. SQLite validates the whole statement at
  // prepare time, so a missing column makes every settings write fail rather
  // than just the update path.
  { table: "settings", column: "updated_at", definition: "TEXT" },
  { table: "usage_records", column: "ttft_ms", definition: "INTEGER" },
  { table: "request_logs", column: "ttft_ms", definition: "INTEGER" },
  // Upstream billing weight. Scheduling prefers cheaper accounts, so a 0.5x
  // reseller is chosen ahead of a 2x one when both are healthy.
  { table: "accounts", column: "rate_multiplier", definition: "REAL DEFAULT 1" },
  { table: "channels", column: "rate_multiplier", definition: "REAL DEFAULT 1" },
  // Health probe results, kept on the row so the console can show liveness
  // without re-testing every upstream on each page load.
  { table: "accounts", column: "last_check_at", definition: "TEXT" },
  { table: "accounts", column: "last_check_ok", definition: "INTEGER" },
  { table: "accounts", column: "last_check_latency_ms", definition: "INTEGER" },
  { table: "accounts", column: "last_check_message", definition: "TEXT" },
  // The upstream's own model list, cached as JSON after a successful fetch, plus
  // the model the operator last probed with. Re-fetching on every dialog open
  // costs an upstream round trip to relearn something that rarely changes, and
  // it forced the operator to re-pick a model each time. The remembered model is
  // also what a batch probe uses, so an account is kept alive with the model it
  // was verified against rather than a provider-wide guess.
  { table: "accounts", column: "upstream_models", definition: "TEXT" },
  { table: "accounts", column: "upstream_models_at", definition: "TEXT" },
  { table: "accounts", column: "probe_model", definition: "TEXT" },
  // Attribution for a usage row. Without these the records page can only group
  // by model or provider, so an operator cannot tell which upstream account or
  // scheduling group served a request.
  { table: "usage_records", column: "group_id", definition: "INTEGER" },
  { table: "usage_records", column: "account_id", definition: "INTEGER" },
  // The plaintext is never stored. New keys keep a versioned AES-GCM payload so
  // an authenticated administrator can copy them later; old hash-only rows stay
  // valid for gateway auth but are not recoverable.
  { table: "api_keys", column: "key_ciphertext", definition: "TEXT" },
  // A client key may be pinned to one group. NULL keeps the previous behaviour
  // of allowing every group, while fallback_group_id is an optional same-provider
  // pool used only after the primary group has no healthy account.
  { table: "api_keys", column: "group_id", definition: "INTEGER" },
  { table: "api_keys", column: "fallback_group_id", definition: "INTEGER" },
  // Cost and routing observability. These columns are nullable so existing rows
  // remain valid and old deployments can migrate without rewriting history.
  { table: "usage_records", column: "rate_multiplier", definition: "REAL DEFAULT 1" },
  { table: "usage_records", column: "base_cost", definition: "REAL DEFAULT 0" },
  { table: "usage_records", column: "cost_estimated", definition: "INTEGER DEFAULT 0" },
  { table: "usage_records", column: "cache_status", definition: "TEXT" }
];

// functions/src/db.ts
var Database = class {
  constructor(db) {
    this.db = db;
  }
  // Generic query helpers
  async query(sql, params = []) {
    const result = await this.db.prepare(sql).bind(...params).all();
    return result.results ?? [];
  }
  async queryOne(sql, params = []) {
    const result = await this.db.prepare(sql).bind(...params).first();
    return result ?? null;
  }
  async exec(sql) {
    await this.db.prepare(sql).run();
  }
  async insert(sql, params = []) {
    const result = await this.db.prepare(sql).bind(...params).run();
    return { lastRowId: Number(result.meta.last_row_id ?? 0), changes: Number(result.meta.changes ?? 0) };
  }
  async update(sql, params = []) {
    const result = await this.db.prepare(sql).bind(...params).run();
    return { changes: Number(result.meta.changes ?? 0) };
  }
  // User operations
  async getUserByUsername(username) {
    return this.queryOne("SELECT * FROM users WHERE username = ?", [username]);
  }
  async createUser(username, passwordHash) {
    return this.insert(
      "INSERT INTO users (username, password_hash) VALUES (?, ?)",
      [username, passwordHash]
    );
  }
  // Group operations
  async listGroups() {
    return this.query("SELECT * FROM groups ORDER BY priority ASC, id ASC");
  }
  async getGroup(id) {
    return this.queryOne("SELECT * FROM groups WHERE id = ?", [id]);
  }
  /**
   * groups.name is UNIQUE. Look the name up first so a collision returns a
   * readable message instead of a raw D1 constraint error.
   */
  async getGroupByName(name) {
    return this.queryOne("SELECT * FROM groups WHERE name = ?", [name]);
  }
  async createGroup(name, description, priority = 0, options = {}) {
    return this.insert(
      `INSERT INTO groups (name, description, priority, enabled, error_threshold, error_count_threshold, window_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        description || "",
        priority,
        options.enabled ?? 1,
        options.error_threshold ?? 0.5,
        options.error_count_threshold ?? 5,
        options.window_seconds ?? 300
      ]
    );
  }
  async updateGroup(id, updates) {
    const fields = [];
    const values = [];
    if (updates.name !== void 0) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.description !== void 0) {
      fields.push("description = ?");
      values.push(updates.description);
    }
    if (updates.enabled !== void 0) {
      fields.push("enabled = ?");
      values.push(updates.enabled);
    }
    if (updates.priority !== void 0) {
      fields.push("priority = ?");
      values.push(updates.priority);
    }
    if (updates.error_threshold !== void 0) {
      fields.push("error_threshold = ?");
      values.push(updates.error_threshold);
    }
    if (updates.error_count_threshold !== void 0) {
      fields.push("error_count_threshold = ?");
      values.push(updates.error_count_threshold);
    }
    if (updates.window_seconds !== void 0) {
      fields.push("window_seconds = ?");
      values.push(updates.window_seconds);
    }
    if (fields.length === 0) return { changes: 0 };
    values.push(id);
    return this.update(`UPDATE groups SET ${fields.join(", ")} WHERE id = ?`, values);
  }
  async deleteGroup(id) {
    return this.update("DELETE FROM groups WHERE id = ?", [id]);
  }
  // Account operations
  async listAccounts() {
    return this.query(`
      SELECT a.*, g.name as group_name
      FROM accounts a
      LEFT JOIN groups g ON a.group_id = g.id
      ORDER BY a.priority ASC, a.id ASC
    `);
  }
  async getAccount(id) {
    return this.queryOne("SELECT * FROM accounts WHERE id = ?", [id]);
  }
  async createAccount(name, provider, apiKey, groupId, baseUrl, priority = 0, clientSpoofing, enabled = 1, rateMultiplier = 1) {
    return this.insert(
      // channel_id is a retired column that older databases still declare
      // NOT NULL, so a literal 0 is written to satisfy both shapes.
      `INSERT INTO accounts (name, provider, api_key, base_url, group_id, channel_id, priority, client_spoofing, enabled, rate_multiplier)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [name, provider, apiKey, baseUrl || "", groupId, priority, clientSpoofing || "", enabled, rateMultiplier]
    );
  }
  async updateAccount(id, updates) {
    const fields = [];
    const values = [];
    if (updates.name !== void 0) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.provider !== void 0) {
      fields.push("provider = ?");
      values.push(updates.provider);
    }
    if (updates.api_key !== void 0) {
      fields.push("api_key = ?");
      values.push(updates.api_key);
    }
    if (updates.base_url !== void 0) {
      fields.push("base_url = ?");
      values.push(updates.base_url);
    }
    if (updates.group_id !== void 0) {
      fields.push("group_id = ?");
      values.push(updates.group_id);
    }
    if (updates.enabled !== void 0) {
      fields.push("enabled = ?");
      values.push(updates.enabled);
    }
    if (updates.priority !== void 0) {
      fields.push("priority = ?");
      values.push(updates.priority);
    }
    if (updates.error_count !== void 0) {
      fields.push("error_count = ?");
      values.push(updates.error_count);
    }
    if (updates.error_rate !== void 0) {
      fields.push("error_rate = ?");
      values.push(updates.error_rate);
    }
    if (updates.client_spoofing !== void 0) {
      fields.push("client_spoofing = ?");
      values.push(updates.client_spoofing);
    }
    if (updates.rate_multiplier !== void 0) {
      fields.push("rate_multiplier = ?");
      values.push(updates.rate_multiplier);
    }
    if (fields.length === 0) return { changes: 0 };
    values.push(id);
    return this.update(`UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`, values);
  }
  async deleteAccount(id) {
    return this.update("DELETE FROM accounts WHERE id = ?", [id]);
  }
  async listAccountsByGroup(groupId) {
    return this.query("SELECT * FROM accounts WHERE group_id = ? AND enabled = 1 ORDER BY priority ASC, id ASC", [groupId]);
  }
  /**
   * Credentials live on the account itself; there is no longer a second layer
   * holding shared defaults.
   */
  async listEnabledAccounts() {
    return this.query(`
      SELECT * FROM accounts WHERE enabled = 1 ORDER BY priority ASC, id ASC
    `);
  }
  /** Dependants that would break if a group were removed. */
  async countAccountsInGroup(groupId) {
    const row = await this.queryOne(
      "SELECT COUNT(*) AS total FROM accounts WHERE group_id = ?",
      [groupId]
    );
    return Number(row?.total || 0);
  }
  async countModelMappingsForGroup(groupId) {
    const row = await this.queryOne(
      "SELECT COUNT(*) AS total FROM model_mappings WHERE group_id = ?",
      [groupId]
    );
    return Number(row?.total || 0);
  }
  /**
   * Name lookups back friendly duplicate errors. Groups have
   * a UNIQUE(name) constraint, which would otherwise surface as a raw D1 500.
   */
  async findGroupByName(name) {
    return this.queryOne("SELECT * FROM groups WHERE name = ?", [name]);
  }
  /**
   * Store the outcome of a liveness probe on the account row.
   *
   * Keeping the last result denormalized lets the console show which upstreams
   * are alive without re-probing every provider on each page load.
   */
  async recordAccountHealthCheck(id, ok, latencyMs, message) {
    return this.update(
      `UPDATE accounts
       SET last_check_at = datetime('now'), last_check_ok = ?, last_check_latency_ms = ?, last_check_message = ?
       WHERE id = ?`,
      [ok ? 1 : 0, Math.max(0, Math.round(latencyMs)), (message || "").slice(0, 300), id]
    );
  }
  /**
   * Cache the upstream's model list on the account.
   *
   * Stored as a JSON array of `{ id, name? }` rows. The list changes rarely, so
   * re-fetching it every time the probe dialog opens costs a round trip to
   * relearn the same answer and forces the operator to re-pick a model.
   */
  async saveUpstreamModels(id, models) {
    return this.update(
      `UPDATE accounts SET upstream_models = ?, upstream_models_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(models.slice(0, 200)), id]
    );
  }
  /**
   * Remember which model an operator probed with.
   *
   * A batch probe reuses this so an account is kept alive against the model it
   * was actually verified with, rather than a provider-wide default the plan may
   * not serve.
   */
  async saveProbeModel(id, model) {
    return this.update("UPDATE accounts SET probe_model = ? WHERE id = ?", [model.slice(0, 200), id]);
  }
  /** Resolve a single account row including its credential. */
  async getAccountWithKey(id) {
    return this.queryOne(`
      SELECT * FROM accounts WHERE id = ?
    `, [id]);
  }
  // Model mapping operations
  async listModelMappings() {
    return this.query("SELECT * FROM model_mappings ORDER BY priority ASC, id ASC");
  }
  async getModelMapping(id) {
    return this.queryOne("SELECT * FROM model_mappings WHERE id = ?", [id]);
  }
  /**
   * findModelMapping resolves a single rule per (client model, provider) pair,
   * so a second identical pair would never be reachable. Surface it as a
   * conflict instead of silently storing dead configuration.
   */
  async findModelMappingByModel(requestedModel, provider) {
    return this.queryOne(
      "SELECT * FROM model_mappings WHERE requested_model = ? AND provider = ?",
      [requestedModel, provider]
    );
  }
  async createModelMapping(requestedModel, provider, upstreamModel, groupId, priority = 0, enabled = 1) {
    return this.insert(
      "INSERT INTO model_mappings (requested_model, provider, upstream_model, group_id, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)",
      [requestedModel, provider, upstreamModel, groupId, priority, enabled]
    );
  }
  async updateModelMapping(id, updates) {
    const fields = [];
    const values = [];
    if (updates.requested_model !== void 0) {
      fields.push("requested_model = ?");
      values.push(updates.requested_model);
    }
    if (updates.provider !== void 0) {
      fields.push("provider = ?");
      values.push(updates.provider);
    }
    if (updates.upstream_model !== void 0) {
      fields.push("upstream_model = ?");
      values.push(updates.upstream_model);
    }
    if (updates.group_id !== void 0) {
      fields.push("group_id = ?");
      values.push(updates.group_id);
    }
    if (updates.enabled !== void 0) {
      fields.push("enabled = ?");
      values.push(updates.enabled);
    }
    if (updates.priority !== void 0) {
      fields.push("priority = ?");
      values.push(updates.priority);
    }
    if (fields.length === 0) return { changes: 0 };
    values.push(id);
    return this.update(`UPDATE model_mappings SET ${fields.join(", ")} WHERE id = ?`, values);
  }
  async deleteModelMapping(id) {
    return this.update("DELETE FROM model_mappings WHERE id = ?", [id]);
  }
  // API Key operations
  async listApiKeys() {
    return this.query(`
      SELECT k.id, k.name, k.enabled, k.balance, k.quota_limit, k.group_id, k.fallback_group_id, k.created_at,
             CASE WHEN k.key_ciphertext IS NOT NULL AND TRIM(k.key_ciphertext) != '' THEN 1 ELSE 0 END AS can_copy,
             g.name AS group_name, fg.name AS fallback_group_name
      FROM api_keys k
      LEFT JOIN groups g ON k.group_id = g.id
      LEFT JOIN groups fg ON k.fallback_group_id = fg.id
      ORDER BY k.id DESC
    `);
  }
  async getApiKeyByHash(keyHash) {
    return this.queryOne("SELECT * FROM api_keys WHERE key_hash = ?", [keyHash]);
  }
  async createApiKey(keyHash, keyCiphertext, name, quotaLimit = 0, groupId = null, fallbackGroupId = null) {
    return this.insert(
      "INSERT INTO api_keys (key_hash, key_ciphertext, name, quota_limit, group_id, fallback_group_id) VALUES (?, ?, ?, ?, ?, ?)",
      [keyHash, keyCiphertext, name || "", quotaLimit, groupId, fallbackGroupId]
    );
  }
  async getApiKeyCiphertext(id) {
    return this.queryOne(
      "SELECT id, key_ciphertext FROM api_keys WHERE id = ?",
      [id]
    );
  }
  async updateApiKey(id, updates) {
    const fields = [];
    const values = [];
    if (updates.name !== void 0) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.enabled !== void 0) {
      fields.push("enabled = ?");
      values.push(updates.enabled);
    }
    if (updates.balance !== void 0) {
      fields.push("balance = ?");
      values.push(updates.balance);
    }
    if (updates.quota_limit !== void 0) {
      fields.push("quota_limit = ?");
      values.push(updates.quota_limit);
    }
    if (updates.group_id !== void 0) {
      fields.push("group_id = ?");
      values.push(updates.group_id);
    }
    if (updates.fallback_group_id !== void 0) {
      fields.push("fallback_group_id = ?");
      values.push(updates.fallback_group_id);
    }
    if (fields.length === 0) return { changes: 0 };
    values.push(id);
    return this.update(`UPDATE api_keys SET ${fields.join(", ")} WHERE id = ?`, values);
  }
  async deleteApiKey(id) {
    return this.update("DELETE FROM api_keys WHERE id = ?", [id]);
  }
  async incrementApiKeyUsage(id, cost) {
    return this.update(
      "UPDATE api_keys SET balance = balance + ? WHERE id = ?",
      [cost, id]
    );
  }
  // Usage records
  async createUsageRecord(record) {
    return this.insert(
      `INSERT INTO usage_records
       (api_key_id, model, provider, prompt_tokens, completion_tokens, total_tokens, cost, base_cost, rate_multiplier, cost_estimated, cache_status, status, error_message, latency_ms, ttft_ms, group_id, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.api_key_id ?? 0,
        record.model,
        record.provider,
        record.prompt_tokens ?? 0,
        record.completion_tokens ?? 0,
        record.total_tokens ?? 0,
        record.cost ?? 0,
        record.base_cost ?? record.cost ?? 0,
        record.rate_multiplier ?? 1,
        record.cost_estimated ?? 0,
        record.cache_status ?? null,
        record.status ?? 200,
        record.error_message || "",
        record.latency_ms ?? 0,
        record.ttft_ms ?? null,
        record.group_id ?? null,
        record.account_id ?? null
      ]
    );
  }
  /**
   * Recent usage rows with their group and key names resolved.
   *
   * The names are joined here rather than looked up in the browser so the
   * records page can filter by group without loading every group first, and so
   * a row still reads correctly after its group or key has been deleted.
   */
  async listUsageRecords(limit = 100, offset = 0) {
    return this.query(
      `SELECT u.*, g.name AS group_name, a.name AS account_name, k.name AS key_name
       FROM usage_records u
       LEFT JOIN groups g ON u.group_id = g.id
       LEFT JOIN accounts a ON u.account_id = a.id
       LEFT JOIN api_keys k ON u.api_key_id = k.id
       ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
  }
  async countUsageRecords() {
    const row = await this.queryOne("SELECT COUNT(*) AS total FROM usage_records");
    return Number(row?.total || 0);
  }
  async deleteUsageRecord(id) {
    return this.update("DELETE FROM usage_records WHERE id = ?", [id]);
  }
  /**
   * Drop usage rows older than `days`, or every row when `days` is 0.
   *
   * D1 bills on rows stored and caps database size, and usage_records is the
   * only table that grows with traffic rather than with configuration, so an
   * operator needs a way to reclaim it. Request logs are trimmed on the same
   * cutoff because failover reads them for error rates and a log with no
   * matching usage row is no longer useful evidence.
   */
  async deleteUsageRecordsOlderThan(days) {
    if (days <= 0) {
      await this.update("DELETE FROM usage_records", []);
      await this.update("DELETE FROM request_logs", []);
      return;
    }
    const cutoff = sqliteTimestamp(Date.now() - days * 24 * 60 * 60 * 1e3);
    await this.update("DELETE FROM usage_records WHERE created_at < ?", [cutoff]);
    await this.update("DELETE FROM request_logs WHERE created_at < ?", [cutoff]);
  }
  // Request logs for error tracking
  async createRequestLog(log) {
    return this.insert(
      `INSERT INTO request_logs (account_id, channel_id, group_id, model, status, error_message, latency_ms, ttft_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.account_id,
        0,
        log.group_id,
        log.model,
        log.status,
        log.error_message || "",
        log.latency_ms ?? 0,
        log.ttft_ms ?? null
      ]
    );
  }
  async getAccountErrorStats(accountId, windowSeconds) {
    const cutoff = sqliteTimestamp(Date.now() - windowSeconds * 1e3);
    const result = await this.queryOne(
      `SELECT 
        COUNT(*) as total_requests,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as error_count
       FROM request_logs 
       WHERE account_id = ? AND created_at >= ?`,
      [accountId, cutoff]
    );
    return result || { total_requests: 0, error_count: 0 };
  }
  /**
   * Dashboard aggregates computed in D1 rather than by paging every row into
   * the browser, so the numbers stay correct beyond the usage page limit.
   */
  async getDashboardStats(windowHours = 24, bucket = "hour") {
    const since = sqliteTimestamp(Date.now() - windowHours * 60 * 60 * 1e3);
    const bucketFormat = bucket === "day" ? "%Y-%m-%d" : "%Y-%m-%d %H:00";
    const todayStart = sqliteTimestamp((/* @__PURE__ */ new Date()).setHours(0, 0, 0, 0));
    const [totals, today, resources] = await Promise.all([
      this.queryOne(`
        SELECT
          COUNT(*) AS total_requests,
          SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) AS success_requests,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(cost), 0) AS total_cost,
          COALESCE(SUM(base_cost), 0) AS base_cost,
          COALESCE(AVG(NULLIF(ttft_ms, 0)), 0) AS avg_ttft,
          COALESCE(AVG(NULLIF(latency_ms, 0)), 0) AS avg_latency,
          COALESCE(SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END), 0) AS cache_hits,
          COALESCE(SUM(CASE WHEN cache_status IS NOT NULL THEN 1 ELSE 0 END), 0) AS cache_samples
        FROM usage_records
        WHERE created_at >= ?
      `, [since]),
      this.queryOne(`
        SELECT
          COUNT(*) AS today_requests,
          COALESCE(SUM(total_tokens), 0) AS today_tokens,
          COALESCE(SUM(cost), 0) AS today_cost
        FROM usage_records WHERE created_at >= ?
      `, [todayStart]),
      this.queryOne(`
        SELECT
          (SELECT COUNT(*) FROM accounts) AS total_accounts,
          (SELECT COUNT(*) FROM accounts WHERE enabled = 1) AS active_accounts,
          (SELECT COUNT(*) FROM api_keys) AS total_keys,
          (SELECT COUNT(*) FROM api_keys WHERE enabled = 1) AS active_keys,
          (SELECT COUNT(*) FROM groups) AS total_groups,
          (SELECT COUNT(*) FROM groups WHERE enabled = 1) AS active_groups,
          (SELECT COUNT(*) FROM model_mappings) AS total_models,
          (SELECT COUNT(*) FROM model_mappings WHERE enabled = 1) AS active_models
      `)
    ]);
    const [trend, byModel, byProvider] = await Promise.all([
      this.query(`
        SELECT
          strftime('${bucketFormat}', created_at) AS bucket,
          COUNT(*) AS requests,
          SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(cost), 0) AS cost
        FROM usage_records WHERE created_at >= ?
        GROUP BY bucket ORDER BY bucket ASC
      `, [since]),
      this.query(`
        SELECT model, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens,
               COALESCE(SUM(base_cost), 0) AS base_cost, COALESCE(SUM(cost), 0) AS cost
        FROM usage_records WHERE created_at >= ? GROUP BY model ORDER BY requests DESC LIMIT 12
      `, [since]),
      this.query(`
        SELECT provider, COUNT(*) AS requests, COALESCE(SUM(base_cost), 0) AS base_cost,
               COALESCE(SUM(cost), 0) AS cost
        FROM usage_records WHERE created_at >= ? GROUP BY provider ORDER BY requests DESC
      `, [since])
    ]);
    return { totals: totals || {}, today: today || {}, resources: resources || {}, trend, byModel, byProvider };
  }
  /**
   * Apply the schema when tables are missing. Pages deployments often have no
   * access to `wrangler d1 execute`, so first run would otherwise fail with a
   * raw "no such table" error. Every statement is idempotent.
   */
  async ensureSchema() {
    if (await this.getSetting("schema_version") === SCHEMA_VERSION) return false;
    const wasReady = await this.schemaReady();
    for (const statement of SCHEMA_STATEMENTS) {
      await this.db.prepare(statement).run();
    }
    await this.applyAdditiveColumns();
    const folded = await this.migrateChannelsIntoAccounts();
    if (folded) {
      await this.setSetting("schema_version", SCHEMA_VERSION);
    }
    return !wasReady;
  }
  /**
   * Fold the retired channel layer into accounts.
   *
   * Channels only ever supplied defaults: a fallback API key and base URL. Two
   * behaviours depended on that indirection and must be preserved exactly, or
   * upgrading would silently change which upstreams receive traffic:
   *
   *  1. An account with a blank key inherited the channel key at request time.
   *     Those credentials are copied onto the account, otherwise the account
   *     would suddenly have no key at all.
   *  2. Scheduling skipped accounts whose channel was disabled. Without the
   *     channel there is nothing left to express that, so such accounts are
   *     disabled individually rather than being quietly promoted to live.
   *
   * Guarded by a settings flag so it runs once, and wrapped so a database that
   * never had a channels table (a fresh deployment) is unaffected.
   */
  async migrateChannelsIntoAccounts() {
    if (await this.getSetting("channels_folded_into_accounts")) return true;
    const hasChannels = await this.queryOne(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'channels'"
    ).catch(() => null);
    if (!Number(hasChannels?.total || 0)) {
      await this.setSetting("channels_folded_into_accounts", (/* @__PURE__ */ new Date()).toISOString());
      return true;
    }
    try {
      await this.update(`
        UPDATE accounts SET api_key = COALESCE(
          (SELECT c.api_key FROM channels c WHERE c.id = accounts.channel_id), ''
        )
        WHERE (api_key IS NULL OR TRIM(api_key) = '')
          AND EXISTS (SELECT 1 FROM channels c
                      WHERE c.id = accounts.channel_id AND TRIM(COALESCE(c.api_key, '')) != '')
      `);
      await this.update(`
        UPDATE accounts SET base_url = COALESCE(
          (SELECT c.base_url FROM channels c WHERE c.id = accounts.channel_id), ''
        )
        WHERE (base_url IS NULL OR TRIM(base_url) = '')
          AND EXISTS (SELECT 1 FROM channels c
                      WHERE c.id = accounts.channel_id AND TRIM(COALESCE(c.base_url, '')) != '')
      `);
      await this.update(`
        UPDATE accounts SET rate_multiplier = COALESCE(
          (SELECT c.rate_multiplier FROM channels c WHERE c.id = accounts.channel_id), 1
        )
        WHERE (rate_multiplier IS NULL OR rate_multiplier = 1)
          AND EXISTS (SELECT 1 FROM channels c
                      WHERE c.id = accounts.channel_id
                        AND c.rate_multiplier IS NOT NULL AND c.rate_multiplier != 1)
      `).catch(() => {
      });
      await this.update(`
        UPDATE accounts SET enabled = 0
        WHERE EXISTS (SELECT 1 FROM channels c
                      WHERE c.id = accounts.channel_id AND c.enabled = 0)
      `);
      await this.setSetting("channels_folded_into_accounts", (/* @__PURE__ */ new Date()).toISOString());
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Add columns introduced after a database was first created.
   *
   * SQLite lacks `ADD COLUMN IF NOT EXISTS`, so the existing columns are read
   * from `PRAGMA table_info` and only genuinely missing ones are added. This
   * never rewrites or drops data.
   */
  async applyAdditiveColumns() {
    const tables = [...new Set(ADDITIVE_COLUMNS.map((entry) => entry.table))];
    const existing = /* @__PURE__ */ new Map();
    for (const table of tables) {
      try {
        const rows = await this.query(`PRAGMA table_info(${table})`);
        existing.set(table, new Set(rows.map((row) => row.name)));
      } catch {
      }
    }
    for (const { table, column, definition } of ADDITIVE_COLUMNS) {
      const columns = existing.get(table);
      if (!columns || columns.has(column)) continue;
      try {
        await this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      } catch {
      }
    }
  }
  /** Read a persisted setting, or null when it has never been written. */
  async getSetting(key) {
    try {
      const row = await this.queryOne("SELECT value FROM settings WHERE key = ?", [key]);
      return row?.value ?? null;
    } catch {
      return null;
    }
  }
  async setSetting(key, value) {
    try {
      await this.update(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        [key, value]
      );
    } catch {
      await this.update(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value]
      );
    }
  }
  /**
   * Store a value only if the key is unset, then return whatever is stored.
   *
   * Concurrent isolates can each generate a candidate session secret. Keeping
   * the first writer's value means tokens issued by one isolate still verify in
   * another, instead of logging users out at random.
   */
  async setSettingIfAbsent(key, value) {
    await this.update("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [key, value]);
    const row = await this.queryOne("SELECT value FROM settings WHERE key = ?", [key]);
    return row?.value ?? value;
  }
  /**
   * Cheap probe used to decide whether migration is needed.
   *
   * A failure propagates instead of reporting `false`. Treating an unreachable
   * database as "no tables yet" made the login screen offer to initialise a
   * deployment that was already set up, so callers must distinguish an empty
   * database from one it could not read.
   */
  async schemaReady() {
    const row = await this.queryOne(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name IN ('users','groups','accounts','model_mappings','api_keys','usage_records','request_logs')"
    );
    return Number(row?.total || 0) >= 7;
  }
  // Cleanup old logs
  async cleanupOldLogs(days = 7) {
    const cutoff = sqliteTimestamp(Date.now() - days * 24 * 60 * 60 * 1e3);
    await this.exec(`DELETE FROM request_logs WHERE created_at < '${cutoff}'`);
    await this.exec(`DELETE FROM usage_records WHERE created_at < '${cutoff}'`);
  }
};
function sqliteTimestamp(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
}
function createDatabase(db) {
  return new Database(db);
}

// functions/src/auth.ts
var PASSWORD_ITERATIONS = 1e5;
function toHex(bytes) {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
async function derivePassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return toHex(bits);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt);
  return `pbkdf2$${PASSWORD_ITERATIONS}$${toHex(salt)}$${hash}`;
}
async function verifyPassword(password, storedHash) {
  const parts = storedHash.split("$");
  if (parts.length === 4 && parts[0] === "pbkdf2") {
    const iterations = Number(parts[1]);
    if (!Number.isSafeInteger(iterations) || iterations < 1e4 || parts[2].length !== 32) return false;
    const actual = await derivePassword(password, fromHex(parts[2]), iterations);
    return actual === parts[3];
  }
  if (/^[0-9a-f]{64}$/i.test(storedHash)) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
    return toHex(digest).toLowerCase() === storedHash.toLowerCase();
  }
  return false;
}
async function authenticateUser(db, username, password) {
  const user = await db.getUserByUsername(username);
  if (!user || !await verifyPassword(password, user.password_hash)) return null;
  return {
    userId: user.id,
    username: user.username,
    isAdmin: true,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1e3
  };
}
async function signJwt(data, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}
async function createSessionToken(session, secret) {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({
    sub: session.userId,
    username: session.username,
    admin: session.isAdmin,
    exp: Math.floor(session.expiresAt / 1e3)
  }));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${await signJwt(signingInput, secret)}`;
}
async function verifySessionToken(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
    if (!payload.exp || Math.floor(Date.now() / 1e3) >= payload.exp) return null;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid || typeof payload.sub !== "number" || typeof payload.username !== "string") return null;
    return { userId: payload.sub, username: payload.username, isAdmin: payload.admin === true, expiresAt: payload.exp * 1e3 };
  } catch {
    return null;
  }
}
async function resolveSessionSecret(db, configured) {
  const explicit = String(configured || "").trim();
  if (explicit) return explicit;
  const stored = await db.getSetting("session_secret");
  if (stored) return stored;
  const generated = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return db.setSettingIfAbsent("session_secret", generated);
}
async function hashApiKey(apiKey) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return toHex(digest);
}
async function authenticateApiKey(db, apiKey) {
  const key = await db.getApiKeyByHash(await hashApiKey(apiKey));
  if (!key || !key.enabled) return null;
  if (key.quota_limit > 0 && key.balance >= key.quota_limit) return null;
  return key;
}

// functions/src/utils/proxy.ts
async function proxyRequest(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6e4);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? void 0 : request.body,
      redirect: "follow",
      signal: controller.signal
    });
    clearTimeout(timeout);
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      headers,
      body: response.body,
      text: () => response.text()
    };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}
function buildUpstreamHeaders(originalHeaders, provider, apiKey, baseUrl, clientSpoofing) {
  const headers = {};
  const preserveHeaders = [
    "content-type",
    "anthropic-version",
    "anthropic-beta",
    "x-api-key",
    "authorization"
  ];
  originalHeaders.forEach((value, key) => {
    if (preserveHeaders.includes(key.toLowerCase())) {
      headers[key] = value;
    }
  });
  switch (provider) {
    case "anthropic":
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
      headers["anthropic-beta"] = headers["anthropic-beta"] || "prompt-caching-2024-12-16,code-execution-2025-05-14";
      delete headers["authorization"];
      break;
    case "openai":
      headers["authorization"] = `Bearer ${apiKey}`;
      break;
    case "xai":
      headers["authorization"] = `Bearer ${apiKey}`;
      break;
    default:
      headers["authorization"] = `Bearer ${apiKey}`;
  }
  applyClientSpoofing(headers, provider, clientSpoofing);
  delete headers["host"];
  delete headers["cf-connecting-ip"];
  delete headers["cf-ray"];
  delete headers["cf-visitor"];
  delete headers["x-forwarded-for"];
  return headers;
}
var CLIENT_SPOOFING_PRESETS = {
  "codex": {
    "user-agent": "Codex CLI/0.1.0",
    "x-client-name": "openai-cli",
    "x-client-version": "0.1.0"
  },
  "codex-ws": {
    "user-agent": "Codex CLI/0.1.0 (WebSocket)",
    "x-client-name": "openai-cli",
    "x-client-version": "0.1.0"
  },
  "claude-code": {
    "user-agent": "claude-cli/1.0",
    "anthropic-beta": "code-execution-2025-05-14,computer-use-2025-07-15"
  },
  "claude-code-ws": {
    "user-agent": "claude-cli/1.0",
    "anthropic-beta": "code-execution-2025-05-14,computer-use-2025-07-15,web-search-2025-07-15"
  },
  "grok": {
    "user-agent": "xAI-Grok/1.0",
    "x-client-name": "grok-cli",
    "x-client-version": "1.0"
  }
};
function applyClientSpoofing(headers, provider, clientSpoofing) {
  if (!clientSpoofing || clientSpoofing.trim() === "") {
    return;
  }
  const preset = CLIENT_SPOOFING_PRESETS[clientSpoofing.toLowerCase()];
  if (preset) {
    for (const [key, value] of Object.entries(preset)) {
      if (key === "anthropic-beta" && provider !== "anthropic") {
        continue;
      }
      headers[key] = value;
    }
    return;
  }
  try {
    const customHeaders = JSON.parse(clientSpoofing);
    if (typeof customHeaders === "object" && customHeaders !== null) {
      for (const [key, value] of Object.entries(customHeaders)) {
        if (typeof value === "string") {
          headers[key] = value;
        }
      }
    }
  } catch {
  }
}
function resolveUpstreamCredentials(account) {
  return {
    apiKey: String(account?.api_key || "").trim(),
    baseUrl: String(account?.base_url || "").trim()
  };
}
function measureStreamTiming(body, startedAt, onDone) {
  let ttftMs = null;
  let settled = false;
  let tail = "";
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const decoder = new TextDecoder();
  const TAIL_LIMIT = 4096;
  const scan = (text) => {
    tail = (tail + text).slice(-TAIL_LIMIT);
    const prompt = /"(?:prompt_tokens|input_tokens)"\s*:\s*(\d+)/g;
    const completion = /"(?:completion_tokens|output_tokens)"\s*:\s*(\d+)/g;
    const total = /"total_tokens"\s*:\s*(\d+)/g;
    for (let m = prompt.exec(tail); m; m = prompt.exec(tail)) {
      usage.promptTokens = Math.max(usage.promptTokens, Number(m[1]) || 0);
    }
    for (let m = completion.exec(tail); m; m = completion.exec(tail)) {
      usage.completionTokens = Math.max(usage.completionTokens, Number(m[1]) || 0);
    }
    for (let m = total.exec(tail); m; m = total.exec(tail)) {
      usage.totalTokens = Math.max(usage.totalTokens, Number(m[1]) || 0);
    }
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    try {
      onDone({
        ttftMs,
        totalMs: Date.now() - startedAt,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens || usage.promptTokens + usage.completionTokens
      });
    } catch {
    }
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (ttftMs === null) ttftMs = Date.now() - startedAt;
      try {
        scan(decoder.decode(chunk, { stream: true }));
      } catch {
      }
    },
    flush() {
      finish();
    },
    cancel() {
      finish();
    }
  }));
}
function accountRateMultiplier(account) {
  const raw = account?.rate_multiplier;
  if (raw === null || raw === void 0 || raw === "") return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}
function getUpstreamBaseUrl(baseUrl, provider) {
  if (baseUrl && baseUrl.trim()) {
    return baseUrl.replace(/\/$/, "");
  }
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "xai":
      return "https://api.x.ai";
    case "openai":
    default:
      return "https://api.openai.com";
  }
}
function findModelMapping(requestedModel, mappings, provider) {
  const enabled = mappings.filter((mapping) => mapping.enabled && (!provider || mapping.provider === provider)).sort((a, b) => a.priority - b.priority || a.id - b.id);
  const exact = enabled.find((mapping) => mapping.requested_model === requestedModel);
  if (exact) return exact;
  return enabled.find((mapping) => {
    if (!mapping.requested_model.endsWith("*")) return false;
    return requestedModel.startsWith(mapping.requested_model.slice(0, -1));
  }) || null;
}

// functions/src/failover.ts
var ACCOUNT_LEVEL_FAILURES = /* @__PURE__ */ new Set([401, 402, 403, 404, 408, 409, 425, 429]);
var FailoverManager = class {
  errorWindows = /* @__PURE__ */ new Map();
  windowMs;
  errorRateThreshold;
  errorCountThreshold;
  db;
  lastUsed = /* @__PURE__ */ new Map();
  constructor(env) {
    const windowSeconds = Number(env.WINDOW_SECONDS);
    const errorRateThreshold = Number(env.ERROR_RATE_THRESHOLD);
    const errorCountThreshold = Number(env.ERROR_COUNT_THRESHOLD);
    this.windowMs = (Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 300) * 1e3;
    this.errorRateThreshold = Number.isFinite(errorRateThreshold) ? Math.min(Math.max(errorRateThreshold, 0), 1) : 0.5;
    this.errorCountThreshold = Number.isFinite(errorCountThreshold) && errorCountThreshold > 0 ? Math.floor(errorCountThreshold) : 5;
  }
  setDb(db) {
    this.db = db;
  }
  // Record request result for error tracking
  recordRequest(accountId, groupId, isError) {
    const now = Date.now();
    const key = accountId;
    let window = this.errorWindows.get(key);
    if (!window) {
      window = {
        accountId,
        groupId,
        timestamps: [],
        errors: []
      };
      this.errorWindows.set(key, window);
    }
    const cutoff = now - this.windowMs;
    while (window.timestamps.length > 0 && window.timestamps[0] < cutoff) {
      window.timestamps.shift();
      window.errors.shift();
    }
    window.timestamps.push(now);
    window.errors.push(isError ? 1 : 0);
  }
  // Get error stats for an account
  getMemoryErrorStats(accountId, group) {
    const window = this.errorWindows.get(accountId);
    if (!window) {
      return {
        accountId,
        groupId: 0,
        windowStart: Date.now() - this.windowMs,
        totalRequests: 0,
        errorCount: 0,
        errorRate: 0,
        isUnhealthy: false
      };
    }
    const totalRequests = window.timestamps.length;
    const errorCount = window.errors.reduce((sum, err) => sum + err, 0);
    const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0;
    const errorRateThreshold = group?.error_threshold ?? this.errorRateThreshold;
    const errorCountThreshold = group?.error_count_threshold ?? this.errorCountThreshold;
    return {
      accountId,
      groupId: window.groupId,
      windowStart: Date.now() - this.windowMs,
      totalRequests,
      errorCount,
      errorRate,
      isUnhealthy: errorRate > errorRateThreshold || errorCount >= errorCountThreshold
    };
  }
  async getErrorStats(accountId, group) {
    const windowSeconds = Math.max(1, Number(group?.window_seconds) || this.windowMs / 1e3);
    if (this.db) {
      try {
        const persisted = await this.db.getAccountErrorStats(accountId, windowSeconds);
        const totalRequests = Number(persisted.total_requests || 0);
        const errorCount = Number(persisted.error_count || 0);
        const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0;
        return {
          accountId,
          groupId: group?.id ?? 0,
          windowStart: Date.now() - windowSeconds * 1e3,
          totalRequests,
          errorCount,
          errorRate,
          isUnhealthy: errorRate > (group?.error_threshold ?? this.errorRateThreshold) || errorCount >= (group?.error_count_threshold ?? this.errorCountThreshold)
        };
      } catch {
      }
    }
    return this.getMemoryErrorStats(accountId, group);
  }
  // Select best account from available accounts
  async selectAccount(accounts, groups, preferredGroupId, fallbackGroupIds = []) {
    if (accounts.length === 0) return null;
    const usableAccounts = accounts.filter((acc) => {
      const group2 = groups.get(acc.group_id);
      return acc.enabled === 1 && Boolean(group2 && group2.enabled === 1);
    });
    if (usableAccounts.length === 0) return null;
    const primary = preferredGroupId ? usableAccounts.filter((acc) => acc.group_id === preferredGroupId) : [];
    const hasFallbackPolicy = Boolean(preferredGroupId && fallbackGroupIds.length);
    const initialAccounts = primary.length > 0 ? primary : hasFallbackPolicy ? usableAccounts.filter((acc) => fallbackGroupIds.includes(acc.group_id)) : usableAccounts;
    if (initialAccounts.length === 0) return null;
    const statsByAccount = new Map(
      await Promise.all(initialAccounts.map(async (acc) => [
        acc.id,
        await this.getErrorStats(acc.id, groups.get(acc.group_id))
      ]))
    );
    let healthyAccounts = initialAccounts.filter((acc) => !statsByAccount.get(acc.id).isUnhealthy);
    if (healthyAccounts.length === 0 && hasFallbackPolicy && primary.length > 0) {
      const fallback = usableAccounts.filter((acc) => fallbackGroupIds.includes(acc.group_id));
      if (fallback.length === 0) return null;
      const fallbackStats = await Promise.all(fallback.map(async (acc) => [
        acc.id,
        await this.getErrorStats(acc.id, groups.get(acc.group_id))
      ]));
      for (const [id, stats] of fallbackStats) statsByAccount.set(id, stats);
      healthyAccounts = fallback.filter((acc) => !statsByAccount.get(acc.id).isUnhealthy);
      if (healthyAccounts.length === 0) healthyAccounts = fallback;
    }
    if (healthyAccounts.length === 0) {
      healthyAccounts = [...initialAccounts].sort((a, b) => {
        const statsA = statsByAccount.get(a.id);
        const statsB = statsByAccount.get(b.id);
        return statsA.errorRate - statsB.errorRate || statsA.errorCount - statsB.errorCount;
      });
    }
    healthyAccounts.sort((a, b) => {
      const groupA = groups.get(a.group_id);
      const groupB = groups.get(b.group_id);
      const statsA = statsByAccount.get(a.id);
      const statsB = statsByAccount.get(b.id);
      return groupA.priority - groupB.priority || a.priority - b.priority || accountRateMultiplier(a) - accountRateMultiplier(b) || statsA.errorRate - statsB.errorRate || statsA.errorCount - statsB.errorCount || (this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0) || a.id - b.id;
    });
    const selected = healthyAccounts[0];
    const group = groups.get(selected.group_id);
    if (!group) return null;
    this.lastUsed.set(selected.id, Date.now());
    return {
      account: selected,
      group,
      stats: statsByAccount.get(selected.id) ?? null
    };
  }
  /** Persist a health probe result so the console can show liveness. */
  async recordHealthCheck(accountId, ok, latencyMs, message) {
    if (!this.db) return;
    await this.db.recordAccountHealthCheck(accountId, ok, latencyMs, message).catch(() => {
    });
  }
  // Check if error should trigger failover
  shouldFailover(error) {
    if (!error) return false;
    const status = error.status || error.statusCode || 0;
    if (status === 0 || status >= 500) return true;
    if (ACCOUNT_LEVEL_FAILURES.has(status)) return true;
    return false;
  }
  // Cleanup old windows periodically
  cleanup() {
    const now = Date.now();
    const cutoff = now - this.windowMs * 2;
    for (const [key, window] of this.errorWindows) {
      if (window.timestamps.length > 0 && window.timestamps[window.timestamps.length - 1] < cutoff) {
        this.errorWindows.delete(key);
      }
    }
  }
};

// functions/src/pricing.ts
var TOKENS_PER_UNIT = 1e6;
var OPENAI_RATES = [
  ["gpt-5.6-cyber", { prompt: 12.5, completion: 75 }],
  ["gpt-5.6-sol", { prompt: 4, completion: 20 }],
  ["gpt-5.6-terra", { prompt: 2, completion: 12 }],
  ["gpt-5.6-luna", { prompt: 0.2, completion: 1.2 }],
  ["gpt-5.5-cyber", { prompt: 12.5, completion: 75 }],
  ["gpt-5.5-pro", { prompt: 30, completion: 180 }],
  ["gpt-5.5", { prompt: 5, completion: 30 }]
];
var ANTHROPIC_RATES = [
  ["claude-opus-5", { prompt: 5, completion: 25 }],
  ["claude-opus-4-8", { prompt: 5, completion: 25 }],
  ["claude-opus-4.8", { prompt: 5, completion: 25 }]
];
var RATES_BY_PROVIDER = {
  openai: OPENAI_RATES,
  anthropic: ANTHROPIC_RATES,
  xai: []
};
var DEFAULT_RATE = { prompt: 1, completion: 3 };
function findTokenRate(provider, model) {
  const id = String(model || "").trim().toLowerCase();
  if (!id) return null;
  const table = RATES_BY_PROVIDER[provider] ?? [];
  let best = null;
  for (const [prefix, rate] of table) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.length)) {
      best = { length: prefix.length, rate };
    }
  }
  return best?.rate ?? null;
}
function priceTokens(tokens, ratePerMillion) {
  const count = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  return count / TOKENS_PER_UNIT * ratePerMillion;
}

// functions/src/billing.ts
function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 19968 && code <= 40959 || code >= 13312 && code <= 19903 || code >= 12288 && code <= 12351) {
      tokens += 2;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}
function extractTokenUsage(body, headers) {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  if (body?.usage) {
    promptTokens = body.usage.prompt_tokens || body.usage.input_tokens || 0;
    completionTokens = body.usage.completion_tokens || body.usage.output_tokens || 0;
    totalTokens = body.usage.total_tokens || promptTokens + completionTokens;
  }
  if (totalTokens === 0) {
    const inputText = typeof body?.messages === "string" ? body.messages : JSON.stringify(body?.messages || body?.input || "");
    const outputText = typeof body?.output === "string" ? body.output : JSON.stringify(body?.output || body?.content || "");
    promptTokens = estimateTokens(inputText);
    completionTokens = estimateTokens(outputText);
    totalTokens = promptTokens + completionTokens;
  }
  return { promptTokens, completionTokens, totalTokens };
}
function calculateCostBreakdown(provider, model, promptTokens, completionTokens, multiplier = 1) {
  const published = findTokenRate(provider, model);
  const rates = published || DEFAULT_RATE;
  const raw = priceTokens(promptTokens, rates.prompt) + priceTokens(completionTokens, rates.completion);
  const baseCost = round6(raw);
  const safeMultiplier = readMultiplier(multiplier);
  return {
    baseCost,
    cost: round6(baseCost * safeMultiplier),
    multiplier: safeMultiplier,
    estimated: !published
  };
}
function readMultiplier(value) {
  if (value === null || value === void 0 || value === "") return 1;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

// functions/src/utils/record.ts
var STREAM_RECORD_TIMEOUT_MS = 15 * 60 * 1e3;
function streamWithRecording(body, status, headers, context) {
  const isError = status >= 400;
  let settle;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });
  const measured = measureStreamTiming(body, context.startedAt, (outcome) => settle(outcome));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0, ttftMs: null, totalMs: Date.now() - context.startedAt }),
      STREAM_RECORD_TIMEOUT_MS
    );
  });
  const settled = Promise.race([finished, timeout]).then((outcome) => {
    if (timer !== void 0) clearTimeout(timer);
    return outcome;
  });
  const persist2 = settled.then(async (outcome) => {
    const breakdown = isError ? { baseCost: 0, cost: 0, multiplier: context.rateMultiplier, estimated: false } : calculateCostBreakdown(
      context.provider,
      context.model,
      outcome.promptTokens,
      outcome.completionTokens,
      context.rateMultiplier
    );
    const cost = breakdown.cost;
    if (cost > 0) {
      await context.db.incrementApiKeyUsage(context.keyRecordId, cost).catch(() => {
      });
    }
    await context.db.createUsageRecord({
      api_key_id: context.keyRecordId,
      group_id: context.groupId,
      account_id: context.accountId,
      model: context.model,
      provider: context.provider,
      prompt_tokens: outcome.promptTokens,
      completion_tokens: outcome.completionTokens,
      total_tokens: outcome.totalTokens,
      cost,
      base_cost: breakdown.baseCost,
      rate_multiplier: breakdown.multiplier,
      cost_estimated: breakdown.estimated ? 1 : 0,
      cache_status: "bypass",
      status,
      error_message: isError ? "Upstream error" : "",
      latency_ms: outcome.totalMs,
      ttft_ms: outcome.ttftMs ?? void 0
    }).catch(() => {
    });
    await context.db.createRequestLog({
      account_id: context.accountId,
      group_id: context.groupId,
      model: context.model,
      status,
      error_message: isError ? "Upstream error" : "",
      latency_ms: outcome.totalMs,
      ttft_ms: outcome.ttftMs ?? void 0
    }).catch(() => {
    });
  }).catch(() => {
  });
  context.ctx?.waitUntil?.(persist2);
  context.failover.recordRequest(context.accountId, context.groupId, isError);
  return new Response(measured, {
    status,
    headers: { ...headers, "content-type": headers["content-type"] || "text/event-stream" }
  });
}

// functions/src/utils/background.ts
function defer(ctx, work) {
  const guarded = work.catch(() => {
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(guarded);
  }
}

// functions/src/utils/routing-cache.ts
var TTL_MS = 5e3;
var snapshots = /* @__PURE__ */ new WeakMap();
var hits = 0;
var misses = 0;
async function loadRoutingSnapshot(db, identity) {
  const now = Date.now();
  const cached = snapshots.get(identity);
  if (cached && now - cached.loadedAt < TTL_MS) {
    hits += 1;
    return cached.value;
  }
  misses += 1;
  const [accounts, groups, mappings] = await Promise.all([
    db.listEnabledAccounts(),
    db.listGroups(),
    db.listModelMappings()
  ]);
  const value = { accounts, groups, mappings };
  snapshots.set(identity, { loadedAt: now, value });
  return value;
}
function invalidateRoutingSnapshot(identity) {
  snapshots.delete(identity);
}
function routingCacheMetrics() {
  const samples = hits + misses;
  return {
    hits,
    misses,
    samples,
    hit_rate: samples ? Math.round(hits / samples * 1e4) / 100 : 0,
    ttl_ms: TTL_MS
  };
}

// functions/src/routes/gateway.ts
async function handleGatewayRequest(request, env, failover, ctx) {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Missing API key" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const apiKey = authHeader.slice(7);
  const keyRecord = await authenticateApiKey(db, apiKey);
  if (!keyRecord) {
    return new Response(JSON.stringify({ error: "Invalid or disabled API key" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const body = await request.text();
  let requestBody;
  try {
    requestBody = body.trim() ? JSON.parse(body) : {};
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const model = requestBody.model || "";
  const stream = requestBody.stream === true;
  let provider = "openai";
  const pathLower = url.pathname.toLowerCase();
  if (pathLower.includes("/claude") || pathLower.includes("/anthropic") || model.startsWith("claude-")) {
    provider = "anthropic";
  } else if (pathLower.includes("/grok") || model.startsWith("grok-")) {
    provider = "xai";
  } else if (pathLower.includes("/openai") || pathLower.includes("/chat/completions") || pathLower.includes("/responses")) {
    provider = "openai";
  }
  const routing = await loadRoutingSnapshot(db, failover);
  let accounts = routing.accounts;
  const groups = new Map(routing.groups.map((g) => [g.id, g]));
  const mappings = routing.mappings;
  const mapping = findModelMapping(model, mappings);
  if (mapping?.provider) provider = mapping.provider;
  accounts = accounts.filter((a) => a.provider === provider && a.enabled);
  const keyGroupId = Number(keyRecord?.group_id) || 0;
  const fallbackGroupId = Number(keyRecord?.fallback_group_id) || 0;
  if (keyGroupId) {
    accounts = accounts.filter((account2) => Number(account2.group_id) === keyGroupId || Number(account2.group_id) === fallbackGroupId);
    if (accounts.length === 0) {
      return new Response(JSON.stringify({
        error: "No available accounts",
        message: "\u8BE5 API \u5BC6\u94A5\u7ED1\u5B9A\u7684\u4E3B\u5206\u7EC4\u548C\u515C\u5E95\u5206\u7EC4\u4E0B\u6CA1\u6709\u53EF\u7528\u8D26\u53F7"
      }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
  }
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: "No available accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const providerMapping = mapping && mapping.provider === provider ? mapping : findModelMapping(model, mappings, provider);
  let upstreamModel = providerMapping?.requested_model.endsWith("*") ? providerMapping.upstream_model + model.slice(providerMapping.requested_model.length - 1) : providerMapping?.upstream_model || model;
  const preferredGroupId = keyGroupId || providerMapping?.group_id || void 0;
  const selection = await failover.selectAccount(accounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : []);
  if (!selection) {
    return new Response(JSON.stringify({ error: "No available accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const { account, group, stats } = selection;
  const credentials = resolveUpstreamCredentials(account);
  const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, provider);
  let upstreamPath = url.pathname;
  if (provider === "anthropic") {
    if (!upstreamPath.includes("/v1/messages")) {
      upstreamPath = "/v1/messages";
    }
  } else if (provider === "openai" && upstreamPath.includes("/chat/completions")) {
  } else if (provider === "xai") {
    if (!upstreamPath.includes("/chat/completions")) {
      upstreamPath = "/v1/chat/completions";
    }
  }
  const upstreamUrl = new URL(`${baseUrl}${upstreamPath}`);
  if (provider === "anthropic") upstreamUrl.searchParams.set("beta", "true");
  const headers = buildUpstreamHeaders(request.headers, provider, credentials.apiKey, credentials.baseUrl, account.client_spoofing);
  if (upstreamModel && upstreamModel !== model && requestBody.model) {
    requestBody.model = upstreamModel;
  }
  const upstreamBody = request.method === "GET" || request.method === "HEAD" ? void 0 : upstreamModel !== model ? JSON.stringify(requestBody) : body;
  const startTime = Date.now();
  let isError = false;
  let errorMessage = "";
  let responseStatus = 200;
  try {
    const proxyResponse = await proxyRequest({
      url: upstreamUrl.toString(),
      method: request.method,
      headers,
      body: new ReadableStream({
        start(controller) {
          if (upstreamBody !== void 0) controller.enqueue(new TextEncoder().encode(upstreamBody));
          controller.close();
        }
      })
    });
    responseStatus = proxyResponse.status;
    isError = responseStatus >= 400;
    if (isError && failover.shouldFailover({ status: responseStatus }) && accounts.length > 1) {
      await proxyResponse.text().catch(() => "");
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: responseStatus, error_message: `Upstream returned ${responseStatus}`, latency_ms: Date.now() - startTime }));
      return handleFailover(upstreamBody, request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), groups, mappings, provider, upstreamModel, stream, `Upstream returned ${responseStatus}`, preferredGroupId, startTime, ctx, fallbackGroupId);
    }
    if (stream && proxyResponse.body) {
      return streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
        db,
        failover,
        keyRecordId: keyRecord.id,
        accountId: account.id,
        groupId: group.id,
        provider,
        model: upstreamModel,
        rateMultiplier: accountRateMultiplier(account),
        startedAt: startTime,
        ctx
      });
    }
    const responseText = await proxyResponse.text();
    let responseBody = {};
    try {
      responseBody = JSON.parse(responseText);
    } catch {
    }
    const { promptTokens, completionTokens, totalTokens } = extractTokenUsage(responseBody, proxyResponse.headers);
    const breakdown = calculateCostBreakdown(provider, upstreamModel, promptTokens, completionTokens, accountRateMultiplier(account));
    const cost = breakdown.cost;
    if (cost > 0) {
      defer(ctx, db.incrementApiKeyUsage(keyRecord.id, cost));
    }
    defer(ctx, db.createUsageRecord({ api_key_id: keyRecord.id, group_id: group.id, account_id: account.id, model: upstreamModel, provider, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, base_cost: breakdown.baseCost, rate_multiplier: breakdown.multiplier, cost_estimated: breakdown.estimated ? 1 : 0, cache_status: "bypass", status: responseStatus, error_message: isError ? responseBody?.error?.message || "Error" : "", latency_ms: Date.now() - startTime }));
    defer(ctx, db.createRequestLog({
      account_id: account.id,
      group_id: group.id,
      model: upstreamModel,
      status: responseStatus,
      error_message: isError ? errorMessage : "",
      latency_ms: Date.now() - startTime
    }));
    failover.recordRequest(account.id, group.id, isError);
    return new Response(responseText, {
      status: proxyResponse.status,
      headers: {
        ...proxyResponse.headers,
        "content-type": "application/json",
        "cache-control": "no-store, no-transform"
      }
    });
  } catch (error) {
    isError = true;
    errorMessage = error instanceof Error ? error.message : "Unknown error";
    responseStatus = 502;
    failover.recordRequest(account.id, group.id, true);
    defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: errorMessage, latency_ms: Date.now() - startTime }));
    return handleFailover(upstreamBody, request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), groups, mappings, provider, upstreamModel, stream, errorMessage, preferredGroupId, startTime, ctx, fallbackGroupId);
  }
}
async function handleFailover(body, request, env, failover, keyRecord, accounts, groups, mappings, provider, upstreamModel, stream, errorMessage, preferredGroupId, originStart = Date.now(), ctx, fallbackGroupId = 0) {
  const db = createDatabase(env.DB);
  const attempted = /* @__PURE__ */ new Set();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    const nextAccounts = accounts.filter((a) => a.enabled && !attempted.has(a.id));
    const selection = await failover.selectAccount(nextAccounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : []);
    if (!selection) {
      break;
    }
    const { account, group } = selection;
    attempted.add(account.id);
    try {
      const credentials = resolveUpstreamCredentials(account);
      const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, provider);
      const url = new URL(request.url);
      let upstreamPath = url.pathname;
      if (provider === "anthropic" && !upstreamPath.includes("/v1/messages")) {
        upstreamPath = "/v1/messages";
      } else if (provider === "xai" && !upstreamPath.includes("/chat/completions")) {
        upstreamPath = "/v1/chat/completions";
      }
      const retryUrl = new URL(`${baseUrl}${upstreamPath}`);
      if (provider === "anthropic") retryUrl.searchParams.set("beta", "true");
      const headers = buildUpstreamHeaders(request.headers, provider, credentials.apiKey, credentials.baseUrl, account.client_spoofing);
      const proxyResponse = await proxyRequest({
        url: retryUrl.toString(),
        method: request.method,
        headers,
        body: new ReadableStream({
          start(controller) {
            if (body !== void 0) controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          }
        })
      });
      const isError = proxyResponse.status >= 400;
      if (isError && failover.shouldFailover({ status: proxyResponse.status }) && i < maxRetries - 1) {
        failover.recordRequest(account.id, group.id, true);
        continue;
      }
      if (stream && !isError && proxyResponse.body) {
        return streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
          db,
          failover,
          keyRecordId: keyRecord.id,
          accountId: account.id,
          groupId: group.id,
          provider,
          model: upstreamModel,
          rateMultiplier: accountRateMultiplier(account),
          startedAt: originStart,
          ctx
        });
      }
      failover.recordRequest(account.id, group.id, isError);
      defer(ctx, db.createRequestLog({
        account_id: account.id,
        group_id: group.id,
        model: upstreamModel,
        status: proxyResponse.status,
        error_message: isError ? "Upstream error" : "",
        latency_ms: 0
      }));
      const responseText = await proxyResponse.text();
      return new Response(responseText, {
        status: proxyResponse.status,
        headers: { ...proxyResponse.headers, "content-type": "application/json", "cache-control": "no-store, no-transform" }
      });
    } catch (retryError) {
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: retryError instanceof Error ? retryError.message : "Upstream request failed", latency_ms: 0 }));
      continue;
    }
  }
  return new Response(JSON.stringify({
    error: "All accounts failed",
    message: errorMessage
  }), {
    status: 502,
    headers: { "Content-Type": "application/json" }
  });
}

// functions/src/utils/headers.ts
function getModelFromHeader(request) {
  const preferredHeaders = [
    "x-requested-model",
    "x-model",
    "model"
  ];
  for (const name of preferredHeaders) {
    const value = request.headers.get(name);
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

// functions/src/routes/openai.ts
async function handleOpenAIRequest(request, env, failover, ctx) {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Missing API key" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const apiKey = authHeader.slice(7);
  const keyRecord = await authenticateApiKey(db, apiKey);
  if (!keyRecord) {
    return new Response(JSON.stringify({ error: "Invalid or disabled API key" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const body = await request.text();
  let requestBody;
  try {
    requestBody = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const model = requestBody.model || getModelFromHeader(request) || "";
  const stream = requestBody.stream === true;
  const isResponses = url.pathname.includes("/responses");
  let endpoint = "/v1/chat/completions";
  if (isResponses) {
    endpoint = "/v1/responses";
  }
  const routing = await loadRoutingSnapshot(db, failover);
  let accounts = routing.accounts;
  accounts = accounts.filter((a) => (a.provider === "openai" || a.provider === "xai") && a.enabled);
  const keyGroupId = Number(keyRecord?.group_id) || 0;
  const fallbackGroupId = Number(keyRecord?.fallback_group_id) || 0;
  if (keyGroupId) {
    accounts = accounts.filter((account2) => Number(account2.group_id) === keyGroupId || Number(account2.group_id) === fallbackGroupId);
    if (accounts.length === 0) {
      return new Response(JSON.stringify({
        error: "No available accounts",
        message: "\u8BE5 API \u5BC6\u94A5\u7ED1\u5B9A\u7684\u4E3B\u5206\u7EC4\u548C\u515C\u5E95\u5206\u7EC4\u4E0B\u6CA1\u6709\u53EF\u7528\u8D26\u53F7"
      }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
  }
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: "No available accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const groups = new Map(routing.groups.map((g) => [g.id, g]));
  const mappings = routing.mappings;
  const mapping = findModelMapping(model, mappings, "openai") || findModelMapping(model, mappings, "xai");
  const requestedProvider = mapping?.provider || (model.toLowerCase().startsWith("grok-") ? "xai" : void 0);
  if (requestedProvider) {
    accounts = accounts.filter((account2) => account2.provider === requestedProvider);
  }
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: "No available accounts for requested model" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  let upstreamModel = mapping?.requested_model.endsWith("*") ? mapping.upstream_model + model.slice(mapping.requested_model.length - 1) : mapping?.upstream_model || model;
  const preferredGroupId = keyGroupId || mapping?.group_id || void 0;
  if (upstreamModel && upstreamModel !== model && requestBody.model) {
    requestBody.model = upstreamModel;
  }
  const selection = await failover.selectAccount(accounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : []);
  if (!selection) {
    return new Response(JSON.stringify({ error: "No available accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const { account, group } = selection;
  const provider = account.provider;
  const credentials = resolveUpstreamCredentials(account);
  const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, provider);
  const upstreamUrl = `${baseUrl}${endpoint}`;
  const headers = buildUpstreamHeaders(request.headers, provider, credentials.apiKey, credentials.baseUrl, account.client_spoofing);
  const startTime = Date.now();
  try {
    const proxyResponse = await proxyRequest({
      url: upstreamUrl,
      method: request.method,
      headers,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody)));
          controller.close();
        }
      })
    });
    const isError = proxyResponse.status >= 400;
    if (isError && failover.shouldFailover({ status: proxyResponse.status }) && accounts.length > 1) {
      await proxyResponse.text().catch(() => "");
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: proxyResponse.status, error_message: `Upstream returned ${proxyResponse.status}`, latency_ms: Date.now() - startTime }));
      return handleFailover2(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), groups, mappings, provider, upstreamModel, stream, `Upstream returned ${proxyResponse.status}`, preferredGroupId, startTime, ctx, fallbackGroupId);
    }
    if (stream && proxyResponse.body) {
      return streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
        db,
        failover,
        keyRecordId: keyRecord.id,
        accountId: account.id,
        groupId: group.id,
        provider,
        model: upstreamModel,
        rateMultiplier: accountRateMultiplier(account),
        startedAt: startTime,
        ctx
      });
    }
    const responseText = await proxyResponse.text();
    let responseBody = {};
    try {
      responseBody = JSON.parse(responseText);
    } catch {
    }
    const { promptTokens, completionTokens, totalTokens } = extractTokenUsage(responseBody, proxyResponse.headers);
    const breakdown = calculateCostBreakdown(provider, upstreamModel, promptTokens, completionTokens, accountRateMultiplier(account));
    const cost = breakdown.cost;
    if (cost > 0) {
      defer(ctx, db.incrementApiKeyUsage(keyRecord.id, cost));
    }
    defer(ctx, db.createUsageRecord({ api_key_id: keyRecord.id, group_id: group.id, account_id: account.id, model: upstreamModel, provider, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, base_cost: breakdown.baseCost, rate_multiplier: breakdown.multiplier, cost_estimated: breakdown.estimated ? 1 : 0, cache_status: "bypass", status: proxyResponse.status, error_message: isError ? responseBody?.error?.message || "Error" : "", latency_ms: Date.now() - startTime }));
    defer(ctx, db.createRequestLog({
      account_id: account.id,
      group_id: group.id,
      model: upstreamModel,
      status: proxyResponse.status,
      error_message: isError ? responseBody?.error?.message || "Error" : "",
      latency_ms: Date.now() - startTime
    }));
    failover.recordRequest(account.id, group.id, isError);
    return new Response(responseText, {
      status: proxyResponse.status,
      headers: {
        ...proxyResponse.headers,
        "content-type": "application/json",
        "cache-control": "no-store, no-transform"
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    failover.recordRequest(account.id, group.id, true);
    defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: errorMessage, latency_ms: Date.now() - startTime }));
    return handleFailover2(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), groups, mappings, provider, upstreamModel, stream, errorMessage, preferredGroupId, startTime, ctx, fallbackGroupId);
  }
}
async function handleFailover2(body, request, env, failover, keyRecord, accounts, groups, mappings, provider, upstreamModel, stream, errorMessage, preferredGroupId, originStart = Date.now(), ctx, fallbackGroupId = 0) {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const isResponses = url.pathname.includes("/responses");
  let endpoint = "/v1/chat/completions";
  if (isResponses) endpoint = "/v1/responses";
  const attempted = /* @__PURE__ */ new Set();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    const nextAccounts = accounts.filter((a) => a.enabled && !attempted.has(a.id));
    const selection = await failover.selectAccount(nextAccounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : []);
    if (!selection) break;
    const { account, group } = selection;
    attempted.add(account.id);
    const currentProvider = account.provider;
    try {
      const credentials = resolveUpstreamCredentials(account);
      const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, currentProvider);
      const upstreamUrl = `${baseUrl}${endpoint}`;
      const headers = buildUpstreamHeaders(request.headers, currentProvider, credentials.apiKey, credentials.baseUrl, account.client_spoofing);
      const proxyResponse = await proxyRequest({
        url: upstreamUrl,
        method: request.method,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          }
        })
      });
      const isError = proxyResponse.status >= 400;
      if (isError && failover.shouldFailover({ status: proxyResponse.status }) && i < maxRetries - 1) {
        failover.recordRequest(account.id, group.id, true);
        continue;
      }
      if (stream && !isError && proxyResponse.body) {
        return streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
          db,
          failover,
          keyRecordId: keyRecord.id,
          accountId: account.id,
          groupId: group.id,
          provider: currentProvider,
          model: upstreamModel,
          rateMultiplier: accountRateMultiplier(account),
          startedAt: originStart,
          ctx
        });
      }
      failover.recordRequest(account.id, group.id, isError);
      defer(ctx, db.createRequestLog({
        account_id: account.id,
        group_id: group.id,
        model: upstreamModel,
        status: proxyResponse.status,
        error_message: isError ? errorMessage : "",
        latency_ms: 0
      }));
      const responseText = await proxyResponse.text();
      return new Response(responseText, {
        status: proxyResponse.status,
        headers: { ...proxyResponse.headers, "content-type": "application/json", "cache-control": "no-store, no-transform" }
      });
    } catch (retryError) {
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: retryError instanceof Error ? retryError.message : "Upstream request failed", latency_ms: 0 }));
      continue;
    }
  }
  return new Response(JSON.stringify({ error: "All accounts failed", message: errorMessage }), { status: 502, headers: { "Content-Type": "application/json" } });
}

// functions/src/routes/claude.ts
async function handleClaudeRequest(request, env, failover, ctx) {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization");
  const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : request.headers.get("x-api-key");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing API key" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const keyRecord = await authenticateApiKey(db, apiKey);
  if (!keyRecord) {
    return new Response(JSON.stringify({ error: "Invalid or disabled API key" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const body = await request.text();
  let requestBody;
  try {
    requestBody = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const model = requestBody.model || getModelFromHeader(request) || "";
  const stream = requestBody.stream === true;
  const routing = await loadRoutingSnapshot(db, failover);
  let accounts = routing.accounts;
  accounts = accounts.filter((a) => a.provider === "anthropic" && a.enabled);
  const keyGroupId = Number(keyRecord?.group_id) || 0;
  const fallbackGroupId = Number(keyRecord?.fallback_group_id) || 0;
  if (keyGroupId) {
    accounts = accounts.filter((account2) => Number(account2.group_id) === keyGroupId || Number(account2.group_id) === fallbackGroupId);
    if (accounts.length === 0) {
      return new Response(JSON.stringify({
        error: "No available accounts",
        message: "\u8BE5 API \u5BC6\u94A5\u7ED1\u5B9A\u7684\u4E3B\u5206\u7EC4\u548C\u515C\u5E95\u5206\u7EC4\u4E0B\u6CA1\u6709\u53EF\u7528\u8D26\u53F7"
      }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
  }
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: "No available Anthropic accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const groups = new Map(routing.groups.map((g) => [g.id, g]));
  const mappings = routing.mappings;
  const mapping = findModelMapping(model, mappings, "anthropic");
  let upstreamModel = mapping?.requested_model.endsWith("*") ? mapping.upstream_model + model.slice(mapping.requested_model.length - 1) : mapping?.upstream_model || model;
  const preferredGroupId = keyGroupId || mapping?.group_id || void 0;
  if (upstreamModel && upstreamModel !== model && requestBody.model) {
    requestBody.model = upstreamModel;
  }
  const selection = await failover.selectAccount(accounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : []);
  if (!selection) {
    return new Response(JSON.stringify({ error: "No available accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const { account, group } = selection;
  const credentials = resolveUpstreamCredentials(account);
  const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, "anthropic");
  const upstreamUrl = `${baseUrl}/v1/messages?beta=true`;
  const headers = buildUpstreamHeaders(request.headers, "anthropic", credentials.apiKey, credentials.baseUrl, account.client_spoofing);
  const startTime = Date.now();
  try {
    const proxyResponse = await proxyRequest({
      url: upstreamUrl,
      method: request.method,
      headers,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody)));
          controller.close();
        }
      })
    });
    const isError = proxyResponse.status >= 400;
    if (isError && failover.shouldFailover({ status: proxyResponse.status }) && accounts.length > 1) {
      await proxyResponse.text().catch(() => "");
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: proxyResponse.status, error_message: `Upstream returned ${proxyResponse.status}`, latency_ms: Date.now() - startTime }));
      return handleClaudeFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), groups, mappings, upstreamModel, stream, `Upstream returned ${proxyResponse.status}`, preferredGroupId, startTime, ctx, fallbackGroupId);
    }
    if (stream && proxyResponse.body) {
      return streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
        db,
        failover,
        keyRecordId: keyRecord.id,
        accountId: account.id,
        groupId: group.id,
        provider: "anthropic",
        model: upstreamModel,
        rateMultiplier: accountRateMultiplier(account),
        startedAt: startTime,
        ctx
      });
    }
    const responseText = await proxyResponse.text();
    let responseBody = {};
    try {
      responseBody = JSON.parse(responseText);
    } catch {
    }
    const { promptTokens, completionTokens, totalTokens } = extractTokenUsage(responseBody, proxyResponse.headers);
    const breakdown = calculateCostBreakdown("anthropic", upstreamModel, promptTokens, completionTokens, accountRateMultiplier(account));
    const cost = breakdown.cost;
    if (cost > 0) {
      defer(ctx, db.incrementApiKeyUsage(keyRecord.id, cost));
    }
    defer(ctx, db.createUsageRecord({ api_key_id: keyRecord.id, group_id: group.id, account_id: account.id, model: upstreamModel, provider: "anthropic", prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, base_cost: breakdown.baseCost, rate_multiplier: breakdown.multiplier, cost_estimated: breakdown.estimated ? 1 : 0, cache_status: "bypass", status: proxyResponse.status, error_message: isError ? responseBody?.error?.message || "Error" : "", latency_ms: Date.now() - startTime }));
    defer(ctx, db.createRequestLog({
      account_id: account.id,
      group_id: group.id,
      model: upstreamModel,
      status: proxyResponse.status,
      error_message: isError ? responseBody?.error?.message || "Error" : "",
      latency_ms: Date.now() - startTime
    }));
    failover.recordRequest(account.id, group.id, isError);
    return new Response(responseText, {
      status: proxyResponse.status,
      headers: {
        ...proxyResponse.headers,
        "content-type": "application/json",
        "cache-control": "no-store, no-transform"
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    failover.recordRequest(account.id, group.id, true);
    defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: errorMessage, latency_ms: Date.now() - startTime }));
    return handleClaudeFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), groups, mappings, upstreamModel, stream, errorMessage, preferredGroupId, startTime, ctx, fallbackGroupId);
  }
}
async function handleClaudeFailover(body, request, env, failover, keyRecord, accounts, groups, mappings, upstreamModel, stream, errorMessage, preferredGroupId, originStart = Date.now(), ctx, fallbackGroupId = 0) {
  const db = createDatabase(env.DB);
  const attempted = /* @__PURE__ */ new Set();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    const nextAccounts = accounts.filter((a) => a.enabled && !attempted.has(a.id));
    const selection = await failover.selectAccount(nextAccounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : []);
    if (!selection) break;
    const { account, group } = selection;
    attempted.add(account.id);
    try {
      const credentials = resolveUpstreamCredentials(account);
      const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, "anthropic");
      const upstreamUrl = `${baseUrl}/v1/messages?beta=true`;
      const headers = buildUpstreamHeaders(request.headers, "anthropic", credentials.apiKey, credentials.baseUrl, account.client_spoofing);
      const proxyResponse = await proxyRequest({
        url: upstreamUrl,
        method: request.method,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          }
        })
      });
      const isError = proxyResponse.status >= 400;
      if (isError && failover.shouldFailover({ status: proxyResponse.status }) && i < maxRetries - 1) {
        failover.recordRequest(account.id, group.id, true);
        continue;
      }
      if (stream && !isError && proxyResponse.body) {
        return streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
          db,
          failover,
          keyRecordId: keyRecord.id,
          accountId: account.id,
          groupId: group.id,
          provider: "anthropic",
          model: upstreamModel,
          rateMultiplier: accountRateMultiplier(account),
          startedAt: originStart,
          ctx
        });
      }
      failover.recordRequest(account.id, group.id, isError);
      defer(ctx, db.createRequestLog({
        account_id: account.id,
        group_id: group.id,
        model: upstreamModel,
        status: proxyResponse.status,
        error_message: isError ? errorMessage : "",
        latency_ms: 0
      }));
      const responseText = await proxyResponse.text();
      return new Response(responseText, {
        status: proxyResponse.status,
        headers: { ...proxyResponse.headers, "content-type": "application/json", "cache-control": "no-store, no-transform" }
      });
    } catch (retryError) {
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: retryError instanceof Error ? retryError.message : "Upstream request failed", latency_ms: 0 }));
      continue;
    }
  }
  return new Response(JSON.stringify({ error: "All Anthropic accounts failed", message: errorMessage }), { status: 502, headers: { "Content-Type": "application/json" } });
}

// functions/src/config/groups.ts
async function handleGroupsRequest(request, env, ctx) {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const method = request.method;
  {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const token = authHeader.slice(7);
    const session = await verifySessionToken(token, await resolveSessionSecret(db, env.JWT_SECRET));
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }
  if (method === "GET") {
    const groups = await db.listGroups();
    return jsonData(groups);
  }
  if (method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }
    const name = String(body.name || "").trim();
    if (!name) return jsonError("\u8BF7\u586B\u5199\u5206\u7EC4\u540D\u79F0", 400);
    const thresholds = readThresholds(body);
    if (typeof thresholds === "string") return jsonError(thresholds, 400);
    if (await db.getGroupByName(name)) return jsonError(`\u5206\u7EC4\u540D\u79F0\u300C${name}\u300D\u5DF2\u5B58\u5728`, 409);
    const result = await db.createGroup(name, String(body.description || "").trim(), Number(body.priority) || 0, {
      enabled: body.enabled === false || body.enabled === 0 ? 0 : 1,
      ...thresholds
    });
    const group = await db.getGroup(result.lastRowId);
    return jsonData(group, 201);
  }
  if (method === "PUT") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    if (!id) return jsonError("Invalid group ID", 400);
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }
    if (!await db.getGroup(id)) return jsonError("\u5206\u7EC4\u4E0D\u5B58\u5728", 404);
    const updates = {};
    if (body.name !== void 0) {
      const name = String(body.name).trim();
      if (!name) return jsonError("\u5206\u7EC4\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A", 400);
      const clash = await db.getGroupByName(name);
      if (clash && Number(clash.id) !== id) return jsonError(`\u5206\u7EC4\u540D\u79F0\u300C${name}\u300D\u5DF2\u5B58\u5728`, 409);
      updates.name = name;
    }
    if (body.description !== void 0) updates.description = String(body.description).trim();
    if (body.priority !== void 0) updates.priority = Number(body.priority) || 0;
    if (body.enabled !== void 0) updates.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;
    const thresholds = readThresholds(body, true);
    if (typeof thresholds === "string") return jsonError(thresholds, 400);
    Object.assign(updates, thresholds);
    await db.updateGroup(id, updates);
    const group = await db.getGroup(id);
    return jsonData(group);
  }
  if (method === "DELETE") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    if (!id) return jsonError("Invalid group ID", 400);
    const attached = await db.countAccountsInGroup(id);
    if (attached > 0) {
      return jsonError(`\u8BE5\u5206\u7EC4\u4E0B\u8FD8\u6709 ${attached} \u4E2A\u8D26\u53F7\uFF0C\u8BF7\u5148\u79FB\u52A8\u6216\u5220\u9664\u8FD9\u4E9B\u8D26\u53F7`, 400);
    }
    const mapped = await db.countModelMappingsForGroup(id);
    if (mapped > 0) {
      return jsonError(`\u8BE5\u5206\u7EC4\u4ECD\u88AB ${mapped} \u6761\u6A21\u578B\u6620\u5C04\u5F15\u7528\uFF0C\u8BF7\u5148\u8C03\u6574\u6620\u5C04`, 400);
    }
    await db.deleteGroup(id);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: JSON_HEADERS });
  }
  return jsonError("Method not allowed", 405);
}
var JSON_HEADERS = { "Content-Type": "application/json" };
function jsonData(data, status = 200) {
  return new Response(JSON.stringify({ data }), { status, headers: JSON_HEADERS });
}
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}
function readThresholds(body, partial = false) {
  const result = {};
  if (body.error_threshold !== void 0) {
    const rate = Number(body.error_threshold);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) return "\u9519\u8BEF\u7387\u9608\u503C\u5FC5\u987B\u5728 0 \u5230 1 \u4E4B\u95F4";
    result.error_threshold = rate;
  } else if (!partial) {
    result.error_threshold = 0.5;
  }
  if (body.error_count_threshold !== void 0) {
    const count = Number(body.error_count_threshold);
    if (!Number.isInteger(count) || count < 1) return "\u9519\u8BEF\u6B21\u6570\u9608\u503C\u5FC5\u987B\u662F\u4E0D\u5C0F\u4E8E 1 \u7684\u6574\u6570";
    result.error_count_threshold = count;
  } else if (!partial) {
    result.error_count_threshold = 5;
  }
  if (body.window_seconds !== void 0) {
    const window = Number(body.window_seconds);
    if (!Number.isInteger(window) || window < 10 || window > 86400) return "\u7EDF\u8BA1\u7A97\u53E3\u5FC5\u987B\u662F 10 \u5230 86400 \u79D2\u4E4B\u95F4\u7684\u6574\u6570";
    result.window_seconds = window;
  } else if (!partial) {
    result.window_seconds = 300;
  }
  return result;
}

// functions/src/utils/provider.ts
function getDefaultBaseUrl(provider) {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "xai":
      return "https://api.x.ai";
    case "openai":
    default:
      return "https://api.openai.com";
  }
}
function getProviderAuthHeaders(provider, apiKey) {
  if (provider === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${apiKey}` };
}
function getProbeModel(provider) {
  switch (provider) {
    case "anthropic":
      return "claude-3-5-haiku-20241022";
    case "xai":
      return "grok-2-latest";
    case "openai":
    default:
      return "gpt-4o-mini";
  }
}

// functions/src/utils/healthcheck.ts
var PROBE_TIMEOUT_MS = 15e3;
var MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
var PROBE_PROMPT = "1+1=?";
var PROBE_MAX_TOKENS = 16;
function readCachedModels(account) {
  const raw = String(account?.upstream_models || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const models = parsed.map((row) => ({ id: String(row?.id || "").trim(), name: row?.name ? String(row.name) : void 0 })).filter((row) => row.id);
    if (!models.length) return null;
    return { models, fetchedAt: String(account?.upstream_models_at || "") };
  } catch {
    return null;
  }
}
function isStale(fetchedAt) {
  if (!fetchedAt) return true;
  const parsed = Date.parse(`${fetchedAt.replace(" ", "T")}Z`);
  if (!Number.isFinite(parsed)) return true;
  return Date.now() - parsed > MODEL_CACHE_TTL_MS;
}
async function listUpstreamModels(db, accountId, refresh = false) {
  const account = await db.getAccount(accountId);
  if (!account) throw new Error("\u8D26\u53F7\u4E0D\u5B58\u5728");
  const cached = readCachedModels(account);
  if (cached && !refresh && !isStale(cached.fetchedAt)) {
    return { models: cached.models, cached: true, fetchedAt: cached.fetchedAt };
  }
  const apiKey = String(account.api_key || "").trim();
  if (!apiKey) throw new Error("\u8D26\u53F7\u6CA1\u6709\u914D\u7F6E\u5BC6\u94A5");
  const baseUrl = (String(account.base_url || "").trim() || getDefaultBaseUrl(account.provider)).replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: getProviderAuthHeaders(account.provider, apiKey),
      signal: controller.signal
    });
    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      if (cached) return { models: cached.models, cached: true, fetchedAt: cached.fetchedAt };
      throw new Error(`\u83B7\u53D6\u6A21\u578B\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`);
    }
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const models = rows.map((row) => ({ id: String(row.id || row.name || "").trim(), name: row.name ? String(row.name) : void 0 })).filter((row) => row.id).slice(0, 200);
    if (!models.length) {
      if (cached) return { models: cached.models, cached: true, fetchedAt: cached.fetchedAt };
      throw new Error("\u4E0A\u6E38\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u6A21\u578B");
    }
    await db.saveUpstreamModels(accountId, models).catch(() => {
    });
    const stored = await db.getAccount(accountId);
    return { models, cached: false, fetchedAt: String(stored?.upstream_models_at || "") };
  } finally {
    clearTimeout(timer);
  }
}
function resolveProbeModel(account, selectedModel) {
  const explicit = String(selectedModel || "").trim();
  if (explicit) return explicit;
  const remembered = String(account?.probe_model || "").trim();
  if (remembered) return remembered;
  return getProbeModel(account?.provider);
}
async function probeAccount(db, accountId, selectedModel) {
  const account = await db.getAccount(accountId);
  if (!account) {
    return {
      accountId,
      name: `#${accountId}`,
      provider: "",
      success: false,
      status: 0,
      latencyMs: 0,
      message: "\u8D26\u53F7\u4E0D\u5B58\u5728"
    };
  }
  const base = {
    accountId,
    name: String(account.name || `#${accountId}`),
    provider: String(account.provider || "")
  };
  const apiKey = String(account.api_key || "").trim();
  if (!apiKey) {
    const result = { ...base, success: false, status: 0, latencyMs: 0, message: "\u8D26\u53F7\u6CA1\u6709\u914D\u7F6E\u5BC6\u94A5" };
    await persist(db, result);
    return result;
  }
  const baseUrl = (String(account.base_url || "").trim() || getDefaultBaseUrl(account.provider)).replace(/\/+$/, "");
  const isAnthropic = account.provider === "anthropic";
  const probeModel = resolveProbeModel(account, selectedModel);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  const endpoint = isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/v1/chat/completions`;
  const payload = {
    model: probeModel,
    max_tokens: PROBE_MAX_TOKENS,
    stream: true,
    messages: [{ role: "user", content: PROBE_PROMPT }]
  };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...getProviderAuthHeaders(account.provider, apiKey),
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      let detail = "";
      try {
        detail = JSON.parse(raw)?.error?.message || "";
      } catch {
        detail = raw.slice(0, 160);
      }
      const result2 = {
        ...base,
        model: probeModel,
        success: false,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        message: `${probeModel} \xB7 \u8FDE\u63A5\u5931\u8D25\uFF08HTTP ${response.status}\uFF09${detail ? `\uFF1A${detail}` : ""}`
      };
      await persist(db, result2);
      return result2;
    }
    const stream = await readProbeStream(response, startedAt);
    const latencyMs = Date.now() - startedAt;
    if (!stream.received) {
      const result2 = {
        ...base,
        model: probeModel,
        success: false,
        status: response.status,
        latencyMs,
        message: `${probeModel} \xB7 \u4E0A\u6E38\u8FD4\u56DE 200 \u4F46\u6CA1\u6709\u63A8\u9001\u4EFB\u4F55\u6D41\u5F0F\u5185\u5BB9`
      };
      await persist(db, result2);
      return result2;
    }
    const ttft = stream.ttftMs ?? latencyMs;
    const result = {
      ...base,
      model: probeModel,
      success: true,
      status: response.status,
      latencyMs,
      ttftMs: ttft,
      message: `${probeModel} \xB7 \u6D41\u5F0F\u8FDE\u63A5\u6210\u529F\uFF08\u9996\u5B57 ${ttft} ms\uFF0C\u5171 ${latencyMs} ms\uFF09`
    };
    await persist(db, result);
    await db.saveProbeModel(accountId, probeModel).catch(() => {
    });
    return result;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error && error.name === "AbortError" ? `${probeModel} \xB7 \u8FDE\u63A5\u8D85\u65F6\uFF08${PROBE_TIMEOUT_MS / 1e3} \u79D2\uFF09` : `${probeModel} \xB7 ${error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF"}`;
    const result = { ...base, model: probeModel, success: false, status: 0, latencyMs, message };
    await persist(db, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
async function readProbeStream(response, startedAt) {
  if (!response.body) return { received: false, ttftMs: null };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (const line of buffered.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        return { received: true, ttftMs: Date.now() - startedAt };
      }
      if (buffered.length > 64e3) break;
    }
  } catch {
  } finally {
    await reader.cancel().catch(() => {
    });
  }
  return { received: false, ttftMs: null };
}
async function probeAccounts(db, accountIds, concurrency = 4, selectedModels) {
  const results = [];
  const queue = [...accountIds];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let id = queue.shift(); id !== void 0; id = queue.shift()) {
      results.push(await probeAccount(db, id, selectedModels?.[id]));
    }
  });
  await Promise.all(workers);
  return accountIds.map((id) => results.find((entry) => entry.accountId === id)).filter((entry) => Boolean(entry));
}
async function persist(db, result) {
  await db.recordAccountHealthCheck(result.accountId, result.success, result.latencyMs, result.message).catch(() => {
  });
}

// functions/src/config/accounts.ts
var JSON_HEADERS2 = { "Content-Type": "application/json" };
function jsonError2(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS2 });
}
function readRateMultiplier(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return "\u500D\u7387\u5FC5\u987B\u662F\u4E0D\u5C0F\u4E8E 0 \u7684\u6570\u5B57";
  if (parsed > 100) return "\u500D\u7387\u4E0D\u80FD\u5927\u4E8E 100";
  return parsed;
}
function normalizeBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
function maskAccount(account) {
  if (!account) return account;
  const { api_key, ...rest } = account;
  return { ...rest, api_key: api_key ? "***" : "", has_api_key: Boolean(api_key) };
}
async function handleAccountsRequest(request, env) {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const method = request.method;
  {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const token = authHeader.slice(7);
    const session = await verifySessionToken(token, await resolveSessionSecret(db, env.JWT_SECRET));
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }
  const modelsMatch = /\/accounts\/(\d+)\/models$/.exec(url.pathname);
  if (method === "GET" && modelsMatch) {
    const id = Number(modelsMatch[1]);
    const refresh = url.searchParams.get("refresh") === "1";
    try {
      const result = await listUpstreamModels(db, id, refresh);
      const account = await db.getAccount(id);
      return new Response(JSON.stringify({
        data: {
          account_id: id,
          models: result.models,
          cached: result.cached,
          fetched_at: result.fetchedAt,
          probe_model: String(account?.probe_model || "")
        }
      }), { status: 200, headers: JSON_HEADERS2 });
    } catch (error) {
      return jsonError2(error instanceof Error ? error.message : "\u83B7\u53D6\u4E0A\u6E38\u6A21\u578B\u5931\u8D25", 502);
    }
  }
  if (method === "GET") {
    const accounts = await db.listAccounts();
    return new Response(JSON.stringify({ data: accounts.map(maskAccount) }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  const isProbePath = url.pathname.endsWith("/test") || url.pathname.endsWith("/test-all");
  if (method === "POST" && !isProbePath) {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError2("Invalid JSON body", 400);
    }
    const name = String(body.name || "").trim();
    const provider = String(body.provider || "").trim();
    const groupId = Number(body.group_id);
    if (!name || !provider || !groupId) {
      return jsonError2("\u8BF7\u586B\u5199\u8D26\u53F7\u540D\u79F0\uFF0C\u5E76\u9009\u62E9\u670D\u52A1\u5546\u548C\u5206\u7EC4", 400);
    }
    if (!["openai", "anthropic", "xai"].includes(provider)) {
      return jsonError2("\u670D\u52A1\u5546\u5FC5\u987B\u662F openai\u3001anthropic \u6216 xai", 400);
    }
    if (!await db.getGroup(groupId)) return jsonError2("\u6240\u9009\u5206\u7EC4\u4E0D\u5B58\u5728", 400);
    const baseUrl = normalizeBaseUrl(body.base_url);
    if (baseUrl === null) return jsonError2("\u57FA\u7840\u5730\u5740\u5FC5\u987B\u662F http(s) \u5F00\u5934\u7684\u5408\u6CD5\u5730\u5740\uFF0C\u4F8B\u5982 https://api.openai.com", 400);
    const apiKey = String(body.api_key || "").trim();
    if (!apiKey) return jsonError2("\u8BF7\u586B\u5199\u4E0A\u6E38\u5BC6\u94A5", 400);
    const multiplier = readRateMultiplier(body.rate_multiplier ?? 1);
    if (typeof multiplier === "string") return jsonError2(multiplier, 400);
    const result = await db.createAccount(
      name,
      provider,
      apiKey,
      groupId,
      baseUrl,
      Number(body.priority) || 0,
      body.client_spoofing,
      body.enabled === false || body.enabled === 0 ? 0 : 1,
      multiplier
    );
    const account = await db.getAccount(result.lastRowId);
    return new Response(JSON.stringify({ data: maskAccount(account) }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "PUT") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    if (!id) return jsonError2("Invalid account ID", 400);
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError2("Invalid JSON body", 400);
    }
    const existing = await db.getAccount(id);
    if (!existing) return jsonError2("\u8D26\u53F7\u4E0D\u5B58\u5728", 404);
    const updates = {};
    if (body.name !== void 0) {
      const name = String(body.name).trim();
      if (!name) return jsonError2("\u8D26\u53F7\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A", 400);
      updates.name = name;
    }
    if (body.provider !== void 0) {
      if (!["openai", "anthropic", "xai"].includes(String(body.provider))) {
        return jsonError2("\u670D\u52A1\u5546\u5FC5\u987B\u662F openai\u3001anthropic \u6216 xai", 400);
      }
      updates.provider = String(body.provider);
    }
    if (body.base_url !== void 0) {
      const baseUrl = normalizeBaseUrl(body.base_url);
      if (baseUrl === null) return jsonError2("\u57FA\u7840\u5730\u5740\u5FC5\u987B\u662F http(s) \u5F00\u5934\u7684\u5408\u6CD5\u5730\u5740\uFF0C\u4F8B\u5982 https://api.openai.com", 400);
      updates.base_url = baseUrl;
    }
    if (body.client_spoofing !== void 0) updates.client_spoofing = String(body.client_spoofing || "").trim();
    if (body.priority !== void 0 && Number.isFinite(Number(body.priority))) updates.priority = Number(body.priority);
    if (body.enabled !== void 0) updates.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;
    if (body.rate_multiplier !== void 0) {
      const multiplier = readRateMultiplier(body.rate_multiplier);
      if (typeof multiplier === "string") return jsonError2(multiplier, 400);
      updates.rate_multiplier = multiplier;
    }
    if (typeof body.api_key === "string" && body.api_key.trim() && body.api_key.trim() !== "***") {
      updates.api_key = body.api_key.trim();
    }
    if (body.group_id !== void 0) {
      const groupId = Number(body.group_id);
      if (!groupId || !await db.getGroup(groupId)) return jsonError2("\u6240\u9009\u5206\u7EC4\u4E0D\u5B58\u5728", 400);
      updates.group_id = groupId;
    }
    await db.updateAccount(id, updates);
    const account = await db.getAccount(id);
    return new Response(JSON.stringify({ data: maskAccount(account) }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "DELETE") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    if (!id) {
      return new Response(JSON.stringify({ error: "Invalid account ID" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    await db.deleteAccount(id);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "POST" && url.pathname.endsWith("/test-all")) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const rawGroup = body.group_id;
    const scoped = rawGroup !== void 0 && rawGroup !== null && String(rawGroup).trim() !== "" && String(rawGroup) !== "all";
    let groupId = 0;
    let groupName = "";
    if (scoped) {
      groupId = Number(rawGroup);
      if (!Number.isInteger(groupId) || groupId <= 0) return jsonError2("\u5206\u7EC4\u65E0\u6548", 400);
      const group = await db.getGroup(groupId);
      if (!group) return jsonError2("\u6240\u9009\u5206\u7EC4\u4E0D\u5B58\u5728", 400);
      groupName = String(group.name || "");
    }
    const accounts = await db.listAccounts();
    const ids = accounts.filter((account) => Number(account.enabled) === 1).filter((account) => !scoped || Number(account.group_id) === groupId).map((account) => Number(account.id));
    if (!ids.length) {
      return jsonError2(scoped ? `\u5206\u7EC4\u300C${groupName}\u300D\u4E0B\u6CA1\u6709\u542F\u7528\u7684\u8D26\u53F7` : "\u6CA1\u6709\u542F\u7528\u7684\u8D26\u53F7\u53EF\u6D4B\u8BD5", 400);
    }
    const results = await probeAccounts(db, ids);
    const healthy = results.filter((result) => result.success).length;
    return new Response(JSON.stringify({
      data: {
        group_id: scoped ? groupId : null,
        group_name: groupName,
        total: results.length,
        healthy,
        failed: results.length - healthy,
        results: results.map((result) => ({
          account_id: result.accountId,
          name: result.name,
          provider: result.provider,
          success: result.success,
          status: result.status,
          latency_ms: result.latencyMs,
          ttft_ms: result.ttftMs ?? null,
          model: result.model || "",
          message: result.message
        }))
      }
    }), { status: 200, headers: JSON_HEADERS2 });
  }
  if (method === "POST" && url.pathname.endsWith("/test")) {
    const segments = url.pathname.split("/");
    const id = parseInt(segments[segments.length - 2] || "0");
    if (!id) return jsonError2("Invalid account ID", 400);
    let selectedModel = "";
    try {
      const body = await request.json();
      selectedModel = String(body?.model || "").trim();
    } catch {
      selectedModel = "";
    }
    const result = await probeAccount(db, id, selectedModel || void 0);
    return new Response(JSON.stringify({
      success: result.success,
      status: result.status,
      latency_ms: result.latencyMs,
      model: result.model || "",
      message: result.message
    }), { status: 200, headers: JSON_HEADERS2 });
  }
  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
}

// functions/src/config/models.ts
async function handleModelsRequest(request, env) {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const method = request.method;
  {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const token = authHeader.slice(7);
    const session = await verifySessionToken(token, await resolveSessionSecret(db, env.JWT_SECRET));
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }
  if (method === "GET") {
    const mappings = await db.listModelMappings();
    return jsonData2(mappings);
  }
  if (method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError3("Invalid JSON body", 400);
    }
    const requestedModel = String(body.requested_model || "").trim();
    const upstreamModel = String(body.upstream_model || "").trim();
    const provider = String(body.provider || "").trim();
    const groupId = Number(body.group_id);
    if (!requestedModel || !upstreamModel) return jsonError3("\u8BF7\u586B\u5199\u5BA2\u6237\u7AEF\u6A21\u578B\u540D\u548C\u4E0A\u6E38\u6A21\u578B\u540D", 400);
    if (!PROVIDERS.includes(provider)) return jsonError3("\u670D\u52A1\u5546\u5FC5\u987B\u662F openai\u3001anthropic \u6216 xai", 400);
    if (!groupId) return jsonError3("\u8BF7\u9009\u62E9\u76EE\u6807\u5206\u7EC4", 400);
    if (!await db.getGroup(groupId)) return jsonError3("\u6240\u9009\u5206\u7EC4\u4E0D\u5B58\u5728", 400);
    if (requestedModel.includes("*") && !requestedModel.endsWith("*")) {
      return jsonError3("\u901A\u914D\u7B26\u53EA\u80FD\u653E\u5728\u5BA2\u6237\u7AEF\u6A21\u578B\u540D\u672B\u5C3E\uFF0C\u4F8B\u5982 gpt-4*", 400);
    }
    const duplicate = await db.findModelMappingByModel(requestedModel, provider);
    if (duplicate) {
      return jsonError3(`\u5DF2\u5B58\u5728 ${requestedModel} \u5230 ${provider} \u7684\u6620\u5C04\uFF0C\u8BF7\u5148\u7F16\u8F91\u6216\u5220\u9664\u539F\u89C4\u5219`, 409);
    }
    const result = await db.createModelMapping(
      requestedModel,
      provider,
      upstreamModel,
      groupId,
      Number(body.priority) || 0,
      body.enabled === false || body.enabled === 0 ? 0 : 1
    );
    const mapping = await db.getModelMapping(result.lastRowId);
    return jsonData2(mapping, 201);
  }
  if (method === "PUT") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    if (!id) return jsonError3("Invalid mapping ID", 400);
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError3("Invalid JSON body", 400);
    }
    if (!await db.getModelMapping(id)) return jsonError3("\u6A21\u578B\u6620\u5C04\u4E0D\u5B58\u5728", 404);
    const updates = {};
    if (body.requested_model !== void 0) {
      const requestedModel = String(body.requested_model).trim();
      if (!requestedModel) return jsonError3("\u5BA2\u6237\u7AEF\u6A21\u578B\u540D\u4E0D\u80FD\u4E3A\u7A7A", 400);
      if (requestedModel.includes("*") && !requestedModel.endsWith("*")) {
        return jsonError3("\u901A\u914D\u7B26\u53EA\u80FD\u653E\u5728\u5BA2\u6237\u7AEF\u6A21\u578B\u540D\u672B\u5C3E\uFF0C\u4F8B\u5982 gpt-4*", 400);
      }
      updates.requested_model = requestedModel;
    }
    if (body.upstream_model !== void 0) {
      const upstreamModel = String(body.upstream_model).trim();
      if (!upstreamModel) return jsonError3("\u4E0A\u6E38\u6A21\u578B\u540D\u4E0D\u80FD\u4E3A\u7A7A", 400);
      updates.upstream_model = upstreamModel;
    }
    if (body.provider !== void 0) {
      const provider = String(body.provider).trim();
      if (!PROVIDERS.includes(provider)) return jsonError3("\u670D\u52A1\u5546\u5FC5\u987B\u662F openai\u3001anthropic \u6216 xai", 400);
      updates.provider = provider;
    }
    if (body.group_id !== void 0) {
      const groupId = Number(body.group_id);
      if (!groupId || !await db.getGroup(groupId)) return jsonError3("\u6240\u9009\u5206\u7EC4\u4E0D\u5B58\u5728", 400);
      updates.group_id = groupId;
    }
    if (body.priority !== void 0) updates.priority = Number(body.priority) || 0;
    if (body.enabled !== void 0) updates.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;
    await db.updateModelMapping(id, updates);
    const mapping = await db.getModelMapping(id);
    return jsonData2(mapping);
  }
  if (method === "DELETE") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    if (!id) {
      return new Response(JSON.stringify({ error: "Invalid mapping ID" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    await db.deleteModelMapping(id);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  return jsonError3("Method not allowed", 405);
}
var PROVIDERS = ["openai", "anthropic", "xai"];
var JSON_HEADERS3 = { "Content-Type": "application/json" };
function jsonData2(data, status = 200) {
  return new Response(JSON.stringify({ data }), { status, headers: JSON_HEADERS3 });
}
function jsonError3(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS3 });
}

// functions/src/key-crypto.ts
var VERSION = "v1";
var IV_BYTES = 12;
function toHex2(value) {
  return Array.from(value instanceof Uint8Array ? value : new Uint8Array(value)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function fromHex2(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error("Invalid encrypted API key");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
async function encryptionKey(secret) {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function resolveApiKeyEncryptionSecret(db, configured) {
  const stored = await db.getSetting("api_key_encryption_secret");
  if (stored) return stored;
  const explicit = String(configured || "").trim();
  if (explicit) {
    return db.setSettingIfAbsent("api_key_encryption_secret", explicit);
  }
  return db.setSettingIfAbsent(
    "api_key_encryption_secret",
    toHex2(crypto.getRandomValues(new Uint8Array(32)))
  );
}
async function encryptApiKey(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(value)
  );
  return `${VERSION}:${toHex2(iv)}:${toHex2(encrypted)}`;
}
async function decryptApiKey(payload, secret) {
  const [version, ivHex, ciphertextHex] = String(payload || "").split(":");
  if (version !== VERSION || !ivHex || !ciphertextHex) throw new Error("Invalid encrypted API key");
  const iv = fromHex2(ivHex);
  if (iv.length !== IV_BYTES) throw new Error("Invalid encrypted API key");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    fromHex2(ciphertextHex)
  );
  return new TextDecoder().decode(plaintext);
}

// functions/_worker.ts
var sharedFailover = null;
function invalidateRouting() {
  if (sharedFailover) invalidateRoutingSnapshot(sharedFailover);
}
var worker_default = {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const wantsHtml = (request.headers.get("accept") || "").includes("text/html");
      if (wantsHtml) {
        const assets = env.ASSETS;
        if (assets) {
          const shellUrl = new URL(request.url);
          shellUrl.pathname = "/";
          const shell = await assets.fetch(new Request(shellUrl.toString(), { headers: request.headers })).catch(() => null);
          if (shell && shell.status < 400) {
            return new Response(shell.body, {
              status: shell.status,
              headers: { ...Object.fromEntries(shell.headers), "x-sub2api-error": encodeURIComponent(message).slice(0, 200) }
            });
          }
        }
      }
      return json({ error: "Internal error", message }, 500);
    }
  }
};
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!env.DB) return json({ error: "D1 binding DB is not configured" }, 500);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Anthropic-Version, Anthropic-Beta"
      }
    });
  }
  if (path === "/health" || path === "/api/health") {
    return json({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
  }
  if (path === "/api/v1/auth/login" && request.method === "POST") {
    return handleLogin(request, env);
  }
  if (path === "/api/v1/auth/setup") {
    if (request.method === "POST") return handleSetup(request, env);
    if (request.method === "GET") return handleSetupStatus(env);
    return json({ error: "Method not allowed" }, 405);
  }
  if (path === "/api/v1/auth/password" && request.method === "POST") {
    return handlePasswordChange(request, env);
  }
  if (path === "/api/v1/stats" && request.method === "GET") {
    return handleStats(request, env);
  }
  if (path.startsWith("/api/v1/keys")) {
    return handleApiKeys(request, env);
  }
  if (path === "/api/v1/usage" || path.startsWith("/api/v1/usage/")) {
    if (request.method === "GET" && path === "/api/v1/usage") return handleUsage(request, env);
    if (request.method === "DELETE") return handleUsageDelete(request, env, path);
    return json({ error: "Method not allowed" }, 405);
  }
  if (path.startsWith("/api/v1/groups")) {
    if (request.method !== "GET") invalidateRouting();
    return handleGroupsRequest(request, env, ctx);
  }
  if (path.startsWith("/api/v1/accounts")) {
    if (request.method !== "GET") invalidateRouting();
    return handleAccountsRequest(request, env);
  }
  if (path.startsWith("/api/v1/models")) {
    if (request.method !== "GET") invalidateRouting();
    return handleModelsRequest(request, env);
  }
  const failover = sharedFailover ?? (sharedFailover = new FailoverManager(env));
  failover.setDb(createDatabase(env.DB));
  if (path === "/v1/models" && request.method === "GET") {
    return handleProviderModels(request, env);
  }
  if (path.startsWith("/v1/chat/completions")) {
    return handleOpenAIRequest(request, env, failover, ctx);
  }
  if (path.startsWith("/v1/responses")) {
    return handleOpenAIRequest(request, env, failover, ctx);
  }
  if (path.startsWith("/v1/messages")) {
    return handleClaudeRequest(request, env, failover, ctx);
  }
  if (path.startsWith("/v1/")) {
    return handleGatewayRequest(request, env, failover, ctx);
  }
  if (env.ASSETS) {
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404 || path.includes(".")) return assetResponse;
    const fallbackUrl = new URL(request.url);
    fallbackUrl.pathname = "/";
    return env.ASSETS.fetch(new Request(fallbackUrl.toString(), request));
  }
  return json({ error: "Not found" }, 404);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Anthropic-Version, Anthropic-Beta"
    }
  });
}
async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.username || !body.password) {
    return json({ error: "Username and password required" }, 400);
  }
  const db = createDatabase(env.DB);
  const session = await authenticateUser(db, body.username, body.password);
  if (!session) return json({ error: "Invalid credentials" }, 401);
  await db.ensureSchema().catch(() => {
  });
  const token = await createSessionToken(session, await resolveSessionSecret(db, env.JWT_SECRET));
  return json({
    token,
    user: { id: session.userId, username: session.username, is_admin: session.isAdmin }
  });
}
async function handleSetup(request, env) {
  const db = createDatabase(env.DB);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.username || !body.password || body.username.length > 128 || body.password.length < 8) {
    return json({ error: "\u8BF7\u586B\u5199\u7528\u6237\u540D\uFF0C\u5BC6\u7801\u81F3\u5C11 8 \u4F4D" }, 400);
  }
  let created = false;
  try {
    created = await db.ensureSchema();
  } catch (error) {
    return json({ error: `\u6570\u636E\u5E93\u521D\u59CB\u5316\u5931\u8D25\uFF1A${error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF"}` }, 500);
  }
  const existing = await db.queryOne("SELECT id, password_hash FROM users LIMIT 1");
  const passwordHash = await hashPassword(body.password);
  if (existing && existing.password_hash.startsWith("$2a$")) {
    await db.update("UPDATE users SET username = ?, password_hash = ? WHERE id = ?", [body.username, passwordHash, existing.id]);
  } else if (existing) {
    return json({ error: "Setup already completed" }, 400);
  } else {
    await db.createUser(body.username, passwordHash);
  }
  return json({ success: true, message: created ? "\u6570\u636E\u5E93\u5DF2\u521D\u59CB\u5316\uFF0C\u7BA1\u7406\u5458\u521B\u5EFA\u6210\u529F" : "\u7BA1\u7406\u5458\u521B\u5EFA\u6210\u529F", schema_created: created });
}
async function handleSetupStatus(env) {
  const db = createDatabase(env.DB);
  let ready;
  try {
    ready = await db.schemaReady();
  } catch (error) {
    return json({ error: "\u6570\u636E\u5E93\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", message: error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF" }, 503);
  }
  if (!ready) {
    return json({ data: { initialized: false, setup_available: true, schema_ready: false } });
  }
  const existing = await db.queryOne("SELECT id, password_hash FROM users LIMIT 1");
  const claimable = !existing || existing.password_hash.startsWith("$2a$");
  return json({ data: { initialized: Boolean(existing), setup_available: claimable, schema_ready: true } });
}
async function handlePasswordChange(request, env) {
  const session = await checkAuth(request, env);
  if (!session) return json({ error: "Unauthorized" }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.current_password || !body.new_password) {
    return json({ error: "Current and new password are required" }, 400);
  }
  if (body.new_password.length < 8) {
    return json({ error: "New password must be at least 8 characters" }, 400);
  }
  const db = createDatabase(env.DB);
  const user = await db.getUserByUsername(session.username);
  if (!user || !await verifyPassword(body.current_password, user.password_hash)) {
    return json({ error: "Current password is incorrect" }, 401);
  }
  await db.update("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(body.new_password), user.id]);
  return json({ success: true });
}
async function handleStats(request, env) {
  const session = await checkAuth(request, env);
  if (!session) return json({ error: "Unauthorized" }, 401);
  const url = new URL(request.url);
  const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours") || "24", 10) || 24, 1), 720);
  const bucket = url.searchParams.get("bucket") === "day" ? "day" : "hour";
  const db = createDatabase(env.DB);
  const stats = await db.getDashboardStats(hours, bucket);
  return json({ data: { hours, bucket, cache: routingCacheMetrics(), ...stats } });
}
async function handleApiKeys(request, env) {
  const session = await checkAuth(request, env);
  if (!session) {
    return json({ error: "Unauthorized" }, 401);
  }
  const db = createDatabase(env.DB);
  await db.ensureSchema();
  const url = new URL(request.url);
  const keyPath = url.pathname.replace(/\/+$/, "");
  const revealMatch = /^\/api\/v1\/keys\/(\d+)\/reveal$/.exec(keyPath);
  const itemMatch = /^\/api\/v1\/keys\/(\d+)$/.exec(keyPath);
  if (keyPath !== "/api/v1/keys" && !revealMatch && !itemMatch) {
    return json({ error: "Invalid API Key path" }, 404);
  }
  if (revealMatch) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (session.isAdmin !== true) return json({ error: "\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650" }, 403);
    const id = Number(revealMatch[1]);
    const key = await db.getApiKeyCiphertext(id);
    if (!key) return json({ error: "API Key not found" }, 404);
    if (!key.key_ciphertext) {
      return json({ error: "\u8BE5\u5BC6\u94A5\u521B\u5EFA\u4E8E\u65E7\u7248\u672C\uFF0C\u65E0\u6CD5\u6062\u590D\uFF0C\u8BF7\u91CD\u65B0\u521B\u5EFA" }, 409);
    }
    try {
      const secret = await decryptApiKey(
        key.key_ciphertext,
        await resolveApiKeyEncryptionSecret(db, env.API_KEY_ENCRYPTION_KEY)
      );
      return new Response(JSON.stringify({ data: { id, key: secret } }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Pragma": "no-cache",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch {
      return json({ error: "\u5BC6\u94A5\u89E3\u5BC6\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u521B\u5EFA" }, 500);
    }
  }
  if (request.method === "GET") {
    const keys = await db.listApiKeys();
    return json({ data: keys });
  }
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "\u8BF7\u586B\u5199\u5BC6\u94A5\u540D\u79F0" }, 400);
    let groupId = null;
    if (body.group_id !== void 0 && body.group_id !== null && String(body.group_id) !== "") {
      groupId = Number(body.group_id);
      if (!groupId || !await db.getGroup(groupId)) return json({ error: "\u6240\u9009\u4E3B\u5206\u7EC4\u4E0D\u5B58\u5728" }, 400);
    }
    let fallbackGroupId = null;
    if (body.fallback_group_id !== void 0 && body.fallback_group_id !== null && String(body.fallback_group_id) !== "") {
      fallbackGroupId = Number(body.fallback_group_id);
      if (!fallbackGroupId || !await db.getGroup(fallbackGroupId)) return json({ error: "\u6240\u9009\u515C\u5E95\u5206\u7EC4\u4E0D\u5B58\u5728" }, 400);
      if (fallbackGroupId === groupId) return json({ error: "\u4E3B\u5206\u7EC4\u548C\u515C\u5E95\u5206\u7EC4\u4E0D\u80FD\u76F8\u540C" }, 400);
    }
    const apiKey = `sk-${Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const keyHash = await hashApiKey(apiKey);
    const keySecret = await resolveApiKeyEncryptionSecret(db, env.API_KEY_ENCRYPTION_KEY);
    const keyCiphertext = await encryptApiKey(apiKey, keySecret);
    const result = await db.createApiKey(keyHash, keyCiphertext, name, body.quota_limit || 0, groupId, fallbackGroupId);
    return json({
      data: {
        id: result.lastRowId,
        key: apiKey,
        name,
        enabled: true,
        balance: 0,
        quota_limit: body.quota_limit || 0,
        group_id: groupId,
        fallback_group_id: fallbackGroupId
      }
    }, 201);
  }
  if (request.method === "PUT") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    if (!id) return json({ error: "Invalid ID" }, 400);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const existing = await db.queryOne("SELECT * FROM api_keys WHERE id = ?", [id]);
    if (!existing) return json({ error: "API Key not found" }, 404);
    const updates = {};
    if (body.name !== void 0) {
      const name = String(body.name).trim();
      if (!name) return json({ error: "\u5BC6\u94A5\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A" }, 400);
      updates.name = name;
    }
    if (body.enabled !== void 0) updates.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;
    if (body.balance !== void 0 && Number.isFinite(Number(body.balance))) updates.balance = Number(body.balance);
    if (body.quota_limit !== void 0 && Number.isFinite(Number(body.quota_limit))) updates.quota_limit = Math.max(0, Number(body.quota_limit));
    if (body.group_id !== void 0) {
      if (body.group_id === null || String(body.group_id) === "") {
        updates.group_id = null;
      } else {
        const groupId = Number(body.group_id);
        if (!groupId || !await db.getGroup(groupId)) return json({ error: "\u6240\u9009\u4E3B\u5206\u7EC4\u4E0D\u5B58\u5728" }, 400);
        updates.group_id = groupId;
        if (body.fallback_group_id !== void 0 && body.fallback_group_id !== null && Number(body.fallback_group_id) === groupId) {
          return json({ error: "\u4E3B\u5206\u7EC4\u548C\u515C\u5E95\u5206\u7EC4\u4E0D\u80FD\u76F8\u540C" }, 400);
        }
      }
    }
    if (body.fallback_group_id !== void 0) {
      if (body.fallback_group_id === null || String(body.fallback_group_id) === "") {
        updates.fallback_group_id = null;
      } else {
        const fallbackGroupId = Number(body.fallback_group_id);
        if (!fallbackGroupId || !await db.getGroup(fallbackGroupId)) return json({ error: "\u6240\u9009\u515C\u5E95\u5206\u7EC4\u4E0D\u5B58\u5728" }, 400);
        const effectivePrimary = body.group_id !== void 0 ? Number(body.group_id) || 0 : Number(existing.group_id) || 0;
        if (fallbackGroupId === effectivePrimary) return json({ error: "\u4E3B\u5206\u7EC4\u548C\u515C\u5E95\u5206\u7EC4\u4E0D\u80FD\u76F8\u540C" }, 400);
        updates.fallback_group_id = fallbackGroupId;
      }
    }
    await db.updateApiKey(id, updates);
    const key = await db.queryOne(`SELECT k.id, k.name, k.enabled, k.balance, k.quota_limit, k.group_id, k.fallback_group_id, k.created_at,
             CASE WHEN k.key_ciphertext IS NOT NULL AND TRIM(k.key_ciphertext) != '' THEN 1 ELSE 0 END AS can_copy,
             g.name AS group_name, fg.name AS fallback_group_name
      FROM api_keys k LEFT JOIN groups g ON k.group_id = g.id LEFT JOIN groups fg ON k.fallback_group_id = fg.id WHERE k.id = ?`, [id]);
    if (!key) return json({ error: "API Key not found" }, 404);
    return json({ data: key });
  }
  if (request.method === "DELETE") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    if (!id) return json({ error: "Invalid ID" }, 400);
    await db.deleteApiKey(id);
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}
async function handleUsage(request, env) {
  const session = await checkAuth(request, env);
  if (!session) {
    return json({ error: "Unauthorized" }, 401);
  }
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 500);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
  const records = await db.listUsageRecords(limit, offset);
  return json({ data: records });
}
async function handleUsageDelete(request, env, path) {
  const session = await checkAuth(request, env);
  if (!session) return json({ error: "Unauthorized" }, 401);
  if (session.isAdmin !== true) return json({ error: "\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650" }, 403);
  const db = createDatabase(env.DB);
  const itemMatch = /^\/api\/v1\/usage\/(\d+)$/.exec(path);
  if (itemMatch) {
    const result = await db.deleteUsageRecord(Number(itemMatch[1]));
    if (!result.changes) return json({ error: "\u8BB0\u5F55\u4E0D\u5B58\u5728" }, 404);
    return json({ success: true, deleted: result.changes });
  }
  if (path !== "/api/v1/usage") return json({ error: "Invalid usage path" }, 404);
  const url = new URL(request.url);
  const rawDays = url.searchParams.get("older_than_days");
  if (rawDays === null) {
    return json({ error: "\u8BF7\u63D0\u4F9B older_than_days\uFF080 \u8868\u793A\u6E05\u7A7A\u5168\u90E8\uFF09" }, 400);
  }
  const days = Number(rawDays);
  if (!Number.isFinite(days) || days < 0 || days > 3650) {
    return json({ error: "older_than_days \u5FC5\u987B\u662F 0 \u5230 3650 \u4E4B\u95F4\u7684\u6570\u5B57" }, 400);
  }
  const before = await db.countUsageRecords();
  await db.deleteUsageRecordsOlderThan(days);
  const after = await db.countUsageRecords();
  return json({ success: true, deleted: Math.max(0, before - after), remaining: after });
}
async function checkAuth(request, env) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7);
  const db = createDatabase(env.DB);
  const session = await verifySessionToken(token, await resolveSessionSecret(db, env.JWT_SECRET));
  return session;
}
async function handleProviderModels(request, env) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Missing API key" }, 401);
  const db = createDatabase(env.DB);
  if (!await authenticateApiKey(db, authHeader.slice(7))) {
    return json({ error: "Invalid or disabled API key" }, 401);
  }
  const accounts = await db.listEnabledAccounts();
  const mappings = await db.listModelMappings();
  const ids = new Set(mappings.filter((m) => m.enabled).map((m) => m.requested_model));
  accounts.forEach((account) => ids.add(account.provider === "anthropic" ? "claude-3-5-sonnet-20241022" : account.provider === "xai" ? "grok-2-latest" : "gpt-4o"));
  return json({ object: "list", data: [...ids].map((id) => ({ id, object: "model", owned_by: "sub2api" })) });
}
export {
  worker_default as default
};
