// Sub2API Gateway - Minimal Frontend
const API_BASE = '/api/v1'
let authToken = localStorage.getItem('auth_token')
let currentUser = JSON.parse(localStorage.getItem('auth_user') || 'null')

function $(id) { return document.getElementById(id) }
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'))
  document.querySelectorAll('.page-section').forEach(p => p.classList.add('hidden'))
  $(pageId).classList.remove('hidden')
}
function apiHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken }
}
async function apiGet(url) {
  const res = await fetch(API_BASE + url, { headers: apiHeaders() })
  if (res.status === 401) { logout(); return null }
  return res.json()
}
async function apiPost(url, body) {
  const res = await fetch(API_BASE + url, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) })
  if (res.status === 401) { logout(); return null }
  return res.json()
}
async function apiDelete(url) {
  const res = await fetch(API_BASE + url, { method: 'DELETE', headers: apiHeaders() })
  if (res.status === 401) { logout(); return null }
  return res.json()
}

function logout() {
  authToken = null
  currentUser = null
  localStorage.removeItem('auth_token')
  localStorage.removeItem('auth_user')
  location.reload()
}

async function login(username, password) {
  const res = await fetch(API_BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  const data = await res.json()
  if (res.ok && data.token) {
    authToken = data.token
    currentUser = data.user
    localStorage.setItem('auth_token', data.token)
    localStorage.setItem('auth_user', JSON.stringify(data.user))
    return true
  }
  return false
}

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page
    showPage('page-app')
    document.querySelectorAll('.page-section').forEach(p => p.classList.add('hidden'))
    const section = document.getElementById('page-' + page)
    if (section) section.classList.remove('hidden')
    loadPage(page)
  })
})
document.getElementById('nav-logout').addEventListener('click', logout)

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const username = document.getElementById('login-username').value
  const password = document.getElementById('login-password').value
  const ok = await login(username, password)
  if (ok) {
    showPage('page-app')
    document.querySelectorAll('.page-section').forEach(p => p.classList.add('hidden'))
    document.getElementById('page-dashboard').classList.remove('hidden')
    loadDashboard()
  } else {
    document.getElementById('login-error').textContent = '登录失败，请检查用户名和密码'
  }
})

async function loadPage(page) {
  if (page === 'dashboard') loadDashboard()
  else if (page === 'keys') loadKeys()
  else if (page === 'usage') loadUsage()
  else if (page === 'admin-groups') loadGroups()
  else if (page === 'admin-channels') loadChannels()
  else if (page === 'admin-accounts') loadAccounts()
}

async function loadDashboard() {
  const stats = await apiGet('/usage')
  const html = '<div class="stats-grid"><div class="stat-card"><h3>总请求数</h3><div class="value">' + (stats.data ? stats.data.length : 0) + '</div></div></div>'
  document.getElementById('dashboard-stats').innerHTML = html
}

async function loadKeys() {
  const data = await apiGet('/keys')
  const keys = data.data || []
  document.getElementById('keys-list').innerHTML = keys.length === 0 ? '<p>暂无 API Key</p>' : '<table><thead><tr><th>ID</th><th>名称</th><th>状态</th><th>余额</th><th>操作</th></tr></thead><tbody>' + keys.map(k => '<tr><td>' + k.id + '</td><td>' + (k.name || '-') + '</td><td>' + (k.enabled ? '启用' : '禁用') + '</td><td>' + k.balance + '</td><td><button class="danger" onclick="deleteKey(' + k.id + ')">删除</button></td></tr>').join('') + '</tbody></table>'
}

async function deleteKey(id) {
  if (!confirm('确定删除？')) return
  await apiDelete('/keys/' + id)
  loadKeys()
}

document.getElementById('btn-create-key').addEventListener('click', async () => {
  const name = prompt('API Key 名称：')
  if (!name) return
  await apiPost('/keys', { name })
  loadKeys()
})

