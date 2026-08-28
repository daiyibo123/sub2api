// Channels configuration API
import type { Env } from '../index';
import { createDatabase } from '../db';
import { verifySessionToken } from '../auth';

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
    const session = await verifySessionToken(token, env.JWT_SECRET || 'change-me-in-dashboard');
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }
  
  // GET /api/v1/channels - list all channels
  if (method === 'GET') {
    const channels = await db.listChannels();
    return new Response(JSON.stringify({ data: channels.map(({ api_key, ...channel }) => ({ ...channel, api_key: api_key ? '***' : '' })) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // POST /api/v1/channels - create channel
  if (method === 'POST') {
    const body = await request.json<{ name: string; provider: string; base_url?: string; api_key?: string; priority?: number }>();
    
    if (!body.name || !body.provider) {
      return new Response(JSON.stringify({ error: 'Name and provider are required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // PUT /api/v1/channels/:id - update channel
  if (method === 'PUT') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    const body = await request.json<Partial<any>>();
    
    if (!id) {
      return new Response(JSON.stringify({ error: 'Invalid channel ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    await db.updateChannel(id, body);
    const channel = await db.getChannel(id);
    
    return new Response(JSON.stringify({ data: channel }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // DELETE /api/v1/channels/:id - delete channel
  if (method === 'DELETE') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    
    if (!id) {
      return new Response(JSON.stringify({ error: 'Invalid channel ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    await db.deleteChannel(id);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}
