const API_BASE = '/api/v1'

const state = {
  token: localStorage.getItem('auth_token') || '',
  user: readStorage('auth_user', null),
  page: 'dashboard',
  data: { keys: [], usage: [], groups: [], channels: [], accounts: [], models: [] },
  filters: { keys: '', usage: '' }
}

const pageMeta = {
  dashboard: { title: '概览' },
  usage: { title: '用量记录' },
  keys: { title: 'API Keys' },
  models: { title: '模型映射' },
  groups: { title: '分组' },
  channels: { title: '渠道' },
  accounts: { title: '上游账号' }
}

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback } catch { return fallback }
}

function $(id) { return document.getElementById(id) }
function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]))
}
function num(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback }
function formatNumber(value) { return new Intl.NumberFormat('zh-CN').format(num(value)) }
function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}
function providerLabel(provider) { return ({ openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI' }[provider] || provider || '-') }
function records(payload) { return Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []) }
function statusPill(enabled, labelOn = '启用', labelOff = '停用') {
  return `<span class="status-pill ${enabled ? '' : 'off'}"><span class="status-dot"></span>${enabled ? labelOn : labelOff}</span>`
}
function emptyState(title, description) {
  return `<div class="empty-state"><strong>${esc(title)}</strong><span>${esc(description || '')}</span></div>`
}

function showToast(message, type = 'info') {
  const node = document.createElement('div')
  node.className = `toast toast-${type}`
  node.innerHTML = `<span class="toast-mark">${type === 'success' ? '✓' : type === 'error' ? '!' : 'i'}</span><span>${esc(message)}</span>`
  $('toast-region').appendChild(node)
  setTimeout(() => node.classList.add('visible'), 10)
  setTimeout(() => { node.classList.remove('visible'); setTimeout(() => node.remove(), 180) }, 3600)
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (state.token) headers.Authorization = `Bearer ${state.token}`
  let body = options.body
  if (body !== undefined && body !== null && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(body)
  }
  const response = await fetch(API_BASE + path, { ...options, headers, body })
  const raw = await response.text()
  let payload = null
  try { payload = raw ? JSON.parse(raw) : null } catch { payload = { error: raw } }
  if (response.status === 401 && path !== '/auth/login' && path !== '/auth/setup') {
    logout(false)
    throw new Error('登录已过期，请重新登录')
  }
  if (!response.ok) throw new Error(payload?.error || payload?.message || `请求失败（${response.status}）`)
  return payload
}

function setLoggedIn(user, token) {
  state.user = user
  state.token = token
  localStorage.setItem('auth_token', token)
  localStorage.setItem('auth_user', JSON.stringify(user))
  $('user-name').textContent = user?.username || '管理员'
  $('heading-user').textContent = user?.username || '管理员'
  $('user-avatar').textContent = (user?.username || 'A').slice(0, 1).toUpperCase()
  $('page-login').classList.add('hidden')
  $('page-app').classList.remove('hidden')
}

function logout(notify = true) {
  state.token = ''
  state.user = null
  localStorage.removeItem('auth_token')
  localStorage.removeItem('auth_user')
  $('page-app').classList.add('hidden')
  $('page-login').classList.remove('hidden')
  if (notify) showToast('已退出登录', 'success')
}

async function login(username, password) {
  return api('/auth/login', { method: 'POST', body: { username, password } })
}

function navigate(page) {
  if (!pageMeta[page]) return
  state.page = page
  document.querySelectorAll('.nav-item[data-page]').forEach(item => item.classList.toggle('active', item.dataset.page === page))
  document.querySelectorAll('.page-section').forEach(section => section.classList.toggle('hidden', section.id !== `page-${page}`))
  $('topbar-title').textContent = pageMeta[page].title
  $('sidebar').classList.remove('open')
  $('page-app').classList.remove('sidebar-visible')
  loadPage(page)
}

async function loadPage(page, silent = false) {
  const endpoint = { keys: '/keys', usage: '/usage?limit=500', groups: '/groups', channels: '/channels', accounts: '/accounts', models: '/models' }[page]
  if (page === 'dashboard') return loadDashboard(silent)
  if (!endpoint) return
  try {
    const payload = await api(endpoint)
    state.data[page] = records(payload)
    if (page === 'keys') renderKeys()
    if (page === 'usage') renderUsage()
    if (page === 'groups') renderGroups()
    if (page === 'channels') renderChannels()
    if (page === 'accounts') renderAccounts()
    if (page === 'models') renderModels()
  } catch (error) {
    showToast(error.message, 'error')
    const target = $(`${page}-list`)
    if (target) target.innerHTML = emptyState('加载失败', error.message)
  }
}

async function loadDashboard(silent = false) {
  try {
    const [usage, keys, groups, channels, accounts, models] = await Promise.all([
      api('/usage?limit=500'), api('/keys'), api('/groups'), api('/channels'), api('/accounts'), api('/models')
    ])
    state.data.usage = records(usage)
    state.data.keys = records(keys)
    state.data.groups = records(groups)
    state.data.channels = records(channels)
    state.data.accounts = records(accounts)
    state.data.models = records(models)
    renderDashboard()
  } catch (error) {
    $('health-badge').innerHTML = '<span class="status-dot" style="background:#f04438"></span>连接异常'
    if (!silent) showToast(error.message, 'error')
  }
}

function renderDashboard() {
  const usage = state.data.usage
  const activeAccounts = state.data.accounts.filter(item => num(item.enabled) === 1).length
  const activeKeys = state.data.keys.filter(item => num(item.enabled) === 1).length
  const success = usage.filter(item => num(item.status, 500) < 400).length
  $('stat-requests').textContent = formatNumber(usage.length)
  $('stat-success').textContent = usage.length ? `${Math.round(success / usage.length * 100)}%` : '--'
  $('stat-success-caption').textContent = usage.length ? `${success} 次请求成功` : '暂无调用记录'
  $('stat-accounts').textContent = formatNumber(activeAccounts)
  $('stat-accounts-caption').textContent = `${state.data.accounts.length} 个账号已配置`
  $('stat-keys').textContent = formatNumber(activeKeys)
  $('stat-keys-caption').textContent = `${state.data.keys.length} 个客户端密钥`

  const recent = usage.slice(0, 8)
  $('dashboard-activity').innerHTML = recent.length ? `<table class="data-table"><thead><tr><th>模型</th><th>服务商</th><th>状态</th><th>耗时</th><th>时间</th></tr></thead><tbody>${recent.map(item => `<tr><td><span class="cell-main">${esc(item.model || '-')}</span></td><td><span class="provider-pill">${esc(providerLabel(item.provider))}</span></td><td>${statusPill(num(item.status, 500) < 400, String(item.status || 'OK'), String(item.status || '失败'))}</td><td>${num(item.latency_ms) ? `${formatNumber(item.latency_ms)} ms` : '-'}</td><td>${formatDate(item.created_at)}</td></tr>`).join('')}</tbody></table>` : emptyState('还没有调用记录', '创建 API Key 并接入模型后，记录会显示在这里。')
  $('resource-health').innerHTML = [
    ['◎', '上游账号', `${activeAccounts} 个启用`, activeAccounts ? 'ok' : 'warn'],
    ['◈', '渠道', `${state.data.channels.filter(item => num(item.enabled) === 1).length} 个启用`, state.data.channels.length ? 'ok' : 'warn'],
    ['▦', '分组', `${state.data.groups.filter(item => num(item.enabled) === 1).length} 个启用`, state.data.groups.length ? 'ok' : 'warn'],
    ['◇', '模型映射', `${state.data.models.filter(item => num(item.enabled) === 1).length} 条规则`, state.data.models.length ? 'ok' : 'warn']
  ].map(([icon, label, value, tone]) => `<div class="resource-item"><div class="resource-label"><span class="resource-icon">${icon}</span>${label}</div><span class="resource-value ${tone === 'warn' ? 'resource-warn' : ''}">${value}</span></div>`).join('')
}

function renderKeys() {
  const query = state.filters.keys.trim().toLowerCase()
  const items = state.data.keys.filter(item => `${item.name || ''} ${item.enabled ? '启用' : '停用'}`.toLowerCase().includes(query))
  $('keys-count').textContent = `${items.length} / ${state.data.keys.length} 个密钥`
  $('keys-list').innerHTML = items.length ? `<table class="data-table"><thead><tr><th>名称</th><th>状态</th><th>余额 / 配额</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${items.map(item => `<tr><td><span class="cell-main">${esc(item.name || '未命名 Key')}</span><div class="cell-sub">ID #${item.id}</div></td><td><button class="toggle ${num(item.enabled) ? 'on' : ''}" data-action="toggle-key" data-id="${item.id}" aria-label="切换密钥状态"></button></td><td><span class="cell-main">${num(item.balance).toFixed(2)}</span><div class="cell-sub">配额 ${num(item.quota_limit) > 0 ? num(item.quota_limit).toFixed(2) : '不限'}</div></td><td>${formatDate(item.created_at)}</td><td><div class="actions"><button class="action-btn danger" data-action="delete-key" data-id="${item.id}" type="button">删除</button></div></td></tr>`).join('')}</tbody></table>` : emptyState('暂无 API Key', '点击右上角按钮创建一个供客户端使用的密钥。')
}

function renderUsage() {
  const query = state.filters.usage.trim().toLowerCase()
  const items = state.data.usage.filter(item => `${item.model || ''} ${item.provider || ''} ${item.status || ''}`.toLowerCase().includes(query))
  $('usage-count').textContent = `${items.length} 条记录`
  $('usage-list').innerHTML = items.length ? `<table class="data-table"><thead><tr><th>模型</th><th>服务商</th><th>Token</th><th>费用</th><th>状态</th><th>耗时</th><th>时间</th></tr></thead><tbody>${items.map(item => `<tr><td><span class="cell-main">${esc(item.model || '-')}</span></td><td><span class="provider-pill">${esc(providerLabel(item.provider))}</span></td><td>${formatNumber(item.total_tokens)}</td><td>$${num(item.cost).toFixed(4)}</td><td>${statusPill(num(item.status, 500) < 400, String(item.status || '200'), String(item.status || '失败'))}</td><td>${num(item.latency_ms) ? `${formatNumber(item.latency_ms)} ms` : '-'}</td><td>${formatDate(item.created_at)}</td></tr>`).join('')}</tbody></table>` : emptyState('暂无用量记录', '网关收到请求后会自动记录用量。')
}

function renderGroups() {
  const items = state.data.groups
  $('groups-list').innerHTML = items.length ? `<table class="data-table"><thead><tr><th>分组</th><th>状态</th><th>优先级</th><th>故障阈值</th><th>窗口</th><th>操作</th></tr></thead><tbody>${items.map(item => `<tr><td><span class="cell-main">${esc(item.name)}</span><div class="cell-sub">${esc(item.description || '未填写描述')}</div></td><td>${statusPill(num(item.enabled) === 1)}</td><td>${formatNumber(item.priority)}</td><td>${num(item.error_threshold, .5)} / ${formatNumber(item.error_count_threshold || 5)}</td><td>${formatNumber(item.window_seconds || 300)} 秒</td><td><div class="actions"><button class="action-btn" data-action="edit-group" data-id="${item.id}" type="button">编辑</button><button class="action-btn danger" data-action="delete-group" data-id="${item.id}" type="button">删除</button></div></td></tr>`).join('')}</tbody></table>` : emptyState('暂无分组', '先创建一个分组，再添加渠道和上游账号。')
}

function renderChannels() {
  const items = state.data.channels
  $('channels-list').innerHTML = items.length ? `<table class="data-table"><thead><tr><th>渠道</th><th>服务商</th><th>基础地址</th><th>状态</th><th>优先级</th><th>操作</th></tr></thead><tbody>${items.map(item => `<tr><td><span class="cell-main">${esc(item.name)}</span><div class="cell-sub">ID #${item.id}</div></td><td><span class="provider-pill">${esc(providerLabel(item.provider))}</span></td><td><span class="cell-sub">${esc(item.base_url || '使用服务商默认地址')}</span></td><td>${statusPill(num(item.enabled) === 1)}</td><td>${formatNumber(item.priority)}</td><td><div class="actions"><button class="action-btn" data-action="edit-channel" data-id="${item.id}" type="button">编辑</button><button class="action-btn danger" data-action="delete-channel" data-id="${item.id}" type="button">删除</button></div></td></tr>`).join('')}</tbody></table>` : emptyState('暂无渠道', '渠道用于定义服务商和请求入口。')
}

function renderAccounts() {
  const items = state.data.accounts
  $('accounts-list').innerHTML = items.length ? `<table class="data-table"><thead><tr><th>账号</th><th>服务商</th><th>分组 / 渠道</th><th>状态</th><th>错误率</th><th>操作</th></tr></thead><tbody>${items.map(item => `<tr><td><span class="cell-main">${esc(item.name)}</span><div class="cell-sub">ID #${item.id} · 优先级 ${formatNumber(item.priority)}</div></td><td><span class="provider-pill">${esc(providerLabel(item.provider))}</span></td><td><span class="cell-main">${esc(item.group_name || `分组 #${item.group_id}`)}</span><div class="cell-sub">${esc(item.channel_name || `渠道 #${item.channel_id}`)}</div></td><td>${statusPill(num(item.enabled) === 1)}</td><td>${num(item.error_rate) ? `${(num(item.error_rate) * 100).toFixed(1)}%` : '0%'}</td><td><div class="actions"><button class="action-btn" data-action="test-account" data-id="${item.id}" type="button">测试</button><button class="action-btn" data-action="edit-account" data-id="${item.id}" type="button">编辑</button><button class="action-btn danger" data-action="delete-account" data-id="${item.id}" type="button">删除</button></div></td></tr>`).join('')}</tbody></table>` : emptyState('暂无上游账号', '先配置分组和渠道，再添加上游服务商账号。')
}

function renderModels() {
  const items = state.data.models
  $('models-list').innerHTML = items.length ? `<table class="data-table"><thead><tr><th>客户端模型</th><th>上游模型</th><th>服务商</th><th>分组</th><th>状态</th><th>操作</th></tr></thead><tbody>${items.map(item => `<tr><td><span class="cell-main">${esc(item.requested_model)}</span></td><td><span class="cell-main">${esc(item.upstream_model)}</span></td><td><span class="provider-pill">${esc(providerLabel(item.provider))}</span></td><td>${esc(state.data.groups.find(group => group.id === item.group_id)?.name || `分组 #${item.group_id}`)}</td><td>${statusPill(num(item.enabled) === 1)}</td><td><div class="actions"><button class="action-btn" data-action="edit-model" data-id="${item.id}" type="button">编辑</button><button class="action-btn danger" data-action="delete-model" data-id="${item.id}" type="button">删除</button></div></td></tr>`).join('')}</tbody></table>` : emptyState('暂无模型映射', '没有映射时，网关会按模型名称自动选择服务商。')
}

function option(value, label, selected) { return `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>` }
function providerOptions(selected) { return ['openai', 'anthropic', 'xai'].map(value => option(value, providerLabel(value), selected)).join('') }
function groupOptions(selected, includeEmpty = false) {
  const first = includeEmpty ? option('', '请选择分组', '') : ''
  return first + state.data.groups.map(group => option(group.id, group.name, selected)).join('')
}
function channelOptions(selected) {
  return option('', '请选择渠道', '') + state.data.channels.map(channel => option(channel.id, `${channel.name} · ${providerLabel(channel.provider)}`, selected)).join('')
}
function field(label, input, full = false) { return `<div class="form-control ${full ? 'full' : ''}"><label class="field-label">${label}</label>${input}</div>` }
function input(name, value, placeholder = '', type = 'text', required = false) { return `<input class="field-input" name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''}>` }
function select(name, choices, value, required = false) { return `<select class="field-select" name="${name}" ${required ? 'required' : ''}>${choices}</select>` }
function checkbox(name, checked = true, label = '启用') { return `<label class="check-row"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span>${label}</span></label>` }

function openModal(title, subtitle, body, submitLabel, onSubmit, showSubmit = true) {
  $('modal-root').innerHTML = `<div class="modal-backdrop" data-close-modal><div class="modal-card" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><button class="icon-btn" type="button" data-close-modal aria-label="关闭">×</button></div>${body}${showSubmit ? `<div class="modal-foot"><button class="btn btn-ghost" type="button" data-close-modal>取消</button><button class="btn btn-primary" id="modal-submit" type="submit" form="modal-form">${esc(submitLabel)}</button></div>` : ''}</div></div>`
  if (!showSubmit) return
  const form = document.createElement('form')
  form.id = 'modal-form'
  form.innerHTML = body
  const card = $('modal-root').querySelector('.modal-card')
  const originalBody = card.querySelector('.modal-body')
  if (originalBody) originalBody.replaceWith(form)
  else { const foot = card.querySelector('.modal-foot'); card.insertBefore(form, foot) }
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const submit = $('modal-submit')
    submit.disabled = true
    submit.textContent = '保存中…'
    const errorNode = form.querySelector('.modal-error')
    if (errorNode) errorNode.textContent = ''
    try { await onSubmit(new FormData(form)); closeModal() } catch (error) { if (errorNode) errorNode.textContent = error.message; else showToast(error.message, 'error'); submit.disabled = false; submit.textContent = submitLabel }
  })
}

