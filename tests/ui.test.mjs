// Headless UI harness: loads the real index.html + app.js in jsdom against a
// stub API, then drives the flows that used to close the dialog on first click.
import { JSDOM, VirtualConsole } from 'jsdom'
import { readFileSync } from 'node:fs'

const html = readFileSync('frontend/index.html', 'utf8')
const appJs = readFileSync('frontend/app.js', 'utf8')

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('PASS', name) }
  else { failures.push(`${name} ${detail}`); console.log('FAIL', name, detail) }
}

// ---- stub backend -----------------------------------------------------------
const db = {
  groups: [
    { id: 1, name: 'default', description: '默认分组', enabled: 1, priority: 0, error_threshold: 0.5, error_count_threshold: 5, window_seconds: 300 },
    { id: 2, name: 'claude-pool', description: 'Claude 专用', enabled: 1, priority: 5, error_threshold: 0.5, error_count_threshold: 5, window_seconds: 300 }
  ],
  accounts: [
    { id: 1, name: 'acct-openai', provider: 'openai', group_id: 1, group_name: 'default', enabled: 1, priority: 0, error_rate: 0, rate_multiplier: 1, has_api_key: true, api_key: '***', base_url: '' },
    { id: 2, name: 'acct-claude', provider: 'anthropic', group_id: 2, group_name: 'claude-pool', enabled: 1, priority: 0, error_rate: 0, rate_multiplier: 0.5, has_api_key: true, api_key: '***', base_url: '' }
  ],
  models: [
    { id: 1, requested_model: 'gpt-4o', provider: 'openai', upstream_model: 'gpt-4o-mini', group_id: 1, enabled: 1, priority: 0 },
    { id: 2, requested_model: 'claude-*', provider: 'anthropic', upstream_model: 'claude-3-5-sonnet-', group_id: 2, enabled: 1, priority: 0 }
  ],
  keys: [
    { id: 1, name: 'prod', enabled: 1, balance: 1.5, quota_limit: 0, group_id: 1, group_name: 'default', created_at: '2026-01-01 00:00:00' },
    { id: 2, name: 'staging', enabled: 1, balance: 0, quota_limit: 5, group_id: 2, group_name: 'claude-pool', created_at: '2026-01-02 00:00:00' }
  ],
  usage: [
    { id: 1, model: 'gpt-4o', provider: 'openai', total_tokens: 120, prompt_tokens: 100, completion_tokens: 20, cost: 0.002, base_cost: 0.002, rate_multiplier: 1, cost_estimated: 0, status: 200, latency_ms: 850, ttft_ms: 320, group_id: 1, group_name: 'default', account_id: 1, account_name: 'acct-openai', key_name: 'prod', created_at: '2026-01-01 00:00:00' },
    { id: 2, model: 'claude-3-5-sonnet', provider: 'anthropic', total_tokens: 80, prompt_tokens: 60, completion_tokens: 20, cost: 0.002, base_cost: 0.004, rate_multiplier: 0.5, cost_estimated: 1, status: 200, latency_ms: 1200, ttft_ms: 2900, group_id: 2, group_name: 'claude-pool', account_id: 2, account_name: 'acct-claude', key_name: 'staging', created_at: '2026-01-02 00:00:00' }
  ]
}
const posted = []

function statsPayload() {
  return {
    data: {
      hours: 24, bucket: 'hour',
      totals: {
        total_requests: 1, success_requests: 1, total_tokens: 120, prompt_tokens: 100,
        completion_tokens: 20, total_cost: 0.002, base_cost: 0.004, avg_latency: 850,
        avg_ttft: 320, cache_hits: 3, cache_samples: 4
      },
      today: { today_requests: 1, today_tokens: 120, today_cost: 0.002 },
      resources: {
        total_accounts: db.accounts.length, active_accounts: db.accounts.length,
        total_keys: db.keys.length, active_keys: db.keys.length,
        total_groups: db.groups.length, active_groups: db.groups.length,
        total_models: db.models.length, active_models: db.models.length
      },
      trend: [{ bucket: '2026-01-01 00:00', requests: 1, errors: 0, prompt_tokens: 100, completion_tokens: 20, cost: 0.002 }],
      byModel: [{ model: 'gpt-4o', requests: 1, tokens: 120, cost: 0.002 }],
      byProvider: [{ provider: 'openai', requests: 1, cost: 0.002 }]
    }
  }
}

