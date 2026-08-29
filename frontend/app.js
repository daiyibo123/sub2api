/* Sub2API Gateway - admin console
 *
 * Modal note: dialogs are built as real DOM nodes and listen on themselves.
 * An earlier version delegated closes through document clicks, and because the
 * backdrop wraps the dialog, every click inside a form bubbled up to a
 * [data-close-modal] ancestor and dismissed the dialog mid-edit. Closes are now
 * driven only by the explicit close controls and by a backdrop hit whose target
 * is the backdrop itself.
 */

const API_BASE = '/api/v1'
const PROVIDERS = { openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI' }
const CHART_COLORS = ['#14b8a6', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#10b981', '#f97316', '#6366f1', '#84cc16', '#06b6d4', '#a855f7', '#ef4444']

const state = {
  token: localStorage.getItem('auth_token') || '',
  user: readStorage('auth_user', null),
  page: 'dashboard',
  data: { keys: [], usage: [], groups: [], accounts: [], models: [] },
  // Pages whose table currently holds real rows, so a refresh can skip the
  // skeleton and avoid a visible flash on every navigation.
  painted: new Set(),
  stats: null,
  // Per-page filters. Every list is filtered client-side: the whole page of
  // rows is already in memory, so re-querying the API for a keystroke would add
  // latency without adding information.
  filters: {
    keys: { q: '', group: '' },
    usage: { q: '', provider: '', group: '' },
    groups: { q: '' },
    accounts: { q: '', provider: '', group: '' },
    models: { q: '', provider: '', group: '' }
  },
  statsRange: { hours: 24, bucket: 'hour' },
  loading: false
}

const pageMeta = {
  dashboard: { title: '仪表盘', subtitle: '系统概览与统计数据' },
  usage: { title: '使用记录', subtitle: '请求状态与 Token 消耗' },
  keys: { title: 'API 密钥', subtitle: '客户端访问凭据' },
  models: { title: '模型映射', subtitle: '模型名与上游模型对应关系' },
  groups: { title: '分组管理', subtitle: '调度优先级与故障切换' },
  accounts: { title: '账号管理', subtitle: '上游服务商凭据' },
  settings: { title: '系统设置', subtitle: '接入地址与账号安全' }
}

/* ------------------------------------------------------------- utilities */

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback }
}
function $(id) { return document.getElementById(id) }
function el(tag, className, html) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html !== undefined) node.innerHTML = html
  return node
}
function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]))
}
function num(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback }
function fmtInt(value) { return new Intl.NumberFormat('zh-CN').format(Math.round(num(value))) }
function fmtTokens(value) {
  const n = num(value)
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return fmtInt(n)
}
function fmtCost(value) {
  const n = num(value)
  if (n > 0 && n < 0.0001) return '<$0.0001'
  return `$${n.toFixed(4)}`
}
function fmtLatency(value) {
  const n = num(value)
  if (!n) return '-'
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${fmtInt(n)} ms`
}
function fmtDate(value) {
  if (!value) return '-'
  // D1 stores "YYYY-MM-DD HH:MM:SS" in UTC; make that explicit for Date.
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function providerLabel(provider) { return PROVIDERS[provider] || provider || '-' }
function records(payload) { return Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []) }
function isOn(value) { return num(value) === 1 || value === true }

// `name` is the full sprite id (e.g. 'i-edit'). Callers pass the prefix, so
// adding another one here would resolve to a nonexistent '#i-i-edit' symbol.
function icon(name, size = '') {
  return `<svg class="ico ${size}" aria-hidden="true"><use href="#${name}"/></svg>`
}
function statusBadge(ok, label) {
  return `<span class="badge ${ok ? 'badge-on' : 'badge-off'}"><span class="dot"></span>${esc(label ?? (ok ? '启用' : '停用'))}</span>`
}
function httpBadge(status) {
  const code = num(status, 0)
  const tone = code === 0 ? 'badge-off' : code < 400 ? 'badge-on' : code < 500 ? 'badge-warn' : 'badge-err'
  return `<span class="badge ${tone}">${code || '-'}</span>`
}
function providerBadge(provider) {
  return `<span class="badge badge-provider prov-${esc(provider || 'unknown')}">${esc(providerLabel(provider))}</span>`
}
function emptyState(iconName, title, description) {
  return `<div class="empty-state">${icon(iconName, 'ico-xl')}<strong>${esc(title)}</strong><span>${esc(description || '')}</span></div>`
}
// Time to first token. Streaming responses report it; a non-streaming call has no
// meaningful first-token moment, so an absent value stays blank rather than
// showing a misleading zero.
function ttftCell(value) {
  const ms = num(value)
  if (!ms) return '<span class="cell-dim">-</span>'
  const tone = ms <= 800 ? 'badge-on' : ms <= 2500 ? 'badge-warn' : 'badge-err'
  return `<span class="badge ${tone} mono">${fmtLatency(ms)}</span>`
}

// Billing weight. 1x is the neutral default and stays dimmed so only accounts
// that actually cost more or less draw the eye.
function multiplierCell(value) {
  const rate = num(value, 1)
  const label = `${Number(rate.toFixed(4))}x`
  if (rate === 1) return `<span class="cell-dim mono">${label}</span>`
  return `<span class="badge ${rate < 1 ? 'badge-on' : 'badge-warn'} mono">${label}</span>`
}

// Liveness from the last probe, with the failure reason available on hover.
function healthCell(item) {
  const checked = item.last_check_at
  if (checked === null || checked === undefined || checked === '') {
    return '<span class="cell-dim">未测试</span>'
  }
  const ok = isOn(item.last_check_ok)
  const latency = num(item.last_check_latency_ms)
  const label = ok ? (latency ? fmtLatency(latency) : '正常') : '异常'
  return `<span class="badge ${ok ? 'badge-on' : 'badge-err'}" title="${esc(item.last_check_message || '')}"><span class="dot"></span>${label}</span>`
    + `<span class="cell-sub">${esc(fmtDate(checked))}</span>`
}

function skeletonTable(rows = 4) {
  return `<div class="skeleton-wrap">${Array.from({ length: rows }, () => '<div class="skeleton-row"></div>').join('')}</div>`
}
function toggleControl(action, id, on) {
  return `<button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-action="${action}" data-id="${id}" type="button"><span class="switch-thumb"></span></button>`
}
function rowActions(buttons) {
  return `<div class="row-actions">${buttons.join('')}</div>`
}
function actionButton(action, id, label, iconName, tone = '') {
  return `<button class="mini-btn ${tone}" data-action="${action}" data-id="${id}" type="button" title="${esc(label)}">${icon(iconName, 'ico-sm')}<span>${esc(label)}</span></button>`
}

function showToast(message, type = 'info') {
  const node = el('div', `toast toast-${type}`)
  const mark = type === 'success' ? 'i-check' : type === 'error' ? 'i-alert' : 'i-info'
  node.innerHTML = `<span class="toast-mark"><svg class="ico ico-sm" aria-hidden="true"><use href="#${mark}"/></svg></span><span>${esc(message)}</span>`
  $('toast-region').appendChild(node)
  requestAnimationFrame(() => node.classList.add('visible'))
  setTimeout(() => {
    node.classList.remove('visible')
    setTimeout(() => node.remove(), 220)
  }, 3600)
}

/* ------------------------------------------------------------------- api */

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (state.token) headers.Authorization = `Bearer ${state.token}`
  let body = options.body
  if (body !== undefined && body !== null && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(body)
  }

  let response
  try {
    response = await fetch(API_BASE + path, { ...options, headers, body })
  } catch {
    throw new Error('网络请求失败，请检查连接')
  }

  const raw = await response.text()
  let payload = null
  try { payload = raw ? JSON.parse(raw) : null } catch { payload = { error: raw } }

  const isAuthRoute = path.startsWith('/auth/login') || path.startsWith('/auth/setup')
  if (response.status === 401 && !isAuthRoute) {
    logout(false)
    showToast('登录已过期，请重新登录', 'error')
    throw new Error('登录已过期，请重新登录')
  }
  if (!response.ok) throw new Error(payload?.error || payload?.message || `请求失败（${response.status}）`)
  return payload
}

/* --------------------------------------------------------------- session */

function applyUser(user) {
  const name = user?.username || '管理员'
  $('user-name').textContent = name
  $('user-avatar').textContent = name.slice(0, 1).toUpperCase()
}

function setLoggedIn(user, token) {
  state.user = user
  state.token = token
  localStorage.setItem('auth_token', token)
  localStorage.setItem('auth_user', JSON.stringify(user))
  applyUser(user)
  $('page-login').classList.add('hidden')
  $('page-app').classList.remove('hidden')
}

function logout(notify = true) {
  state.token = ''
  state.user = null
  state.stats = null
  state.data = { keys: [], usage: [], groups: [], accounts: [], models: [] }
  // Cached rows belong to the session that fetched them.
  state.painted.clear()
  localStorage.removeItem('auth_token')
  localStorage.removeItem('auth_user')
  closeModal()
  $('page-app').classList.add('hidden')
  $('page-login').classList.remove('hidden')
  if (notify) showToast('已退出登录', 'success')
}

async function detectSetupState() {
  try {
    const result = await api('/auth/setup', { method: 'GET' })
    const needsSetup = result?.data?.needs_setup === true || result?.needs_setup === true
    $('setup-form').classList.toggle('hidden', !needsSetup)
    $('login-form').classList.toggle('hidden', needsSetup)
    $('auth-title').textContent = needsSetup ? '初始化管理员' : '登录控制台'
    $('auth-subtitle').textContent = needsSetup
      ? '首次部署，请创建控制台管理员账号'
      : '统一管理上游账号、分组与调用密钥'
  } catch {
    // Probe failures leave the login form in place; the login call reports why.
  }
}

/* ------------------------------------------------------------ navigation */

function navigate(page) {
  if (!pageMeta[page]) return
  state.page = page
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    const active = item.dataset.page === page
    item.classList.toggle('active', active)
    item.setAttribute('aria-current', active ? 'page' : 'false')
  })
  document.querySelectorAll('.page-section').forEach(section => {
    section.classList.toggle('hidden', section.id !== `page-${page}`)
  })
  $('topbar-title').textContent = pageMeta[page].title
  $('topbar-subtitle').textContent = pageMeta[page].subtitle
  closeSidebar()

  // Paint whatever is already cached before awaiting the network. The section
  // markup ships empty, so without this the panel appears blank until the fetch
  // resolves even when the data was loaded minutes ago.
  paintCached(page)
  loadPage(page, state.painted.has(page))
}

/**
 * Render a page from cached state without touching the network.
 *
 * Returns true when something was drawn, so the caller can decide between a
 * skeleton (nothing to show yet) and a quiet background refresh.
 */
function paintCached(page) {
  if (page === 'dashboard') {
    if (!state.stats) return false
    renderDashboard()
    state.painted.add(page)
    return true
  }
  if (page === 'settings') {
    renderSettings()
    state.painted.add(page)
    return true
  }
  if (!RENDERERS[page] || !state.data[page]?.length) return false
  RENDERERS[page]()
  state.painted.add(page)
  return true
}

function openSidebar() {
  $('sidebar').classList.add('open')
  $('sidebar-scrim').classList.add('visible')
}
function closeSidebar() {
  $('sidebar').classList.remove('open')
  $('sidebar-scrim').classList.remove('visible')
}

function setHealth(ok, text) {
  const pill = $('health-pill')
  pill.classList.toggle('down', !ok)
  $('health-text').textContent = text || (ok ? '连接正常' : '连接异常')
}

function updateNavCounts() {
  document.querySelectorAll('.nav-badge[data-count]').forEach(badge => {
    const list = state.data[badge.dataset.count]
    const total = Array.isArray(list) ? list.length : 0
    badge.textContent = total ? String(total) : ''
    badge.classList.toggle('hidden', !total)
  })
}

/* ------------------------------------------------------------ data loads */

const ENDPOINTS = {
  keys: '/keys',
  usage: '/usage?limit=500',
  groups: '/groups',
  accounts: '/accounts',
  models: '/models'
}

const RENDERERS = {
  keys: renderKeys,
  usage: renderUsage,
  groups: renderGroups,
  accounts: renderAccounts,
  models: renderModels
}

async function loadPage(page, silent = false) {
  if (page === 'dashboard') return loadDashboard(silent)
  if (page === 'settings') return renderSettings()

  const endpoint = ENDPOINTS[page]
  if (!endpoint) return
  const target = $(`${page}-list`)

  // Groups are referenced by the account, key and model forms, so keep them
  // loaded whenever those pages are open.
  const needsRefs = page === 'accounts' || page === 'models' || page === 'keys'

  // A skeleton is only an improvement over a blank panel. Once real rows are
  // already visible, replacing them with placeholders is the flicker itself.
  const hasVisibleRows = state.painted.has(page)
  try {
    if (target && !hasVisibleRows) target.innerHTML = skeletonTable()
    const requests = [api(endpoint)]
    if (needsRefs) requests.push(api('/groups'))
    const [payload, groups] = await Promise.all(requests)

    state.data[page] = records(payload)
    if (needsRefs) state.data.groups = records(groups)
    setHealth(true)
    RENDERERS[page]?.()
    state.painted.add(page)
    updateNavCounts()
    syncGroupFilters()
  } catch (error) {
    // Keep already-rendered rows on screen; a failed refresh should not wipe
    // data the operator is reading.
    if (target && !hasVisibleRows) target.innerHTML = emptyState('i-alert', '加载失败', error.message)
    if (!silent) showToast(error.message, 'error')
  }
}

async function loadDashboard(silent = false) {
  try {
    const [stats, usage, keys, groups, accounts, models] = await Promise.all([
      api(`/stats?hours=${state.statsRange.hours}&bucket=${state.statsRange.bucket}`),
      api('/usage?limit=50'),
      api('/keys'), api('/groups'), api('/accounts'), api('/models')
    ])
    state.stats = stats?.data || stats || null
    state.data.usage = records(usage)
    state.data.keys = records(keys)
    state.data.groups = records(groups)
    state.data.accounts = records(accounts)
    state.data.models = records(models)
    setHealth(true)
    renderDashboard()
    // The dashboard loads every entity, but only paints its own widgets. Mark
    // just the dashboard as painted: the other sections' list nodes are still
    // empty, so navigate() must render them from this cache on first visit.
    state.painted.add('dashboard')
    updateNavCounts()
    syncGroupFilters()
  } catch (error) {
    setHealth(false)
    if (!silent) showToast(error.message, 'error')
  }
}

/* ---------------------------------------------------------- svg charting */

function doughnutChart(slices, centerLabel, centerValue) {
  const total = slices.reduce((sum, item) => sum + item.value, 0)
  if (!total) return emptyState('i-chart', '暂无数据', '有调用记录后会显示分布。')

  const radius = 60
  const stroke = 22
  const circumference = 2 * Math.PI * radius
  let offset = 0

  const arcs = slices.map((slice, index) => {
    const fraction = slice.value / total
    const dash = fraction * circumference
    const segment = `<circle class="arc" cx="80" cy="80" r="${radius}" fill="none"
      stroke="${CHART_COLORS[index % CHART_COLORS.length]}" stroke-width="${stroke}"
      stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" stroke-linecap="butt"
      transform="rotate(-90 80 80)"><title>${esc(slice.label)}: ${fmtInt(slice.value)}</title></circle>`
    offset += dash
    return segment
  }).join('')

  const legend = slices.map((slice, index) => `
    <li>
      <span class="legend-dot" style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></span>
      <span class="legend-label" title="${esc(slice.label)}">${esc(slice.label)}</span>
      <span class="legend-value">${fmtInt(slice.value)}</span>
      <span class="legend-pct">${(slice.value / total * 100).toFixed(1)}%</span>
    </li>`).join('')

  return `<div class="chart-doughnut">
    <svg viewBox="0 0 160 160" class="doughnut" role="img" aria-label="${esc(centerLabel)}分布">
      ${arcs}
      <text x="80" y="74" class="doughnut-value">${esc(centerValue)}</text>
      <text x="80" y="94" class="doughnut-label">${esc(centerLabel)}</text>
    </svg>
    <ul class="chart-legend">${legend}</ul>
  </div>`
}

function lineChart(points, series) {
  if (!points.length) return emptyState('i-chart', '暂无数据', '所选时间范围内没有调用记录。')

  const width = 640
  const height = 200
  const pad = { top: 16, right: 12, bottom: 26, left: 48 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom

  const maxValue = Math.max(1, ...series.flatMap(s => points.map(p => num(p[s.key]))))
  const stepX = points.length > 1 ? plotW / (points.length - 1) : 0
  const xAt = i => pad.left + (points.length > 1 ? i * stepX : plotW / 2)
  const yAt = v => pad.top + plotH - (num(v) / maxValue) * plotH

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
    const y = pad.top + plotH - ratio * plotH
    return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" class="grid"/>
      <text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" class="axis-label" text-anchor="end">${fmtTokens(maxValue * ratio)}</text>`
  }).join('')

  // Label at most 6 ticks so dense hourly ranges stay readable.
  const tickEvery = Math.max(1, Math.ceil(points.length / 6))
  const xLabels = points.map((point, index) => {
    if (index % tickEvery !== 0 && index !== points.length - 1) return ''
    const label = String(point.bucket || '').slice(-5)
    return `<text x="${xAt(index).toFixed(1)}" y="${height - 8}" class="axis-label" text-anchor="middle">${esc(label)}</text>`
  }).join('')

  const paths = series.map(s => {
    const line = points.map((point, index) => `${index ? 'L' : 'M'}${xAt(index).toFixed(1)},${yAt(point[s.key]).toFixed(1)}`).join(' ')
    const area = `${line} L${xAt(points.length - 1).toFixed(1)},${(pad.top + plotH).toFixed(1)} L${xAt(0).toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`
    const dots = points.length <= 30
      ? points.map((point, index) => `<circle cx="${xAt(index).toFixed(1)}" cy="${yAt(point[s.key]).toFixed(1)}" r="2.5" fill="${s.color}"><title>${esc(point.bucket)} · ${s.label}: ${fmtInt(point[s.key])}</title></circle>`).join('')
      : ''
    return `<path d="${area}" fill="${s.color}" opacity=".10"/><path d="${line}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`
  }).join('')

  const legend = series.map(s => `<span class="legend-inline"><span class="legend-dot" style="background:${s.color}"></span>${esc(s.label)}</span>`).join('')

  return `<div class="chart-line">
    <div class="chart-legend-row">${legend}</div>
    <svg viewBox="0 0 ${width} ${height}" class="linechart" role="img" aria-label="Token 趋势">
      ${gridLines}${paths}${xLabels}
    </svg>
  </div>`
}