function closeModal() { $('modal-root').innerHTML = '' }
function modalBody(content, error = true) { return `<div class="modal-body">${content}${error ? '<p class="modal-error"></p>' : ''}</div>` }

function openSetupModal() {
  const body = modalBody(`<div class="form-grid">${field('管理员用户名', input('username', '', '例如 admin', 'text', true))}${field('登录密码', input('password', '', '至少 8 位', 'password', true))}${field('确认密码', input('confirm', '', '再次输入密码', 'password', true))}</div>`)
  openModal('初始化管理员', '首次部署时创建控制台管理员账号。不会预填或展示默认凭据。', body, '创建管理员', async form => {
    const values = Object.fromEntries(form.entries())
    if (values.password !== values.confirm) throw new Error('两次输入的密码不一致')
    await api('/auth/setup', { method: 'POST', body: { username: values.username, password: values.password } })
    $('login-username').value = values.username
    $('login-password').value = ''
    $('login-error').textContent = '初始化成功，请输入密码登录'
    showToast('管理员创建成功', 'success')
  })
}

function openKeyModal() {
  const body = modalBody(`<div class="form-grid">${field('Key 名称', input('name', '', '例如 production-app', 'text', true))}${field('额度上限', input('quota_limit', '0', '0 表示不限额', 'number'))}</div><p class="field-hint">额度按余额累计使用；设置为 0 表示不限制额度。</p>`)
  openModal('创建 API Key', '为客户端生成一个新的访问密钥。', body, '生成密钥', async form => {
    const values = Object.fromEntries(form.entries())
    const result = await api('/keys', { method: 'POST', body: { name: values.name, quota_limit: num(values.quota_limit) } })
    closeModal()
    showSecretModal(result?.data?.key || '')
    await loadPage('keys', true)
    showToast('API Key 已创建', 'success')
  })
}

