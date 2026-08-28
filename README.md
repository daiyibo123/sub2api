# Sub2API Cloudflare Gateway

一个运行在 Cloudflare Pages Functions + D1 上的多模型中转网关。提供 OpenAI、Anthropic、xAI 的统一入口，支持模型映射、分组/渠道/账号三层调度、错误率熔断、自动故障切换、用量统计和管理后台。

界面参考 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) 的设计语言（teal 主色 + slate 中性色、可折叠侧栏、玻璃态顶栏、卡片式统计），但实现是零依赖的原生 HTML/CSS/JS，不需要构建前端。

## 部署到 Cloudflare Pages

### 1. 创建资源

创建一个 Pages 项目和一个 D1 数据库（例如 `sub2api-db`）。

构建设置：

| 项目 | 值 |
| --- | --- |
| 构建命令 | `npm run build` |
| 构建输出目录 | `frontend` |
| 根目录 | 留空 |

**根目录必须留空**。本仓库的 `frontend` 和 `functions` 是同级目录；把根目录设为 `functions` 会让 Wrangler 把输出目录解析到仓库外，Cloudflare 会拒绝部署。

### 2. 绑定 D1

进入 **Settings → Functions → Bindings**，选择 **Production** 环境并绑定：

- D1：变量名必须是 `DB`
- KV（可选）：变量名 `CONFIG_KV`

不要配置 Functions 目录。Worker 在构建时生成到 `frontend/_worker.js`。

### 3. 部署并初始化

部署完成后直接访问站点。首次打开会显示初始化表单，填写管理员用户名和密码即可——**建表会自动完成，不需要预先执行 SQL**。

如果你更习惯命令行：

```bash
curl -X POST https://<your-domain>/api/v1/auth/setup \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"至少 8 位强密码"}'
```

初始化接口在管理员存在后自动关闭。

### 4. 设置 JWT_SECRET（建议）

```bash
npx wrangler pages secret put JWT_SECRET --project-name sub2api-gateway
```

不设置也能正常运行：首次需要签名时会生成一个 256 位随机密钥并存入 D1 的 `settings` 表，重启和多实例之间共享，登录态不会失效。显式配置 `JWT_SECRET` 的好处是可以随时轮换密钥（改环境变量即会使所有旧 token 失效）。

## 使用流程

登录后按顺序创建：**分组 → 渠道 → 上游账号 → 模型映射（可选）→ API Key**。

- **分组**决定调度优先级和熔断阈值（错误率、错误次数、统计窗口）。
- **渠道**定义服务商、请求地址和可选的默认密钥。
- **上游账号**是具体凭据。账号密钥留空会继承所属渠道的密钥，因此同一批 key 可以只填一次。
- **模型映射**把客户端模型名改写成上游模型名，并可指定目标分组。支持后缀通配符，例如 `gpt-4*`。
- **API Key** 供客户端使用，完整值只在创建时显示一次。

## 客户端地址

| 客户端 | 地址 | 认证 |
| --- | --- | --- |
| OpenAI / Codex | `https://<your-domain>/v1` | `Authorization: Bearer <key>` |
| Claude Code | `https://<your-domain>` | `x-api-key` 或 `Authorization: Bearer` |
| Grok | `https://<your-domain>/v1` | `Authorization: Bearer <key>` |

## 调度与故障切换

每次请求先校验账号、渠道、分组均已启用，并要求渠道服务商与账号服务商一致；不一致的账号永远不会被选中，因此后台在保存时就会拦截这种组合。

调度顺序：

1. 模型映射指定的分组优先；该分组没有可用账号时回退到同服务商的其他分组。
2. 依次比较分组优先级、渠道优先级、账号优先级（数值越小越优先）。
3. 读取 D1 `request_logs` 中统计窗口内的错误率和错误次数；达到分组阈值的账号会被暂时熔断跳过。
4. 条件相同时按最近使用时间分散请求。

上游返回 `408`、`425`、`429`、`5xx` 或发生网络错误时自动切换账号重试；`4xx` 客户端错误直接透传，不浪费重试次数。重试上限由 `MAX_SAME_ACCOUNT_RETRIES` 控制（限制在 1–5）。流式响应在切换账号后仍保持 SSE 格式。

## 本地开发

```bash
npm install
npm run dev
```

`npm run dev` 会打包 Worker 并启动 `wrangler pages dev`。本地 D1 数据是空的，首次访问同样会引导初始化。

## 测试

```bash
npm run typecheck      # TypeScript 检查
npm run test:ui        # 后台界面（jsdom，53 项）
npm run test:api       # 管理 API 契约（41 项，需先启动 dev）
npm run test:gateway   # 调度 / 故障切换 / 流式（36 项，需先启动 dev）
```

`test:api` 和 `test:gateway` 需要一个干净的本地数据库：

```bash
rm -rf .wrangler/state
npx wrangler pages dev frontend --port 8788 --d1 DB=sub2api-db --compatibility-flag=nodejs_compat
```

`test:gateway` 会在 9101–9103 端口启动假上游，覆盖优先级选择、错误熔断、跨分组回退、模型映射改写、SSE 流式转发、Anthropic 头部处理和客户端伪装。

## 配置变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | 自动生成并持久化 | 会话签名密钥 |
| `ERROR_RATE_THRESHOLD` | `0.5` | 全局错误率阈值，分组可覆盖 |
| `ERROR_COUNT_THRESHOLD` | `5` | 全局错误次数阈值，分组可覆盖 |
| `WINDOW_SECONDS` | `300` | 全局统计窗口，分组可覆盖 |
| `MAX_SAME_ACCOUNT_RETRIES` | `3` | 故障切换重试上限（1–5） |

## 目录

```text
frontend/              静态管理后台（index.html / styles.css / app.js）
frontend/_worker.js    构建产物，Pages 高级模式入口
functions/_worker.ts   Worker 源码入口与路由
functions/src/         认证、调度、代理、配置 API
functions/src/schema.ts 建表语句（首次运行自动执行）
functions/schema.sql   同等内容的 SQL 版本，供手动执行
tests/                 API / UI / 网关测试
wrangler.jsonc         本地开发配置
```

## License

MIT

使用前请阅读 [DISCLAIMER.md](DISCLAIMER.md)。