function respond(body, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    text: () => Promise.resolve(JSON.stringify(body))
  })
}

function fakeFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const path = String(url).replace('/api/v1', '')
  const body = options.body ? JSON.parse(options.body) : null
  if (method !== 'GET') posted.push({ path, method, body })

  if (path === '/auth/login') return respond({ token: 't0ken', user: { id: 1, username: 'admin', is_admin: true } })
  if (path.startsWith('/auth/setup')) return respond({ data: { initialized: true, setup_available: false } })
  if (path.startsWith('/stats')) return respond(statsPayload())
  if (path.startsWith('/usage')) {
    if (method === 'DELETE') return respond({ success: true, deleted: 2, remaining: 0 })
    return respond({ data: db.usage })
  }

  // The probe dialog reads the list cached on the account, so the stub reports
  // `cached` and the remembered model the same way the worker does.
  const upstreamModels = path.match(/^\/accounts\/(\d+)\/models/)
  if (upstreamModels) {
    return respond({
      data: {
        account_id: Number(upstreamModels[1]),
        models: [{ id: 'gpt-5.6-terra' }, { id: 'gpt-5.5' }],
        cached: !path.includes('refresh=1'),
        fetched_at: '2026-01-01 00:00:00',
        probe_model: 'gpt-5.5'
      }
    })
  }
  if (path === '/accounts/test-all') {
    return respond({
      data: {
        group_id: body?.group_id === 'all' ? null : Number(body?.group_id),
        total: 1, healthy: 1, failed: 0,
        results: [{ account_id: 1, name: 'acct-openai', success: true, status: 200, latency_ms: 400, ttft_ms: 180, model: 'gpt-5.5', message: 'gpt-5.5 · 流式连接成功' }]
      }
    })
  }

  const table = path.match(/^\/(keys|groups|accounts|models)/)?.[1]
  if (!table) return respond({ error: `unhandled ${path}` }, 404)
  if (method === 'GET') return respond({ data: db[table] })
  if (method === 'POST') {
    const created = { id: db[table].length + 1, ...body }
    db[table].push(created)
    return respond({ data: table === 'keys' ? { ...created, key: 'sk-generated-secret' } : created }, 201)
  }
  if (method === 'PUT') return respond({ data: { ...body, id: 1 } })
  if (method === 'DELETE') return respond({ success: true })
  return respond({ error: 'bad' }, 400)
}

// ---- boot -------------------------------------------------------------------
const virtualConsole = new VirtualConsole()
const jsErrors = []
virtualConsole.on('jsdomError', error => jsErrors.push(error.message))

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:8788/', virtualConsole })
const { window } = dom
const doc = window.document

window.fetch = fakeFetch
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
window.confirm = () => true
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true })

window.eval(appJs)

const tick = (n = 6) => new Promise(resolve => { let i = 0; const step = () => (++i >= n ? resolve() : setTimeout(step, 6)) ; step() })

function fire(node, type) {
  node.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
}
/** A real user press is mousedown then click; both must leave the dialog open. */
function press(node) { fire(node, 'mousedown'); fire(node, 'click') }