function showSecretModal(secret) {
  $('modal-root').innerHTML = `<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true"><div class="modal-head"><div><h2>保存你的 API Key</h2><p>出于安全原因，完整密钥只会显示这一次。</p></div><button class="icon-btn" type="button" data-close-modal aria-label="关闭">×</button></div><div class="modal-body"><div class="secret-box"><code id="new-secret">${esc(secret)}</code><button class="copy-btn" type="button" data-action="copy-secret">复制</button></div><p class="field-hint">请将它放入客户端的 Authorization: Bearer 或 x-api-key 请求头中。</p></div><div class="modal-foot"><button class="btn btn-primary" type="button" data-close-modal>我已保存</button></div></div></div>`
}

function openGroupModal(group = null) {
  const body = modalBody(`<div class="form-grid">${field('分组名称', input('name', group?.name || '', '例如 default', 'text', true))}${field('优先级', input('priority', group?.priority ?? 0, '数字越小越优先', 'number'))}${field('描述', input('description', group?.description || '', '可选说明'), true)}${field('错误率阈值', input('error_threshold', group?.error_threshold ?? .5, '0 - 1', 'number'))}${field('错误次数阈值', input('error_count_threshold', group?.error_count_threshold ?? 5, '触发切换的次数', 'number'))}${field('统计窗口（秒）', input('window_seconds', group?.window_seconds ?? 300, '默认 300 秒', 'number'))}${field('状态', checkbox('enabled', group ? num(group.enabled) === 1 : true), true)}</div>`)
  openModal(group ? '编辑分组' : '新建分组', '配置账号调度和故障切换策略。', body, '保存分组', async form => {
    const values = Object.fromEntries(form.entries())
    const payload = { name: values.name, description: values.description, priority: num(values.priority), error_threshold: num(values.error_threshold, .5), error_count_threshold: num(values.error_count_threshold, 5), window_seconds: num(values.window_seconds, 300), enabled: values.enabled === 'on' ? 1 : 0 }
    await api(group ? `/groups/${group.id}` : '/groups', { method: group ? 'PUT' : 'POST', body: payload })
    await loadPage('groups', true); await loadDashboard(true); showToast(group ? '分组已更新' : '分组已创建', 'success')
  })
}