/* ------------------------------------------------------------ dashboard */

function statCard({ label, value, caption, iconName, tint }) {
  return `<article class="stat-card">
    <span class="stat-icon ${tint}">${icon(iconName)}</span>
    <div class="stat-body">
      <span class="stat-label">${esc(label)}</span>
      <strong class="stat-value">${value}</strong>
      <span class="stat-caption">${caption}</span>
    </div>
  </article>`
}

function renderDashboard() {
  const stats = state.stats || {}
  const totals = stats.totals || {}
  const today = stats.today || {}
  const res = stats.resources || {}

  const totalRequests = num(totals.total_requests)
  const successRequests = num(totals.success_requests)
  const successRate = totalRequests ? (successRequests / totalRequests * 100) : 0

  $('stats-grid').innerHTML = [
    statCard({
      label: '总请求数', iconName: 'i-activity', tint: 'tint-teal',
      value: fmtInt(totalRequests),
      caption: `今日 <span class="pos">${fmtInt(today.today_requests)}</span> 次`
    }),
    statCard({
      label: '成功率', iconName: 'i-check', tint: 'tint-emerald',
      value: totalRequests ? `${successRate.toFixed(1)}%` : '--',
      caption: totalRequests ? `${fmtInt(totalRequests - successRequests)} 次失败` : '暂无调用记录'
    }),
    statCard({
      label: '平均响应', iconName: 'i-clock', tint: 'tint-rose',
      value: num(totals.avg_latency) ? fmtLatency(totals.avg_latency) : '--',
      caption: `${fmtInt(res.active_accounts)} 个账号可调度`
    }),
    statCard({
      label: '总费用', iconName: 'i-coin', tint: 'tint-amber',
      value: fmtCost(totals.total_cost),
      caption: `今日 ${fmtCost(today.today_cost)}`
    }),
    statCard({
      label: '总 Token', iconName: 'i-token', tint: 'tint-indigo',
      value: fmtTokens(totals.total_tokens),
      caption: `输入 ${fmtTokens(totals.prompt_tokens)} · 输出 ${fmtTokens(totals.completion_tokens)}`
    }),
    statCard({
      label: '今日 Token', iconName: 'i-zap', tint: 'tint-violet',
      value: fmtTokens(today.today_tokens),
      caption: `${fmtInt(today.today_requests)} 次请求`
    }),
    statCard({
      label: '上游账号', iconName: 'i-users', tint: 'tint-sky',
      value: fmtInt(res.active_accounts),
      caption: `共 ${fmtInt(res.total_accounts)} 个已配置`
    }),
    statCard({
      label: 'API 密钥', iconName: 'i-key', tint: 'tint-fuchsia',
      value: fmtInt(res.active_keys),
      caption: `共 ${fmtInt(res.total_keys)} 个客户端密钥`
    })
  ].join('')

  const resources = [
    ['i-users', '上游账号', res.active_accounts, res.total_accounts, 'accounts', 'tint-sky'],
    ['i-layers', '分组', res.active_groups, res.total_groups, 'groups', 'tint-emerald'],
    ['i-route', '模型映射', res.active_models, res.total_models, 'models', 'tint-amber']
  ]
  $('resource-health').innerHTML = resources.map(([iconName, label, active, total, page, tint]) => {
    const totalCount = num(total)
    const activeCount = num(active)
    // An unconfigured resource is the actionable case, so it gets the amber
    // treatment and a call to action rather than a meaningless "0 / 0".
    const empty = !totalCount
    const ratio = totalCount ? Math.min(activeCount / totalCount * 100, 100) : 0
    const allOn = totalCount && activeCount === totalCount
    return `<button class="res-card${empty ? ' is-empty' : ''}" data-navigate="${page}" type="button">
      <span class="res-top">
        <span class="stat-icon ${empty ? 'tint-amber' : tint}">${icon(iconName)}</span>
        <span class="res-label">${esc(label)}</span>
        ${icon('i-chevron', 'ico-sm chevron')}
      </span>
      <span class="res-figure">
        <strong>${empty ? '—' : fmtInt(activeCount)}</strong>
        ${empty ? '<em>尚未配置</em>' : `<em>/ ${fmtInt(totalCount)} 启用</em>`}
      </span>
      ${empty
        ? '<span class="res-hint">点击前往配置</span>'
        : `<span class="meter${allOn ? ' is-full' : ''}"><span style="width:${ratio}%"></span></span>`}
    </button>`
  }).join('')

  const models = (stats.byModel || []).map(row => ({ label: row.model || '未知模型', value: num(row.requests) }))
  $('chart-models').innerHTML = doughnutChart(models, '总请求', fmtTokens(totalRequests))

  const trend = (stats.trend || []).map(row => ({
    bucket: row.bucket,
    prompt_tokens: num(row.prompt_tokens),
    completion_tokens: num(row.completion_tokens)
  }))
  $('chart-tokens').innerHTML = lineChart(trend, [
    { key: 'prompt_tokens', label: '输入 Token', color: '#14b8a6' },
    { key: 'completion_tokens', label: '输出 Token', color: '#3b82f6' }
  ])

  const recent = state.data.usage.slice(0, 8)
  $('dashboard-activity').innerHTML = recent.length
    ? table(
        ['模型', '服务商', '状态', 'Token', '耗时', '时间'],
        recent.map(item => [
          `<span class="cell-main">${esc(item.model || '-')}</span>`,
          providerBadge(item.provider),
          httpBadge(item.status),
          fmtTokens(item.total_tokens),
          fmtLatency(item.latency_ms),
          `<span class="cell-dim">${fmtDate(item.created_at)}</span>`
        ])
      )
    : emptyState('i-inbox', '还没有调用记录', '创建 API 密钥并接入客户端后，记录会显示在这里。')
}

