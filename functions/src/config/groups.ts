// Groups configuration API
import { Env } from '../index';
import { createDatabase } from '../db';
import { verifySessionToken } from '../auth';

export async function handleGroupsRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const method = request.method;
  
  // Auth check for write operations
  if (method !== 'GET') {
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    
    const token = authHeader.slice(7);
    const session = await verifySessionToken(token, env.JWT_SECRET || 'default-secret');
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }
  
  // GET /api/v1/groups - list all groups
  if (method === 'GET') {
    const groups = await db.listGroups();
    return new Response(JSON.stringify({ data: groups }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // POST /api/v1/groups - create group
  if (method === 'POST') {
    const body = await request.json<{ name: string; description?: string; priority?: number; error_threshold?: number; error_count_threshold?: number; window_seconds?: number }>();
    
    if (!body.name) {
      return new Response(JSON.stringify({ error: 'Name is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const result = await db.createGroup(
      body.name,
      body.description,
      body.priority || 0
    );
    
    // Update thresholds if provided
    if (body.error_threshold !== undefined || body.error_count_threshold !== undefined || body.window_seconds !== undefined) {
      await db.updateGroup(result.lastRowId, {
        error_threshold: body.error_threshold ?? 0.5,
        error_count_threshold: body.error_count_threshold ?? 5,
        window_seconds: body.window_seconds ?? 300
      });
    }
    
    const group = await db.getGroup(result.lastRowId);
    return new Response(JSON.stringify({ data: group }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // PUT /api/v1/groups/:id - update group
  if (method === 'PUT') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    const body = await request.json<Partial<any>>();
    
    if (!id) {
      return new Response(JSON.stringify({ error: 'Invalid group ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    await db.updateGroup(id, body);
    const group = await db.getGroup(id);
    
    return new Response(JSON.stringify({ data: group }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // DELETE /api/v1/groups/:id - delete group
  if (method === 'DELETE') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    
    if (!id) {
      return new Response(JSON.stringify({ error: 'Invalid group ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    await db.deleteGroup(id);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}