function openChannelModal(channel = null) {
  const body = modalBody(`<div class="form-grid">${field('渠道名称', input('name', channel?.name || '', '例如 OpenAI 主渠道', 'text', true))}${field('服务商', select('provider', providerOptions(channel?.provider || 'openai'), channel?.provider || 'openai', true))}${field('基础地址', input('base_url', channel?.base_url || '', '留空使用默认地址'), true)}${field('渠道 API Key', input('api_key', '', channel ? '留空则保持原值' : '可选，账号 API Key 优先', 'password'))}${field('优先级', input('priority', channel?.priority ?? 0, '数字越小越优先', 'number'))}${field('状态', checkbox('enabled', channel ? num(channel.enabled) === 1 : true))}</div>`)
  openModal(channel ? '编辑渠道' : '新建渠道', '渠道是服务商入口的基础配置。', body, '保存渠道', async form => {
    const values = Object.fromEntries(form.entries())
    const payload = { name: values.name, provider: values.provider, base_url: values.base_url, priority: num(values.priority), enabled: values.enabled === 'on' ? 1 : 0 }
    if (values.api_key) payload.api_key = values.api_key
    await api(channel ? `/channels/${channel.id}` : '/channels', { method: channel ? 'PUT' : 'POST', body: payload })
    await loadPage('channels', true); await loadDashboard(true); showToast(channel ? '渠道已更新' : '渠道已创建', 'success')
  })
}