/* --------------------------------------------------------------- tables */

function table(headers, rows, options = {}) {
  const head = headers.map(h => `<th${h.numeric ? ' class="num"' : ''}>${esc(h.label ?? h)}</th>`).join('')
  const body = rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')
  return `<table class="data-table${options.compact ? ' compact' : ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

/**
 * Apply a page's search box and dropdowns to its rows.
 *
 * Search is a fuzzy substring match over the fields a person would actually
 * type, so `text` is supplied per page rather than stringifying whole records —
 * matching on raw JSON would let an id or a timestamp satisfy a name search.
 * Provider and group are exact matches, and an empty value means "all".
 */
function applyFilters(rows, filter, { text, provider, group }) {
  const query = String(filter.q || '').trim().toLowerCase()
  const wantProvider = String(filter.provider || '')
  const wantGroup = String(filter.group || '')

  return rows.filter(row => {
    if (query && !text(row).toLowerCase().includes(query)) return false
    if (wantProvider && String(provider ? provider(row) : '') !== wantProvider) return false
    if (wantGroup && String(group ? group(row) : '') !== wantGroup) return false
    return true
  })
}

/** "12 / 30 个账号" when filtered, plain total when not. */
function filterSummary(shown, total, unit) {
  if (!total) return ''
  return shown === total ? `${total} ${unit}` : `${shown} / ${total} ${unit}`
}

/** Keep every group dropdown in sync with the loaded groups. */
function syncGroupFilters() {
  const options = ['<option value="">全部分组</option>']
    .concat(state.data.groups.map(group =>
      `<option value="${group.id}">${esc(group.name)}</option>`))
    .join('')

  for (const [id, key] of [
    ['keys-group', 'keys'], ['usage-group', 'usage'],
    ['accounts-group', 'accounts'], ['models-group', 'models']
  ]) {
    const select = $(id)
    if (!select) continue
    // Preserve the operator's selection across a refresh; rebuilding the list
    // would otherwise silently reset the filter to "all".
    const current = state.filters[key].group
    select.innerHTML = options
    if (current && select.querySelector(`option[value="${current}"]`)) {
      select.value = current
    } else if (current) {
      // The selected group disappeared, so fall back to showing everything.
      state.filters[key].group = ''
      select.value = ''
    }
  }
}

function renderKeys() {
  const all = state.data.keys
  const items = applyFilters(all, state.filters.keys, {
    text: item => `${item.name || ''} ${item.group_name || ''} ${isOn(item.enabled) ? '启用' : '停用'}`,
    group: item => item.group_id || ''
  })
  $('keys-count').textContent = filterSummary(items.length, all.length, '个密钥')

  $('keys-list').innerHTML = items.length
    ? table(
        ['名称', '分组', '状态', '已用额度', '额度上限', '创建时间', '操作'],
        items.map(item => {
          const used = num(item.balance)
          const limit = num(item.quota_limit)
          const ratio = limit > 0 ? Math.min(used / limit * 100, 100) : 0
          return [
            `<span class="cell-main">${esc(item.name || '未命名密钥')}</span><span class="cell-sub">ID #${item.id}</span>`,
            item.group_id
              ? `<span class="badge badge-group">${esc(item.group_name || `#${item.group_id}`)}</span>`
              : '<span class="cell-dim">全部分组</span>',
            toggleControl('toggle-key', item.id, isOn(item.enabled)),
            limit > 0
              ? `<span class="cell-main">$${used.toFixed(4)}</span><div class="meter"><span style="width:${ratio}%"></span></div>`
              : `<span class="cell-main">$${used.toFixed(4)}</span>`,
            limit > 0 ? `$${limit.toFixed(2)}` : '<span class="cell-dim">不限</span>',
            `<span class="cell-dim">${fmtDate(item.created_at)}</span>`,
            rowActions([
              actionButton('edit-key', item.id, '编辑', 'i-edit'),
              actionButton('delete-key', item.id, '删除', 'i-trash', 'danger')
            ])
          ]
        })
      )
    : emptyState('i-key', all.length ? '没有匹配的密钥' : '暂无 API 密钥', all.length ? '换个关键词再试。' : '点击右上角创建一个供客户端使用的密钥。')
}

