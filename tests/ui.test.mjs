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
  groups: [{ id: 1, name: 'default', description: '默认分组', enabled: 1, priority: 0, error_threshold: 0.5, error_count_threshold: 5, window_seconds: 300 }],
  channels: [{ id: 1, name: 'OpenAI 主渠道', provider: 'openai', base_url: '', enabled: 1, priority: 0, has_api_key: true, api_key: '***' }, { id: 2, name: 'Claude 主渠道', provider: 'anthropic', base_url: '', enabled: 1, priority: 0, has_api_key: true, api_key: '***' }],
  accounts: [{ id: 1, name: 'acct-1', provider: 'openai', group_id: 1, channel_id: 1, group_name: 'default', channel_name: 'OpenAI 主渠道', enabled: 1, priority: 0, error_rate: 0, has_api_key: true, api_key: '***' }],
  models: [{ id: 1, requested_model: 'gpt-4o', provider: 'openai', upstream_model: 'gpt-4o-mini', group_id: 1, enabled: 1, priority: 0 }],
  keys: [{ id: 1, name: 'prod', enabled: 1, balance: 1.5, quota_limit: 0, created_at: '2026-01-01 00:00:00' }],
  usage: [{ id: 1, model: 'gpt-4o', provider: 'openai', total_tokens: 120, prompt_tokens: 100, completion_tokens: 20, cost: 0.002, status: 200, latency_ms: 850, created_at: '2026-01-01 00:00:00' }]
}
const posted = []

function statsPayload() {
  return {
    data: {
      hours: 24, bucket: 'hour',
      totals: { total_requests: 1, success_requests: 1, total_tokens: 120, prompt_tokens: 100, completion_tokens: 20, total_cost: 0.002, avg_latency: 850 },
      today: { today_requests: 1, today_tokens: 120, today_cost: 0.002 },
      resources: {
        total_accounts: db.accounts.length, active_accounts: db.accounts.length,
        total_keys: db.keys.length, active_keys: db.keys.length,
        total_channels: db.channels.length, active_channels: db.channels.length,
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
  if (path.startsWith('/usage')) return respond({ data: db.usage })

  const table = path.match(/^\/(keys|groups|channels|accounts|models)/)?.[1]
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
  ['新建渠道', 'btn-create-channel'],
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

// ---- account dialog: channels filter by provider ---------------------------
db.channels.push({ id: 2, name: 'Claude 渠道', provider: 'anthropic', base_url: '', enabled: 1, priority: 0, has_api_key: true })
press(doc.getElementById('btn-create-account'))
await tick(8)
form = doc.querySelector('.modal-form')
const providerSelect = form.querySelector('[name="provider"]')
const channelSelect = form.querySelector('[name="channel_id"]')
check('account dialog has provider + channel', Boolean(providerSelect && channelSelect))

providerSelect.value = 'anthropic'
providerSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
await tick(4)
const channelLabels = [...channelSelect.options].map(option => option.textContent).join('|')
check('channel list follows provider', channelLabels.includes('Claude') && !channelLabels.includes('OpenAI'), channelLabels)
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

check('no uncaught page errors', jsErrors.length === 0, jsErrors.join(' | '))

console.log(`\nPASSED ${pass} / ${pass + failures.length}`)
if (failures.length) {
  console.log('FAILURES:')
  failures.forEach(entry => console.log('  -', entry))
  process.exit(1)
}
