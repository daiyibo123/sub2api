// D1 Database abstraction layer
import type { Env } from './index';
import type { UsageRecord, RequestLog } from './types';

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

  async createGroup(name: string, description?: string, priority = 0) {
    return this.insert(
      'INSERT INTO groups (name, description, priority) VALUES (?, ?, ?)',
      [name, description || '', priority]
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

  async createChannel(name: string, provider: string, baseUrl?: string, apiKey?: string, priority = 0) {
    return this.insert(
      'INSERT INTO channels (name, provider, base_url, api_key, priority) VALUES (?, ?, ?, ?, ?)',
      [name, provider, baseUrl || '', apiKey || '', priority]
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

  async createAccount(name: string, provider: string, apiKey: string, groupId: number, channelId: number, baseUrl?: string, priority = 0, clientSpoofing?: string) {
    return this.insert(
      'INSERT INTO accounts (name, provider, api_key, base_url, group_id, channel_id, priority, client_spoofing) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, provider, apiKey, baseUrl || '', groupId, channelId, priority, clientSpoofing || '']
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

  async listEnabledAccounts() {
    return this.query<any>('SELECT * FROM accounts WHERE enabled = 1 ORDER BY priority ASC, id ASC');
  }

  // Model mapping operations
  async listModelMappings() {
    return this.query<any>('SELECT * FROM model_mappings ORDER BY priority ASC, id ASC');
  }

  async getModelMapping(id: number) {
    return this.queryOne<any>('SELECT * FROM model_mappings WHERE id = ?', [id]);
  }

  async createModelMapping(requestedModel: string, provider: string, upstreamModel: string, groupId: number, priority = 0) {
    return this.insert(
      'INSERT INTO model_mappings (requested_model, provider, upstream_model, group_id, priority) VALUES (?, ?, ?, ?, ?)',
      [requestedModel, provider, upstreamModel, groupId, priority]
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