function renderUsage() {
  const all = state.data.usage
  const items = applyFilters(all, state.filters.usage, {
    text: item => `${item.model || ''} ${item.provider || ''} ${item.status || ''} ${item.group_name || ''} ${item.account_name || ''} ${item.key_name || ''}`,
    provider: item => item.provider || '',
    group: item => item.group_id || ''
  })
  $('usage-count').textContent = filterSummary(items.length, all.length, '条记录')

  $('usage-list').innerHTML = items.length
    ? table(
        ['模型', '服务商', '分组 / 账号', '密钥', '输入', '输出', '合计', '费用', '状态', '首字', '耗时', '时间'],
        items.map(item => [
          `<span class="cell-main">${esc(item.model || '-')}</span>${item.error_message ? `<span class="cell-sub err" title="${esc(item.error_message)}">${esc(item.error_message)}</span>` : ''}`,
          providerBadge(item.provider),
          item.group_name || item.account_name
            ? `<span class="badge badge-group">${esc(item.group_name || '未知分组')}</span><span class="cell-sub">${esc(item.account_name || '账号已删除')}</span>`
            : '<span class="cell-dim">-</span>',
          item.key_name
            ? `<span class="cell-dim">${esc(item.key_name)}</span>`
            : '<span class="cell-dim">-</span>',
          fmtTokens(item.prompt_tokens),
          fmtTokens(item.completion_tokens),
          `<span class="cell-main">${fmtTokens(item.total_tokens)}</span>`,
          fmtCost(item.cost),
          httpBadge(item.status),
          ttftCell(item.ttft_ms),
          fmtLatency(item.latency_ms),
          `<span class="cell-dim">${fmtDate(item.created_at)}</span>`
        ])
      )
    : emptyState('i-activity', all.length ? '没有匹配的记录' : '暂无使用记录', all.length ? '换个关键词再试。' : '网关收到请求后会自动记录用量。')
}

function renderGroups() {
  const all = state.data.groups
  const items = applyFilters(all, state.filters.groups, {
    text: item => `${item.name || ''} ${item.description || ''}`
  })
  $('groups-count').textContent = filterSummary(items.length, all.length, '个分组')
  $('groups-list').innerHTML = items.length
    ? table(
        ['分组', '状态', '优先级', '错误率阈值', '错误次数', '统计窗口', '账号数', '操作'],
        items.map(item => {
          const bound = state.data.accounts.filter(a => num(a.group_id) === num(item.id)).length
          return [
            `<span class="cell-main">${esc(item.name)}</span><span class="cell-sub">${esc(item.description || '未填写描述')}</span>`,
            toggleControl('toggle-group', item.id, isOn(item.enabled)),
            `<span class="mono">${fmtInt(item.priority)}</span>`,
            `<span class="mono">${(num(item.error_threshold, .5) * 100).toFixed(0)}%</span>`,
            `<span class="mono">${fmtInt(item.error_count_threshold || 5)}</span>`,
            `<span class="mono">${fmtInt(item.window_seconds || 300)} 秒</span>`,
            bound ? `<span class="mono">${bound}</span>` : '<span class="cell-dim">0</span>',
            rowActions([
              actionButton('edit-group', item.id, '编辑', 'i-edit'),
              actionButton('delete-group', item.id, '删除', 'i-trash', 'danger')
            ])
          ]
        })
      )
    : emptyState('i-layers', all.length ? '没有匹配的分组' : '暂无分组', all.length ? '换个关键词再试。' : '先创建一个分组，再把上游账号加进去。')
}


