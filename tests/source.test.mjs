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

console.log()
console.log(`PASSED ${pass} / ${pass + failures.length}`)
for (const failure of failures) console.log(' -', failure)
process.exit(failures.length ? 1 : 0)
