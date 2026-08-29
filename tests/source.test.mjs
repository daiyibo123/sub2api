// Structural guards for mistakes that runtime tests cannot catch.
//
// The dropped-write bug (usage records never reaching D1 in production) passed
// every runtime suite because miniflare keeps the process alive after a
// Response, while a real Worker isolate may be destroyed immediately. A test
// that exercises the gateway therefore cannot detect it — only reading the
// source can. Same for icon references: a wrong sprite id renders an empty box
// rather than throwing.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('PASS', name) }
  else { failures.push(`${name} ${detail}`); console.log('FAIL', name, detail) }
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

const tsFiles = walk('functions').filter(file => file.endsWith('.ts'))

// ---- 1. every fire-and-forget D1 write must go through defer() -------------
//
// `db.createUsageRecord(...).catch(() => {})` on its own is dropped when the
// isolate dies. It must be either awaited or handed to ctx.waitUntil.
const WRITE_METHODS = [
  'createUsageRecord', 'createRequestLog', 'incrementApiKeyUsage',
  'recordAccountHealthCheck', 'updateAccountError', 'ensureSchema'
]

const strayWrites = []
for (const file of tsFiles) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (!WRITE_METHODS.some(method => line.includes(`.${method}(`))) return
    // Acceptable forms: awaited, deferred, or the method's own definition.
    if (/\bawait\b/.test(line)) return
    if (/\bdefer(All)?\s*\(/.test(line)) return
    if (/^\s*(async\s+)?[a-zA-Z]+\s*\(/.test(line) && line.includes('):')) return
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return
    if (/return\s+this\./.test(line)) return
    strayWrites.push(`${file}:${index + 1}`)
  })
}
check('no D1 write is left un-deferred', strayWrites.length === 0, strayWrites.join(' '))

// ---- 2. gateway routes must accept an execution context -------------------
for (const route of ['openai', 'claude', 'grok', 'gateway']) {
  const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
  const signature = source.match(/export async function handle\w+Request\(([^)]*)\)/)?.[1] || ''
  check(`${route} route receives ctx`, signature.includes('ctx'), signature)
}

// ---- 3. the worker must pass ctx into every route it dispatches -----------
const workerSource = readFileSync('functions/_worker.ts', 'utf8')
const dispatches = [...workerSource.matchAll(/return handle(OpenAI|Claude|Grok|Gateway)Request\(([^)]*)\)/g)]
check('worker dispatches at least four gateway routes', dispatches.length >= 4, String(dispatches.length))
const missingCtx = dispatches.filter(match => !match[2].includes('ctx')).map(match => match[1])
check('worker passes ctx to every gateway route', missingCtx.length === 0, missingCtx.join(','))

// ---- 4. every icon reference resolves to a sprite symbol ------------------
const html = readFileSync('frontend/index.html', 'utf8')
const appJs = readFileSync('frontend/app.js', 'utf8')
const symbols = new Set([...html.matchAll(/<symbol[^>]*\bid="([^"]+)"/g)].map(match => match[1]))
check('sprite defines symbols', symbols.size > 0, String(symbols.size))

const referenced = new Set()
for (const match of html.matchAll(/href="#(i-[\w-]+)"/g)) referenced.add(match[1])
for (const match of appJs.matchAll(/href="#\$\{name\}"/g)) void match // built dynamically
for (const match of appJs.matchAll(/icon\(\s*'([^']+)'/g)) referenced.add(match[1])
for (const match of appJs.matchAll(/iconName:\s*'([^']+)'/g)) referenced.add(match[1])
for (const match of appJs.matchAll(/,\s*'(i-[\w-]+)'/g)) referenced.add(match[1])
for (const match of appJs.matchAll(/\[\s*'(i-[\w-]+)'/g)) referenced.add(match[1])
for (const match of appJs.matchAll(/href="#(i-[\w-]+)"/g)) referenced.add(match[1])

const unresolved = [...referenced].filter(name => !symbols.has(name))
check('every referenced icon exists in the sprite', unresolved.length === 0, unresolved.join(' '))

// ---- 5. icon() must not double-prefix ------------------------------------
// Capture to the function's closing brace on its own line: a naive [^}]*
// stops at the '}' inside `${size}` and reads as a false failure.
const iconFn = appJs.match(/function icon\([\s\S]*?\n\}/)?.[0] || ''
check('icon() uses the id verbatim', iconFn.includes('#${name}'), iconFn.replace(/\s+/g, ' '))

// ---- 6. sprite symbols need a viewBox to scale ---------------------------
const symbolTags = [...html.matchAll(/<symbol[^>]*>/g)].map(match => match[0])
const withoutViewBox = symbolTags.filter(tag => !tag.includes('viewBox'))
check('every sprite symbol has a viewBox', withoutViewBox.length === 0, String(withoutViewBox.length))

// ---- 7. the removed channel layer must stay removed ---------------------
const channelLeaks = []
for (const file of [...tsFiles, 'frontend/app.js', 'frontend/index.html']) {
  const source = readFileSync(file, 'utf8')
  // The migration is the one place allowed to reference the retired table.
  // db/schema hold the migration; types.ts documents the retained legacy column.
  if (file.endsWith('db.ts') || file.endsWith('schema.ts') || file.endsWith('types.ts')) continue
  if (/\bchannel_id\b|\/channels\b|listChannels|getChannel\(/.test(source)) {
    channelLeaks.push(file)
  }
}
check('no live code path still uses channels', channelLeaks.length === 0, channelLeaks.join(' '))

// ---- 8. every CSS class emitted by the app must be styled ---------------
const css = readFileSync('frontend/styles.css', 'utf8')
const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => match[1]))
const emitted = new Set()
for (const match of html.matchAll(/class="([^"$]+)"/g)) {
  match[1].split(/\s+/).filter(Boolean).forEach(token => emitted.add(token))
}
for (const match of appJs.matchAll(/class="([^"$]*)"/g)) {
  match[1].split(/\s+/).filter(Boolean).forEach(token => emitted.add(token))
}
// Utility classes applied via classList rather than markup.
for (const extra of ['is-busy', 'hidden', 'active', 'visible', 'dark', 'on', 'open', 'compact']) {
  emitted.add(extra)
}
const unstyled = [...emitted].filter(token => !defined.has(token) && !/^(ico|i-)/.test(token))
check('every emitted class has styling', unstyled.length === 0, unstyled.join(' '))

