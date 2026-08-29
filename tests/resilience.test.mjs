// Proves an exception can never escape the Worker fetch handler.
//
// This is the failure the user saw as Cloudflare "Error 1101 Worker threw
// exception": the whole page white-screens and the real message is only in
// Workers Logs. The router had no try/catch, so a single transient D1 error on
// any route took down the request. These tests drive the *built bundle* with a
// D1 stub that throws, and assert a normal response comes back instead.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('PASS', name) }
  else { failures.push(`${name} ${detail}`); console.log('FAIL', name, detail) }
}

// Load the shipped bundle. Testing the artifact, not the sources, is deliberate:
// the deployed file is what Pages serves.
const bundle = readFileSync('frontend/_worker.js', 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'sub2api-'))
const modPath = join(dir, 'worker.mjs')
writeFileSync(modPath, bundle)
const worker = (await import(pathToFileURL(modPath).href)).default

check('bundle exports a fetch handler', typeof worker?.fetch === 'function')

// ---- D1 stub whose every statement throws ---------------------------------
const D1_ERROR = 'D1_ERROR: Network connection lost.'
function explodingDb() {
  const stmt = {
    bind: () => stmt,
    first: async () => { throw new Error(D1_ERROR) },
    all: async () => { throw new Error(D1_ERROR) },
    run: async () => { throw new Error(D1_ERROR) }
  }
  return { prepare: () => stmt, batch: async () => { throw new Error(D1_ERROR) }, exec: async () => { throw new Error(D1_ERROR) } }
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
const assets = {
  fetch: async request => {
    const path = new URL(request.url).pathname
    if (path === '/' || path === '/index.html') {
      return new Response('<!doctype html><title>shell</title>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    return new Response('not found', { status: 404 })
  }
}

async function callWorker(path, init = {}, env = {}) {
  const request = new Request(`https://example.test${path}`, init)
  return worker.fetch(request, { DB: explodingDb(), ASSETS: assets, ...env }, ctx)
}

// Every route that touches D1. Each one previously threw straight to the edge.
const routes = [
  ['GET  /api/v1/auth/setup', '/api/v1/auth/setup', {}],
  ['POST /api/v1/auth/setup', '/api/v1/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password123' }) }],
  ['POST /api/v1/auth/login', '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) }],
  ['GET  /api/v1/stats', '/api/v1/stats', { headers: { authorization: 'Bearer x' } }],
  ['GET  /api/v1/keys', '/api/v1/keys', { headers: { authorization: 'Bearer x' } }],
  ['GET  /api/v1/usage', '/api/v1/usage', { headers: { authorization: 'Bearer x' } }],
  ['GET  /api/v1/groups', '/api/v1/groups', { headers: { authorization: 'Bearer x' } }],
  ['GET  /api/v1/accounts', '/api/v1/accounts', { headers: { authorization: 'Bearer x' } }],
  ['GET  /api/v1/models', '/api/v1/models', { headers: { authorization: 'Bearer x' } }],
  ['POST /v1/chat/completions', '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer sk-x', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o' }) }],
  ['POST /v1/messages', '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'sk-x', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022' }) }],
  ['GET  /v1/models', '/v1/models', { headers: { authorization: 'Bearer sk-x' } }]
]

for (const [label, path, init] of routes) {
  let response = null
  let threw = null
  try {
    response = await callWorker(path, init)
  } catch (error) {
    threw = error
  }
  check(`${label} does not throw out of fetch`, threw === null, threw ? `threw ${threw.message}` : '')
  check(`${label} returns a Response`, response instanceof Response, response ? `status ${response?.status}` : 'no response')
  if (response) {
    // A thrown D1 error must surface as a server error, not a success page.
    check(`${label} reports a status, not a crash`, response.status >= 400 && response.status < 600, `status ${response.status}`)
  }
}

// ---- an unreachable database is not an uninitialized one ------------------
//
// schemaReady() used to swallow D1 errors and answer "false", so during a blip
// the login screen was told setup was available on a fully configured site.
const setupProbe = await callWorker('/api/v1/auth/setup')
const setupBody = await setupProbe.json().catch(() => null)
check('setup probe fails loudly when D1 is unreachable', setupProbe.status === 503, `status ${setupProbe.status}`)
check('setup probe does not claim setup is available', setupBody?.data?.setup_available !== true, JSON.stringify(setupBody))

// With a healthy but empty database it must still offer initialization.
const emptyDb = () => {
  const stmt = {
    bind: () => stmt,
    // No tables exist yet, so the table-count probe legitimately returns zero.
    first: async () => ({ total: 0 }),
    all: async () => ({ results: [] }),
    run: async () => ({ success: true })
  }
  return { prepare: () => stmt, batch: async () => [], exec: async () => ({}) }
}
const freshProbe = await worker.fetch(
  new Request('https://example.test/api/v1/auth/setup'),
  { DB: emptyDb(), ASSETS: assets },
  ctx
)
const freshBody = await freshProbe.json().catch(() => null)
check('empty database still offers setup', freshProbe.status === 200 && freshBody?.data?.setup_available === true, JSON.stringify(freshBody))
check('empty database reports schema not ready', freshBody?.data?.schema_ready === false, JSON.stringify(freshBody))

