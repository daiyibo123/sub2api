// Model mappings configuration API
import type { Env } from '../index';
import { createDatabase } from '../db';
import { verifySessionToken, resolveSessionSecret } from '../auth';

export async function handleModelsRequest(request: Request, env: Env): Promise<Response> {
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
  
  // GET /api/v1/models - list all model mappings
  if (method === 'GET') {
    const mappings = await db.listModelMappings();
    return jsonData(mappings);
  }
  
  // POST /api/v1/models - create model mapping
  if (method === 'POST') {
    let body: {
      requested_model?: string; provider?: string; upstream_model?: string;
      group_id?: number; priority?: number; enabled?: number | boolean;
    };
    try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

    const requestedModel = String(body.requested_model || '').trim();
    const upstreamModel = String(body.upstream_model || '').trim();
    const provider = String(body.provider || '').trim();
    const groupId = Number(body.group_id);

    if (!requestedModel || !upstreamModel) return jsonError('请填写客户端模型名和上游模型名', 400);
    if (!PROVIDERS.includes(provider)) return jsonError('服务商必须是 openai、anthropic 或 xai', 400);
    if (!groupId) return jsonError('请选择目标分组', 400);
    if (!(await db.getGroup(groupId))) return jsonError('所选分组不存在', 400);

    // Only a trailing '*' is supported as a prefix wildcard by findModelMapping.
    if (requestedModel.includes('*') && !requestedModel.endsWith('*')) {
      return jsonError('通配符只能放在客户端模型名末尾，例如 gpt-4*', 400);
    }

    // findModelMapping resolves one rule per client model and provider, so a
    // second identical pair would never be reachable.
    const duplicate = await db.findModelMappingByModel(requestedModel, provider);
    if (duplicate) {
      return jsonError(`已存在 ${requestedModel} 到 ${provider} 的映射，请先编辑或删除原规则`, 409);
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
    return jsonData(mapping, 201);
  }
  
  // PUT /api/v1/models/:id - update model mapping
  if (method === 'PUT') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    if (!id) return jsonError('Invalid mapping ID', 400);

    let body: Record<string, any>;
    try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

    if (!(await db.getModelMapping(id))) return jsonError('模型映射不存在', 404);

    const updates: Record<string, unknown> = {};
    if (body.requested_model !== undefined) {
      const requestedModel = String(body.requested_model).trim();
      if (!requestedModel) return jsonError('客户端模型名不能为空', 400);
      if (requestedModel.includes('*') && !requestedModel.endsWith('*')) {
        return jsonError('通配符只能放在客户端模型名末尾，例如 gpt-4*', 400);
      }
      updates.requested_model = requestedModel;
    }
    if (body.upstream_model !== undefined) {
      const upstreamModel = String(body.upstream_model).trim();
      if (!upstreamModel) return jsonError('上游模型名不能为空', 400);
      updates.upstream_model = upstreamModel;
    }
    if (body.provider !== undefined) {
      const provider = String(body.provider).trim();
      if (!PROVIDERS.includes(provider)) return jsonError('服务商必须是 openai、anthropic 或 xai', 400);
      updates.provider = provider;
    }
    if (body.group_id !== undefined) {
      const groupId = Number(body.group_id);
      if (!groupId || !(await db.getGroup(groupId))) return jsonError('所选分组不存在', 400);
      updates.group_id = groupId;
    }
    if (body.priority !== undefined) updates.priority = Number(body.priority) || 0;
    if (body.enabled !== undefined) updates.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;

    await db.updateModelMapping(id, updates);
    const mapping = await db.getModelMapping(id);
    return jsonData(mapping);
  }
  
  // DELETE /api/v1/models/:id - delete model mapping
  if (method === 'DELETE') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    
    if (!id) {
      return new Response(JSON.stringify({ error: 'Invalid mapping ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    await db.deleteModelMapping(id);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
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
