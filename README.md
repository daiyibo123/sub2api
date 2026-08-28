# Sub2API Cloudflare Gateway

一个基于 Cloudflare Pages Functions、D1 和 KV 的多模型智能网关。它提供 OpenAI、Anthropic 和 xAI 的统一入口，支持模型映射、账号优先级、故障切换、用量记录和管理后台。

## 部署到 Cloudflare Pages

### 1. 创建资源

在 Cloudflare 创建一个 Pages 项目，以及一个 D1 数据库（例如 `sub2api-db`）。可选地创建 KV 命名空间（例如 `sub2api-config-kv`）。

在 Pages 项目设置中先确认 **Root directory（根目录）留空或填写 `/`**，不要填写 `functions`。本仓库的 `frontend` 和 `functions` 是同级目录；把根目录设为 `functions` 会让 Wrangler 将输出目录解析成仓库外的 `../frontend`，Cloudflare 会拒绝部署。

构建设置建议如下：

- 构建命令：`npm run build`（也可以留空，因为仓库已包含打包后的 `functions/_worker.js`）
- 构建输出目录：`frontend`
- Functions 目录：`functions`

在 Pages 项目的 Settings -> Functions -> Bindings 中绑定：

- D1：变量名必须是 `DB`
- KV：变量名 `CONFIG_KV`（当前版本可选）

### 2. 初始化数据库

```bash
npx wrangler d1 execute sub2api-db --remote --file=functions/schema.sql
```

### 3. 设置密钥

```bash
npx wrangler pages secret put JWT_SECRET --project-name sub2api-gateway
```

请使用随机生成的长字符串，不要使用仓库中的默认值。

### 4. 部署

```bash
npm install
npm run deploy
```

`npm run deploy` 会先将 `functions/_worker.ts` 打包成 Pages 可识别的 `functions/_worker.js` 和 `frontend/_worker.js`，然后上传 `frontend` 静态文件和 Functions。双入口兼容 Pages 的 Functions 部署和构建输出目录部署方式。

## 首次使用

数据库初始化后，先创建管理员：

```bash
curl -X POST https://<your-domain>/api/v1/auth/setup \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"请使用至少 8 位强密码"}'
```

然后访问站点登录，在管理后台依次创建分组、渠道和上游账号，最后创建供客户端使用的 API Key。初始化接口在存在管理员后会自动关闭。

## 客户端地址

OpenAI/Codex：`https://<your-domain>/v1`

Claude Code：`https://<your-domain>`（使用 `x-api-key` 或 `Authorization: Bearer`）

Grok：`https://<your-domain>/v1`

## 本地检查

```bash
npm run typecheck
npm run build:functions
```

本地 Pages 调试需要传入 D1 绑定，例如：

```bash
npx wrangler pages dev frontend --d1 DB=sub2api-db --compatibility-flag=nodejs_compat
```

## 配置变量

`ERROR_RATE_THRESHOLD`、`ERROR_COUNT_THRESHOLD` 和 `WINDOW_SECONDS` 控制故障切换窗口；`MAX_SAME_ACCOUNT_RETRIES` 控制单次请求的最大重试次数。它们已在 `wrangler.jsonc` 中提供合理默认值，可在 Pages 环境变量中覆盖。

## 目录

```text
frontend/              静态管理后台
functions/_worker.ts   Pages 高级 Functions 入口
functions/src/         API、认证、代理和故障切换逻辑
functions/schema.sql   D1 建表脚本
wrangler.jsonc         Pages 基础配置
```

## License

MIT

使用前请阅读 [DISCLAIMER.md](DISCLAIMER.md)。
