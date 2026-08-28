// Channels configuration API
import type { Env } from '../index';
import { createDatabase } from '../db';
import { verifySessionToken, resolveSessionSecret } from '../auth';

export async function handleChannelsRequest(request: Request, env: Env): Promise<Response> {
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
  
  // GET /api/v1/channels - list all channels
  if (method === 'GET') {
    const channels = await db.listChannels();
    return jsonData(channels.map(maskChannel));
  }
  
  // POST /api/v1/channels - create channel
  if (method === 'POST') {
    let body: {
      name?: string; provider?: string; base_url?: string; api_key?: string;
      priority?: number; enabled?: number | boolean;
    };
    try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

    const name = String(body.name || '').trim();
    const provider = String(body.provider || '').trim();
    if (!name) return jsonError('请填写渠道名称', 400);
    if (!PROVIDERS.includes(provider)) return jsonError('服务商必须是 openai、anthropic 或 xai', 400);

    const baseUrl = normalizeBaseUrl(body.base_url);
    if (baseUrl === null) return jsonError('基础地址必须是 http(s) 开头的合法地址', 400);

    // channels.name is UNIQUE; report the clash instead of a raw D1 error.
    if (await db.getChannelByName(name)) return jsonError(`渠道名称「${name}」已存在`, 409);

    const result = await db.createChannel(
      name,
      provider,
      baseUrl,
      String(body.api_key || '').trim(),
      Number(body.priority) || 0,
      body.enabled === false || body.enabled === 0 ? 0 : 1
    );
    
    const channel = await db.getChannel(result.lastRowId);
    return jsonData(maskChannel(channel), 201);
  }
  
  // PUT /api/v1/channels/:id - update channel
  if (method === 'PUT') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    if (!id) return jsonError('Invalid channel ID', 400);

    let body: Record<string, any>;
    try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

    const existing = await db.getChannel(id);
    if (!existing) return jsonError('渠道不存在', 404);

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return jsonError('请填写渠道名称', 400);
      const clash = await db.getChannelByName(name);
      if (clash && Number(clash.id) !== id) return jsonError(`渠道名称「${name}」已存在`, 409);
      updates.name = name;
    }
    if (body.provider !== undefined) {
      const provider = String(body.provider).trim();
      if (!PROVIDERS.includes(provider)) return jsonError('服务商必须是 openai、anthropic 或 xai', 400);
      updates.provider = provider;
    }
    if (body.base_url !== undefined) {
      const baseUrl = normalizeBaseUrl(body.base_url);
      if (baseUrl === null) return jsonError('基础地址必须是 http(s) 开头的合法地址', 400);
      updates.base_url = baseUrl;
    }
    // An omitted or blank key preserves the stored credential.
    if (body.api_key !== undefined && String(body.api_key).trim()) {
      updates.api_key = String(body.api_key).trim();
    }
    if (body.priority !== undefined) updates.priority = Number(body.priority) || 0;
    if (body.enabled !== undefined) updates.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;

    // Switching provider would orphan accounts that still point at this channel.
    const nextProvider = String(updates.provider ?? existing.provider);
    if (nextProvider !== existing.provider) {
      const conflicting = await db.countAccountsForChannelWithOtherProvider(id, nextProvider);
      if (conflicting > 0) {
        return jsonError(`该渠道下有 ${conflicting} 个 ${existing.provider} 账号，请先调整账号服务商`, 400);
      }
    }

    await db.updateChannel(id, updates);
    const channel = await db.getChannel(id);
    return jsonData(maskChannel(channel));
  }
  
  // DELETE /api/v1/channels/:id - delete channel
  if (method === 'DELETE') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    if (!id) return jsonError('Invalid channel ID', 400);

    if (!await db.getChannel(id)) return jsonError('渠道不存在', 404);

    // Accounts reference channels by id with no FK cascade, so deleting a
    // referenced channel would leave accounts that can never be scheduled.
    const dependants = await db.countAccountsForChannel(id);
    if (dependants > 0) {
      return jsonError(`该渠道下还有 ${dependants} 个上游账号，请先删除或迁移这些账号`, 400);
    }

    await db.deleteChannel(id);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: JSON_HEADERS });
  }
  
  return jsonError('Method not allowed', 405);
}

const PROVIDERS = ['openai', 'anthropic', 'xai'];

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: JSON_HEADERS });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

/** Never return a stored credential; the UI only needs to know one exists. */
function maskChannel(channel: any) {
  if (!channel) return channel;
  const { api_key, ...rest } = channel;
  return { ...rest, has_api_key: Boolean(api_key), api_key: api_key ? '***' : '' };
}

/**
 * Blank means "use the provider default". Anything else must parse as an
 * absolute http(s) URL, otherwise upstream fetches fail at request time with a
 * confusing error instead of here.
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
