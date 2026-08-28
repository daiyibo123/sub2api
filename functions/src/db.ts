// D1 Database abstraction layer
import type { Env } from './index';
import type { UsageRecord, RequestLog } from './types';
import { SCHEMA_STATEMENTS } from './schema';

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

  // Channel operations
  async listChannels() {
    return this.query<any>('SELECT * FROM channels ORDER BY priority ASC, id ASC');
  }

  async getChannel(id: number) {
    return this.queryOne<any>('SELECT * FROM channels WHERE id = ?', [id]);
  }

  /** channels.name is UNIQUE; pre-check so collisions get a readable message. */
  async getChannelByName(name: string) {
    return this.queryOne<any>('SELECT * FROM channels WHERE name = ?', [name]);
  }

  async createChannel(name: string, provider: string, baseUrl?: string, apiKey?: string, priority = 0, enabled = 1) {
    return this.insert(
      'INSERT INTO channels (name, provider, base_url, api_key, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)',
      [name, provider, baseUrl || '', apiKey || '', priority, enabled]
    );
  }

  async updateChannel(id: number, updates: Partial<any>) {
    const fields: string[] = [];
    const values: any[] = [];
    
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.provider !== undefined) { fields.push('provider = ?'); values.push(updates.provider); }
    if (updates.base_url !== undefined) { fields.push('base_url = ?'); values.push(updates.base_url); }
    if (updates.api_key !== undefined) { fields.push('api_key = ?'); values.push(updates.api_key); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled); }
    if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
    
    if (fields.length === 0) return { changes: 0 };
    values.push(id);
    return this.update(`UPDATE channels SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async deleteChannel(id: number) {
    return this.update('DELETE FROM channels WHERE id = ?', [id]);
  }

  // Account operations
  async listAccounts() {
    return this.query<any>(`
      SELECT a.*, g.name as group_name, c.name as channel_name 
      FROM accounts a
      LEFT JOIN groups g ON a.group_id = g.id
      LEFT JOIN channels c ON a.channel_id = c.id
      ORDER BY a.priority ASC, a.id ASC
    `);
  }

  async getAccount(id: number) {
    return this.queryOne<any>('SELECT * FROM accounts WHERE id = ?', [id]);
  }

  async createAccount(name: string, provider: string, apiKey: string, groupId: number, channelId: number, baseUrl?: string, priority = 0, clientSpoofing?: string, enabled = 1) {
    return this.insert(
      'INSERT INTO accounts (name, provider, api_key, base_url, group_id, channel_id, priority, client_spoofing, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, provider, apiKey, baseUrl || '', groupId, channelId, priority, clientSpoofing || '', enabled]
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
    if (updates.channel_id !== undefined) { fields.push('channel_id = ?'); values.push(updates.channel_id); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled); }
    if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
    if (updates.error_count !== undefined) { fields.push('error_count = ?'); values.push(updates.error_count); }
    if (updates.error_rate !== undefined) { fields.push('error_rate = ?'); values.push(updates.error_rate); }
    if (updates.client_spoofing !== undefined) { fields.push('client_spoofing = ?'); values.push(updates.client_spoofing); }
    
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
   * An account with a blank api_key falls back to its channel's key, so a
   * channel can hold one shared credential for several accounts.
   */
  async listEnabledAccounts() {
    return this.query<any>(`
      SELECT a.*, COALESCE(NULLIF(a.api_key, ''), c.api_key, '') AS api_key
      FROM accounts a
      LEFT JOIN channels c ON a.channel_id = c.id
      WHERE a.enabled = 1
      ORDER BY a.priority ASC, a.id ASC
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
   * Count accounts that would be orphaned by switching a channel's provider.
   * Scheduling requires channel.provider === account.provider, so such accounts
   * would silently stop receiving traffic.
   */
  async countAccountsForChannelWithOtherProvider(channelId: number, nextProvider: string): Promise<number> {
    const row = await this.queryOne<{ total: number }>(
      'SELECT COUNT(*) AS total FROM accounts WHERE channel_id = ? AND provider != ?',
      [channelId, nextProvider]
    );
    return Number(row?.total || 0);
  }

  /**
   * Name lookups back friendly duplicate errors. Both groups and channels have
   * a UNIQUE(name) constraint, which would otherwise surface as a raw D1 500.
   */
  async findGroupByName(name: string) {
    return this.queryOne<any>('SELECT * FROM groups WHERE name = ?', [name]);
  }

  async findChannelByName(name: string) {
    return this.queryOne<any>('SELECT * FROM channels WHERE name = ?', [name]);
  }

  /** Accounts still pointing at a channel, used to block unsafe deletes. */
  async countAccountsForChannel(channelId: number): Promise<number> {
    const row = await this.queryOne<{ total: number }>(
      'SELECT COUNT(*) AS total FROM accounts WHERE channel_id = ?',
      [channelId]
    );
    return Number(row?.total || 0);
  }

  /** Resolve an account with the channel key fallback applied. */
  async getAccountWithKey(id: number) {
    return this.queryOne<any>(`
      SELECT a.*, COALESCE(NULLIF(a.api_key, ''), c.api_key, '') AS api_key
      FROM accounts a
      LEFT JOIN channels c ON a.channel_id = c.id
      WHERE a.id = ?
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
    return this.query<any>('SELECT id, name, enabled, balance, quota_limit, created_at FROM api_keys ORDER BY id DESC');
  }

  async getApiKeyByHash(keyHash: string) {
    return this.queryOne<any>('SELECT * FROM api_keys WHERE key_hash = ?', [keyHash]);
  }

  async createApiKey(keyHash: string, name?: string, quotaLimit = 0) {
    return this.insert(
      'INSERT INTO api_keys (key_hash, name, quota_limit) VALUES (?, ?, ?)',
      [keyHash, name || '', quotaLimit]
    );
  }

  async updateApiKey(id: number, updates: Partial<any>) {
    const fields: string[] = [];
    const values: any[] = [];
    
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled); }
    if (updates.balance !== undefined) { fields.push('balance = ?'); values.push(updates.balance); }
    if (updates.quota_limit !== undefined) { fields.push('quota_limit = ?'); values.push(updates.quota_limit); }
    
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
       (api_key_id, model, provider, prompt_tokens, completion_tokens, total_tokens, cost, status, error_message, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.api_key_id ?? 0,
        record.model,
        record.provider,
        record.prompt_tokens ?? 0,
        record.completion_tokens ?? 0,
        record.total_tokens ?? 0,
        record.cost ?? 0,
        record.status ?? 200,
        record.error_message || '',
        record.latency_ms ?? 0
      ]
    );
  }

  async listUsageRecords(limit = 100, offset = 0) {
    return this.query<any>(
      'SELECT * FROM usage_records ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
  }

  // Request logs for error tracking
  async createRequestLog(log: Partial<RequestLog>) {
    return this.insert(
      `INSERT INTO request_logs (account_id, channel_id, group_id, model, status, error_message, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        log.account_id,
        log.channel_id,
        log.group_id,
        log.model,
        log.status,
        log.error_message || '',
        log.latency_ms ?? 0
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

  async getChannelErrorStats(channelId: number, windowSeconds: number) {
    const cutoff = sqliteTimestamp(Date.now() - windowSeconds * 1000);
    const result = await this.queryOne<any>(
      `SELECT 
        COUNT(*) as total_requests,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as error_count
       FROM request_logs 
       WHERE channel_id = ? AND created_at >= ?`,
      [channelId, cutoff]
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
          COALESCE(AVG(NULLIF(latency_ms, 0)), 0) AS avg_latency
        FROM usage_records
      `),
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
          (SELECT COUNT(*) FROM channels) AS total_channels,
          (SELECT COUNT(*) FROM channels WHERE enabled = 1) AS active_channels,
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
        SELECT model, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost
        FROM usage_records GROUP BY model ORDER BY requests DESC LIMIT 12
      `),
      this.query<any>(`
        SELECT provider, COUNT(*) AS requests, COALESCE(SUM(cost), 0) AS cost
        FROM usage_records GROUP BY provider ORDER BY requests DESC
      `)
    ]);

    return { totals: totals || {}, today: today || {}, resources: resources || {}, trend, byModel, byProvider };
  }

  /**
   * Apply the schema when tables are missing. Pages deployments often have no
   * access to `wrangler d1 execute`, so first run would otherwise fail with a
   * raw "no such table" error. Every statement is idempotent.
   */
  async ensureSchema(): Promise<boolean> {
    const wasReady = await this.schemaReady();
    // Every statement is `IF NOT EXISTS`, so this runs unconditionally: a
    // database created by an older release is missing later tables, and
    // skipping when the original tables exist would leave those gaps forever.
    for (const statement of SCHEMA_STATEMENTS) {
      await this.db.prepare(statement).run();
    }
    return !wasReady;
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
    await this.update(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [key, value]
    );
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

  /** Cheap probe used to decide whether migration is needed. */
  async schemaReady(): Promise<boolean> {
    try {
      const row = await this.queryOne<{ total: number }>(
        "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name IN ('users','groups','channels','accounts','model_mappings','api_keys','usage_records','request_logs')"
      );
      return Number(row?.total || 0) >= 8;
    } catch {
      return false;
    }
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