function openAccountModal(account = null) {
  const hasDependencies = state.data.groups.length && state.data.channels.length
  const body = modalBody(`${!hasDependencies ? '<div class="notice-bar"><span class="notice-icon">!</span><span>请先创建至少一个分组和渠道，再添加上游账号。</span></div>' : ''}<div class="form-grid">${field('账号名称', input('name', account?.name || '', '例如 OpenAI 主账号', 'text', true))}${field('服务商', select('provider', providerOptions(account?.provider || 'openai'), account?.provider || 'openai', true))}${field('上游 API Key', input('api_key', '', account ? '留空则保持原值' : 'sk-…', 'password', !account))}${field('基础地址', input('base_url', account?.base_url || '', '留空使用服务商默认地址'))}${field('所属分组', select('group_id', groupOptions(account?.group_id, true), account?.group_id || '', true))}${field('所属渠道', select('channel_id', channelOptions(account?.channel_id), account?.channel_id || '', true))}${field('优先级', input('priority', account?.priority ?? 0, '数字越小越优先', 'number'))}${field('客户端伪装', input('client_spoofing', account?.client_spoofing || '', '可选，例如 claude-code'))}${field('状态', checkbox('enabled', account ? num(account.enabled) === 1 : true), true)}</div>`)
  openModal(account ? '编辑上游账号' : '添加上游账号', '上游密钥只保存在 D1 中，列表会自动脱敏。', body, '保存账号', async form => {
    const values = Object.fromEntries(form.entries())
    const payload = { name: values.name, provider: values.provider, base_url: values.base_url, group_id: num(values.group_id), channel_id: num(values.channel_id), priority: num(values.priority), client_spoofing: values.client_spoofing, enabled: values.enabled === 'on' ? 1 : 0 }
    if (values.api_key) payload.api_key = values.api_key
    if (!payload.group_id || !payload.channel_id) throw new Error('请选择分组和渠道')
    await api(account ? `/accounts/${account.id}` : '/accounts', { method: account ? 'PUT' : 'POST', body: payload })
    await loadPage('accounts', true); await loadDashboard(true); showToast(account ? '账号已更新' : '账号已添加', 'success')
  })
}

