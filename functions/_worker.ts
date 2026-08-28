// Sub2API Gateway - Cloudflare Pages _worker entry
// This file acts as the unified entry for all requests in Cloudflare Pages Functions

import { createDatabase } from './src/db'
import { verifySessionToken, hashApiKey, hashPassword, verifyPassword, authenticateUser, authenticateApiKey, createSessionToken, resolveSessionSecret } from './src/auth'
import type { Env } from './src/index'
import { FailoverManager } from './src/failover'
import { handleGatewayRequest } from './src/routes/gateway'
import { handleOpenAIRequest } from './src/routes/openai'
import { handleClaudeRequest } from './src/routes/claude'
import { handleGrokRequest } from './src/routes/grok'
import { handleGroupsRequest } from './src/config/groups'
import { handleAccountsRequest } from './src/config/accounts'
import { handleModelsRequest } from './src/config/models'

// Keep an isolate-local scheduler between requests. Persistent request logs in
// D1 are also consulted by FailoverManager, so this cache is only a fast path.
let sharedFailover: FailoverManager | null = null

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

    // Setup. GET reports whether an administrator already exists so the login
    // screen can offer initialization only on a fresh deployment.
    if (path === '/api/v1/auth/setup') {
      if (request.method === 'POST') return handleSetup(request, env)
      if (request.method === 'GET') return handleSetupStatus(env)
      return json({ error: 'Method not allowed' }, 405)
    }

    // Change the signed-in administrator password.
    if (path === '/api/v1/auth/password' && request.method === 'POST') {
      return handlePasswordChange(request, env)
    }

    // Aggregated dashboard metrics
    if (path === '/api/v1/stats' && request.method === 'GET') {
      return handleStats(request, env)
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
    if (path.startsWith('/api/v1/accounts')) {
      return handleAccountsRequest(request, env)
    }
    if (path.startsWith('/api/v1/models')) {
      return handleModelsRequest(request, env)
    }

    // Gateway endpoints
    const failover = sharedFailover ?? (sharedFailover = new FailoverManager(env))
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
      const assetResponse = await env.ASSETS.fetch(request)
      if (assetResponse.status !== 404 || path.includes('.')) return assetResponse

      // Pages canonicalizes /index.html to /. Use the root asset for SPA routes
      // instead of requesting /index.html and creating a redirect loop.
      const fallbackUrl = new URL(request.url)
      fallbackUrl.pathname = '/'
      return env.ASSETS.fetch(new Request(fallbackUrl.toString(), request))
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

  // Bring an already-initialised database up to the current schema. Setup only
  // runs before the first admin exists, so an upgraded deployment would never
  // otherwise gain columns or the channel fold-in added after it was created.
  // ensureSchema is idempotent and flag-guarded, so this costs one settings
  // read once the work is done.
  await db.ensureSchema().catch(() => {})

  const token = await createSessionToken(session, await resolveSessionSecret(db, env.JWT_SECRET))

  return json({
    token,
    user: { id: session.userId, username: session.username, is_admin: session.isAdmin }
  })
}

async function handleSetup(request: Request, env: Env): Promise<Response> {
  const db = createDatabase(env.DB)

  let body: { username?: string; password?: string }
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

  if (!body.username || !body.password || body.username.length > 128 || body.password.length < 8) {
    return json({ error: '请填写用户名，密码至少 8 位' }, 400)
  }

  // Create the tables on first run so a fresh Pages deployment does not require
  // shell access to apply schema.sql before the console can be used.
  let created = false
  try {
    created = await db.ensureSchema()
  } catch (error) {
    return json({ error: `数据库初始化失败：${error instanceof Error ? error.message : '未知错误'}` }, 500)
  }

  const existing = await db.queryOne<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users LIMIT 1')

  const passwordHash = await hashPassword(body.password)
  if (existing && existing.password_hash.startsWith('$2a$')) {
    await db.update('UPDATE users SET username = ?, password_hash = ? WHERE id = ?', [body.username, passwordHash, existing.id])
  } else if (existing) {
    return json({ error: 'Setup already completed' }, 400)
  } else {
    await db.createUser(body.username, passwordHash)
  }

  return json({ success: true, message: created ? '数据库已初始化，管理员创建成功' : '管理员创建成功', schema_created: created })
}

