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
import { encryptApiKey, decryptApiKey, resolveApiKeyEncryptionSecret } from './src/key-crypto'
import { routingCacheMetrics, invalidateRoutingSnapshot } from './src/utils/routing-cache'

// Keep an isolate-local scheduler between requests. Persistent request logs in
// D1 are also consulted by FailoverManager, so this cache is only a fast path.
let sharedFailover: FailoverManager | null = null

/**
 * Drop this isolate's cached routing snapshot.
 *
 * The snapshot is keyed by the shared scheduler, so there is nothing to clear
 * before the first gateway request has created one.
 */
function invalidateRouting(): void {
  if (sharedFailover) invalidateRoutingSnapshot(sharedFailover)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // An exception escaping this handler is what the Cloudflare edge renders as
    // the opaque "Error 1101 Worker threw exception" HTML page: the whole site
    // white-screens and the real message is only visible in Workers Logs. A
    // transient D1 failure on any single route must not do that, so every throw
    // is converted into a normal response that also carries the reason.
    try {
      return await route(request, env, ctx)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const wantsHtml = (request.headers.get('accept') || '').includes('text/html')
      if (wantsHtml) {
        // A browser navigation gets the shell back so the SPA still loads and can
        // report the failure itself, rather than a raw JSON blob.
        const assets = env.ASSETS
        if (assets) {
          const shellUrl = new URL(request.url)
          shellUrl.pathname = '/'
          const shell = await assets.fetch(new Request(shellUrl.toString(), { headers: request.headers }))
            .catch(() => null)
          if (shell && shell.status < 400) {
            return new Response(shell.body, {
              status: shell.status,
              headers: { ...Object.fromEntries(shell.headers), 'x-sub2api-error': encodeURIComponent(message).slice(0, 200) }
            })
          }
        }
      }
      return json({ error: 'Internal error', message }, 500)
    }
  }
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  // Usage. DELETE is on the same prefix because usage_records is the only table
  // that grows with traffic rather than with configuration, and D1 caps database
  // size — an operator needs a way to reclaim it without shell access.
  if (path === '/api/v1/usage' || path.startsWith('/api/v1/usage/')) {
    if (request.method === 'GET' && path === '/api/v1/usage') return handleUsage(request, env)
    if (request.method === 'DELETE') return handleUsageDelete(request, env, path)
    return json({ error: 'Method not allowed' }, 405)
  }

  // Config endpoints. A write changes which accounts the gateway may pick, so
  // the isolate's routing snapshot is dropped immediately instead of serving
  // stale routing for the rest of its TTL.
  if (path.startsWith('/api/v1/groups')) {
    if (request.method !== 'GET') invalidateRouting()
    return handleGroupsRequest(request, env, ctx)
  }
  if (path.startsWith('/api/v1/accounts')) {
    if (request.method !== 'GET') invalidateRouting()
    return handleAccountsRequest(request, env)
  }
  if (path.startsWith('/api/v1/models')) {
    if (request.method !== 'GET') invalidateRouting()
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
    return handleOpenAIRequest(request, env, failover, ctx)
  }
  if (path.startsWith('/v1/responses')) {
    return handleOpenAIRequest(request, env, failover, ctx)
  }
  if (path.startsWith('/v1/messages')) {
    return handleClaudeRequest(request, env, failover, ctx)
  }
  if (path.startsWith('/v1/')) {
    return handleGatewayRequest(request, env, failover, ctx)
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
  let ready: boolean
  try {
    ready = await db.schemaReady()
  } catch (error) {
    // Unreachable is not the same as empty. Reporting setup as available here
    // would invite an operator to re-initialise a configured deployment.
    return json({ error: '数据库暂时无法访问，请稍后重试', message: error instanceof Error ? error.message : '未知错误' }, 503)
  }
  if (!ready) {
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
  return json({ data: { hours, bucket, cache: routingCacheMetrics(), ...stats } })
}

async function handleApiKeys(request: Request, env: Env): Promise<Response> {
  const session = await checkAuth(request, env)
  if (!session) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const db = createDatabase(env.DB)
  await db.ensureSchema()
  const url = new URL(request.url)
  const keyPath = url.pathname.replace(/\/+$/, '')
  const revealMatch = /^\/api\/v1\/keys\/(\d+)\/reveal$/.exec(keyPath)
  const itemMatch = /^\/api\/v1\/keys\/(\d+)$/.exec(keyPath)

  if (keyPath !== '/api/v1/keys' && !revealMatch && !itemMatch) {
    return json({ error: 'Invalid API Key path' }, 404)
  }

  // Reveal is deliberately a strict POST endpoint. It is separate from the
  // list response so plaintext keys never enter the normal page payload.
  if (revealMatch) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    if (session.isAdmin !== true) return json({ error: '需要管理员权限' }, 403)

    const id = Number(revealMatch[1])
    const key = await db.getApiKeyCiphertext(id)
    if (!key) return json({ error: 'API Key not found' }, 404)
    if (!key.key_ciphertext) {
      return json({ error: '该密钥创建于旧版本，无法恢复，请重新创建' }, 409)
    }

    try {
      const secret = await decryptApiKey(
        key.key_ciphertext,
        await resolveApiKeyEncryptionSecret(db, env.API_KEY_ENCRYPTION_KEY)
      )
      return new Response(JSON.stringify({ data: { id, key: secret } }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch {
      // Do not leak cipher details or the configured encryption secret.
      return json({ error: '密钥解密失败，请重新创建' }, 500)
    }
  }

  if (request.method === 'GET') {
    const keys = await db.listApiKeys()
    return json({ data: keys })
  }

  if (request.method === 'POST') {
    let body: { name?: string; quota_limit?: number; group_id?: number | null; fallback_group_id?: number | null }
    try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

    const name = String(body.name || '').trim()
    if (!name) return json({ error: '请填写密钥名称' }, 400)

    // A key may be pinned to one group so its traffic only ever reaches that
    // group's accounts. Null means every group stays eligible.
    let groupId: number | null = null
    if (body.group_id !== undefined && body.group_id !== null && String(body.group_id) !== '') {
      groupId = Number(body.group_id)
      if (!groupId || !(await db.getGroup(groupId))) return json({ error: '所选主分组不存在' }, 400)
    }

    let fallbackGroupId: number | null = null
    if (body.fallback_group_id !== undefined && body.fallback_group_id !== null && String(body.fallback_group_id) !== '') {
      fallbackGroupId = Number(body.fallback_group_id)
      if (!fallbackGroupId || !(await db.getGroup(fallbackGroupId))) return json({ error: '所选兜底分组不存在' }, 400)
      if (fallbackGroupId === groupId) return json({ error: '主分组和兜底分组不能相同' }, 400)
    }

    const apiKey = `sk-${Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')}`
    const keyHash = await hashApiKey(apiKey)
    const keySecret = await resolveApiKeyEncryptionSecret(db, env.API_KEY_ENCRYPTION_KEY)
    const keyCiphertext = await encryptApiKey(apiKey, keySecret)

    const result = await db.createApiKey(keyHash, keyCiphertext, name, body.quota_limit || 0, groupId, fallbackGroupId)

    return json({
      data: {
        id: result.lastRowId,
        key: apiKey,
        name,
        enabled: true,
        balance: 0,
        quota_limit: body.quota_limit || 0,
        group_id: groupId,
        fallback_group_id: fallbackGroupId
      }
    }, 201)
  }

  if (request.method === 'PUT') {
    const id = parseInt(url.pathname.split('/').pop() || '0')
    if (!id) return json({ error: 'Invalid ID' }, 400)

    let body: { name?: string; enabled?: number | boolean; balance?: number; quota_limit?: number; group_id?: number | null; fallback_group_id?: number | null }
    try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

    const existing = await db.queryOne<any>('SELECT * FROM api_keys WHERE id = ?', [id])
    if (!existing) return json({ error: 'API Key not found' }, 404)

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
      // An explicit empty value clears the primary pin and restores access to all groups.
      if (body.group_id === null || String(body.group_id) === '') {
        updates.group_id = null
      } else {
        const groupId = Number(body.group_id)
        if (!groupId || !(await db.getGroup(groupId))) return json({ error: '所选主分组不存在' }, 400)
        updates.group_id = groupId
        if (body.fallback_group_id !== undefined && body.fallback_group_id !== null && Number(body.fallback_group_id) === groupId) {
          return json({ error: '主分组和兜底分组不能相同' }, 400)
        }
      }
    }
    if (body.fallback_group_id !== undefined) {
      if (body.fallback_group_id === null || String(body.fallback_group_id) === '') {
        updates.fallback_group_id = null
      } else {
        const fallbackGroupId = Number(body.fallback_group_id)
        if (!fallbackGroupId || !(await db.getGroup(fallbackGroupId))) return json({ error: '所选兜底分组不存在' }, 400)
        const effectivePrimary = body.group_id !== undefined ? Number(body.group_id) || 0 : Number(existing.group_id) || 0
        if (fallbackGroupId === effectivePrimary) return json({ error: '主分组和兜底分组不能相同' }, 400)
        updates.fallback_group_id = fallbackGroupId
      }
    }
    await db.updateApiKey(id, updates)
    const key = await db.queryOne(`SELECT k.id, k.name, k.enabled, k.balance, k.quota_limit, k.group_id, k.fallback_group_id, k.created_at,
             CASE WHEN k.key_ciphertext IS NOT NULL AND TRIM(k.key_ciphertext) != '' THEN 1 ELSE 0 END AS can_copy,
             g.name AS group_name, fg.name AS fallback_group_name
      FROM api_keys k LEFT JOIN groups g ON k.group_id = g.id LEFT JOIN groups fg ON k.fallback_group_id = fg.id WHERE k.id = ?`, [id])
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

/**
 * Delete usage rows: one by id, or everything older than `days`.
 *
 * Admin-only and destructive, so the two shapes are kept explicit rather than
 * letting a missing parameter mean "wipe the table". `days=0` does clear
 * everything, but only when the caller says so.
 */
async function handleUsageDelete(request: Request, env: Env, path: string): Promise<Response> {
  const session = await checkAuth(request, env)
  if (!session) return json({ error: 'Unauthorized' }, 401)
  if (session.isAdmin !== true) return json({ error: '需要管理员权限' }, 403)

  const db = createDatabase(env.DB)
  const itemMatch = /^\/api\/v1\/usage\/(\d+)$/.exec(path)
  if (itemMatch) {
    const result = await db.deleteUsageRecord(Number(itemMatch[1]))
    if (!result.changes) return json({ error: '记录不存在' }, 404)
    return json({ success: true, deleted: result.changes })
  }

  if (path !== '/api/v1/usage') return json({ error: 'Invalid usage path' }, 404)

  const url = new URL(request.url)
  const rawDays = url.searchParams.get('older_than_days')
  if (rawDays === null) {
    return json({ error: '请提供 older_than_days（0 表示清空全部）' }, 400)
  }
  const days = Number(rawDays)
  if (!Number.isFinite(days) || days < 0 || days > 3650) {
    return json({ error: 'older_than_days 必须是 0 到 3650 之间的数字' }, 400)
  }

  const before = await db.countUsageRecords()
  await db.deleteUsageRecordsOlderThan(days)
  const after = await db.countUsageRecords()
  return json({ success: true, deleted: Math.max(0, before - after), remaining: after })
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
