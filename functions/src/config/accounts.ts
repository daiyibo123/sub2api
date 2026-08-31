// Accounts configuration API
import type { Env } from '../index';
import { createDatabase } from '../db';
import { verifySessionToken, resolveSessionSecret } from '../auth';
import { probeAccount, probeAccounts, listUpstreamModels } from '../utils/healthcheck';
import { isProvider, getProbeModel } from '../utils/provider';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

/** Never return stored upstream credentials to the dashboard. */
/**
 * Parse a billing weight. Returns a message when the value is unusable.
 *
 * 0 is allowed and means the upstream is free, so the check is `>= 0` rather
 * than truthiness. The ceiling only guards against a typo that would otherwise
 * push an account to the very end of the scheduling order forever.
 */
function readRateMultiplier(value: unknown): number | string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return '倍率必须是不小于 0 的数字';
  if (parsed > 100) return '倍率不能大于 100';
  return parsed;
}

/**
 * Blank means "use the provider default". Anything else must parse as an
 * absolute http(s) URL, otherwise the mistake only surfaces later as a
 * confusing upstream fetch failure instead of a clear message here.
 */
function normalizeBaseUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function maskAccount(account: any) {
  if (!account) return account;
  const { api_key, ...rest } = account;
  return { ...rest, api_key: api_key ? '***' : '', has_api_key: Boolean(api_key) };
}

