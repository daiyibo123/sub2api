// Sub2API Gateway - Cloudflare Pages _worker entry
// This file acts as the unified entry for all requests in Cloudflare Pages Functions

import { createDatabase } from './src/db'
import { verifySessionToken, hashApiKey } from './src/auth'
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
    const path = url.pathname

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
    if (path === '/api/v1/auth/setup' && request.method === 'POST') {
      return handleSetup(request, env)
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

    // Static assets fallback
    return json({ error: 'Not found' }, 404)
  }
}

// Env type for Cloudflare Pages Functions
export interface Env {
  DB: D1Database
  CONFIG_KV: KVNamespace
  JWT_SECRET?: string
  ERROR_RATE_THRESHOLD?: string
  ERROR_COUNT_THRESHOLD?: string
  WINDOW_SECONDS?: string
  MAX_SAME_ACCOUNT_RETRIES?: string
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  })
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ username: string; password: string }>()

  if (!body.username || !body.password) {
    return json({ error: 'Username and password required' }, 400)
  }

  const db = createDatabase(env.DB)
  const user = await db.getUserByUsername(body.username)

  if (!user) {
    return json({ error: 'Invalid credentials' }, 401)
  }

  const encoder = new TextEncoder()
  const data = encoder.encode(body.password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const passwordHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

  if (passwordHash !== user.password_hash.substring(0, 64)) {
    return json({ error: 'Invalid credentials' }, 401)
  }

  const session = {
    userId: user.id,
    username: user.username,
    isAdmin: true,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
  }

  const token = createSessionToken(session)

  return json({
    token,
    user: { id: user.id, username: user.username, is_admin: true }
  })
}

async function handleSetup(request: Request, env: Env): Promise<Response> {
  const db = createDatabase(env.DB)
  const existing = await db.getUserByUsername('admin')

  if (existing) {
    return json({ error: 'Setup already completed' }, 400)
  }

  const body = await request.json<{ username: string; password: string }>()

  if (!body.username || !body.password) {
    return json({ error: 'Username and password required' }, 400)
  }

  const encoder = new TextEncoder()
  const data = encoder.encode(body.password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const passwordHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

  await db.createUser(body.username, passwordHash)

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
    const body = await request.json<{ name?: string; quota_limit?: number }>()

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
  const limit = parseInt(url.searchParams.get('limit') || '100')
  const offset = parseInt(url.searchParams.get('offset') || '0')

  const records = await db.listUsageRecords(limit, offset)
  return json({ data: records })
}

async function checkAuth(request: Request, env: Env): Promise<any> {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  const token = authHeader.slice(7)
  const session = await verifySessionToken(token, env.JWT_SECRET || 'default-secret')
  return session
}

function createSessionToken(session: any): string {
  const payload = {
    sub: session.userId,
    username: session.username,
    admin: session.isAdmin,
    exp: Math.floor(session.expiresAt / 1000)
  }

  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payloadB64 = btoa(JSON.stringify(payload))
  const signature = btoa(`${header}.${payloadB64}`)

  return `${header}.${payloadB64}.${signature}`
}