async function handleSetupStatus(env: Env): Promise<Response> {
  const db = createDatabase(env.DB)

  // Before the tables exist, setup is what creates them, so report it as
  // available rather than surfacing a database error on the login screen.
  if (!(await db.schemaReady())) {
    return json({ data: { initialized: false, setup_available: true, schema_ready: false } })
  }

  const existing = await db.queryOne<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users LIMIT 1')
  // A legacy bcrypt row is a placeholder that setup is still allowed to claim.
  const claimable = !existing || existing.password_hash.startsWith('$2a$')
  return json({ data: { initialized: Boolean(existing), setup_available: claimable, schema_ready: true } })
}

async function handlePasswordChange(request: Request, env: Env): Promise<Response> {
  const session = await checkAuth(request, env)
  if (!session) return json({ error: 'Unauthorized' }, 401)

  let body: { current_password?: string; new_password?: string }
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

  if (!body.current_password || !body.new_password) {
    return json({ error: 'Current and new password are required' }, 400)
  }
  if (body.new_password.length < 8) {
    return json({ error: 'New password must be at least 8 characters' }, 400)
  }

  const db = createDatabase(env.DB)
  const user = await db.getUserByUsername(session.username)
  if (!user || !(await verifyPassword(body.current_password, user.password_hash))) {
    return json({ error: 'Current password is incorrect' }, 401)
  }

  await db.update('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(body.new_password), user.id])
  return json({ success: true })
}

async function handleStats(request: Request, env: Env): Promise<Response> {
  const session = await checkAuth(request, env)
  if (!session) return json({ error: 'Unauthorized' }, 401)

  const url = new URL(request.url)
  const hours = Math.min(Math.max(parseInt(url.searchParams.get('hours') || '24', 10) || 24, 1), 720)
  const bucket = url.searchParams.get('bucket') === 'day' ? 'day' : 'hour'

  const db = createDatabase(env.DB)
  const stats = await db.getDashboardStats(hours, bucket)

  return json({ data: { hours, bucket, ...stats } })
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
    let body: { name?: string; quota_limit?: number; group_id?: number | null }
    try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

    const name = String(body.name || '').trim()
    if (!name) return json({ error: '请填写密钥名称' }, 400)

    // A key may be pinned to one group so its traffic only ever reaches that
    // group's accounts. Null means every group stays eligible.
    let groupId: number | null = null
    if (body.group_id !== undefined && body.group_id !== null && String(body.group_id) !== '') {
      groupId = Number(body.group_id)
      if (!groupId || !(await db.getGroup(groupId))) return json({ error: '所选分组不存在' }, 400)
    }

    const apiKey = `sk-${Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')}`
    const keyHash = await hashApiKey(apiKey)

    const result = await db.createApiKey(keyHash, name, body.quota_limit || 0, groupId)

    return json({
      data: {
        id: result.lastRowId,
        key: apiKey,
        name,
        enabled: true,
        balance: 0,
        quota_limit: body.quota_limit || 0,
        group_id: groupId
      }
    }, 201)
  }

  if (request.method === 'PUT') {
    const id = parseInt(url.pathname.split('/').pop() || '0')
    if (!id) return json({ error: 'Invalid ID' }, 400)

    let body: { name?: string; enabled?: number | boolean; balance?: number; quota_limit?: number; group_id?: number | null }
    try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) return json({ error: '密钥名称不能为空' }, 400)
      updates.name = name
    }
    if (body.enabled !== undefined) updates.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0
    if (body.balance !== undefined && Number.isFinite(Number(body.balance))) updates.balance = Number(body.balance)
    if (body.quota_limit !== undefined && Number.isFinite(Number(body.quota_limit))) updates.quota_limit = Math.max(0, Number(body.quota_limit))
    if (body.group_id !== undefined) {
      // An explicit empty value clears the pin and restores access to all groups.
      if (body.group_id === null || String(body.group_id) === '') {
        updates.group_id = null
      } else {
        const groupId = Number(body.group_id)
        if (!groupId || !(await db.getGroup(groupId))) return json({ error: '所选分组不存在' }, 400)
        updates.group_id = groupId
      }
    }
    await db.updateApiKey(id, updates)
    const key = await db.queryOne(`SELECT k.id, k.name, k.enabled, k.balance, k.quota_limit, k.group_id, k.created_at,
             g.name AS group_name
      FROM api_keys k LEFT JOIN groups g ON k.group_id = g.id WHERE k.id = ?`, [id])
    if (!key) return json({ error: 'API Key not found' }, 404)
    return json({ data: key })
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
  const db = createDatabase(env.DB)
  const session = await verifySessionToken(token, await resolveSessionSecret(db, env.JWT_SECRET))
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