// ---- a failed migration must not stamp the schema version -----------------
//
// The channel fold deliberately leaves its own flag unset so the next request
// retries. But ensureSchema used to stamp schema_version regardless, and that
// stamp makes the next call take its fast path and return immediately — so the
// retry never happened and the database stayed half-migrated forever.
{
  const writes = []
  const foldFailingDb = () => {
    const settings = new Map()
    const make = sql => {
      const stmt = {
        bind: (...args) => {
          stmt.args = args
          return stmt
        },
        first: async () => {
          if (/FROM settings WHERE key/.test(sql)) {
            const key = stmt.args?.[0]
            return settings.has(key) ? { value: settings.get(key) } : null
          }
          // Report the legacy shape: all tables present, plus a channels table.
          if (/name = 'channels'/.test(sql)) return { total: 1 }
          if (/sqlite_master/.test(sql)) return { total: 7 }
          if (/PRAGMA/.test(sql)) return null
          return null
        },
        all: async () => {
          // PRAGMA table_info drives the additive-column pass; claim every
          // column already exists so the run reaches the fold.
          if (/PRAGMA table_info/.test(sql)) {
            return { results: [{ name: 'id' }, { name: 'rate_multiplier' }, { name: 'channel_id' }, { name: 'api_key' }, { name: 'base_url' }, { name: 'enabled' }, { name: 'updated_at' }, { name: 'group_id' }, { name: 'account_id' }, { name: 'ttft_ms' }] }
          }
          return { results: [] }
        },
        run: async () => {
          if (/INSERT INTO settings|UPDATE settings/.test(sql)) {
            const [key, value] = stmt.args || []
            settings.set(key, value)
            writes.push(key)
            return { success: true }
          }
          // The fold's account rewrites fail; everything else succeeds.
          if (/UPDATE accounts SET/.test(sql)) throw new Error('D1_ERROR: fold failed')
          return { success: true }
        }
      }
      return stmt
    }
    return { prepare: make, batch: async () => [], exec: async () => ({}), _settings: settings }
  }

  const db = foldFailingDb()
  // POST /auth/setup is the route that applies the schema.
  await worker.fetch(
    new Request('https://example.test/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password123' })
    }),
    { DB: db, ASSETS: assets },
    ctx
  ).catch(() => {})

  check('a failed fold does not stamp schema_version',
    !writes.includes('schema_version'),
    `settings written: ${writes.join(', ') || 'none'}`)
  check('a failed fold does not set its own completion flag',
    !writes.includes('channels_folded_into_accounts'),
    `settings written: ${writes.join(', ') || 'none'}`)
}

// ---- the JSON error carries the real reason -------------------------------
const apiResponse = await callWorker('/api/v1/usage', { headers: { authorization: 'Bearer x' } })
const apiBody = await apiResponse.text()
check('api error body is JSON', apiBody.trim().startsWith('{'), apiBody.slice(0, 80))
let parsed = null
try { parsed = JSON.parse(apiBody) } catch {}
check('api error body is parseable', parsed !== null)
check('api error body is not the Cloudflare 1101 page', !apiBody.includes('Worker threw exception'))

// ---- a browser navigation still gets the SPA shell ------------------------
//
// Returning raw JSON to a navigation would replace the app with a blob of text.
// The shell loads instead, and the reason rides along in a header.
const navResponse = await callWorker('/dashboard', { headers: { accept: 'text/html' } })
check('navigation during failure returns 200 shell', navResponse.status === 200, `status ${navResponse.status}`)
const navBody = await navResponse.text()
check('navigation returns html, not JSON', navBody.includes('<!doctype html'), navBody.slice(0, 80))
check('navigation never shows the 1101 page', !navBody.includes('Worker threw exception'))

// ---- missing bindings degrade instead of crashing -------------------------
let noDbThrew = null
let noDbResponse = null
try {
  const request = new Request('https://example.test/api/v1/usage')
  noDbResponse = await worker.fetch(request, { ASSETS: assets }, ctx)
} catch (error) { noDbThrew = error }
check('missing DB binding does not throw', noDbThrew === null, noDbThrew ? noDbThrew.message : '')
check('missing DB binding returns 500', noDbResponse?.status === 500, `status ${noDbResponse?.status}`)

// A worker with neither binding must still answer rather than crash.
let bareThrew = null
let bareResponse = null
try {
  bareResponse = await worker.fetch(new Request('https://example.test/'), {}, ctx)
} catch (error) { bareThrew = error }
check('no bindings at all does not throw', bareThrew === null, bareThrew ? bareThrew.message : '')
check('no bindings returns a Response', bareResponse instanceof Response)

// ---- an exploding ASSETS binding must not crash a page load ---------------
let assetThrew = null
let assetResponse = null
try {
  assetResponse = await worker.fetch(
    new Request('https://example.test/dashboard', { headers: { accept: 'text/html' } }),
    { DB: explodingDb(), ASSETS: { fetch: async () => { throw new Error('assets unavailable') } } },
    ctx
  )
} catch (error) { assetThrew = error }
check('exploding ASSETS does not throw out of fetch', assetThrew === null, assetThrew ? assetThrew.message : '')
check('exploding ASSETS returns a Response', assetResponse instanceof Response, `status ${assetResponse?.status}`)

// ---- health check stays up even when D1 is down ---------------------------
//
// Uptime monitors hit /health; it must not depend on the database.
const health = await callWorker('/health')
check('health check succeeds while D1 is down', health.status === 200, `status ${health.status}`)

// ---- OPTIONS preflight stays up too --------------------------------------
const preflight = await callWorker('/v1/chat/completions', { method: 'OPTIONS' })
check('CORS preflight succeeds while D1 is down', preflight.status < 400, `status ${preflight.status}`)

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nFailures:')
  for (const failure of failures) console.log('  ' + failure)
  process.exit(1)
}
