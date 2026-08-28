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
  async createGroup(name, description, priority = 0) {
    return this.insert(
      "INSERT INTO groups (name, description, priority) VALUES (?, ?, ?)",
      [name, description || "", priority]
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
  // Channel operations
  async listChannels() {
    return this.query("SELECT * FROM channels ORDER BY priority ASC, id ASC");
  }
  async getChannel(id) {
    return this.queryOne("SELECT * FROM channels WHERE id = ?", [id]);
  }
  async createChannel(name, provider, baseUrl, apiKey, priority = 0) {
    return this.insert(
      "INSERT INTO channels (name, provider, base_url, api_key, priority) VALUES (?, ?, ?, ?, ?)",
      [name, provider, baseUrl || "", apiKey || "", priority]
    );
  }
  async updateChannel(id, updates) {
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
    if (updates.base_url !== void 0) {
      fields.push("base_url = ?");
      values.push(updates.base_url);
    }
    if (updates.api_key !== void 0) {
      fields.push("api_key = ?");
      values.push(updates.api_key);
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
    return this.update(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`, values);
  }
  async deleteChannel(id) {
    return this.update("DELETE FROM channels WHERE id = ?", [id]);
  }
  // Account operations
  async listAccounts() {
    return this.query(`
      SELECT a.*, g.name as group_name, c.name as channel_name 
      FROM accounts a
      LEFT JOIN groups g ON a.group_id = g.id
      LEFT JOIN channels c ON a.channel_id = c.id
      ORDER BY a.priority ASC, a.id ASC
    `);
  }
  async getAccount(id) {
    return this.queryOne("SELECT * FROM accounts WHERE id = ?", [id]);
  }
  async createAccount(name, provider, apiKey, groupId, channelId, baseUrl, priority = 0, clientSpoofing) {
    return this.insert(
      "INSERT INTO accounts (name, provider, api_key, base_url, group_id, channel_id, priority, client_spoofing) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [name, provider, apiKey, baseUrl || "", groupId, channelId, priority, clientSpoofing || ""]
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
    if (updates.channel_id !== void 0) {
      fields.push("channel_id = ?");
      values.push(updates.channel_id);
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
  async listEnabledAccounts() {
    return this.query("SELECT * FROM accounts WHERE enabled = 1 ORDER BY priority ASC, id ASC");
  }
  // Model mapping operations
  async listModelMappings() {
    return this.query("SELECT * FROM model_mappings ORDER BY priority ASC, id ASC");
  }
  async getModelMapping(id) {
    return this.queryOne("SELECT * FROM model_mappings WHERE id = ?", [id]);
  }
  async createModelMapping(requestedModel, provider, upstreamModel, groupId, priority = 0) {
    return this.insert(
      "INSERT INTO model_mappings (requested_model, provider, upstream_model, group_id, priority) VALUES (?, ?, ?, ?, ?)",
      [requestedModel, provider, upstreamModel, groupId, priority]
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
    return this.query("SELECT id, name, enabled, balance, quota_limit, created_at FROM api_keys ORDER BY id DESC");
  }
  async getApiKeyByHash(keyHash) {
    return this.queryOne("SELECT * FROM api_keys WHERE key_hash = ?", [keyHash]);
  }
  async createApiKey(keyHash, name, quotaLimit = 0) {
    return this.insert(
      "INSERT INTO api_keys (key_hash, name, quota_limit) VALUES (?, ?, ?)",
      [keyHash, name || "", quotaLimit]
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
        record.error_message || "",
        record.latency_ms ?? 0
      ]
    );
  }
  async listUsageRecords(limit = 100, offset = 0) {
    return this.query(
      "SELECT * FROM usage_records ORDER BY created_at DESC LIMIT ? OFFSET ?",
      [limit, offset]
    );
  }
  // Request logs for error tracking
  async createRequestLog(log) {
    return this.insert(
      `INSERT INTO request_logs (account_id, channel_id, group_id, model, status, error_message, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        log.account_id,
        log.channel_id,
        log.group_id,
        log.model,
        log.status,
        log.error_message || "",
        log.latency_ms ?? 0
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
  async getChannelErrorStats(channelId, windowSeconds) {
    const cutoff = sqliteTimestamp(Date.now() - windowSeconds * 1e3);
    const result = await this.queryOne(
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

// functions/src/failover.ts
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
  recordRequest(accountId, channelId, groupId, isError) {
    const now = Date.now();
    const key = accountId;
    let window = this.errorWindows.get(key);
    if (!window) {
      window = {
        accountId,
        channelId,
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
        channelId: 0,
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
      channelId: window.channelId,
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
          channelId: 0,
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
  async selectAccount(accounts, channels, groups, preferredGroupId) {
    if (accounts.length === 0) return null;
    const usableAccounts = accounts.filter((acc) => {
      const channel2 = channels.get(acc.channel_id);
      const group2 = groups.get(acc.group_id);
      return acc.enabled === 1 && Boolean(channel2 && group2 && channel2.enabled === 1 && group2.enabled === 1) && channel2?.provider === acc.provider;
    });
    if (usableAccounts.length === 0) return null;
    const preferred = preferredGroupId ? usableAccounts.filter((acc) => acc.group_id === preferredGroupId) : [];
    const candidateAccounts = preferred.length > 0 ? preferred : usableAccounts;
    const statsByAccount = new Map(
      await Promise.all(candidateAccounts.map(async (acc) => [
        acc.id,
        await this.getErrorStats(acc.id, groups.get(acc.group_id))
      ]))
    );
    let healthyAccounts = candidateAccounts.filter((acc) => {
      const stats = statsByAccount.get(acc.id);
      return !stats.isUnhealthy;
    });
    if (healthyAccounts.length === 0) {
      healthyAccounts = [...candidateAccounts].sort((a, b) => {
        const statsA = statsByAccount.get(a.id);
        const statsB = statsByAccount.get(b.id);
        return statsA.errorRate - statsB.errorRate || statsA.errorCount - statsB.errorCount;
      });
    }
    healthyAccounts.sort((a, b) => {
      const groupA = groups.get(a.group_id);
      const groupB = groups.get(b.group_id);
      const channelA = channels.get(a.channel_id);
      const channelB = channels.get(b.channel_id);
      const statsA = statsByAccount.get(a.id);
      const statsB = statsByAccount.get(b.id);
      return groupA.priority - groupB.priority || channelA.priority - channelB.priority || a.priority - b.priority || statsA.errorRate - statsB.errorRate || statsA.errorCount - statsB.errorCount || (this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0) || a.id - b.id;
    });
    const selected = healthyAccounts[0];
    const channel = channels.get(selected.channel_id);
    const group = groups.get(selected.group_id);
    if (!channel || !group) return null;
    this.lastUsed.set(selected.id, Date.now());
    return {
      account: selected,
      channel,
      group,
      stats: statsByAccount.get(selected.id) ?? null
    };
  }
  // Check if error should trigger failover
  shouldFailover(error) {
    if (!error) return false;
    const status = error.status || error.statusCode || 0;
    return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
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
function calculateCost(provider, model, promptTokens, completionTokens) {
  const pricing = {
    openai: {
      "gpt-4o": { prompt: 2.5, completion: 10 },
      "gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
      "gpt-4-turbo": { prompt: 10, completion: 30 },
      "gpt-3.5-turbo": { prompt: 0.5, completion: 1.5 },
      "o1": { prompt: 15, completion: 60 },
      "o1-mini": { prompt: 3, completion: 12 },
      "o3": { prompt: 10, completion: 40 }
    },
    anthropic: {
      "claude-sonnet-4-20250514": { prompt: 3, completion: 15 },
      "claude-3-5-sonnet-20241022": { prompt: 3, completion: 15 },
      "claude-3-5-haiku-20241022": { prompt: 0.8, completion: 4 },
      "claude-3-opus-20240229": { prompt: 15, completion: 75 }
    },
    xai: {
      "grok-2-latest": { prompt: 2, completion: 10 },
      "grok-2": { prompt: 2, completion: 10 },
      "grok-vision-beta": { prompt: 2, completion: 10 }
    }
  };
  const providerPricing = pricing[provider] || pricing["openai"];
  const modelPricing = providerPricing[model] || { prompt: 1, completion: 2 };
  const promptCost = promptTokens / 1e3 * modelPricing.prompt;
  const completionCost = completionTokens / 1e3 * modelPricing.completion;
  return Math.round((promptCost + completionCost) * 1e6) / 1e6;
}

// functions/src/routes/gateway.ts
async function handleGatewayRequest(request, env, failover) {
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
  let accounts = await db.listEnabledAccounts();
  const [channelsRaw, groupsRaw, mappingsRaw] = await Promise.all([
    db.listChannels(),
    db.listGroups(),
    db.listModelMappings()
  ]);
  const channels = new Map(channelsRaw.map((c) => [c.id, c]));
  const groups = new Map(groupsRaw.map((g) => [g.id, g]));
  const mappings = mappingsRaw;
  const mapping = findModelMapping(model, mappings);
  if (mapping?.provider) provider = mapping.provider;
  accounts = accounts.filter((a) => a.provider === provider && a.enabled);
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: "No available accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const providerMapping = mapping && mapping.provider === provider ? mapping : findModelMapping(model, mappings, provider);
  let upstreamModel = providerMapping?.requested_model.endsWith("*") ? providerMapping.upstream_model + model.slice(providerMapping.requested_model.length - 1) : providerMapping?.upstream_model || model;
  const preferredGroupId = providerMapping?.group_id || void 0;
  const selection = await failover.selectAccount(accounts, channels, groups, preferredGroupId);
  if (!selection) {
    return new Response(JSON.stringify({ error: "No available accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const { account, channel, group, stats } = selection;
  const baseUrl = getUpstreamBaseUrl(account.base_url, provider);
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
  const headers = buildUpstreamHeaders(request.headers, provider, account.api_key, account.base_url, account.client_spoofing);
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
      failover.recordRequest(account.id, channel.id, group.id, true);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: responseStatus, error_message: `Upstream returned ${responseStatus}`, latency_ms: Date.now() - startTime }).catch(() => {
      });
      return handleFailover(upstreamBody, request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), channels, groups, mappings, provider, upstreamModel, stream, `Upstream returned ${responseStatus}`, preferredGroupId);
    }
    if (stream && proxyResponse.body) {
      failover.recordRequest(account.id, channel.id, group.id, isError);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: responseStatus, error_message: isError ? "Upstream error" : "", latency_ms: Date.now() - startTime }).catch(() => {
      });
      return new Response(proxyResponse.body, { status: proxyResponse.status, headers: { ...proxyResponse.headers, "content-type": proxyResponse.headers["content-type"] || "text/event-stream" } });
    }
    const responseText = await proxyResponse.text();
    let responseBody = {};
    try {
      responseBody = JSON.parse(responseText);
    } catch {
    }
    const { promptTokens, completionTokens, totalTokens } = extractTokenUsage(responseBody, proxyResponse.headers);
    const cost = calculateCost(
      provider,
      upstreamModel,
      responseBody?.usage?.prompt_tokens || 0,
      responseBody?.usage?.completion_tokens || 0
    );
    if (cost > 0) {
      db.incrementApiKeyUsage(keyRecord.id, cost).catch(() => {
      });
    }
    db.createUsageRecord({ api_key_id: keyRecord.id, model: upstreamModel, provider, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, status: responseStatus, error_message: isError ? responseBody?.error?.message || "Error" : "", latency_ms: Date.now() - startTime }).catch(() => {
    });
    db.createRequestLog({
      account_id: account.id,
      channel_id: channel.id,
      group_id: group.id,
      model: upstreamModel,
      status: responseStatus,
      error_message: isError ? errorMessage : "",
      latency_ms: Date.now() - startTime
    }).catch(() => {
    });
    failover.recordRequest(account.id, channel.id, group.id, isError);
    return new Response(responseText, {
      status: proxyResponse.status,
      headers: {
        ...proxyResponse.headers,
        "content-type": "application/json"
      }
    });
  } catch (error) {
    isError = true;
    errorMessage = error instanceof Error ? error.message : "Unknown error";
    responseStatus = 502;
    failover.recordRequest(account.id, channel.id, group.id, true);
    db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: 502, error_message: errorMessage, latency_ms: Date.now() - startTime }).catch(() => {
    });
    return handleFailover(upstreamBody, request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), channels, groups, mappings, provider, upstreamModel, stream, errorMessage, preferredGroupId);
  }
}
async function handleFailover(body, request, env, failover, keyRecord, accounts, channels, groups, mappings, provider, upstreamModel, stream, errorMessage, preferredGroupId) {
  const db = createDatabase(env.DB);
  const attempted = /* @__PURE__ */ new Set();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    const nextAccounts = accounts.filter((a) => a.enabled && !attempted.has(a.id));
    const selection = await failover.selectAccount(nextAccounts, channels, groups, preferredGroupId);
    if (!selection) {
      break;
    }
    const { account, channel, group } = selection;
    attempted.add(account.id);
    try {
      const baseUrl = getUpstreamBaseUrl(account.base_url, provider);
      const url = new URL(request.url);
      let upstreamPath = url.pathname;
      if (provider === "anthropic" && !upstreamPath.includes("/v1/messages")) {
        upstreamPath = "/v1/messages";
      } else if (provider === "xai" && !upstreamPath.includes("/chat/completions")) {
        upstreamPath = "/v1/chat/completions";
      }
      const retryUrl = new URL(`${baseUrl}${upstreamPath}`);
      if (provider === "anthropic") retryUrl.searchParams.set("beta", "true");
      const headers = buildUpstreamHeaders(request.headers, provider, account.api_key, account.base_url, account.client_spoofing);
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
        failover.recordRequest(account.id, channel.id, group.id, true);
        continue;
      }
      failover.recordRequest(account.id, channel.id, group.id, isError);
      db.createRequestLog({
        account_id: account.id,
        channel_id: channel.id,
        group_id: group.id,
        model: upstreamModel,
        status: proxyResponse.status,
        error_message: isError ? "Upstream error" : "",
        latency_ms: 0
      }).catch(() => {
      });
      if (stream && !isError && proxyResponse.body) {
        return new Response(proxyResponse.body, {
          status: proxyResponse.status,
          headers: { ...proxyResponse.headers, "content-type": proxyResponse.headers["content-type"] || "text/event-stream" }
        });
      }
      const responseText = await proxyResponse.text();
      return new Response(responseText, {
        status: proxyResponse.status,
        headers: { ...proxyResponse.headers, "content-type": "application/json" }
      });
    } catch (retryError) {
      failover.recordRequest(account.id, channel.id, group.id, true);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: 502, error_message: retryError instanceof Error ? retryError.message : "Upstream request failed", latency_ms: 0 }).catch(() => {
      });
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
async function handleOpenAIRequest(request, env, failover) {
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
  let accounts = await db.listEnabledAccounts();
  accounts = accounts.filter((a) => (a.provider === "openai" || a.provider === "xai") && a.enabled);
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: "No available accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const [channelsRaw, groupsRaw, mappingsRaw] = await Promise.all([
    db.listChannels(),
    db.listGroups(),
    db.listModelMappings()
  ]);
  const channels = new Map(channelsRaw.map((c) => [c.id, c]));
  const groups = new Map(groupsRaw.map((g) => [g.id, g]));
  const mappings = mappingsRaw;
  const mapping = findModelMapping(model, mappings, "openai") || findModelMapping(model, mappings, "xai");
  const requestedProvider = mapping?.provider || (model.toLowerCase().startsWith("grok-") ? "xai" : void 0);
  if (requestedProvider) {
    accounts = accounts.filter((account2) => account2.provider === requestedProvider);
  }
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: "No available accounts for requested model" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  let upstreamModel = mapping?.requested_model.endsWith("*") ? mapping.upstream_model + model.slice(mapping.requested_model.length - 1) : mapping?.upstream_model || model;
  const preferredGroupId = mapping?.group_id || void 0;
  if (upstreamModel && upstreamModel !== model && requestBody.model) {
    requestBody.model = upstreamModel;
  }
  const selection = await failover.selectAccount(accounts, channels, groups, preferredGroupId);
  if (!selection) {
    return new Response(JSON.stringify({ error: "No available accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const { account, channel, group } = selection;
  const provider = account.provider;
  const baseUrl = getUpstreamBaseUrl(account.base_url, provider);
  const upstreamUrl = `${baseUrl}${endpoint}`;
  const headers = buildUpstreamHeaders(request.headers, provider, account.api_key, account.base_url, account.client_spoofing);
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
      failover.recordRequest(account.id, channel.id, group.id, true);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: proxyResponse.status, error_message: `Upstream returned ${proxyResponse.status}`, latency_ms: Date.now() - startTime }).catch(() => {
      });
      return handleFailover2(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), channels, groups, mappings, provider, upstreamModel, stream, `Upstream returned ${proxyResponse.status}`, preferredGroupId);
    }
    if (stream && proxyResponse.body) {
      failover.recordRequest(account.id, channel.id, group.id, isError);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: proxyResponse.status, error_message: isError ? "Upstream error" : "", latency_ms: Date.now() - startTime }).catch(() => {
      });
      return new Response(proxyResponse.body, { status: proxyResponse.status, headers: { ...proxyResponse.headers, "content-type": proxyResponse.headers["content-type"] || "text/event-stream" } });
    }
    const responseText = await proxyResponse.text();
    let responseBody = {};
    try {
      responseBody = JSON.parse(responseText);
    } catch {
    }
    const { promptTokens, completionTokens, totalTokens } = extractTokenUsage(responseBody, proxyResponse.headers);
    const cost = calculateCost(provider, upstreamModel, promptTokens, completionTokens);
    if (cost > 0) {
      db.incrementApiKeyUsage(keyRecord.id, cost).catch(() => {
      });
    }
    db.createUsageRecord({ api_key_id: keyRecord.id, model: upstreamModel, provider, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, status: proxyResponse.status, error_message: isError ? responseBody?.error?.message || "Error" : "", latency_ms: Date.now() - startTime }).catch(() => {
    });
    db.createRequestLog({
      account_id: account.id,
      channel_id: channel.id,
      group_id: group.id,
      model: upstreamModel,
      status: proxyResponse.status,
      error_message: isError ? responseBody?.error?.message || "Error" : "",
      latency_ms: Date.now() - startTime
    }).catch(() => {
    });
    failover.recordRequest(account.id, channel.id, group.id, isError);
    return new Response(responseText, {
      status: proxyResponse.status,
      headers: {
        ...proxyResponse.headers,
        "content-type": "application/json"
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    failover.recordRequest(account.id, channel.id, group.id, true);
    db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: 502, error_message: errorMessage, latency_ms: Date.now() - startTime }).catch(() => {
    });
    return handleFailover2(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), channels, groups, mappings, provider, upstreamModel, stream, errorMessage, preferredGroupId);
  }
}
async function handleFailover2(body, request, env, failover, keyRecord, accounts, channels, groups, mappings, provider, upstreamModel, stream, errorMessage, preferredGroupId) {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const isResponses = url.pathname.includes("/responses");
  let endpoint = "/v1/chat/completions";
  if (isResponses) endpoint = "/v1/responses";
  const attempted = /* @__PURE__ */ new Set();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    const nextAccounts = accounts.filter((a) => a.enabled && !attempted.has(a.id));
    const selection = await failover.selectAccount(nextAccounts, channels, groups, preferredGroupId);
    if (!selection) break;
    const { account, channel, group } = selection;
    attempted.add(account.id);
    const currentProvider = account.provider;
    try {
      const baseUrl = getUpstreamBaseUrl(account.base_url, currentProvider);
      const upstreamUrl = `${baseUrl}${endpoint}`;
      const headers = buildUpstreamHeaders(request.headers, currentProvider, account.api_key, account.base_url, account.client_spoofing);
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
        failover.recordRequest(account.id, channel.id, group.id, true);
        continue;
      }
      failover.recordRequest(account.id, channel.id, group.id, isError);
      db.createRequestLog({
        account_id: account.id,
        channel_id: channel.id,
        group_id: group.id,
        model: upstreamModel,
        status: proxyResponse.status,
        error_message: isError ? errorMessage : "",
        latency_ms: 0
      }).catch(() => {
      });
      if (stream && !isError && proxyResponse.body) {
        return new Response(proxyResponse.body, {
          status: proxyResponse.status,
          headers: { ...proxyResponse.headers, "content-type": proxyResponse.headers["content-type"] || "text/event-stream" }
        });
      }
      const responseText = await proxyResponse.text();
      return new Response(responseText, {
        status: proxyResponse.status,
        headers: { ...proxyResponse.headers, "content-type": "application/json" }
      });
    } catch (retryError) {
      failover.recordRequest(account.id, channel.id, group.id, true);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: 502, error_message: retryError instanceof Error ? retryError.message : "Upstream request failed", latency_ms: 0 }).catch(() => {
      });
      continue;
    }
  }
  return new Response(JSON.stringify({ error: "All accounts failed", message: errorMessage }), { status: 502, headers: { "Content-Type": "application/json" } });
}

