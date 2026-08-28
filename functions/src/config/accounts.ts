// Accounts configuration API
import type { Env } from '../index';
import { createDatabase } from '../db';
import { verifySessionToken } from '../auth';

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
    const session = await verifySessionToken(token, env.JWT_SECRET || 'change-me-in-dashboard');
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }
  
  // GET /api/v1/accounts - list all accounts
  if (method === 'GET') {
    const accounts = await db.listAccounts();
    return new Response(JSON.stringify({ data: accounts.map(({ api_key, ...account }) => ({ ...account, api_key: api_key ? '***' : '' })) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // POST /api/v1/accounts - create account
  if (method === 'POST' && !url.pathname.endsWith('/test')) {
    const body = await request.json<{ name: string; provider: string; api_key: string; group_id: number; channel_id: number; base_url?: string; priority?: number }>();
    
    if (!body.name || !body.provider || !body.api_key || !body.group_id || !body.channel_id) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // PUT /api/v1/accounts/:id - update account
  if (method === 'PUT') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    const body = await request.json<Partial<any>>();
    
    if (!id) {
      return new Response(JSON.stringify({ error: 'Invalid account ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    await db.updateAccount(id, body);
    const account = await db.getAccount(id);
    
    return new Response(JSON.stringify({ data: account }), {
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
    if (!account) {
      return new Response(JSON.stringify({ error: 'Account not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Simple test: try to make a request to the provider
    try {
      const baseUrl = account.base_url || getDefaultBaseUrl(account.provider);
      const testUrl = `${baseUrl}/v1/models`;
      
      const response = await fetch(testUrl, {
        headers: getAuthHeaders(account.provider, account.api_key)
      });
      
      return new Response(JSON.stringify({ 
        success: response.ok, 
        status: response.status,
        message: response.ok ? 'Connection successful' : 'Connection failed'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        success: false, 
        message: error instanceof Error ? error.message : 'Unknown error'
      }), {
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
