// Sub2API Gateway - Cloudflare Pages _worker entry
// This file acts as the unified entry for all requests in Cloudflare Pages Functions

import { createDatabase } from './src/db'
import { verifySessionToken, hashApiKey, hashPassword, authenticateUser, authenticateApiKey, createSessionToken } from './src/auth'
import type { Env } from './src/index'
import { FailoverManager } from './src/failover'
import { handleGatewayRequest } from './src/routes/gateway'
import { handleOpenAIRequest } from './src/routes/openai'
import { handleClaudeRequest } from './src/routes/claude'
import { handleGrokRequest } from './src/routes/grok'
import { handleGroupsRequest } from './src/config/groups'
import { handleChannelsRequest } from './src/config/channels'
import { handleAccountsRequest } from './src/config/accounts'
import { handleModelsRequest } from './src/config/models'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (!env.DB) return json({ error: 'D1 binding DB is not configured' }, 500)

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Anthropic-Version, Anthropic-Beta',
        }
      })
    }

    // Health check
    if (path === '/health' || path === '/api/health') {
      return json({ status: 'ok', timestamp: new Date().toISOString() })
    }

    // Login
    if (path === '/api/v1/auth/login' && request.method === 'POST') {
      return handleLogin(request, env)
    }

    // Setup
    if (path === '/api/v1/auth/setup') {
      if (request.method === 'POST') return handleSetup(request, env)
      if (request.method === 'GET') return json({ method: 'POST', message: 'Send username and password as JSON to initialize the administrator.' })
      return json({ error: 'Method not allowed' }, 405)
    }

    // API Key management
    if (path.startsWith('/api/v1/keys')) {
      return handleApiKeys(request, env)
    }

    // Usage
    if (path === '/api/v1/usage' && request.method === 'GET') {
      return handleUsage(request, env)
    }

    // Config endpoints
    if (path.startsWith('/api/v1/groups')) {
      return handleGroupsRequest(request, env, ctx)
    }
    if (path.startsWith('/api/v1/channels')) {
      return handleChannelsRequest(request, env)
    }
    if (path.startsWith('/api/v1/accounts')) {
      return handleAccountsRequest(request, env)
    }
    if (path.startsWith('/api/v1/models')) {
      return handleModelsRequest(request, env)
    }

    // Gateway endpoints
    const failover = new FailoverManager(env)
    failover.setDb(createDatabase(env.DB))

    // OpenAI clients commonly probe this endpoint before sending a request.
    if (path === '/v1/models' && request.method === 'GET') {
      return handleProviderModels(request, env)
    }

    if (path.startsWith('/v1/chat/completions')) {
      return handleOpenAIRequest(request, env, failover)
    }
    if (path.startsWith('/v1/responses')) {
      return handleOpenAIRequest(request, env, failover)
    }
    if (path.startsWith('/v1/messages')) {
      return handleClaudeRequest(request, env, failover)
    }
    if (path.startsWith('/v1/')) {
      return handleGatewayRequest(request, env, failover)
    }

    // In Pages advanced mode static files are exposed through ASSETS.
    if (env.ASSETS) {
      const assetUrl = new URL(request.url)
      if (!assetUrl.pathname.includes('.')) assetUrl.pathname = '/index.html'
      return env.ASSETS.fetch(new Request(assetUrl.toString(), request))
    }
    return json({ error: 'Not found' }, 404)
  }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Anthropic-Version, Anthropic-Beta',
    }
  })
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: { username?: string; password?: string }
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

  if (!body.username || !body.password) {
    return json({ error: 'Username and password required' }, 400)
  }

  const db = createDatabase(env.DB)
  const session = await authenticateUser(db, body.username, body.password)
  if (!session) return json({ error: 'Invalid credentials' }, 401)
  const token = await createSessionToken(session, env.JWT_SECRET || 'change-me-in-dashboard')

  return json({
    token,
    user: { id: session.userId, username: session.username, is_admin: session.isAdmin }
  })
}

async function handleSetup(request: Request, env: Env): Promise<Response> {
  const db = createDatabase(env.DB)
  const existing = await db.queryOne<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users LIMIT 1')

  let body: { username?: string; password?: string }
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

  if (!body.username || !body.password || body.username.length > 128 || body.password.length < 8) {
    return json({ error: 'Username and password required' }, 400)
  }

  const passwordHash = await hashPassword(body.password)
  if (existing && existing.password_hash.startsWith('$2a$')) {
    await db.update('UPDATE users SET username = ?, password_hash = ? WHERE id = ?', [body.username, passwordHash, existing.id])
  } else if (existing) {
    return json({ error: 'Setup already completed' }, 400)
  } else {
    await db.createUser(body.username, passwordHash)
  }

  return json({ success: true, message: 'Admin user created' })
}

async function handleApiKeys(request: Request, env: Env): Promise<Response> {
  const session = await checkAuth(request, env)
  if (!session) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const db = createDatabase(env.DB)
  const url = new URL(request.url)

  if (request.method === 'GET') {
    const keys = await db.listApiKeys()
    return json({ data: keys })
  }

  if (request.method === 'POST') {
    let body: { name?: string; quota_limit?: number }
    try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

    const apiKey = `sk-${Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')}`
    const keyHash = await hashApiKey(apiKey)

    const result = await db.createApiKey(keyHash, body.name, body.quota_limit || 0)

    return json({
      data: {
        id: result.lastRowId,
        key: apiKey,
        name: body.name,
        enabled: true,
        balance: 0,
        quota_limit: body.quota_limit || 0
      }
    }, 201)
  }

  if (request.method === 'DELETE') {
    const id = parseInt(url.pathname.split('/').pop() || '0')
    if (!id) return json({ error: 'Invalid ID' }, 400)
    await db.deleteApiKey(id)
    return json({ success: true })
  }

  return json({ error: 'Method not allowed' }, 405)
}

async function handleUsage(request: Request, env: Env): Promise<Response> {
  const session = await checkAuth(request, env)
  if (!session) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const db = createDatabase(env.DB)
  const url = new URL(request.url)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500)
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0)

  const records = await db.listUsageRecords(limit, offset)
  return json({ data: records })
}

async function checkAuth(request: Request, env: Env): Promise<any> {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  const token = authHeader.slice(7)
  const session = await verifySessionToken(token, env.JWT_SECRET || 'change-me-in-dashboard')
  return session
}

async function handleProviderModels(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Missing API key' }, 401)
  const db = createDatabase(env.DB)
  if (!await authenticateApiKey(db, authHeader.slice(7))) {
    return json({ error: 'Invalid or disabled API key' }, 401)
  }
  const accounts = await db.listEnabledAccounts()
  const mappings = await db.listModelMappings()
  const ids = new Set<string>(mappings.filter(m => m.enabled).map(m => m.requested_model))
  accounts.forEach(account => ids.add(account.provider === 'anthropic' ? 'claude-3-5-sonnet-20241022' : account.provider === 'xai' ? 'grok-2-latest' : 'gpt-4o'))
  return json({ object: 'list', data: [...ids].map(id => ({ id, object: 'model', owned_by: 'sub2api' })) })
}
