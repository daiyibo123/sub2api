# Sub2API Cloudflare Gateway

一个基于 Cloudflare Pages Functions、D1 和 KV 的多模型智能网关。它提供 OpenAI、Anthropic 和 xAI 的统一入口，支持模型映射、账号优先级、故障切换、用量记录和管理后台。

## 部署到 Cloudflare Pages

### 1. 创建资源

在 Cloudflare 创建一个 Pages 项目，以及一个 D1 数据库（例如 `sub2api-db`）。可选地创建 KV 命名空间（例如 `sub2api-config-kv`）。

在 Pages 项目设置中先确认 **Root directory（根目录）留空或填写 `/`**，不要填写 `functions`。本仓库的 `frontend` 和 `functions` 是同级目录；把根目录设为 `functions` 会让 Wrangler 将输出目录解析成仓库外的 `../frontend`，Cloudflare 会拒绝部署。

构建设置建议如下：

- 构建命令：`npm run build`
- 构建输出目录：`frontend`
- 根目录：留空

本仓库的 `wrangler.jsonc` 仅用于本地开发，不包含 `pages_build_output_dir`，因此生产环境绑定在 Pages 面板中配置。进入 **Settings -> Functions -> Bindings**，选择 **Production** 环境并绑定：

- D1：变量名必须是 `DB`
- KV：变量名 `CONFIG_KV`

不要把根目录设置为 `functions`，也不要配置 Functions 目录。Worker 已在构建时生成到 `frontend/_worker.js`。

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

`npm run deploy` 会先将 `functions/_worker.ts` 打包成 `frontend/_worker.js`，然后上传 `frontend` 静态文件。生产环境的 D1、KV 和密钥由 Pages 项目设置注入。

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

## 调度与故障切换

每次请求会先校验账号、渠道和分组均已启用，并要求渠道服务商与账号服务商一致。调度顺序为：

1. 模型映射指定的分组（如果该分组没有可用账号，则回退到同服务商的其他分组）。
2. 分组优先级、渠道优先级、账号优先级（数值越小越优先）。
3. D1 `request_logs` 中配置窗口内的错误率和错误次数；达到分组阈值的账号会暂时熔断。
4. 同等条件下按最近使用时间分散请求。

上游返回 `408`、`425`、`429` 或 `5xx`，以及网络超时等错误会自动切换账号重试。重试次数由 `MAX_SAME_ACCOUNT_RETRIES` 控制，范围会限制在 1 到 5 次。流式响应在切换账号后仍保持 SSE 格式。

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

`ERROR_RATE_THRESHOLD`、`ERROR_COUNT_THRESHOLD`、`WINDOW_SECONDS` 和 `MAX_SAME_ACCOUNT_RETRIES` 为可选运行时变量；未设置时使用代码内置默认值。

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