async function loadUsage() {
  const data = await apiGet('/usage')
  const records = data.data || []
  document.getElementById('usage-list').innerHTML = records.length === 0 ? '<p>暂无使用记录</p>' : '<table><thead><tr><th>ID</th><th>模型</th><th>状态</th><th>时间</th></tr></thead><tbody>' + records.slice(0, 50).map(r => '<tr><td>' + r.id + '</td><td>' + r.model + '</td><td>' + r.status + '</td><td>' + new Date(r.created_at).toLocaleString() + '</td></tr>').join('') + '</tbody></table>'
}

async function loadGroups() {
  const data = await apiGet('/groups')
  const groups = data.data || data || []
  document.getElementById('groups-list').innerHTML = groups.length === 0 ? '<p>暂无分组</p>' : '<table><thead><tr><th>ID</th><th>名称</th><th>优先级</th><th>启用</th><th>操作</th></tr></thead><tbody>' + groups.map(g => '<tr><td>' + g.id + '</td><td>' + g.name + '</td><td>' + g.priority + '</td><td>' + (g.enabled ? '是' : '否') + '</td><td><button class="danger" onclick="deleteGroup(' + g.id + ')">删除</button></td></tr>').join('') + '</tbody></table>'
}

async function deleteGroup(id) {
  if (!confirm('确定删除？')) return
  await apiDelete('/groups/' + id)
  loadGroups()
}

document.getElementById('btn-create-group').addEventListener('click', async () => {
  const name = prompt('分组名称：')
  if (!name) return
  await apiPost('/groups', { name })
  loadGroups()
})

async function loadChannels() {
  const data = await apiGet('/channels')
  const channels = data.data || data || []
  document.getElementById('channels-list').innerHTML = channels.length === 0 ? '<p>暂无渠道</p>' : '<table><thead><tr><th>ID</th><th>名称</th><th>服务商</th><th>启用</th><th>操作</th></tr></thead><tbody>' + channels.map(c => '<tr><td>' + c.id + '</td><td>' + c.name + '</td><td>' + c.provider + '</td><td>' + (c.enabled ? '是' : '否') + '</td><td><button class="danger" onclick="deleteChannel(' + c.id + ')">删除</button></td></tr>').join('') + '</tbody></table>'
}

async function deleteChannel(id) {
  if (!confirm('确定删除？')) return
  await apiDelete('/channels/' + id)
  loadChannels()
}

document.getElementById('btn-create-channel').addEventListener('click', async () => {
  const name = prompt('渠道名称：')
  if (!name) return
  const provider = prompt('服务商（openai/anthropic/xai）：') || 'openai'
  await apiPost('/channels', { name, provider })
  loadChannels()
})

async function loadAccounts() {
  const data = await apiGet('/accounts')
  const accounts = data.data || data || []
  document.getElementById('accounts-list').innerHTML = accounts.length === 0 ? '<p>暂无账号</p>' : '<table><thead><tr><th>ID</th><th>名称</th><th>服务商</th><th>启用</th><th>操作</th></tr></thead><tbody>' + accounts.map(a => '<tr><td>' + a.id + '</td><td>' + a.name + '</td><td>' + a.provider + '</td><td>' + (a.enabled ? '是' : '否') + '</td><td><button class="danger" onclick="deleteAccount(' + a.id + ')">删除</button></td></tr>').join('') + '</tbody></table>'
}

async function deleteAccount(id) {
  if (!confirm('确定删除？')) return
  await apiDelete('/accounts/' + id)
  loadAccounts()
}

document.getElementById('btn-create-account').addEventListener('click', async () => {
  const name = prompt('账号名称：')
  if (!name) return
  const provider = prompt('服务商（openai/anthropic/xai）：') || 'openai'
  const apiKey = prompt('API Key：')
  if (!apiKey) return
  const groupId = parseInt(prompt('分组 ID：') || '0')
  const channelId = parseInt(prompt('渠道 ID：') || '0')
  await apiPost('/accounts', { name, provider, api_key: apiKey, group_id: groupId, channel_id: channelId })
  loadAccounts()
})

if (authToken) {
  showPage('page-app')
  document.querySelec
