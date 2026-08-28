// Accounts configuration API
import type { Env } from '../index';
import { createDatabase } from '../db';
import { verifySessionToken, resolveSessionSecret } from '../auth';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

/** Never return stored upstream credentials to the dashboard. */
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
  
  // GET /api/v1/accounts - list all accounts
  if (method === 'GET') {
    const accounts = await db.listAccounts();
    return new Response(JSON.stringify({ data: accounts.map(maskAccount) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // POST /api/v1/accounts - create account
  if (method === 'POST' && !url.pathname.endsWith('/test')) {
    let body: {
      name?: string; provider?: string; api_key?: string; group_id?: number; channel_id?: number;
      base_url?: string; priority?: number; client_spoofing?: string; enabled?: number | boolean;
    };
    try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

    const name = String(body.name || '').trim();
    const provider = String(body.provider || '').trim();
    const groupId = Number(body.group_id);
    const channelId = Number(body.channel_id);

    if (!name || !provider || !groupId || !channelId) {
      return jsonError('请填写账号名称，并选择服务商、分组和渠道', 400);
    }
    if (!['openai', 'anthropic', 'xai'].includes(provider)) {
      return jsonError('服务商必须是 openai、anthropic 或 xai', 400);
    }

    // Referenced group and channel must exist, and the channel provider has to
    // match, otherwise scheduling would silently skip this account forever.
    const [group, channel] = await Promise.all([db.getGroup(groupId), db.getChannel(channelId)]);
    if (!group) return jsonError('所选分组不存在', 400);
    if (!channel) return jsonError('所选渠道不存在', 400);
    if (channel.provider !== provider) {
      return jsonError(`所选渠道属于 ${channel.provider}，与账号服务商 ${provider} 不一致`, 400);
    }

    // An empty account key inherits the channel key at request time, so only
    // reject when neither side can supply credentials.
    const apiKey = String(body.api_key || '').trim();
    if (!apiKey && !String(channel.api_key || '').trim()) {
      return jsonError('账号密钥为空时，所选渠道必须配置默认密钥', 400);
    }

    const result = await db.createAccount(
      name,
      provider,
      apiKey,
      groupId,
      channelId,
      body.base_url,
      Number(body.priority) || 0,
      body.client_spoofing,
      body.enabled === false || body.enabled === 0 ? 0 : 1
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
    if (body.base_url !== undefined) updates.base_url = String(body.base_url || '').trim();
    if (body.client_spoofing !== undefined) updates.client_spoofing = String(body.client_spoofing || '').trim();
    if (body.priority !== undefined && Number.isFinite(Number(body.priority))) updates.priority = Number(body.priority);
    if (body.enabled !== undefined) updates.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;
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
    if (body.channel_id !== undefined) {
      const channelId = Number(body.channel_id);
      const channel = channelId ? await db.getChannel(channelId) : null;
      if (!channel) return jsonError('所选渠道不存在', 400);
      const provider = String(updates.provider ?? existing.provider);
      if (channel.provider !== provider) {
        return jsonError(`所选渠道属于 ${channel.provider}，与账号服务商 ${provider} 不一致`, 400);
      }
      updates.channel_id = channelId;
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
  
  // POST /api/v1/accounts/:id/test - test account connection
  if (method === 'POST' && url.pathname.endsWith('/test')) {
    const segments = url.pathname.split('/');
    const id = parseInt(segments[segments.length - 2] || '0');
    if (!id) {
      return new Response(JSON.stringify({ error: 'Invalid account ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const account = await db.getAccount(id);
    if (!account) return jsonError('账号不存在', 404);

    // The scheduler falls back to the channel key when the account key is
    // blank, so the test has to resolve credentials and base URL the same way.
    const channel = await db.getChannel(account.channel_id);
    const apiKey = String(account.api_key || '').trim() || String(channel?.api_key || '').trim();
    if (!apiKey) {
      return new Response(JSON.stringify({ success: false, message: '账号和渠道都没有配置密钥' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    const baseUrl = String(account.base_url || '').trim()
      || String(channel?.base_url || '').trim()
      || getDefaultBaseUrl(account.provider);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      // Anthropic has no public GET /v1/models on every plan, so probe the
      // endpoint the gateway actually forwards to with a 1-token request.
      const isAnthropic = account.provider === 'anthropic';
      const testUrl = isAnthropic
        ? `${baseUrl.replace(/\/$/, '')}/v1/messages`
        : `${baseUrl.replace(/\/$/, '')}/v1/models`;

      const response = await fetch(testUrl, {
        method: isAnthropic ? 'POST' : 'GET',
        headers: { ...getAuthHeaders(account.provider, apiKey), 'content-type': 'application/json' },
        body: isAnthropic ? JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        }) : undefined,
        signal: controller.signal
      }).finally(() => clearTimeout(timer));

      let detail = '';
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        try { detail = JSON.parse(raw)?.error?.message || ''; } catch { detail = raw.slice(0, 160); }
      }

      return new Response(JSON.stringify({
        success: response.ok,
        status: response.status,
        message: response.ok
          ? `连接成功（HTTP ${response.status}）`
          : `连接失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? '连接超时（15 秒）'
        : error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ success: false, message }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}

function getDefaultBaseUrl(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'https://api.anthropic.com';
    case 'xai': return 'https://api.x.ai';
    case 'openai': return 'https://api.openai.com';
    default: return 'https://api.openai.com';
  }
}

function getAuthHeaders(provider: string, apiKey: string): Record<string, string> {
  switch (provider) {
    case 'anthropic':
      return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    case 'openai':
    case 'xai':
      return { 'authorization': `Bearer ${apiKey}` };
    default:
      return { 'authorization': `Bearer ${apiKey}` };
  }
}