export async function handleAccountsRequest(request: Request, env: Env): Promise<Response> {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const method = request.method;
  
  // Configuration is an administrator-only surface.
  {
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    
    const token = authHeader.slice(7);
    const session = await verifySessionToken(token, await resolveSessionSecret(db, env.JWT_SECRET));
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }
  
  // GET /api/v1/accounts/:id/models - ask the upstream which models it serves.
  // This must be matched before the plain list route, otherwise the trailing
  // path segment would be ignored and every account would be returned instead.
  const modelsMatch = /\/accounts\/(\d+)\/models$/.exec(url.pathname);
  if (method === 'GET' && modelsMatch) {
    const id = Number(modelsMatch[1]);
    // The list is cached on the account after a successful fetch, so reopening
    // the dialog does not re-hit the upstream. `?refresh=1` forces a live fetch
    // for the case where the upstream's catalogue really did change.
    const refresh = url.searchParams.get('refresh') === '1';
    try {
      const result = await listUpstreamModels(db, id, refresh);
      const account = await db.getAccount(id);
      return new Response(JSON.stringify({
        data: {
          account_id: id,
          models: result.models,
          cached: result.cached,
          fetched_at: result.fetchedAt,
          probe_model: String(account?.probe_model || '')
        }
      }), { status: 200, headers: JSON_HEADERS });
    } catch (error) {
      // A rejected upstream listing is information about that upstream, not a
      // broken admin API, so the message is surfaced verbatim to the operator.
      return jsonError(error instanceof Error ? error.message : '获取上游模型失败', 502);
    }
  }

  // GET /api/v1/accounts - list all accounts
  if (method === 'GET') {
    const accounts = await db.listAccounts();
    return new Response(JSON.stringify({ data: accounts.map(maskAccount) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // POST /api/v1/accounts - create account
  // `/test` and `/test-all` are probe endpoints, not creates. Checking only for
  // a `/test` suffix would let `/test-all` fall through into account creation.
  const isProbePath = url.pathname.endsWith('/test') || url.pathname.endsWith('/test-all');
  if (method === 'POST' && !isProbePath) {
    let body: {
      name?: string; provider?: string; api_key?: string; group_id?: number;
      base_url?: string; priority?: number; client_spoofing?: string; enabled?: number | boolean;
      rate_multiplier?: number;
    };
    try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

    const name = String(body.name || '').trim();
    const provider = String(body.provider || '').trim();
    const groupId = Number(body.group_id);

    if (!name || !provider || !groupId) {
      return jsonError('请填写账号名称，并选择服务商和分组', 400);
    }
    if (!['openai', 'anthropic', 'xai'].includes(provider)) {
      return jsonError('服务商必须是 openai、anthropic 或 xai', 400);
    }

    // The group must exist, otherwise scheduling would silently skip this
    // account forever.
    if (!(await db.getGroup(groupId))) return jsonError('所选分组不存在', 400);

    // The account now carries its own credential; there is no channel left to
    // inherit one from.
    const baseUrl = normalizeBaseUrl(body.base_url);
    if (baseUrl === null) return jsonError('基础地址必须是 http(s) 开头的合法地址，例如 https://api.openai.com', 400);

    const apiKey = String(body.api_key || '').trim();
    if (!apiKey) return jsonError('请填写上游密钥', 400);

    const multiplier = readRateMultiplier(body.rate_multiplier ?? 1);
    if (typeof multiplier === 'string') return jsonError(multiplier, 400);

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
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // PUT /api/v1/accounts/:id - update account
  if (method === 'PUT') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    if (!id) return jsonError('Invalid account ID', 400);

    let body: Partial<any>;
    try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

    const existing = await db.getAccount(id);
    if (!existing) return jsonError('账号不存在', 404);

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return jsonError('账号名称不能为空', 400);
      updates.name = name;
    }
    if (body.provider !== undefined) {
      if (!['openai', 'anthropic', 'xai'].includes(String(body.provider))) {
        return jsonError('服务商必须是 openai、anthropic 或 xai', 400);
      }
      updates.provider = String(body.provider);
    }
    if (body.base_url !== undefined) {
      const baseUrl = normalizeBaseUrl(body.base_url);
      if (baseUrl === null) return jsonError('基础地址必须是 http(s) 开头的合法地址，例如 https://api.openai.com', 400);
      updates.base_url = baseUrl;
    }
    if (body.client_spoofing !== undefined) updates.client_spoofing = String(body.client_spoofing || '').trim();
    if (body.priority !== undefined && Number.isFinite(Number(body.priority))) updates.priority = Number(body.priority);
    if (body.enabled !== undefined) updates.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;
    if (body.rate_multiplier !== undefined) {
      const multiplier = readRateMultiplier(body.rate_multiplier);
      if (typeof multiplier === 'string') return jsonError(multiplier, 400);
      updates.rate_multiplier = multiplier;
    }
    // A blank key means "keep the stored credential" so the masked list value
    // can never be written back over the real secret.
    if (typeof body.api_key === 'string' && body.api_key.trim() && body.api_key.trim() !== '***') {
      updates.api_key = body.api_key.trim();
    }
    if (body.group_id !== undefined) {
      const groupId = Number(body.group_id);
      if (!groupId || !(await db.getGroup(groupId))) return jsonError('所选分组不存在', 400);
      updates.group_id = groupId;
    }
    await db.updateAccount(id, updates);
    const account = await db.getAccount(id);

    return new Response(JSON.stringify({ data: maskAccount(account) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // DELETE /api/v1/accounts/:id - delete account
  if (method === 'DELETE') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    
    if (!id) {
      return new Response(JSON.stringify({ error: 'Invalid account ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    await db.deleteAccount(id);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // POST /api/v1/accounts/test-all - keep-alive probe (批量测活)
  //
  // Scoping is by group, and several groups may be selected at once: an operator
  // usually wants to keep a few named pools warm, not one pool or everything.
  //
  // The model is chosen per provider, not per account. A provider default is
  // predictable — an operator reading the results knows exactly which model was
  // exercised — whereas replaying whatever each account happened to be probed
  // with last makes two accounts in the same group report on different models.
  // `models` lets the caller override a provider's default for this run.
  if (method === 'POST' && url.pathname.endsWith('/test-all')) {
    let body: {
      group_id?: number | string | null;
      group_ids?: Array<number | string> | null;
      models?: Record<string, string> | null;
    } = {};
    try { body = await request.json() as typeof body; } catch { body = {}; }

    // `group_ids` is the multi-select form; `group_id` is kept so an existing
    // single-group caller (or a saved keep-alive cron) does not break.
    const rawGroups: Array<number | string> = Array.isArray(body.group_ids)
      ? body.group_ids
      : body.group_id !== undefined && body.group_id !== null
        ? [body.group_id]
        : [];

    const requested = rawGroups
      .map(value => String(value).trim())
      .filter(value => value !== '' && value !== 'all');
    // An explicit "all" — or nothing at all — means every enabled account.
    const scoped = requested.length > 0;

    const groupIds: number[] = [];
    const groupNames: string[] = [];
    for (const value of requested) {
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) return jsonError('分组无效', 400);
      const group = await db.getGroup(id);
      if (!group) return jsonError('所选分组不存在', 400);
      if (groupIds.includes(id)) continue;
      groupIds.push(id);
      groupNames.push(String(group.name || ''));
    }

    // Per-provider overrides. Validated here so a typo is reported once rather
    // than surfacing as an identical upstream failure on every account.
    const overrides: Record<string, string> = {};
    for (const [provider, model] of Object.entries(body.models || {})) {
      if (!isProvider(provider)) return jsonError(`未知的服务商：${provider}`, 400);
      const trimmed = String(model || '').trim();
      if (trimmed) overrides[provider] = trimmed;
    }

    const accounts = await db.listAccounts();
    const selected = accounts
      .filter(account => Number(account.enabled) === 1)
      .filter(account => !scoped || groupIds.includes(Number(account.group_id)));

    if (!selected.length) {
      return jsonError(
        scoped ? `分组「${groupNames.join('、')}」下没有启用的账号` : '没有启用的账号可测试',
        400
      );
    }

    // Resolve each account's model from its provider before probing, so the
    // response can report which model every row was tested with.
    const ids = selected.map(account => Number(account.id));
    const models: Record<number, string> = {};
    for (const account of selected) {
      const provider = String(account.provider || '');
      models[Number(account.id)] = overrides[provider] || getProbeModel(provider);
    }

    const results = await probeAccounts(db, ids, 4, models);
    const healthy = results.filter(result => result.success).length;
    return new Response(JSON.stringify({
      data: {
        group_ids: scoped ? groupIds : null,
        group_names: scoped ? groupNames : null,
        // Retained for a caller written against the single-group response.
        group_id: scoped && groupIds.length === 1 ? groupIds[0] : null,
        group_name: scoped && groupNames.length === 1 ? groupNames[0] : '',
        total: results.length,
        healthy,
        failed: results.length - healthy,
        results: results.map(result => ({
          account_id: result.accountId,
          name: result.name,
          provider: result.provider,
          group_id: Number(selected.find(a => Number(a.id) === result.accountId)?.group_id) || null,
          group_name: String(selected.find(a => Number(a.id) === result.accountId)?.group_name || ''),
          success: result.success,
          status: result.status,
          latency_ms: result.latencyMs,
          ttft_ms: result.ttftMs ?? null,
          model: result.model || '',
          message: result.message
        }))
      }
    }), { status: 200, headers: JSON_HEADERS });
  }

  // POST /api/v1/accounts/:id/test - probe one account (测活)
  if (method === 'POST' && url.pathname.endsWith('/test')) {
    const segments = url.pathname.split('/');
    const id = parseInt(segments[segments.length - 2] || '0');
    if (!id) return jsonError('Invalid account ID', 400);

    // The dialog sends the model the operator picked from the upstream's own
    // list. A missing body keeps the provider default so the older
    // one-click path still works.
    let selectedModel = '';
    try {
      const body = await request.json() as { model?: string };
      selectedModel = String(body?.model || '').trim();
    } catch {
      selectedModel = '';
    }

    const result = await probeAccount(db, id, selectedModel || undefined);
    // A failed probe is a valid answer about the upstream, not a failed API
    // call, so the transport stays 200 and the verdict rides in the body.
    return new Response(JSON.stringify({
      success: result.success,
      status: result.status,
      latency_ms: result.latencyMs,
      model: result.model || '',
      message: result.message
    }), { status: 200, headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}