// functions/src/routes/claude.ts
async function handleClaudeRequest(request, env, failover) {
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
  let accounts = await db.listEnabledAccounts();
  accounts = accounts.filter((a) => a.provider === "anthropic" && a.enabled);
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: "No available Anthropic accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const [channelsRaw, groupsRaw, mappingsRaw] = await Promise.all([
    db.listChannels(),
    db.listGroups(),
    db.listModelMappings()
  ]);
  const channels = new Map(channelsRaw.map((c) => [c.id, c]));
  const groups = new Map(groupsRaw.map((g) => [g.id, g]));
  const mappings = mappingsRaw;
  const mapping = findModelMapping(model, mappings, "anthropic");
  let upstreamModel = mapping?.requested_model.endsWith("*") ? mapping.upstream_model + model.slice(mapping.requested_model.length - 1) : mapping?.upstream_model || model;
  const preferredGroupId = mapping?.group_id || void 0;
  if (upstreamModel && upstreamModel !== model && requestBody.model) {
    requestBody.model = upstreamModel;
  }
  const selection = await failover.selectAccount(accounts, channels, groups, preferredGroupId);
  if (!selection) {
    return new Response(JSON.stringify({ error: "No available accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const { account, channel, group } = selection;
  const baseUrl = getUpstreamBaseUrl(account.base_url, "anthropic");
  const upstreamUrl = `${baseUrl}/v1/messages?beta=true`;
  const headers = buildUpstreamHeaders(request.headers, "anthropic", account.api_key, account.base_url, account.client_spoofing);
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
      failover.recordRequest(account.id, channel.id, group.id, true);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: proxyResponse.status, error_message: `Upstream returned ${proxyResponse.status}`, latency_ms: Date.now() - startTime }).catch(() => {
      });
      return handleClaudeFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), channels, groups, mappings, upstreamModel, stream, `Upstream returned ${proxyResponse.status}`, preferredGroupId);
    }
    if (stream && proxyResponse.body) {
      failover.recordRequest(account.id, channel.id, group.id, isError);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: proxyResponse.status, error_message: isError ? "Upstream error" : "", latency_ms: Date.now() - startTime }).catch(() => {
      });
      return new Response(proxyResponse.body, { status: proxyResponse.status, headers: { ...proxyResponse.headers, "content-type": proxyResponse.headers["content-type"] || "text/event-stream" } });
    }
    const responseText = await proxyResponse.text();
    let responseBody = {};
    try {
      responseBody = JSON.parse(responseText);
    } catch {
    }
    const { promptTokens, completionTokens, totalTokens } = extractTokenUsage(responseBody, proxyResponse.headers);
    const cost = calculateCost("anthropic", upstreamModel, promptTokens, completionTokens);
    if (cost > 0) {
      db.incrementApiKeyUsage(keyRecord.id, cost).catch(() => {
      });
    }
    db.createUsageRecord({ api_key_id: keyRecord.id, model: upstreamModel, provider: "anthropic", prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, status: proxyResponse.status, error_message: isError ? responseBody?.error?.message || "Error" : "", latency_ms: Date.now() - startTime }).catch(() => {
    });
    db.createRequestLog({
      account_id: account.id,
      channel_id: channel.id,
      group_id: group.id,
      model: upstreamModel,
      status: proxyResponse.status,
      error_message: isError ? responseBody?.error?.message || "Error" : "",
      latency_ms: Date.now() - startTime
    }).catch(() => {
    });
    failover.recordRequest(account.id, channel.id, group.id, isError);
    return new Response(responseText, {
      status: proxyResponse.status,
      headers: {
        ...proxyResponse.headers,
        "content-type": "application/json"
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    failover.recordRequest(account.id, channel.id, group.id, true);
    db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: 502, error_message: errorMessage, latency_ms: Date.now() - startTime }).catch(() => {
    });
    return handleClaudeFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter((candidate) => candidate.id !== account.id), channels, groups, mappings, upstreamModel, stream, errorMessage, preferredGroupId);
  }
}
async function handleClaudeFailover(body, request, env, failover, keyRecord, accounts, channels, groups, mappings, upstreamModel, stream, errorMessage, preferredGroupId) {
  const db = createDatabase(env.DB);
  const attempted = /* @__PURE__ */ new Set();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    const nextAccounts = accounts.filter((a) => a.enabled && !attempted.has(a.id));
    const selection = await failover.selectAccount(nextAccounts, channels, groups, preferredGroupId);
    if (!selection) break;
    const { account, channel, group } = selection;
    attempted.add(account.id);
    try {
      const baseUrl = getUpstreamBaseUrl(account.base_url, "anthropic");
      const upstreamUrl = `${baseUrl}/v1/messages?beta=true`;
      const headers = buildUpstreamHeaders(request.headers, "anthropic", account.api_key, account.base_url, account.client_spoofing);
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
        failover.recordRequest(account.id, channel.id, group.id, true);
        continue;
      }
      failover.recordRequest(account.id, channel.id, group.id, isError);
      db.createRequestLog({
        account_id: account.id,
        channel_id: channel.id,
        group_id: group.id,
        model: upstreamModel,
        status: proxyResponse.status,
        error_message: isError ? errorMessage : "",
        latency_ms: 0
      }).catch(() => {
      });
      if (stream && !isError && proxyResponse.body) {
        return new Response(proxyResponse.body, {
          status: proxyResponse.status,
          headers: { ...proxyResponse.headers, "content-type": proxyResponse.headers["content-type"] || "text/event-stream" }
        });
      }
      const responseText = await proxyResponse.text();
      return new Response(responseText, {
        status: proxyResponse.status,
        headers: { ...proxyResponse.headers, "content-type": "application/json" }
      });
    } catch (retryError) {
      failover.recordRequest(account.id, channel.id, group.id, true);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: 502, error_message: retryError instanceof Error ? retryError.message : "Upstream request failed", latency_ms: 0 }).catch(() => {
      });
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
    const session = await verifySessionToken(token, env.JWT_SECRET || "change-me-in-dashboard");
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }
  if (method === "GET") {
    const groups = await db.listGroups();
    return new Response(JSON.stringify({ data: groups }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "POST") {
    const body = await request.json();
    if (!body.name) {
      return new Response(JSON.stringify({ error: "Name is required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const result = await db.createGroup(
      body.name,
      body.description,
      body.priority || 0
    );
    if (body.error_threshold !== void 0 || body.error_count_threshold !== void 0 || body.window_seconds !== void 0) {
      await db.updateGroup(result.lastRowId, {
        error_threshold: body.error_threshold ?? 0.5,
        error_count_threshold: body.error_count_threshold ?? 5,
        window_seconds: body.window_seconds ?? 300
      });
    }
    const group = await db.getGroup(result.lastRowId);
    return new Response(JSON.stringify({ data: group }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "PUT") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    const body = await request.json();
    if (!id) {
      return new Response(JSON.stringify({ error: "Invalid group ID" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    await db.updateGroup(id, body);
    const group = await db.getGroup(id);
    return new Response(JSON.stringify({ data: group }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "DELETE") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    if (!id) {
      return new Response(JSON.stringify({ error: "Invalid group ID" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    await db.deleteGroup(id);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
}

// functions/src/config/channels.ts
async function handleChannelsRequest(request, env) {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const method = request.method;
  {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const token = authHeader.slice(7);
    const session = await verifySessionToken(token, env.JWT_SECRET || "change-me-in-dashboard");
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }
  if (method === "GET") {
    const channels = await db.listChannels();
    return new Response(JSON.stringify({ data: channels.map(({ api_key, ...channel }) => ({ ...channel, api_key: api_key ? "***" : "" })) }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "POST") {
    const body = await request.json();
    if (!body.name || !body.provider) {
      return new Response(JSON.stringify({ error: "Name and provider are required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const result = await db.createChannel(
      body.name,
      body.provider,
      body.base_url,
      body.api_key,
      body.priority || 0
    );
    const channel = await db.getChannel(result.lastRowId);
    return new Response(JSON.stringify({ data: channel }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "PUT") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    const body = await request.json();
    if (!id) {
      return new Response(JSON.stringify({ error: "Invalid channel ID" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    await db.updateChannel(id, body);
    const channel = await db.getChannel(id);
    return new Response(JSON.stringify({ data: channel }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "DELETE") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    if (!id) {
      return new Response(JSON.stringify({ error: "Invalid channel ID" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    await db.deleteChannel(id);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
}

// functions/src/config/accounts.ts
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
    const session = await verifySessionToken(token, env.JWT_SECRET || "change-me-in-dashboard");
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }
  if (method === "GET") {
    const accounts = await db.listAccounts();
    return new Response(JSON.stringify({ data: accounts.map(({ api_key, ...account }) => ({ ...account, api_key: api_key ? "***" : "" })) }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "POST" && !url.pathname.endsWith("/test")) {
    const body = await request.json();
    if (!body.name || !body.provider || !body.api_key || !body.group_id || !body.channel_id) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const result = await db.createAccount(
      body.name,
      body.provider,
      body.api_key,
      body.group_id,
      body.channel_id,
      body.base_url,
      body.priority || 0
    );
    const account = await db.getAccount(result.lastRowId);
    return new Response(JSON.stringify({ data: account }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "PUT") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    const body = await request.json();
    if (!id) {
      return new Response(JSON.stringify({ error: "Invalid account ID" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    await db.updateAccount(id, body);
    const account = await db.getAccount(id);
    return new Response(JSON.stringify({ data: account }), {
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
  if (method === "POST" && url.pathname.endsWith("/test")) {
    const segments = url.pathname.split("/");
    const id = parseInt(segments[segments.length - 2] || "0");
    if (!id) {
      return new Response(JSON.stringify({ error: "Invalid account ID" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const account = await db.getAccount(id);
    if (!account) {
      return new Response(JSON.stringify({ error: "Account not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    try {
      const baseUrl = account.base_url || getDefaultBaseUrl(account.provider);
      const testUrl = `${baseUrl}/v1/models`;
      const response = await fetch(testUrl, {
        headers: getAuthHeaders(account.provider, account.api_key)
      });
      return new Response(JSON.stringify({
        success: response.ok,
        status: response.status,
        message: response.ok ? "Connection successful" : "Connection failed"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        message: error instanceof Error ? error.message : "Unknown error"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
}
function getDefaultBaseUrl(provider) {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "xai":
      return "https://api.x.ai";
    case "openai":
      return "https://api.openai.com";
    default:
      return "https://api.openai.com";
  }
}
function getAuthHeaders(provider, apiKey) {
  switch (provider) {
    case "anthropic":
      return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    case "openai":
    case "xai":
      return { "authorization": `Bearer ${apiKey}` };
    default:
      return { "authorization": `Bearer ${apiKey}` };
  }
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
    const session = await verifySessionToken(token, env.JWT_SECRET || "change-me-in-dashboard");
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }
  if (method === "GET") {
    const mappings = await db.listModelMappings();
    return new Response(JSON.stringify({ data: mappings }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "POST") {
    const body = await request.json();
    if (!body.requested_model || !body.provider || !body.upstream_model || !body.group_id) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const result = await db.createModelMapping(
      body.requested_model,
      body.provider,
      body.upstream_model,
      body.group_id,
      body.priority || 0
    );
    const mapping = await db.getModelMapping(result.lastRowId);
    return new Response(JSON.stringify({ data: mapping }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (method === "PUT") {
    const id = parseInt(url.pathname.split("/").pop() || "0");
    const body = await request.json();
    if (!id) {
      return new Response(JSON.stringify({ error: "Invalid mapping ID" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    await db.updateModelMapping(id, body);
    const mapping = await db.getModelMapping(id);
    return new Response(JSON.stringify({ data: mapping }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
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
  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
}

// functions/_worker.ts
var sharedFailover = null;
var worker_default = {
  async fetch(request, env, ctx) {
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
      if (request.method === "GET") return json({ method: "POST", message: "Send username and password as JSON to initialize the administrator." });
      return json({ error: "Method not allowed" }, 405);
    }
    if (path.startsWith("/api/v1/keys")) {
      return handleApiKeys(request, env);
    }
    if (path === "/api/v1/usage" && request.method === "GET") {
      return handleUsage(request, env);
    }
    if (path.startsWith("/api/v1/groups")) {
      return handleGroupsRequest(request, env, ctx);
    }
    if (path.startsWith("/api/v1/channels")) {
      return handleChannelsRequest(request, env);
    }
    if (path.startsWith("/api/v1/accounts")) {
      return handleAccountsRequest(request, env);
    }
    if (path.startsWith("/api/v1/models")) {
      return handleModelsRequest(request, env);
    }
    const failover = sharedFailover ?? (sharedFailover = new FailoverManager(env));
    failover.setDb(createDatabase(env.DB));
    if (path === "/v1/models" && request.method === "GET") {
      return handleProviderModels(request, env);
    }
    if (path.startsWith("/v1/chat/completions")) {
      return handleOpenAIRequest(request, env, failover);
    }
    if (path.startsWith("/v1/responses")) {
      return handleOpenAIRequest(request, env, failover);
    }
    if (path.startsWith("/v1/messages")) {
      return handleClaudeRequest(request, env, failover);
    }
    if (path.startsWith("/v1/")) {
      return handleGatewayRequest(request, env, failover);
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
};
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
  const token = await createSessionToken(session, env.JWT_SECRET || "change-me-in-dashboard");
  return json({
    token,
    user: { id: session.userId, username: session.username, is_admin: session.isAdmin }
  });
}
async function handleSetup(request, env) {
  const db = createDatabase(env.DB);
  const existing = await db.queryOne("SELECT id, password_hash FROM users LIMIT 1");
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.username || !body.password || body.username.length > 128 || body.password.length < 8) {
    return json({ error: "Username and password required" }, 400);
  }
  const passwordHash = await hashPassword(body.password);
  if (existing && existing.password_hash.startsWith("$2a$")) {
    await db.update("UPDATE users SET username = ?, password_hash = ? WHERE id = ?", [body.username, passwordHash, existing.id]);
  } else if (existing) {
    return json({ error: "Setup already completed" }, 400);
  } else {
    await db.createUser(body.username, passwordHash);
  }
  return json({ success: true, message: "Admin user created" });
}
async function handleApiKeys(request, env) {
  const session = await checkAuth(request, env);
  if (!session) {
    return json({ error: "Unauthorized" }, 401);
  }
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
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
    const apiKey = `sk-${Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const keyHash = await hashApiKey(apiKey);
    const result = await db.createApiKey(keyHash, body.name, body.quota_limit || 0);
    return json({
      data: {
        id: result.lastRowId,
        key: apiKey,
        name: body.name,
        enabled: true,
        balance: 0,
        quota_limit: body.quota_limit || 0
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
    const updates = {};
    if (body.name !== void 0) updates.name = String(body.name).trim();
    if (body.enabled !== void 0) updates.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;
    if (body.balance !== void 0 && Number.isFinite(Number(body.balance))) updates.balance = Number(body.balance);
    if (body.quota_limit !== void 0 && Number.isFinite(Number(body.quota_limit))) updates.quota_limit = Math.max(0, Number(body.quota_limit));
    await db.updateApiKey(id, updates);
    const key = await db.queryOne("SELECT id, name, enabled, balance, quota_limit, created_at FROM api_keys WHERE id = ?", [id]);
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
async function checkAuth(request, env) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7);
  const session = await verifySessionToken(token, env.JWT_SECRET || "change-me-in-dashboard");
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
