// Model mappings configuration API
import type { Env } from '../index';
import { createDatabase } from '../db';
import { verifySessionToken } from '../auth';

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
    const session = await verifySessionToken(token, env.JWT_SECRET || 'change-me-in-dashboard');
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }
  
  // GET /api/v1/models - list all model mappings
  if (method === 'GET') {
    const mappings = await db.listModelMappings();
    return new Response(JSON.stringify({ data: mappings }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // POST /api/v1/models - create model mapping
  if (method === 'POST') {
    const body = await request.json<{ requested_model: string; provider: string; upstream_model: string; group_id: number; priority?: number }>();
    
    if (!body.requested_model || !body.provider || !body.upstream_model || !body.group_id) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // PUT /api/v1/models/:id - update model mapping
  if (method === 'PUT') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    const body = await request.json<Partial<any>>();
    
    if (!id) {
      return new Response(JSON.stringify({ error: 'Invalid mapping ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    await db.updateModelMapping(id, body);
    const mapping = await db.getModelMapping(id);
    
    return new Response(JSON.stringify({ data: mapping }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
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
  
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}