function renderAccounts() {
  const all = state.data.accounts
  const items = applyFilters(all, state.filters.accounts, {
    text: item => `${item.name || ''} ${item.provider || ''} ${providerLabel(item.provider)} ${item.group_name || ''} ${item.base_url || ''}`,
    provider: item => item.provider || '',
    group: item => item.group_id || ''
  })
  $('accounts-count').textContent = filterSummary(items.length, all.length, '个账号')
  $('accounts-list').innerHTML = items.length
    ? table(
        ['账号', '服务商', '分组', '地址', '倍率', '测活', '状态', '错误率', '优先级', '操作'],
        items.map(item => [
          `<span class="cell-main">${esc(item.name)}</span><span class="cell-sub">ID #${item.id}${item.client_spoofing ? ` · 伪装 ${esc(item.client_spoofing)}` : ''}</span>`,
          providerBadge(item.provider),
          `<span class="badge badge-group">${esc(item.group_name || `分组 #${item.group_id}`)}</span>`,
          item.base_url
            ? `<span class="cell-dim mono" title="${esc(item.base_url)}">${esc(item.base_url.replace(/^https?:\/\//, ''))}</span>`
            : '<span class="cell-dim">服务商默认</span>',
          multiplierCell(item.rate_multiplier),
          healthCell(item),
          toggleControl('toggle-account', item.id, isOn(item.enabled)),
          num(item.error_rate)
            ? `<span class="badge badge-warn">${(num(item.error_rate) * 100).toFixed(1)}%</span>`
            : '<span class="cell-dim">0%</span>',
          `<span class="mono">${fmtInt(item.priority)}</span>`,
          rowActions([
            actionButton('test-account', item.id, '测试', 'i-play'),
            actionButton('edit-account', item.id, '编辑', 'i-edit'),
            actionButton('delete-account', item.id, '删除', 'i-trash', 'danger')
          ])
        ])
      )
    : emptyState('i-users', all.length ? '没有匹配的账号' : '暂无上游账号', all.length ? '调整上面的筛选条件再试。' : '先创建一个分组，再添加上游服务商账号。')
}

function renderModels() {
  const all = state.data.models
  const items = applyFilters(all, state.filters.models, {
    text: item => `${item.requested_model || ''} ${item.upstream_model || ''} ${item.provider || ''} ${providerLabel(item.provider)}`,
    provider: item => item.provider || '',
    group: item => item.group_id || ''
  })
  $('models-count').textContent = filterSummary(items.length, all.length, '个映射')
  $('models-list').innerHTML = items.length
    ? table(
        ['客户端模型', '上游模型', '服务商', '目标分组', '状态', '优先级', '操作'],
        items.map(item => {
          const group = state.data.groups.find(g => num(g.id) === num(item.group_id))
          return [
            `<span class="cell-main mono">${esc(item.requested_model)}</span>${String(item.requested_model || '').endsWith('*') ? '<span class="cell-sub">前缀通配</span>' : ''}`,
            `<span class="mono">${esc(item.upstream_model)}</span>`,
            providerBadge(item.provider),
            group ? esc(group.name) : `<span class="cell-dim">分组 #${item.group_id}</span>`,
            toggleControl('toggle-model', item.id, isOn(item.enabled)),
            `<span class="mono">${fmtInt(item.priority)}</span>`,
            rowActions([
              actionButton('edit-model', item.id, '编辑', 'i-edit'),
              actionButton('delete-model', item.id, '删除', 'i-trash', 'danger')
            ])
          ]
        })
      )
    : emptyState('i-route', all.length ? '没有匹配的映射' : '暂无模型映射', all.length ? '调整上面的筛选条件再试。' : '没有映射时，网关按模型名称自动选择服务商。')
}

function renderSettings() {
  const origin = window.location.origin
  const endpoints = [
    ['OpenAI / Codex', `${origin}/v1`, 'Authorization: Bearer <API Key>'],
    ['Claude Code', origin, 'x-api-key 或 Authorization: Bearer'],
    ['Grok', `${origin}/v1`, 'Authorization: Bearer <API Key>']
  ]
  $('endpoint-list').innerHTML = endpoints.map(([name, url, auth]) => `
    <div class="endpoint-row">
      <div class="endpoint-meta"><strong>${esc(name)}</strong><span>${esc(auth)}</span></div>
      <code class="endpoint-url">${esc(url)}</code>
      <button class="mini-btn" data-action="copy-text" data-text="${esc(url)}" type="button">${icon('i-copy', 'ico-sm')}<span>复制</span></button>
    </div>`).join('')
}

/* ---------------------------------------------------------------- modals */

let activeModal = null

/**
 * Close the current dialog. Pass `only` to close a specific dialog: an
 * onSubmit handler may itself open a follow-up dialog (the API key secret), and
 * an unconditional close would then dismiss that replacement instead.
 */
function closeModal(only = null) {
  if (!activeModal) return
  if (only && activeModal.backdrop !== only) return
  const { backdrop, previousFocus } = activeModal
  activeModal = null
  backdrop.remove()
  document.body.classList.remove('modal-open')
  if (previousFocus && document.contains(previousFocus)) previousFocus.focus()
}

/**
 * Build a dialog. `fields` is HTML for the form body; `onSubmit` receives a
 * FormData and may throw to surface an inline error without closing.
 */
function openModal({ title, subtitle, body, submitLabel = '保存', onSubmit, size = '', footer }) {
  closeModal()

  const previousFocus = document.activeElement
  const backdrop = el('div', 'modal-backdrop')
  const card = el('div', `modal-card ${size}`)
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', title)

  const head = el('div', 'modal-head', `
    <div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
    <button class="icon-btn" type="button" data-modal-close aria-label="关闭">${icon('i-close')}</button>`)
  card.appendChild(head)

  if (onSubmit) {
    const form = el('form', 'modal-form')
    form.noValidate = true
    form.innerHTML = `<div class="modal-body">${body}<p class="modal-error" role="alert"></p></div>
      <div class="modal-foot">
        <button class="btn btn-ghost" type="button" data-modal-close>取消</button>
        <button class="btn btn-primary" type="submit">${esc(submitLabel)}</button>
      </div>`

    const submit = form.querySelector('button[type="submit"]')
    const errorNode = form.querySelector('.modal-error')

    form.addEventListener('submit', async event => {
      event.preventDefault()
      errorNode.textContent = ''
      submit.disabled = true
      submit.textContent = '保存中…'
      try {
        await onSubmit(new FormData(form), form)
        // Scoped to this dialog so a follow-up dialog opened by onSubmit stays.
        closeModal(backdrop)
      } catch (error) {
        errorNode.textContent = error.message || '保存失败'
        submit.disabled = false
        submit.textContent = submitLabel
      }
    })
    card.appendChild(form)
  } else {
    card.appendChild(el('div', 'modal-body', body))
    card.appendChild(el('div', 'modal-foot', footer ?? '<button class="btn btn-primary" type="button" data-modal-close>关闭</button>'))
  }

  // Closes come only from explicit controls and from a click that lands on the
  // backdrop itself, never from a click that merely bubbles through it.
  card.addEventListener('click', event => {
    if (event.target.closest('[data-modal-close]')) closeModal()
  })
  backdrop.addEventListener('mousedown', event => {
    if (event.target === backdrop) closeModal()
  })

  backdrop.appendChild(card)
  $('modal-root').appendChild(backdrop)
  document.body.classList.add('modal-open')
  activeModal = { backdrop, previousFocus }

  const first = card.querySelector('input:not([type=hidden]), select, textarea')
  if (first) first.focus()
  return card
}

function confirmModal({ title, message, confirmLabel = '确认删除', onConfirm }) {
  const card = openModal({
    title,
    body: `<p class="confirm-text">${esc(message)}</p>`,
    footer: `<button class="btn btn-ghost" type="button" data-modal-close>取消</button>
             <button class="btn btn-danger" type="button" data-confirm>${esc(confirmLabel)}</button>`
  })
  const button = card.querySelector('[data-confirm]')
  button.addEventListener('click', async () => {
    button.disabled = true
    button.textContent = '处理中…'
    try {
      await onConfirm()
      closeModal()
    } catch (error) {
      closeModal()
      showToast(error.message, 'error')
    }
  })
  button.focus()
}