/** Text of a function body, located by a start marker and a closing line. */
function blockAfter(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  if (start < 0) return ''
  const end = source.indexOf(endMarker, start)
  return end < 0 ? source.slice(start) : source.slice(start, end + endMarker.length)
}

// ---- 8. waitUntil must never be registered from a post-response callback --
// Calling ctx.waitUntil() after the fetch handler returned throws, which the
// runtime surfaces as a 1101 "Worker threw exception". The streaming recorder
// hit exactly that, so the registration must be straight-line code.
{
  const record = readFileSync('functions/src/utils/record.ts', 'utf8')
  const callbackBody = blockAfter(record, 'measureStreamTiming(', ');')
  check('stream recorder does not defer from inside the stream callback',
    !callbackBody.includes('defer(') && !callbackBody.includes('waitUntil'),
    callbackBody.slice(0, 120))
  check('stream recorder registers waitUntil synchronously',
    record.includes('waitUntil?.(persist)') || record.includes('waitUntil(persist)'))
}

// ---- 9. schema work must be gated behind a cheap version check -----------
// Applying the schema is ~30 D1 round trips and Cloudflare caps a request at 50
// subrequests, so an unconditional ensureSchema on a hot path throws 1101.
{
  const db = readFileSync('functions/src/db.ts', 'utf8')
  const body = blockAfter(db, 'async ensureSchema(', 'return !wasReady;')
  check('ensureSchema short-circuits on a version flag',
    body.includes("getSetting('schema_version')"), body.slice(0, 200))
  check('ensureSchema records the version last',
    body.lastIndexOf("setSetting('schema_version'") > body.indexOf('SCHEMA_STATEMENTS'),
    'version must be written after the work')
}


// ---- 10. every settings column a write touches must be declared ----------
// `setSetting` wrote `updated_at` before the column existed. SQLite validates a
// statement at prepare time, so the whole INSERT failed -- and with it every
// flag that marks a migration finished, making the channel fold-in retry on
// every login forever instead of completing once.
{
  const schema = readFileSync('functions/src/schema.ts', 'utf8')
  const db = readFileSync('functions/src/db.ts', 'utf8')

  const createAt = schema.indexOf('CREATE TABLE IF NOT EXISTS settings')
  const settingsBlock = schema.slice(createAt, schema.indexOf('`', createAt))

  const declared = new Set()
  for (const line of settingsBlock.split(/\r?\n/).slice(1)) {
    const name = line.trim().split(/\s+/)[0].replace(/[(),]/g, '')
    if (name && name !== ')') declared.add(name)
  }
  for (const m of schema.matchAll(/table:\s*'settings',\s*column:\s*'(\w+)'/g)) {
    declared.add(m[1])
  }

  // Columns named on the left of an assignment in a settings write.
  const referenced = new Set()
  for (const m of db.matchAll(/settings[^;]{0,240}/g)) {
    for (const col of m[0].matchAll(/SET\s+(\w+)\s*=/g)) referenced.add(col[1])
    for (const col of m[0].matchAll(/,\s*(\w+)\s*=\s*datetime/g)) referenced.add(col[1])
  }

  const missing = [...referenced].filter(col => !declared.has(col))
  check('every settings column a write touches is declared', missing.length === 0,
    `missing=${missing.join(' ')} declared=${[...declared].join(' ')}`)

  // The fallback exists precisely because older databases predate the column.
  check('setSetting degrades when updated_at is absent',
    /DO UPDATE SET value = excluded\.value`/.test(db),
    'a timestamp-free fallback INSERT must remain')
}

// ---- 11. usage records must carry attribution ------------------------------
// Without group_id / account_id the console cannot say which upstream served a
// request, so the usage page degrades to an unfilterable flat list.
{
  const schema = readFileSync('functions/src/schema.ts', 'utf8')
  for (const col of ['group_id', 'account_id', 'ttft_ms']) {
    // A plain substring: the declaration format is fixed, and regex escapes
    // inside a template literal silently collapse (\s becomes s).
    check(`usage_records declares ${col}`,
      schema.includes(`table: 'usage_records', column: '${col}'`))
  }
  const routes = ['openai', 'claude', 'grok', 'gateway']
  for (const route of routes) {
    const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
    const call = source.slice(source.indexOf('createUsageRecord'))
    check(`${route} attributes its usage record`,
      /group_id:/.test(call.slice(0, 400)) && /account_id:/.test(call.slice(0, 400)),
      call.slice(0, 90))
  }
  const record = readFileSync('functions/src/utils/record.ts', 'utf8')
  check('streaming recorder attributes its usage record',
    /group_id:\s*context\.groupId/.test(record) && /account_id:\s*context\.accountId/.test(record))
}

console.log()
console.log(`PASSED ${pass} / ${pass + failures.length}`)
for (const failure of failures) console.log(' -', failure)
process.exit(failures.length ? 1 : 0)
