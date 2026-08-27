# Cloudflare 部署指南（精简版）

## 前置条件
- Cloudflare 账号
- Node.js 18+ 和 pnpm/npm
- Wrangler CLI：`npm install -g wrangler`
- 已开通 Pages、D1

## 1. 创建 Cloudflare 资源

```bash
cd functions
wrangler d1 create sub2api-db
wrangler kv namespace create CONFIG_KV
```

把返回的 `database_id` 和 KV `id` 更新到 `functions/wrangler.jsonc`。

## 2. 构建前端

```bash
cd frontend
npm install
npm run build
```

## 3. 部署到 Cloudflare Pages

### 方式一：Dashboard
1. Cloudflare Dashboard → Pages → Create project
2. 连接 Git 或直接上传 `frontend/dist`
3. 构建命令：`npm run build`
4. 构建输出目录：`dist`
5. 环境变量：`VITE_API_BASE_URL=/api/v1`

### 方式二：Wrangler
```bash
cd frontend
wrangler pages project create sub2api-frontend
wrangler pages project publish dist --project-name sub2api-frontend
```

## 4. 绑定 Functions 依赖

在 Pages 项目设置 → Functions：
- D1 绑定：`DB` → `sub2api-db`
- KV 绑定：`CONFIG_KV` → 你的 KV id

## 5. 初始化系统

访问 `https://你的域名/setup` 创建管理员账号。

访问 `https://你的域名/api/v1/auth/setup` 也可以创建管理员：
```bash
curl -X POST https://你的域名/api/v1/auth/setup \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"你的密码"}'
```

## 6. 验证

- 前端：`https://你的域名/login`
- 网关：`https://你的域名/v1/chat/completions`
- Claude：`https://你的域名/v1/messages`
- 健康检查：`https://你的域名/health`

## 目录说明
- `functions/_worker.ts`：Pages Functions 统一入口
- `functions/wrangler.jsonc`：部署配置
- `functions/schema.sql`：D1 建表语句
- `frontend/dist`：前端构建输出