# Sub2API - Cloudflare 一键部署版

## 简介

这是精简后的 Sub2API，可直接部署到 **Cloudflare Pages + Pages Functions**，无需服务器。

**核心功能：**
- API Key 分发与管理
- 分组 / 渠道 / 上游账号管理
- OpenAI / Claude / Grok 路由转发
- 错误率 + 错误数无感故障切换
- 客户端伪装（Codex / Claude Code / Grok CLI 等）

---

## 快速部署

### 方式一：Cloudflare Pages（推荐）

1. 在 Cloudflare Dashboard 创建 **D1 数据库**：`sub2api-db`
2. 创建 **KV 命名空间**：`sub2api-config-kv`
3. 记下两者的 ID，填入 `functions/wrangler.jsonc`
4. 把代码推送到 GitHub
5. 在 Cloudflare Pages 连接 GitHub 仓库，配置：
   - 构建命令：`cd frontend && npm install && npm run build`
   - 构建输出目录：`frontend/dist`
   - Functions 目录：`functions`
6. 部署后访问 `https://你的项目.pages.dev/login`
7. 使用 `admin` / `admin123` 登录

### 方式二：本地直接部署

```bash
# 1. 安装依赖并构建前端
cd frontend
npm install
npm run build

# 2. 部署到 Cloudflare Pages
cd ..
wrangler pages project publish frontend/dist
```

---

## 首次配置

登录后按顺序添加：

1. **分组**：OpenAI / Claude / Grok
2. **渠道**：各平台的 base_url + api_key
3. **账号**：关联分组和渠道，可填写客户端伪装
4. **模型映射**：如 `gpt-4o` → `gpt-4o-2024-08-06`
5. **API Key**：创建供终端使用的 Key

---

## 客户端配置

### OpenAI / Codex

```bash
export OPENAI_BASE_URL=https://你的项目.pages.dev/v1
export OPENAI_API_KEY=sk-user-你创建的key
```

### Claude Code

```bash
export ANTHROPIC_BASE_URL=https://你的项目.pages.dev
export ANTHROPIC_API_KEY=sk-user-你创建的key
```

### Grok

```bash
export XAI_BASE_URL=https://你的项目.pages.dev/v1
export XAI_API_KEY=sk-user-你创建的key
```

---

## 目录结构

```
.
├── frontend/                  # Vue3 前端
│   └── dist/                  # 构建输出
├── functions/                 # Cloudflare Pages Functions
│   ├── src/
│   │   ├── routes/            # 网关路由
│   │   ├── utils/             # 工具函数
│   │   ├── db.ts              # D1 数据库
│   │   ├── auth.ts            # 认证
│   │   ├── failover.ts        # 故障切换
│   │   └── billing.ts         # 计费
│   ├── schema.sql             # D1 数据库 schema
│   └── wrangler.jsonc         # Functions 配置
└── README.md
```

---

## 技术栈

- **前端**：Vue 3 + Vite + TailwindCSS + Pinia
- **后端**：Cloudflare Pages Functions（TypeScript）
- **数据库**：Cloudflare D1（SQLite）
- **缓存**：Cloudflare KV

---

## 环境变量

| 变量 | 说明 | 必须 |
|------|------|------|
| `VITE_API_BASE_URL` | 前端 API 地址 | ✅ |
| `ERROR_RATE_THRESHOLD` | 错误率阈值（默认 0.5） | ❌ |
| `ERROR_COUNT_THRESHOLD` | 错误数阈值（默认 5） | ❌ |
| `WINDOW_SECONDS` | 统计窗口（默认 300） | ❌ |

---

## License

MIT