// ---- login ------------------------------------------------------------------
doc.getElementById('login-username').value = 'admin'
doc.getElementById('login-password').value = 'password123'
doc.getElementById('login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await tick(14)

check('login reveals app shell', !doc.getElementById('page-app').classList.contains('hidden'))
check('login hides login page', doc.getElementById('page-login').classList.contains('hidden'))

// ---- the reported crash: every "add" dialog ---------------------------------
const dialogs = [
  ['新建分组', 'btn-create-group'],
  ['添加账号', 'btn-create-account'],
  ['新建映射', 'btn-create-model'],
  ['创建 API Key', 'btn-create-key']
]

for (const [label, buttonId] of dialogs) {
  press(doc.getElementById(buttonId))
  await tick()

  const card = doc.querySelector('.modal-card')
  check(`${label}: dialog opens`, Boolean(card))
  if (!card) continue

  const controls = [...card.querySelectorAll('input, select, textarea, label, .form-control, .modal-body')]
  check(`${label}: dialog has fields`, controls.length > 0, `${controls.length}`)

  // The regression: pressing any field bubbled to the backdrop and closed it.
  let closedBy = null
  for (const control of controls) {
    press(control)
    await tick(2)
    if (!doc.querySelector('.modal-card')) {
      closedBy = control.tagName + (control.name ? `[name=${control.name}]` : `.${control.className}`)
      break
    }
  }
  check(`${label}: survives clicking every field`, closedBy === null, closedBy ? `closed by ${closedBy}` : '')

  if (doc.querySelector('.modal-card')) {
    press(doc.querySelector('.modal-card'))
    await tick(2)
    check(`${label}: survives clicking dialog body`, Boolean(doc.querySelector('.modal-card')))
  }

  // Backdrop dismissal is intentionally bound to mousedown on the backdrop
  // itself, so a drag that ends outside the dialog cannot discard edits.
  const backdrop = doc.querySelector('.modal-backdrop')
  if (backdrop) fire(backdrop, 'mousedown')
  await tick(2)
  check(`${label}: backdrop click closes`, !doc.querySelector('.modal-card'))
}

// ---- a dialog must actually save -------------------------------------------
press(doc.getElementById('btn-create-group'))
await tick()
let form = doc.querySelector('.modal-form')
check('group form exists', Boolean(form))
form.querySelector('[name="name"]').value = 'team-b'
form.querySelector('[name="priority"]').value = '3'
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await tick(14)

const groupPost = posted.find(entry => entry.path === '/groups' && entry.method === 'POST')
check('group POST sent', Boolean(groupPost))
check('group POST carries name', groupPost?.body?.name === 'team-b', JSON.stringify(groupPost?.body))
check('group POST carries enabled', groupPost?.body?.enabled === 1)
check('dialog closed after save', !doc.querySelector('.modal-card'))

// ---- account dialog: credentials live on the account itself ----------------
press(doc.getElementById('btn-create-account'))
await tick(6)
form = doc.querySelector('.modal-form')
const providerSelect = form.querySelector('[name="provider"]')
const groupSelect = form.querySelector('[name="group_id"]')
const keyInput = form.querySelector('[name="api_key"]')
const baseInput = form.querySelector('[name="base_url"]')
const multiplierInput = form.querySelector('[name="rate_multiplier"]')
check('account dialog has provider + group', Boolean(providerSelect && groupSelect))
check('account dialog carries its own credentials', Boolean(keyInput && baseInput))
check('account dialog exposes rate multiplier', Boolean(multiplierInput))
check('account dialog has no channel field', !form.querySelector('[name="channel_id"]'))

providerSelect.value = 'anthropic'
providerSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
await tick(4)
check('dialog still open after provider change', Boolean(doc.querySelector('.modal-card')))

fire(doc.querySelector('.modal-backdrop'), 'mousedown')
await tick(2)

// ---- API key secret dialog --------------------------------------------------
press(doc.getElementById('btn-create-key'))
await tick(6)
form = doc.querySelector('.modal-form')
form.querySelector('[name="name"]').value = 'ci-key'
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await tick(16)
const secretShown = doc.body.textContent.includes('sk-generated-secret')
check('new key secret is shown once', secretShown)

// ---- navigation across every page ------------------------------------------
for (const button of [...doc.querySelectorAll('.nav-item[data-page]')]) {
  const page = button.dataset.page
  press(button)
  await tick(8)
  const section = doc.getElementById(`page-${page}`)
  check(`navigate to ${page}`, section && !section.classList.contains('hidden'))
}

// ---- edit dialog prefills --------------------------------------------------
press(doc.querySelector('.nav-item[data-page="groups"]'))
await tick(8)
const editButton = doc.querySelector('[data-action="edit-group"]')
check('group row has edit action', Boolean(editButton))
if (editButton) {
  press(editButton)
  await tick(6)
  const editForm = doc.querySelector('.modal-form')
  check('edit dialog opens', Boolean(editForm))
  check('edit dialog prefills name', editForm?.querySelector('[name="name"]')?.value === 'default', editForm?.querySelector('[name="name"]')?.value)
  if (editForm) {
    press(editForm.querySelector('[name="name"]'))
    await tick(2)
    check('edit dialog survives field click', Boolean(doc.querySelector('.modal-card')))
  }
}

// ---- toolbar filters -------------------------------------------------------
// Every list page must be narrowable by provider and group; showing one flat
// list makes it impossible to tell which upstream a row belongs to.
function rowsIn(listId) {
  return doc.querySelectorAll(`#${listId} tbody tr`).length
}

function setSelect(id, value) {
  const select = doc.getElementById(id)
  select.value = value
  select.dispatchEvent(new window.Event('change', { bubbles: true }))
}

function setSearch(id, value) {
  const input = doc.getElementById(id)
  input.value = value
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

for (const [page, listId] of [['usage', 'usage-list'], ['accounts', 'accounts-list'], ['models', 'models-list'], ['keys', 'keys-list']]) {
  press(doc.querySelector(`.nav-item[data-page="${page}"]`))
  await tick(10)
  check(`${page}: toolbar exists`, Boolean(doc.querySelector(`#page-${page} .toolbar`)))
  // Earlier tests create extra rows, so compare against the stub rather than a
  // literal: a hardcoded count breaks whenever a test above adds a record.
  check(`${page}: rows rendered before filtering`, rowsIn(listId) === db[page].length,
    `${rowsIn(listId)} of ${db[page].length}`)
}

// Group dropdowns must be populated from loaded groups, not left empty.
for (const id of ['usage-group', 'accounts-group', 'models-group', 'keys-group']) {
  const select = doc.getElementById(id)
  // One option per group plus the leading "all groups" entry.
  check(`${id} lists every group`, select && select.options.length === db.groups.length + 1,
    `${select?.options.length} for ${db.groups.length} groups`)
}

// Provider filter on usage.
press(doc.querySelector('.nav-item[data-page="usage"]'))
await tick(8)
setSelect('usage-provider', 'anthropic')
await tick(2)
check('usage provider filter narrows rows', rowsIn('usage-list') === 1, String(rowsIn('usage-list')))
check('usage count reflects the filter', /1 \/ 2/.test(doc.getElementById('usage-count').textContent),
  doc.getElementById('usage-count').textContent)
setSelect('usage-provider', '')
await tick(2)
check('clearing the provider filter restores rows', rowsIn('usage-list') === 2, String(rowsIn('usage-list')))

// Group filter on usage, which needs the attribution columns to exist.
setSelect('usage-group', '2')
await tick(2)
check('usage group filter narrows rows', rowsIn('usage-list') === 1, String(rowsIn('usage-list')))
check('usage table shows the group name', /claude-pool/.test(doc.getElementById('usage-list').textContent))
setSelect('usage-group', '')
await tick(2)

// Fuzzy search must match on more than the model name.
setSearch('usage-search', 'acct-claude')
await tick(2)
check('usage search matches the account name', rowsIn('usage-list') === 1, String(rowsIn('usage-list')))
setSearch('usage-search', 'zzz-no-match')
await tick(2)
check('a filter with no matches says so, not "no data"',
  /没有匹配/.test(doc.getElementById('usage-list').textContent),
  doc.getElementById('usage-list').textContent.slice(0, 60))
setSearch('usage-search', '')
await tick(2)

// Accounts page: provider and group both narrow.
press(doc.querySelector('.nav-item[data-page="accounts"]'))
await tick(8)
setSelect('accounts-provider', 'openai')
await tick(2)
check('accounts provider filter narrows rows', rowsIn('accounts-list') === 1, String(rowsIn('accounts-list')))
setSelect('accounts-provider', '')
setSelect('accounts-group', '2')
await tick(2)
check('accounts group filter narrows rows', rowsIn('accounts-list') === 1, String(rowsIn('accounts-list')))
setSelect('accounts-group', '')
await tick(2)

// Models and keys.
press(doc.querySelector('.nav-item[data-page="models"]'))
await tick(8)
setSelect('models-provider', 'anthropic')
await tick(2)
check('models provider filter narrows rows', rowsIn('models-list') === 1, String(rowsIn('models-list')))
setSelect('models-provider', '')
await tick(2)

press(doc.querySelector('.nav-item[data-page="keys"]'))
await tick(8)
setSelect('keys-group', '1')
await tick(2)
check('keys group filter narrows rows', rowsIn('keys-list') === 1, String(rowsIn('keys-list')))
setSelect('keys-group', '')
await tick(2)

press(doc.querySelector('.nav-item[data-page="groups"]'))
await tick(8)
setSearch('groups-search', 'claude')
await tick(2)
check('groups search narrows rows', rowsIn('groups-list') === 1, String(rowsIn('groups-list')))
setSearch('groups-search', '')
await tick(2)

// ---- theme toggle -----------------------------------------------------------
const rootBefore = doc.documentElement.classList.contains('dark')
press(doc.getElementById('theme-toggle'))
await tick(4)
check('theme toggles', doc.documentElement.classList.contains('dark') !== rootBefore, `${rootBefore} -> ${doc.documentElement.classList.contains('dark')}`)

// ---- charts rendered without a chart library -------------------------------
press(doc.querySelector('.nav-item[data-page="dashboard"]'))
await tick(12)
check('trend chart drew svg', Boolean(doc.querySelector('#chart-tokens svg')))
check('model chart drew svg', Boolean(doc.querySelector('#chart-models svg')))
check('stat cards populated', /1/.test(doc.getElementById('stats-grid').textContent))

// ---- reworked dashboard cards ----------------------------------------------
// Resource counts belong to the resource panel; repeating them as stat cards
// pushed the grid onto a ragged third row and said the same thing twice.
const statsText = doc.getElementById('stats-grid').textContent
check('dashboard shows average first-token', /平均首字/.test(statsText), statsText.slice(0, 120))
check('dashboard shows the routing cache hit rate', /缓存命中率/.test(statsText))
check('dashboard cost card names the multiplier', /倍率后/.test(statsText))
check('stat grid no longer repeats resource counts', !/API 密钥/.test(statsText))
const resourceText = doc.getElementById('resource-health').textContent
check('resource panel covers keys', /API 密钥/.test(resourceText), resourceText.slice(0, 120))

// ---- reworked usage columns -------------------------------------------------
press(doc.querySelector('.nav-item[data-page="usage"]'))
await tick(10)
const usageHead = [...doc.querySelectorAll('#usage-list thead th')].map(th => th.textContent)
// One combined Token column instead of three per-direction ones; the split still
// appears inside the cell. The action column carries no label.
check('usage table fits without a token column per direction',
  usageHead.includes('Token')
  && !usageHead.includes('输入')
  && !usageHead.includes('输出')
  && usageHead.filter(Boolean).length === 9, usageHead.join('|'))
check('usage row keeps both token directions', /↑|↓/.test(doc.getElementById('usage-list').textContent))
// The discounted row must show what produced the charged figure, otherwise a
// multiplier is invisible and the number looks wrong against the model's price.
check('usage cost cell shows the multiplier', /0\.5x/.test(doc.getElementById('usage-list').textContent),
  doc.getElementById('usage-list').textContent.slice(0, 200))
check('usage marks an estimated price', /估算价/.test(doc.getElementById('usage-list').textContent))

// ---- usage records must be removable ---------------------------------------
// D1 caps database size and usage_records is the only table that grows with
// traffic, so an operator needs both a single-row delete and a bulk cleanup.
check('usage row exposes a delete action', Boolean(doc.querySelector('#usage-list [data-action="delete-usage"]')))
press(doc.querySelector('#usage-list [data-action="delete-usage"]'))
await tick(6)
check('deleting a usage row asks for confirmation', /删除/.test(doc.querySelector('.modal-card')?.textContent || ''),
  doc.querySelector('.modal-card')?.textContent?.slice(0, 80) || 'no dialog')
press(doc.querySelector('.modal-card [data-confirm]') || doc.querySelector('.modal-foot .btn-danger') || doc.querySelector('.modal-foot .btn-primary'))
await tick(14)
const usageDelete = posted.find(entry => entry.method === 'DELETE' && /^\/usage\/\d+$/.test(entry.path))
check('single usage delete hits the record endpoint', Boolean(usageDelete), JSON.stringify(posted.slice(-3)))

press(doc.getElementById('btn-clean-usage'))
await tick(8)
const cleanupForm = doc.querySelector('.modal-form')
check('usage cleanup dialog opens', Boolean(cleanupForm))
if (cleanupForm) {
  cleanupForm.querySelector('[name="older_than_days"]').value = '7'
  cleanupForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await tick(16)
  const cleanup = posted.find(entry => entry.method === 'DELETE' && entry.path.includes('older_than_days=7'))
  check('bulk cleanup sends the retention window', Boolean(cleanup), JSON.stringify(posted.slice(-3)))
}

// ---- probe dialog reuses the cached model list ------------------------------
// Re-fetching on every open is what the operator complained about: the list is
// stored on the account, so opening the dialog must show it without a refetch.
press(doc.querySelector('.nav-item[data-page="accounts"]'))
await tick(10)
press(doc.querySelector('#accounts-list [data-action="test-account"]'))
await tick(14)
const probeCard = doc.querySelector('.modal-card')
const probeSelect = probeCard?.querySelector('#f-test_model')
check('probe dialog opens', Boolean(probeCard))
check('probe dialog loads models without pressing a button', (probeSelect?.options.length || 0) > 1,
  `${probeSelect?.options.length} options`)
check('probe dialog preselects the remembered model', probeSelect?.value === 'gpt-5.5', probeSelect?.value)
check('probe dialog reports the list came from cache', /缓存/.test(probeCard?.textContent || ''),
  probeCard?.querySelector('[data-test-result]')?.textContent || '')
fire(doc.querySelector('.modal-backdrop'), 'mousedown')
await tick(4)

// ---- batch probe is scoped to a group --------------------------------------
press(doc.getElementById('btn-test-accounts'))
await tick(8)
const batchCard = doc.querySelector('.modal-card')
const batchSelect = batchCard?.querySelector('#f-batch_group')
check('batch probe dialog opens', Boolean(batchCard))
check('batch probe lists every group plus "all"', batchSelect?.options.length === db.groups.length + 1,
  `${batchSelect?.options.length} for ${db.groups.length} groups`)
if (batchSelect) {
  batchSelect.value = '2'
  press(batchCard.querySelector('[data-run-test]'))
  await tick(16)
  const batchPost = posted.find(entry => entry.path === '/accounts/test-all' && entry.body?.group_id === '2')
  check('batch probe sends the chosen group', Boolean(batchPost), JSON.stringify(posted.slice(-3)))
  check('batch probe lists each account result', /acct-openai/.test(doc.body.textContent))
}

check('no uncaught page errors', jsErrors.length === 0, jsErrors.join(' | '))

// The page keeps a live-refresh interval running, which is a timer inside this
// jsdom window. Node will not exit while it is pending, so the window has to be
// torn down explicitly rather than relying on the script simply ending.
window.close()

console.log(`\nPASSED ${pass} / ${pass + failures.length}`)
if (failures.length) {
  console.log('FAILURES:')
  failures.forEach(entry => console.log('  -', entry))
  process.exit(1)
}