/* ----------------------------------------------------------- form fields */

function field(label, control, options = {}) {
  return `<div class="form-field ${options.full ? 'full' : ''}">
    <label class="field-label" for="${options.id || ''}">${esc(label)}${options.required ? '<span class="req">*</span>' : ''}</label>
    ${control}
    ${options.hint ? `<span class="field-hint">${options.hint}</span>` : ''}
  </div>`
}
function textInput(name, value = '', placeholder = '', type = 'text', attrs = '') {
  return `<input class="field-input" id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${attrs}>`
}
function selectInput(name, optionsHtml, attrs = '') {
  return `<select class="field-select" id="f-${name}" name="${name}" ${attrs}>${optionsHtml}</select>`
}
function option(value, label, selected) {
  return `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`
}
function providerOptions(selected) {
  return Object.entries(PROVIDERS).map(([value, label]) => option(value, label, selected)).join('')
}
function groupOptions(selected, placeholder = '请选择分组') {
  return option('', placeholder, selected) + state.data.groups.map(g => option(g.id, `${g.name}${isOn(g.enabled) ? '' : '（已停用）'}`, selected)).join('')
}
function switchField(name, checked, label = '启用') {
  return `<label class="check-row">
    <input type="checkbox" id="f-${name}" name="${name}" ${checked ? 'checked' : ''}>
    <span>${esc(label)}</span>
  </label>`
}
function formGrid(content) { return `<div class="form-grid">${content}</div>` }

/* ------------------------------------------------------------ modal defs */

function openKeyModal(key = null) {
  const editing = Boolean(key)
  openModal({
    title: editing ? '编辑 API 密钥' : '创建 API 密钥',
    subtitle: editing ? '密钥本身不可查看，只能修改名称与额度。' : '为客户端生成一个新的访问密钥。',
    submitLabel: editing ? '保存修改' : '生成密钥',
    body: formGrid(
      field('名称', textInput('name', key?.name || '', '例如 production-app', 'text', 'required'), { id: 'f-name', required: true }) +
      field('额度上限（USD）', textInput('quota_limit', key?.quota_limit ?? 0, '0 表示不限额', 'number', 'min="0" step="0.01"'), {
        id: 'f-quota_limit', hint: '按累计费用计算，达到上限后密钥自动拒绝请求。'
      }) +
      field('绑定分组', selectInput('group_id', groupOptions(key?.group_id, '不限（全部分组）')), {
        id: 'f-group_id', full: true,
        hint: '绑定后该密钥只会调度所选分组内的账号；分组内无可用账号时请求直接失败，不会跨分组。'
      }) +
      (editing ? field('已用额度（USD）', textInput('balance', num(key.balance).toFixed(4), '', 'number', 'min="0" step="0.0001"'), { id: 'f-balance', hint: '可手动重置，例如续费后清零。' }) : '') +
      field('状态', switchField('enabled', editing ? isOn(key.enabled) : true), { full: !editing })
    ),
    async onSubmit(form) {
      const values = Object.fromEntries(form.entries())
      const name = String(values.name || '').trim()
      if (!name) throw new Error('请填写密钥名称')

      const payload = {
        name,
        quota_limit: num(values.quota_limit),
        enabled: values.enabled === 'on' ? 1 : 0,
        // Empty string means "any group"; the API stores NULL for that.
        group_id: values.group_id ? num(values.group_id) : null
      }
      if (editing) {
        payload.balance = num(values.balance)
        await api(`/keys/${key.id}`, { method: 'PUT', body: payload })
        await loadPage('keys', true)
        showToast('密钥已更新', 'success')
      } else {
        const result = await api('/keys', { method: 'POST', body: payload })
        const secret = result?.data?.key || ''
        await loadPage('keys', true)
        showSecretModal(secret)
      }
    }
  })
}

function showSecretModal(secret) {
  openModal({
    title: '保存你的 API 密钥',
    subtitle: '出于安全原因，完整密钥只显示这一次。',
    body: `<div class="secret-box">
        <code id="new-secret">${esc(secret)}</code>
        <button class="mini-btn" type="button" data-action="copy-text" data-text="${esc(secret)}">${icon('i-copy', 'ico-sm')}<span>复制</span></button>
      </div>
      <p class="field-hint">请将它放入客户端的 <code>Authorization: Bearer</code> 或 <code>x-api-key</code> 请求头。</p>`,
    footer: '<button class="btn btn-primary" type="button" data-modal-close>我已保存</button>'
  })
}

function openGroupModal(group = null) {
  const editing = Boolean(group)
  openModal({
    title: editing ? '编辑分组' : '新建分组',
    subtitle: '分组决定调度顺序和账号熔断策略。',
    submitLabel: '保存分组',
    body: formGrid(
      field('分组名称', textInput('name', group?.name || '', '例如 default', 'text', 'required'), { id: 'f-name', required: true }) +
      field('优先级', textInput('priority', group?.priority ?? 0, '数字越小越优先', 'number'), { id: 'f-priority' }) +
      field('描述', textInput('description', group?.description || '', '可选说明'), { id: 'f-description', full: true }) +
      field('错误率阈值', textInput('error_threshold', group?.error_threshold ?? 0.5, '0 - 1', 'number', 'min="0" max="1" step="0.05"'), {
        id: 'f-error_threshold', hint: '窗口内错误率超过该值时熔断，0.5 表示 50%。'
      }) +
      field('错误次数阈值', textInput('error_count_threshold', group?.error_count_threshold ?? 5, '触发熔断的次数', 'number', 'min="1" step="1"'), { id: 'f-error_count_threshold' }) +
      field('统计窗口（秒）', textInput('window_seconds', group?.window_seconds ?? 300, '默认 300', 'number', 'min="10" step="10"'), { id: 'f-window_seconds' }) +
      field('状态', switchField('enabled', editing ? isOn(group.enabled) : true))
    ),
    async onSubmit(form) {
      const values = Object.fromEntries(form.entries())
      const name = String(values.name || '').trim()
      if (!name) throw new Error('请填写分组名称')

      const threshold = num(values.error_threshold, 0.5)
      if (threshold < 0 || threshold > 1) throw new Error('错误率阈值需在 0 到 1 之间')

      const payload = {
        name,
        description: String(values.description || '').trim(),
        priority: num(values.priority),
        error_threshold: threshold,
        error_count_threshold: Math.max(1, num(values.error_count_threshold, 5)),
        window_seconds: Math.max(10, num(values.window_seconds, 300)),
        enabled: values.enabled === 'on' ? 1 : 0
      }
      await api(editing ? `/groups/${group.id}` : '/groups', { method: editing ? 'PUT' : 'POST', body: payload })
      await loadPage('groups', true)
      showToast(editing ? '分组已更新' : '分组已创建', 'success')
    }
  })
}