function openModelModal(model = null) {
  const body = modalBody(`<div class="form-grid">${field('客户端模型名', input('requested_model', model?.requested_model || '', '例如 gpt-4o', 'text', true))}${field('服务商', select('provider', providerOptions(model?.provider || 'openai'), model?.provider || 'openai', true))}${field('上游模型名', input('upstream_model', model?.upstream_model || '', '例如 gpt-4o-mini', 'text', true))}${field('目标分组', select('group_id', groupOptions(model?.group_id, true), model?.group_id || '', true))}${field('优先级', input('priority', model?.priority ?? 0, '数字越小越优先', 'number'))}${field('状态', checkbox('enabled', model ? num(model.enabled) === 1 : true))}</div>`)
  openModal(model ? '编辑模型映射' : '新建模型映射', '为客户端模型指定上游模型和调度分组。', body, '保存映射', async form => {
    const values = Object.fromEntries(form.entries())
    const payload = { requested_model: values.requested_model, provider: values.provider, upstream_model: values.upstream_model, group_id: num(values.group_id), priority: num(values.priority), enabled: values.enabled === 'on' ? 1 : 0 }
    if (!payload.group_id) throw new Error('请选择目标分组')
    await api(model ? `/models/${model.id}` : '/models', { method: model ? 'PUT' : 'POST', body: payload })
    await loadPage('models', true); await loadDashboard(true); showToast(model ? '映射已更新' : '映射已创建', 'success')
  })
}

