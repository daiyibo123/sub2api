// D1 Database abstraction layer
import type { Env } from './index';
import type { UsageRecord, RequestLog } from './types';
import { SCHEMA_STATEMENTS, ADDITIVE_COLUMNS, SCHEMA_VERSION } from './schema';

export class Database {
  constructor(private db: D1Database) {}

  // Generic query helpers
  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const result = await this.db.prepare(sql).bind(...params).all<T>();
    return result.results ?? [];
  }

  async queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const result = await this.db.prepare(sql).bind(...params).first<T>();
    return result ?? null;
  }

  async exec(sql: string): Promise<void> {
    await this.db.prepare(sql).run();
  }

  async insert(sql: string, params: any[] = []): Promise<{ lastRowId: number; changes: number }> {
    const result = await this.db.prepare(sql).bind(...params).run();
    return { lastRowId: Number(result.meta.last_row_id ?? 0), changes: Number(result.meta.changes ?? 0) };
  }

  async update(sql: string, params: any[] = []): Promise<{ changes: number }> {
    const result = await this.db.prepare(sql).bind(...params).run();
    return { changes: Number(result.meta.changes ?? 0) };
  }

  // User operations
  async getUserByUsername(username: string) {
    return this.queryOne<any>('SELECT * FROM users WHERE username = ?', [username]);
  }

  async createUser(username: string, passwordHash: string) {
    return this.insert(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, passwordHash]
    );
  }

  // Group operations
  async listGroups() {
    return this.query<any>('SELECT * FROM groups ORDER BY priority ASC, id ASC');
  }

  async getGroup(id: number) {
    return this.queryOne<any>('SELECT * FROM groups WHERE id = ?', [id]);
  }

  /**
   * groups.name is UNIQUE. Look the name up first so a collision returns a
   * readable message instead of a raw D1 constraint error.
   */
  async getGroupByName(name: string) {
    return this.queryOne<any>('SELECT * FROM groups WHERE name = ?', [name]);
  }

  async createGroup(name: string, description?: string, priority = 0, options: {
    enabled?: number;
    error_threshold?: number;
    error_count_threshold?: number;
    window_seconds?: number;
  } = {}) {
    return this.insert(
      `INSERT INTO groups (name, description, priority, enabled, error_threshold, error_count_threshold, window_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        description || '',
        priority,
        options.enabled ?? 1,
        options.error_threshold ?? 0.5,
        options.error_count_threshold ?? 5,
        options.window_seconds ?? 300
      ]
    );
  }

  async updateGroup(id: number, updates: Partial<any>) {
    const fields: string[] = [];
    const values: any[] = [];
    
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled); }
    if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
    if (updates.error_threshold !== undefined) { fields.push('error_threshold = ?'); values.push(updates.error_threshold); }
    if (updates.error_count_threshold !== undefined) { fields.push('error_count_threshold = ?'); values.push(updates.error_count_threshold); }
    if (updates.window_seconds !== undefined) { fields.push('window_seconds = ?'); values.push(updates.window_seconds); }
    
    if (fields.length === 0) return { changes: 0 };
    values.push(id);
    return this.update(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async deleteGroup(id: number) {
    return this.update('DELETE FROM groups WHERE id = ?', [id]);
  }







  // Account operations
  async listAccounts() {
    return this.query<any>(`
      SELECT a.*, g.name as group_name
      FROM accounts a
      LEFT JOIN groups g ON a.group_id = g.id
      ORDER BY a.priority ASC, a.id ASC
    `);
  }

  async getAccount(id: number) {
    return this.queryOne<any>('SELECT * FROM accounts WHERE id = ?', [id]);
  }

  async createAccount(name: string, provider: string, apiKey: string, groupId: number, baseUrl?: string, priority = 0, clientSpoofing?: string, enabled = 1, rateMultiplier = 1) {
    return this.insert(
      // channel_id is a retired column that older databases still declare
      // NOT NULL, so a literal 0 is written to satisfy both shapes.
      `INSERT INTO accounts (name, provider, api_key, base_url, group_id, channel_id, priority, client_spoofing, enabled, rate_multiplier)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [name, provider, apiKey, baseUrl || '', groupId, priority, clientSpoofing || '', enabled, rateMultiplier]
    );
  }

  async updateAccount(id: number, updates: Partial<any>) {
    const fields: string[] = [];
    const values: any[] = [];
    
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.provider !== undefined) { fields.push('provider = ?'); values.push(updates.provider); }
    if (updates.api_key !== undefined) { fields.push('api_key = ?'); values.push(updates.api_key); }
    if (updates.base_url !== undefined) { fields.push('base_url = ?'); values.push(updates.base_url); }
    if (updates.group_id !== undefined) { fields.push('group_id = ?'); values.push(updates.group_id); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled); }
    if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
    if (updates.error_count !== undefined) { fields.push('error_count = ?'); values.push(updates.error_count); }
    if (updates.error_rate !== undefined) { fields.push('error_rate = ?'); values.push(updates.error_rate); }
    if (updates.client_spoofing !== undefined) { fields.push('client_spoofing = ?'); values.push(updates.client_spoofing); }
    if (updates.rate_multiplier !== undefined) { fields.push('rate_multiplier = ?'); values.push(updates.rate_multiplier); }
    
    if (fields.length === 0) return { changes: 0 };
    values.push(id);
    return this.update(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async deleteAccount(id: number) {
    return this.update('DELETE FROM accounts WHERE id = ?', [id]);
  }

  async listAccountsByGroup(groupId: number) {
    return this.query<any>('SELECT * FROM accounts WHERE group_id = ? AND enabled = 1 ORDER BY priority ASC, id ASC', [groupId]);
  }

  /**
   * Credentials live on the account itself; there is no longer a second layer
   * holding shared defaults.
   */
  async listEnabledAccounts() {
    return this.query<any>(`
      SELECT * FROM accounts WHERE enabled = 1 ORDER BY priority ASC, id ASC
    `);
  }

  /** Dependants that would break if a group were removed. */
  async countAccountsInGroup(groupId: number): Promise<number> {
    const row = await this.queryOne<{ total: number }>(
      'SELECT COUNT(*) AS total FROM accounts WHERE group_id = ?',
      [groupId]
    );
    return Number(row?.total || 0);
  }

  async countModelMappingsForGroup(groupId: number): Promise<number> {
    const row = await this.queryOne<{ total: number }>(
      'SELECT COUNT(*) AS total FROM model_mappings WHERE group_id = ?',
      [groupId]
    );
    return Number(row?.total || 0);
  }


  /**
   * Name lookups back friendly duplicate errors. Groups have
   * a UNIQUE(name) constraint, which would otherwise surface as a raw D1 500.
   */
  async findGroupByName(name: string) {
    return this.queryOne<any>('SELECT * FROM groups WHERE name = ?', [name]);
  }



  /**
   * Store the outcome of a liveness probe on the account row.
   *
   * Keeping the last result denormalized lets the console show which upstreams
   * are alive without re-probing every provider on each page load.
   */
  async recordAccountHealthCheck(id: number, ok: boolean, latencyMs: number, message: string) {
    return this.update(
      `UPDATE accounts
       SET last_check_at = datetime('now'), last_check_ok = ?, last_check_latency_ms = ?, last_check_message = ?
       WHERE id = ?`,
      [ok ? 1 : 0, Math.max(0, Math.round(latencyMs)), (message || '').slice(0, 300), id]
    );
  }

  /** Resolve a single account row including its credential. */
  async getAccountWithKey(id: number) {
    return this.queryOne<any>(`
      SELECT * FROM accounts WHERE id = ?
    `, [id]);
  }

  // Model mapping operations
  async listModelMappings() {
    return this.query<any>('SELECT * FROM model_mappings ORDER BY priority ASC, id ASC');
  }

  async getModelMapping(id: number) {
    return this.queryOne<any>('SELECT * FROM model_mappings WHERE id = ?', [id]);
  }

  /**
   * findModelMapping resolves a single rule per (client model, provider) pair,
   * so a second identical pair would never be reachable. Surface it as a
   * conflict instead of silently storing dead configuration.
   */
  async findModelMappingByModel(requestedModel: string, provider: string) {
    return this.queryOne<any>(
      'SELECT * FROM model_mappings WHERE requested_model = ? AND provider = ?',
      [requestedModel, provider]
    );
  }

  async createModelMapping(requestedModel: string, provider: string, upstreamModel: string, groupId: number, priority = 0, enabled = 1) {
    return this.insert(
      'INSERT INTO model_mappings (requested_model, provider, upstream_model, group_id, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)',
      [requestedModel, provider, upstreamModel, groupId, priority, enabled]
    );
  }

  async updateModelMapping(id: number, updates: Partial<any>) {
    const fields: string[] = [];
    const values: any[] = [];
    
    if (updates.requested_model !== undefined) { fields.push('requested_model = ?'); values.push(updates.requested_model); }
    if (updates.provider !== undefined) { fields.push('provider = ?'); values.push(updates.provider); }
    if (updates.upstream_model !== undefined) { fields.push('upstream_model = ?'); values.push(updates.upstream_model); }
    if (updates.group_id !== undefined) { fields.push('group_id = ?'); values.push(updates.group_id); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled); }
    if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
    
    if (fields.length === 0) return { changes: 0 };
    values.push(id);
    return this.update(`UPDATE model_mappings SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async deleteModelMapping(id: number) {
    return this.update('DELETE FROM model_mappings WHERE id = ?', [id]);
  }

  // API Key operations
  async listApiKeys() {
    return this.query<any>(`
      SELECT k.id, k.name, k.enabled, k.balance, k.quota_limit, k.group_id, k.fallback_group_id, k.created_at,
             CASE WHEN k.key_ciphertext IS NOT NULL AND TRIM(k.key_ciphertext) != '' THEN 1 ELSE 0 END AS can_copy,
             g.name AS group_name, fg.name AS fallback_group_name
      FROM api_keys k
      LEFT JOIN groups g ON k.group_id = g.id
      LEFT JOIN groups fg ON k.fallback_group_id = fg.id
      ORDER BY k.id DESC
    `);
  }

  async getApiKeyByHash(keyHash: string) {
    return this.queryOne<any>('SELECT * FROM api_keys WHERE key_hash = ?', [keyHash]);
  }

  async createApiKey(keyHash: string, keyCiphertext: string | null, name?: string, quotaLimit = 0, groupId: number | null = null, fallbackGroupId: number | null = null) {
    return this.insert(
      'INSERT INTO api_keys (key_hash, key_ciphertext, name, quota_limit, group_id, fallback_group_id) VALUES (?, ?, ?, ?, ?, ?)',
      [keyHash, keyCiphertext, name || '', quotaLimit, groupId, fallbackGroupId]
    );
  }

  async getApiKeyCiphertext(id: number) {
    return this.queryOne<{ id: number; key_ciphertext: string | null }>(
      'SELECT id, key_ciphertext FROM api_keys WHERE id = ?', [id]
    );
  }

  async updateApiKey(id: number, updates: Partial<any>) {
    const fields: string[] = [];
    const values: any[] = [];
    
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled); }
    if (updates.balance !== undefined) { fields.push('balance = ?'); values.push(updates.balance); }
    if (updates.quota_limit !== undefined) { fields.push('quota_limit = ?'); values.push(updates.quota_limit); }
    if (updates.group_id !== undefined) { fields.push('group_id = ?'); values.push(updates.group_id); }
    if (updates.fallback_group_id !== undefined) { fields.push('fallback_group_id = ?'); values.push(updates.fallback_group_id); }
    
    if (fields.length === 0) return { changes: 0 };
    values.push(id);
    return this.update(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async deleteApiKey(id: number) {
    return this.update('DELETE FROM api_keys WHERE id = ?', [id]);
  }

  async incrementApiKeyUsage(id: number, cost: number) {
    return this.update(
      'UPDATE api_keys SET balance = balance + ? WHERE id = ?',
      [cost, id]
    );
  }

  // Usage records
  async createUsageRecord(record: Partial<UsageRecord>) {
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
        record.error_message || '',
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
    return this.query<any>(
      `SELECT u.*, g.name AS group_name, a.name AS account_name, k.name AS key_name
       FROM usage_records u
       LEFT JOIN groups g ON u.group_id = g.id
       LEFT JOIN accounts a ON u.account_id = a.id
       LEFT JOIN api_keys k ON u.api_key_id = k.id
       ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
  }

  // Request logs for error tracking
  async createRequestLog(log: Partial<RequestLog>) {
    return this.insert(
      `INSERT INTO request_logs (account_id, channel_id, group_id, model, status, error_message, latency_ms, ttft_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.account_id,
        0,
        log.group_id,
        log.model,
        log.status,
        log.error_message || '',
        log.latency_ms ?? 0,
        log.ttft_ms ?? null
      ]
    );
  }

  async getAccountErrorStats(accountId: number, windowSeconds: number) {
    const cutoff = sqliteTimestamp(Date.now() - windowSeconds * 1000);
    const result = await this.queryOne<any>(
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
  async getDashboardStats(windowHours = 24, bucket: 'hour' | 'day' = 'hour') {
    const since = sqliteTimestamp(Date.now() - windowHours * 60 * 60 * 1000);
    const bucketFormat = bucket === 'day' ? '%Y-%m-%d' : '%Y-%m-%d %H:00';
    const todayStart = sqliteTimestamp(new Date().setHours(0, 0, 0, 0));

    const [totals, today, resources] = await Promise.all([
      this.queryOne<any>(`
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
      this.queryOne<any>(`
        SELECT
          COUNT(*) AS today_requests,
          COALESCE(SUM(total_tokens), 0) AS today_tokens,
          COALESCE(SUM(cost), 0) AS today_cost
        FROM usage_records WHERE created_at >= ?
      `, [todayStart]),
      this.queryOne<any>(`
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

    // Hourly buckets drive the trend chart; model rows drive the doughnut.
    const [trend, byModel, byProvider] = await Promise.all([
      this.query<any>(`
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
      this.query<any>(`
        SELECT model, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens,
               COALESCE(SUM(base_cost), 0) AS base_cost, COALESCE(SUM(cost), 0) AS cost
        FROM usage_records WHERE created_at >= ? GROUP BY model ORDER BY requests DESC LIMIT 12
      `, [since]),
      this.query<any>(`
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
  async ensureSchema(): Promise<boolean> {
    // Fast path. Applying the schema is ~30 D1 round trips and Cloudflare caps a
    // request at 50 subrequests, so a hot path must not pay that every time.
    // One cheap read tells us the current version is already applied.
    if (await this.getSetting('schema_version') === SCHEMA_VERSION) return false;

    const wasReady = await this.schemaReady();
    // Every statement is `IF NOT EXISTS`, so this runs unconditionally: a
    // database created by an older release is missing later tables, and
    // skipping when the original tables exist would leave those gaps forever.
    for (const statement of SCHEMA_STATEMENTS) {
      await this.db.prepare(statement).run();
    }
    await this.applyAdditiveColumns();
    // Columns must exist before the backfill reads or writes them.
    const folded = await this.migrateChannelsIntoAccounts();
    // Recorded last, and only on full success: a crash midway — or a backfill
    // that failed and wants to retry — leaves the version unset so the next
    // request tries again instead of taking the fast path forever.
    if (folded) {
      await this.setSetting('schema_version', SCHEMA_VERSION);
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
  private async migrateChannelsIntoAccounts(): Promise<boolean> {
    if (await this.getSetting('channels_folded_into_accounts')) return true;

    const hasChannels = await this.queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'channels'"
    ).catch(() => null);
    if (!Number(hasChannels?.total || 0)) {
      await this.setSetting('channels_folded_into_accounts', new Date().toISOString());
      return true;
    }

    try {
      // Inherit credentials before the join disappears.
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

      // Carry the multiplier across only where the account never set its own.
      await this.update(`
        UPDATE accounts SET rate_multiplier = COALESCE(
          (SELECT c.rate_multiplier FROM channels c WHERE c.id = accounts.channel_id), 1
        )
        WHERE (rate_multiplier IS NULL OR rate_multiplier = 1)
          AND EXISTS (SELECT 1 FROM channels c
                      WHERE c.id = accounts.channel_id
                        AND c.rate_multiplier IS NOT NULL AND c.rate_multiplier != 1)
      `).catch(() => {
        // Older channels rows may predate rate_multiplier; the default of 1 is
        // already correct in that case.
      });

      // A disabled channel used to mask every account beneath it.
      await this.update(`
        UPDATE accounts SET enabled = 0
        WHERE EXISTS (SELECT 1 FROM channels c
                      WHERE c.id = accounts.channel_id AND c.enabled = 0)
      `);

      await this.setSetting('channels_folded_into_accounts', new Date().toISOString());
      return true;
    } catch {
      // Leave the flag unset so the next request retries rather than starting
      // the gateway on half-migrated credentials. Reported to the caller so the
      // schema version is not stamped either: stamping it would take the fast
      // path on the next request and the retry would never happen.
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
  private async applyAdditiveColumns(): Promise<void> {
    const tables = [...new Set(ADDITIVE_COLUMNS.map(entry => entry.table))];
    const existing = new Map<string, Set<string>>();

    for (const table of tables) {
      try {
        const rows = await this.query<{ name: string }>(`PRAGMA table_info(${table})`);
        existing.set(table, new Set(rows.map(row => row.name)));
      } catch {
        // Table absent entirely; the CREATE statements above already cover it.
      }
    }

    for (const { table, column, definition } of ADDITIVE_COLUMNS) {
      const columns = existing.get(table);
      if (!columns || columns.has(column)) continue;
      try {
        await this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      } catch {
        // A concurrent isolate may have added it between the read and write.
      }
    }
  }

  /** Read a persisted setting, or null when it has never been written. */
  async getSetting(key: string): Promise<string | null> {
    try {
      const row = await this.queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
      return row?.value ?? null;
    } catch {
      // The settings table may not exist yet on a pre-migration database.
      return null;
    }
  }

  async setSetting(key: string, value: string): Promise<void> {
    try {
      await this.update(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        [key, value]
      );
    } catch {
      // A database created before `settings.updated_at` existed rejects the
      // statement above at prepare time, which would make every settings write
      // fail — including the flags that mark a migration finished. The
      // timestamp is only diagnostic, so fall back to writing the value alone.
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
  async setSettingIfAbsent(key: string, value: string): Promise<string> {
    await this.update('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    const row = await this.queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
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
  async schemaReady(): Promise<boolean> {
    const row = await this.queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name IN ('users','groups','accounts','model_mappings','api_keys','usage_records','request_logs')"
    );
    return Number(row?.total || 0) >= 7;
  }

  // Cleanup old logs
  async cleanupOldLogs(days = 7) {
    const cutoff = sqliteTimestamp(Date.now() - days * 24 * 60 * 60 * 1000);
    await this.exec(`DELETE FROM request_logs WHERE created_at < '${cutoff}'`);
    await this.exec(`DELETE FROM usage_records WHERE created_at < '${cutoff}'`);
  }
}

function sqliteTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');
}

export function createDatabase(db: D1Database): Database {
  return new Database(db);
}