function openAccountModal(account = null) {
  const editing = Boolean(account)
  const provider = account?.provider || 'openai'
  const missingRefs = !state.data.groups.length

  const warning = missingRefs
    ? `<div class="notice notice-warn">${icon('i-alert', 'ico-sm')}<span>请先创建至少一个分组，再添加上游账号。</span></div>`
    : ''

  openModal({
    title: editing ? '编辑上游账号' : '添加上游账号',
    subtitle: '账号直接持有上游凭据，并按所属分组参与调度。',
    submitLabel: '保存账号',
    body: warning + formGrid(
      field('账号名称', textInput('name', account?.name || '', '例如 OpenAI 主账号', 'text', 'required'), { id: 'f-name', required: true }) +
      field('服务商', selectInput('provider', providerOptions(provider), 'required'), {
        id: 'f-provider', required: true, hint: '决定请求转发到哪个上游协议。'
      }) +
      field('上游密钥', textInput('api_key', '', editing ? '留空保持原值' : '例如 sk-...', 'password', 'autocomplete="new-password"'), {
        id: 'f-api_key', full: true, required: !editing, hint: '仅用于服务端转发，保存后在界面和接口中始终脱敏。'
      }) +
      field('所属分组', selectInput('group_id', groupOptions(account?.group_id), 'required'), {
        id: 'f-group_id', required: true, hint: '分组决定调度顺序、熔断策略，以及哪些 API 密钥可以用到它。'
      }) +
      field('基础地址', textInput('base_url', account?.base_url || '', '留空使用服务商默认地址'), {
        id: 'f-base_url', full: true, hint: '中转或自建入口填写完整地址，例如 https://api.example.com。'
      }) +
      field('优先级', textInput('priority', account?.priority ?? 0, '数字越小越优先', 'number'), { id: 'f-priority' }) +
      field('计费倍率', textInput('rate_multiplier', account?.rate_multiplier ?? 1, '1 = 原价', 'number', 'min="0" max="100" step="0.01"'), {
        id: 'f-rate_multiplier', hint: '上游折扣。同优先级下倍率低的账号优先调度。'
      }) +
      field('客户端伪装', textInput('client_spoofing', account?.client_spoofing || '', '可选，例如 claude-code'), {
        id: 'f-client_spoofing', full: true, hint: '支持预设名或 JSON 请求头对象。'
      }) +
      field('状态', switchField('enabled', editing ? isOn(account.enabled) : true), { full: true })
    ),
    async onSubmit(form) {
      const values = Object.fromEntries(form.entries())
      const name = String(values.name || '').trim()
      if (!name) throw new Error('请填写账号名称')
      const groupId = num(values.group_id)
      if (!groupId) throw new Error('请选择所属分组')
      if (!editing && !String(values.api_key || '').trim()) throw new Error('请填写上游密钥')

      const payload = {
        name,
        provider: values.provider,
        base_url: String(values.base_url || '').trim(),
        group_id: groupId,
        priority: num(values.priority),
        client_spoofing: String(values.client_spoofing || '').trim(),
        enabled: values.enabled === 'on' ? 1 : 0,
        rate_multiplier: num(values.rate_multiplier, 1)
      }
      if (values.api_key) payload.api_key = String(values.api_key).trim()

      await api(editing ? `/accounts/${account.id}` : '/accounts', { method: editing ? 'PUT' : 'POST', body: payload })
      await loadPage('accounts', true)
      showToast(editing ? '账号已更新' : '账号已添加', 'success')
    }
  })
}

function openModelModal(model = null) {
  const editing = Boolean(model)
  openModal({
    title: editing ? '编辑模型映射' : '新建模型映射',
    subtitle: '为客户端模型名指定上游模型和调度分组。',
    submitLabel: '保存映射',
    body: formGrid(
      field('客户端模型名', textInput('requested_model', model?.requested_model || '', '例如 gpt-4o 或 claude-*', 'text', 'required'), {
        id: 'f-requested_model', required: true, hint: '以 <code>*</code> 结尾表示前缀通配。'
      }) +
      field('上游模型名', textInput('upstream_model', model?.upstream_model || '', '例如 gpt-4o-mini', 'text', 'required'), { id: 'f-upstream_model', required: true }) +
      field('服务商', selectInput('provider', providerOptions(model?.provider || 'openai'), 'required'), { id: 'f-provider', required: true }) +
      field('目标分组', selectInput('group_id', groupOptions(model?.group_id), 'required'), {
        id: 'f-group_id', required: true, hint: '该分组无可用账号时会回退到同服务商其他分组。'
      }) +
      field('优先级', textInput('priority', model?.priority ?? 0, '数字越小越优先', 'number'), { id: 'f-priority' }) +
      field('状态', switchField('enabled', editing ? isOn(model.enabled) : true))
    ),
    async onSubmit(form) {
      const values = Object.fromEntries(form.entries())
      const requested = String(values.requested_model || '').trim()
      const upstream = String(values.upstream_model || '').trim()
      if (!requested) throw new Error('请填写客户端模型名')
      if (!upstream) throw new Error('请填写上游模型名')
      const groupId = num(values.group_id)
      if (!groupId) throw new Error('请选择目标分组')

      const payload = {
        requested_model: requested,
        upstream_model: upstream,
        provider: values.provider,
        group_id: groupId,
        priority: num(values.priority),
        enabled: values.enabled === 'on' ? 1 : 0
      }
      await api(editing ? `/models/${model.id}` : '/models', { method: editing ? 'PUT' : 'POST', body: payload })
      await loadPage('models', true)
      showToast(editing ? '映射已更新' : '映射已创建', 'success')
    }
  })
}

/* --------------------------------------------------------------- actions */

function findRecord(collection, id) {
  return state.data[collection].find(entry => num(entry.id) === num(id)) || null
}

function requestDelete({ path, label, name, page }) {
  confirmModal({
    title: `删除${label}`,
    message: `确定删除${label}「${name}」吗？此操作无法撤销。`,
    async onConfirm() {
      await api(path, { method: 'DELETE' })
      await loadPage(page, true)
      showToast(`${label}已删除`, 'success')
    }
  })
}

async function toggleEntity(endpoint, page, id, control) {
  const next = control.classList.contains('on') ? 0 : 1
  control.disabled = true
  try {
    await api(`${endpoint}/${id}`, { method: 'PUT', body: { enabled: next } })
    await loadPage(page, true)
    showToast(next ? '已启用' : '已停用', 'success')
  } catch (error) {
    showToast(error.message, 'error')
    control.disabled = false
  }
}

async function copyText(text, button) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      // Clipboard API needs a secure context; fall back to a temporary node.
      const area = el('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    if (button) {
      const original = button.innerHTML
      button.innerHTML = `${icon('i-check', 'ico-sm')}<span>已复制</span>`
      setTimeout(() => { button.innerHTML = original }, 1600)
    }
    showToast('已复制到剪贴板', 'success')
  } catch {
    showToast('复制失败，请手动选择内容', 'error')
  }
}

document.addEventListener('click', async event => {
  const target = event.target instanceof Element ? event.target : null
  if (!target) return

  const navButton = target.closest('[data-navigate]')
  if (navButton) { navigate(navButton.dataset.navigate); return }

  const action = target.closest('[data-action]')
  if (!action) return

  const id = num(action.dataset.id)
  const name = action.dataset.action

  try {
    switch (name) {
      case 'copy-text':
        await copyText(action.dataset.text || '', action)
        break

      case 'edit-key': { const record = findRecord('keys', id); if (record) openKeyModal(record); break }
      case 'toggle-key': await toggleEntity('/keys', 'keys', id, action); break
      case 'delete-key': {
        const record = findRecord('keys', id)
        requestDelete({ path: `/keys/${id}`, label: 'API 密钥', name: record?.name || `#${id}`, page: 'keys' })
        break
      }

      case 'edit-group': { const record = findRecord('groups', id); if (record) openGroupModal(record); break }
      case 'toggle-group': await toggleEntity('/groups', 'groups', id, action); break
      case 'delete-group': {
        const record = findRecord('groups', id)
        const bound = state.data.accounts.filter(a => num(a.group_id) === id).length
        if (bound) { showToast(`该分组下还有 ${bound} 个账号，请先转移或删除`, 'error'); break }
        requestDelete({ path: `/groups/${id}`, label: '分组', name: record?.name || `#${id}`, page: 'groups' })
        break
      }

      case 'edit-account': { const record = findRecord('accounts', id); if (record) openAccountModal(record); break }
      case 'toggle-account': await toggleEntity('/accounts', 'accounts', id, action); break
      case 'delete-account': {
        const record = findRecord('accounts', id)
        requestDelete({ path: `/accounts/${id}`, label: '上游账号', name: record?.name || `#${id}`, page: 'accounts' })
        break
      }
      case 'test-account': {
        const original = action.innerHTML
        action.disabled = true
        action.innerHTML = `${icon('i-clock', 'ico-sm')}<span>测试中</span>`
        try {
          const result = await api(`/accounts/${id}/test`, { method: 'POST' })
          const ok = result?.success === true || result?.data?.success === true
          const message = result?.message || result?.data?.message || (ok ? '连接测试成功' : '连接测试失败')
          showToast(message, ok ? 'success' : 'error')
          // The probe stores its verdict on the row, so reload to surface it.
          await loadPage('accounts', true)
        } finally {
          action.disabled = false
          action.innerHTML = original
        }
        break
      }

      case 'edit-model': { const record = findRecord('models', id); if (record) openModelModal(record); break }
      case 'toggle-model': await toggleEntity('/models', 'models', id, action); break
      case 'delete-model': {
        const record = findRecord('models', id)
        requestDelete({ path: `/models/${id}`, label: '模型映射', name: record?.requested_model || `#${id}`, page: 'models' })
        break
      }
    }
  } catch (error) {
    showToast(error.message, 'error')
  }
})