async function confirmDelete(path, label, reloadPage) {
  if (!window.confirm(`确定删除${label}吗？此操作无法撤销。`)) return
  try { await api(path, { method: 'DELETE' }); await loadPage(reloadPage, true); await loadDashboard(true); showToast(`${label}已删除`, 'success') } catch (error) { showToast(error.message, 'error') }
}

document.addEventListener('click', async event => {
  const navigateButton = event.target.closest('[data-navigate]')
  if (navigateButton) { navigate(navigateButton.dataset.navigate); return }
  const closeButton = event.target.closest('[data-close-modal]')
  if (closeButton && (closeButton.classList.contains('modal-backdrop') || closeButton.tagName === 'BUTTON')) { closeModal(); return }
  const action = event.target.closest('[data-action]')
  if (!action) return
  const id = num(action.dataset.id)
  const item = key => state.data[key].find(entry => num(entry.id) === id)
  try {
    switch (action.dataset.action) {
      case 'copy-secret': await navigator.clipboard.writeText($('new-secret').textContent); action.textContent = '已复制'; showToast('API Key 已复制', 'success'); break
      case 'delete-key': await confirmDelete(`/keys/${id}`, 'API Key', 'keys'); break
      case 'toggle-key': { await api(`/keys/${id}`, { method: 'PUT', body: { enabled: action.classList.contains('on') ? 0 : 1 } }); await loadPage('keys', true); showToast('Key 状态已更新', 'success'); break }
      case 'edit-group': openGroupModal(item('groups')); break
      case 'delete-group': await confirmDelete(`/groups/${id}`, '分组', 'groups'); break
      case 'edit-channel': openChannelModal(item('channels')); break
      case 'delete-channel': await confirmDelete(`/channels/${id}`, '渠道', 'channels'); break
      case 'test-account': { action.disabled = true; action.textContent = '测试中'; const result = await api(`/accounts/${id}/test`, { method: 'POST' }); showToast(result?.success ? '连接测试成功' : (result?.message || '连接测试失败'), result?.success ? 'success' : 'error'); action.disabled = false; action.textContent = '测试'; break }
      case 'edit-account': openAccountModal(item('accounts')); break
      case 'delete-account': await confirmDelete(`/accounts/${id}`, '上游账号', 'accounts'); break
      case 'edit-model': openModelModal(item('models')); break
      case 'delete-model': await confirmDelete(`/models/${id}`, '模型映射', 'models'); break
    }
  } catch (error) { showToast(error.message, 'error'); if (action) { action.disabled = false; action.textContent = action.dataset.action === 'test-account' ? '测试' : action.textContent } }
})