/* ------------------------------------------------------------- app chrome */

function applyTheme(theme) {
  const dark = theme === 'dark'
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  localStorage.setItem('theme', dark ? 'dark' : 'light')
  $('theme-icon').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon')
  $('theme-label').textContent = dark ? '浅色模式' : '深色模式'
}

function applySidebar(collapsed) {
  $('page-app').classList.toggle('sidebar-collapsed', collapsed)
  localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0')
  $('collapse-icon').querySelector('use').setAttribute('href', collapsed ? '#i-expand' : '#i-collapse')
  $('collapse-label').textContent = collapsed ? '展开侧栏' : '收起侧栏'
}

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
  item.addEventListener('click', () => navigate(item.dataset.page))
})

$('theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark')
  if (state.page === 'dashboard') renderDashboard()
})
$('sidebar-collapse').addEventListener('click', () => {
  applySidebar(!$('page-app').classList.contains('sidebar-collapsed'))
})
$('sidebar-open').addEventListener('click', openSidebar)
$('sidebar-close').addEventListener('click', closeSidebar)
$('sidebar-scrim').addEventListener('click', closeSidebar)
$('nav-logout').addEventListener('click', () => logout(true))
$('user-menu').addEventListener('click', () => navigate('settings'))

/**
 * Spin a refresh control for exactly as long as its request runs.
 *
 * A fixed timer either stops while a slow fetch is still pending or keeps
 * spinning after a fast one finished, so the animation is tied to the promise.
 * The button is disabled meanwhile so repeated clicks cannot stack requests.
 */
async function withRefreshSpin(button, work) {
  if (!button || button.classList.contains('is-busy')) return
  button.classList.add('is-busy')
  try {
    await work()
  } finally {
    button.classList.remove('is-busy')
  }
}

// An explicit click reports failures: silent mode exists for background polls,
// and a refresh that quietly does nothing looks like a broken button.
$('topbar-refresh').addEventListener('click', event =>
  withRefreshSpin(event.currentTarget, () => loadPage(state.page)))
$('dashboard-refresh').addEventListener('click', event =>
  withRefreshSpin(event.currentTarget, () => loadDashboard()))
$('btn-refresh-usage').addEventListener('click', event =>
  withRefreshSpin(event.currentTarget, () => loadPage('usage')))

$('btn-create-key').addEventListener('click', () => openKeyModal())
$('btn-create-group').addEventListener('click', () => openGroupModal())
$('btn-create-account').addEventListener('click', () => openAccountModal())
$('btn-test-accounts').addEventListener('click', async event => {
  const button = event.currentTarget
  const original = button.innerHTML
  button.disabled = true
  button.innerHTML = `${icon('i-clock', 'ico-sm')}<span>测活中…</span>`
  try {
    const result = await api('/accounts/test-all', { method: 'POST' })
    const summary = result?.data || {}
    const failed = num(summary.failed)
    showToast(
      `测活完成：${num(summary.healthy)} 个正常${failed ? `，${failed} 个异常` : ''}`,
      failed ? 'warn' : 'success'
    )
    await loadPage('accounts', true)
  } catch (error) {
    showToast(error.message || '批量测活失败', 'error')
  } finally {
    button.disabled = false
    button.innerHTML = original
  }
})
$('btn-create-model').addEventListener('click', () => openModelModal())

/**
 * Wire every toolbar control to its page filter.
 *
 * Filtering is client-side over the already-loaded rows, so typing re-renders
 * without a network round trip. Each page owns its own filter object, which is
 * why the control id encodes both the page and the field it drives.
 */
for (const [id, page, field, render] of [
  ['keys-search', 'keys', 'q', renderKeys],
  ['keys-group', 'keys', 'group', renderKeys],
  ['usage-search', 'usage', 'q', renderUsage],
  ['usage-provider', 'usage', 'provider', renderUsage],
  ['usage-group', 'usage', 'group', renderUsage],
  ['groups-search', 'groups', 'q', renderGroups],
  ['accounts-search', 'accounts', 'q', renderAccounts],
  ['accounts-provider', 'accounts', 'provider', renderAccounts],
  ['accounts-group', 'accounts', 'group', renderAccounts],
  ['models-search', 'models', 'q', renderModels],
  ['models-provider', 'models', 'provider', renderModels],
  ['models-group', 'models', 'group', renderModels]
]) {
  const control = $(id)
  if (!control) continue
  control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', event => {
    state.filters[page][field] = event.target.value
    render()
  })
}

$('stats-range').addEventListener('change', event => {
  state.statsRange.hours = num(event.target.value, 24)
  loadDashboard()
})
$('stats-bucket').addEventListener('change', event => {
  state.statsRange.bucket = event.target.value === 'day' ? 'day' : 'hour'
  loadDashboard()
})

$('password-form').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.currentTarget
  const message = $('password-message')
  const button = form.querySelector('button[type="submit"]')
  message.textContent = ''
  message.classList.remove('ok')

  const current = $('pw-current').value
  const next = $('pw-next').value
  const confirm = $('pw-confirm').value

  if (next.length < 8) { message.textContent = '新密码至少需要 8 位'; return }
  if (next !== confirm) { message.textContent = '两次输入的新密码不一致'; return }

  button.disabled = true
  try {
    await api('/auth/password', { method: 'POST', body: { current_password: current, new_password: next } })
    form.reset()
    message.classList.add('ok')
    message.textContent = '密码已更新'
    showToast('密码已更新', 'success')
  } catch (error) {
    message.textContent = error.message
  } finally {
    button.disabled = false
  }
})

$('login-form').addEventListener('submit', async event => {
  event.preventDefault()
  const button = event.currentTarget.querySelector('button[type="submit"]')
  const message = $('login-error')
  message.textContent = ''
  button.disabled = true
  button.textContent = '验证中…'
  try {
    const username = $('login-username').value.trim()
    const password = $('login-password').value
    if (!username || !password) throw new Error('请输入用户名和密码')
    const result = await api('/auth/login', { method: 'POST', body: { username, password } })
    setLoggedIn(result.user, result.token)
    $('login-password').value = ''
    navigate('dashboard')
  } catch (error) {
    message.textContent = error.message || '登录失败，请检查用户名和密码'
  } finally {
    button.disabled = false
    button.textContent = '进入控制台'
  }
})

$('setup-form').addEventListener('submit', async event => {
  event.preventDefault()
  const button = event.currentTarget.querySelector('button[type="submit"]')
  const message = $('setup-error')
  message.textContent = ''

  const username = $('setup-username').value.trim()
  const password = $('setup-password').value
  const confirm = $('setup-confirm').value

  if (!username) { message.textContent = '请输入管理员用户名'; return }
  if (password.length < 8) { message.textContent = '密码至少需要 8 位'; return }
  if (password !== confirm) { message.textContent = '两次输入的密码不一致'; return }

  button.disabled = true
  button.textContent = '创建中…'
  try {
    await api('/auth/setup', { method: 'POST', body: { username, password } })
    const result = await api('/auth/login', { method: 'POST', body: { username, password } })
    setLoggedIn(result.user, result.token)
    navigate('dashboard')
    showToast('管理员创建成功', 'success')
  } catch (error) {
    message.textContent = error.message
  } finally {
    button.disabled = false
    button.textContent = '创建管理员'
  }
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && activeModal) closeModal()
})

/* ----------------------------------------------------------------- boot */

applyTheme(localStorage.getItem('theme') || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
applySidebar(localStorage.getItem('sidebar_collapsed') === '1')

if (state.token && state.user) {
  applyUser(state.user)
  $('page-app').classList.remove('hidden')
  navigate('dashboard')
} else {
  $('page-login').classList.remove('hidden')
  detectSetupState()
}