document.querySelectorAll('.nav-item[data-page]').forEach(item => item.addEventListener('click', () => navigate(item.dataset.page)))
$('nav-logout').addEventListener('click', () => logout(true))
$('sidebar-open').addEventListener('click', () => { $('sidebar').classList.add('open'); $('page-app').classList.add('sidebar-visible') })
$('sidebar-close').addEventListener('click', () => { $('sidebar').classList.remove('open'); $('page-app').classList.remove('sidebar-visible') })
$('topbar-refresh').addEventListener('click', () => loadPage(state.page))
$('dashboard-refresh').addEventListener('click', () => loadDashboard())
$('btn-refresh-usage').addEventListener('click', () => loadPage('usage'))
$('btn-setup').addEventListener('click', openSetupModal)
$('btn-create-key').addEventListener('click', openKeyModal)
$('btn-create-group').addEventListener('click', () => openGroupModal())
$('btn-create-channel').addEventListener('click', () => openChannelModal())
$('btn-create-account').addEventListener('click', () => openAccountModal())
$('btn-create-model').addEventListener('click', () => openModelModal())
$('keys-search').addEventListener('input', event => { state.filters.keys = event.target.value; renderKeys() })
$('usage-search').addEventListener('input', event => { state.filters.usage = event.target.value; renderUsage() })

$('login-form').addEventListener('submit', async event => {
  event.preventDefault()
  const button = event.currentTarget.querySelector('button[type="submit"]')
  const message = $('login-error')
  message.textContent = ''
  button.disabled = true
  button.querySelector('span').textContent = '验证中…'
  try {
    const result = await login($('login-username').value.trim(), $('login-password').value)
    setLoggedIn(result.user, result.token)
    navigate('dashboard')
  } catch (error) { message.textContent = error.message || '登录失败，请检查用户名和密码' } finally { button.disabled = false; button.querySelector('span').textContent = '进入控制台' }
})

document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('modal-root').innerHTML) closeModal() })

if (state.token && state.user) {
  setLoggedIn(state.user, state.token)
  navigate('dashboard')
}
