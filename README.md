# Sub2API Gateway (Cloudflare)

一个运行在 Cloudflare Pages Functions + D1 上的多模型中转网关。提供 OpenAI、Anthropic、xAI 的统一入口，支持分组/账号两层调度、倍率感知选号、错误率熔断、自动故障切换、上游测活、首字时间统计和管理后台。

前端是原生 HTML/CSS/JS，不打包任何运行时依赖；后端用 esbuild 打成单个 Worker 脚本。整站冷启动只需加载一个约 115 KB 的 bundle。

## 部署

1. **创建 D1 数据库**

   ```bash
   npx wrangler d1 create sub2api-db
   ```

   把返回的 `database_id` 填进 [wrangler.jsonc](wrangler.jsonc)。

2. **在 Pages 项目里绑定 D1**

   Settings → Functions → Bindings → 添加 D1，变量名必须是 `DB`。缺这个绑定所有接口都会报错。

3. **（建议）设置签名密钥**

   ```bash
   npx wrangler pages secret put JWT_SECRET --project-name sub2api-gateway
   ```

   不设也能跑：首次初始化时会生成一个随机密钥存进 D1，登录态可以跨重启保持。显式设置更稳妥——万一 D1 数据被清空，已签发的会话不会失效。

4. **部署**

   ```bash
   npm install
   npm run deploy
   ```

   或者直接推到 GitHub，由 Pages 自动构建。`frontend/_worker.js` 是提交进仓库的构建产物，Pages 直接取用，所以改完 TypeScript 记得 `npm run build` 再提交。

**不需要手动执行 `wrangler d1 execute`。** 建表语句在代码里（[functions/src/schema.ts](functions/src/schema.ts)），首次初始化管理员时自动创建，全部是 `IF NOT EXISTS` 的增量语句，对已有数据只增不改。

## 首次使用

打开站点，登录页会自动检测数据库未初始化，显示「初始化管理员」表单。

之后按顺序创建：**分组 → 上游账号 → 模型映射（可选）→ API Key**。

- **分组**是调度单元，决定优先级和熔断阈值（错误率、错误次数、统计窗口）。
- **上游账号**是具体凭据，自带服务商、请求地址、密钥、倍率和优先级，归属于一个分组。
- **模型映射**把客户端模型名改写成上游模型名，可选。支持末尾通配符（`gpt-4*`）。
- **API Key** 是客户端凭据，可以绑定到指定分组。

### 客户端接入

```
OpenAI 兼容：      POST https://<你的域名>/v1/chat/completions
Anthropic Messages：POST https://<你的域名>/v1/messages
```

密钥放进 `Authorization: Bearer <key>` 或 `x-api-key: <key>`。

## 调度逻辑

每次请求先筛掉不可用的账号：已停用的、分组已停用的、服务商与请求不匹配的、以及所属分组已熔断的。如果 API Key 绑定了分组，只有该分组下的账号进入候选——这是硬约束，绑定分组下没有可用账号时直接返回 503，不会跨组兜底。

候选账号按以下顺序排序，逐级比较：

1. 分组优先级（数值越小越优先）
2. 账号优先级
3. **计费倍率**（同优先级下倍率低的先用）
4. 窗口内错误率
5. 窗口内错误次数
6. 最近使用时间（越久未用越优先，用于均摊流量）
7. 账号 ID（保证结果稳定）

倍率只在同优先级时生效，优先级始终压过成本——运营上需要保留强制指定的能力。

> 这里和 sub2api 有意不同：sub2api 的调度是成本无关的，倍率只作为利润控制的准入开关（`U ≤ D × (1 - margin - buffer)`），从不参与排序。本项目按你的要求把倍率作为排序键，但放在优先级之后，避免破坏优先级语义。

### 故障切换

上游返回 `0`（连接失败）、`408`、`425`、`429` 或 `5xx` 时切到下一个账号，最多重试 `MAX_SAME_ACCOUNT_RETRIES` 次（默认 3，上限 5）。`4xx` 客户端错误直接透传，不重试——重试改不了请求本身的问题，只会浪费额度。

熔断按分组阈值统计：窗口内错误率或错误次数超限就临时跳过该账号。全部账号都不健康时，退化为选择「最不坏」的那个，而不是直接失败。

### 首字时间（TTFT）

流式响应的首字节时间记录在 `usage_records.ttft_ms`，使用记录页有独立的「首字」列。

测量不做缓冲：每个 chunk 先转发给客户端，再记时间戳。缓冲测量会抬高被测指标本身。用量统计从流结束回调里写入，不阻塞响应。

## 上游测活

- 单个账号：账号列表里点「测试」
- 批量：账号页右上角「批量测活」，并发 4 个，只测已启用的账号

探测请求走真实网关路径：Anthropic 发一个 `max_tokens: 1` 的 `/v1/messages`（不是所有套餐都开放 `GET /v1/models`，用它会把正常 key 误判成失效），其余服务商用 `GET /v1/models`。结果写回账号行，列表直接显示延迟和时间，不用每次翻页都重测。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `JWT_SECRET` | 自动生成 | 会话签名密钥 |
| `WINDOW_SECONDS` | 300 | 错误统计窗口 |
| `ERROR_RATE_THRESHOLD` | 0.5 | 熔断错误率阈值 |
| `ERROR_COUNT_THRESHOLD` | 5 | 熔断错误次数阈值 |
| `MAX_SAME_ACCOUNT_RETRIES` | 3 | 单次请求最大重试次数 |

分组可以单独覆盖前三项。

## 本地开发

```bash
npm install
npm run build
npx wrangler pages dev frontend --port 8788 --local \
  --d1 DB=sub2api-db --compatibility-flag=nodejs_compat \
  --persist-to .wrangler/devstate
```

## 测试

```bash
npm run typecheck      # tsc
npm run test:ui        # 49 项，jsdom 驱动真实 DOM
npm run test:api       # 37 项，配置面 CRUD 与校验
npm run test:gateway   # 36 项，调度/故障切换/流式（带假上游）
npm run test:features  # 32 项，倍率/测活/TTFT/密钥分组
```

后三个需要本地 dev server 在 8788 端口运行，并且数据库是干净的（它们会创建管理员）。`tests/upstream_stub.py` 是假的上游服务商，用来验证真实转发行为而不是 mock 断言。

`tests/migration.test.py` 验证旧版（含 channels 表）数据库的迁移，需要两阶段运行：停服务器时 seed，起服务器后验证。

## 从旧版升级

早期版本有独立的「渠道」层，账号必须挂在渠道下、可以留空密钥继承渠道密钥。渠道的 11 个字段全是 accounts 的子集，只提供默认值，却带来 500 多处耦合，因此已合并进账号。

**迁移是自动的**，首次登录时执行，只跑一次：

- 密钥为空的账号写入其渠道的密钥
- 地址为空的账号写入其渠道的地址
- 未单独设置倍率的账号继承渠道倍率
- **挂在已停用渠道下的账号会被停用** —— 原先这些账号被渠道屏蔽，去掉渠道层后如果不处理会突然开始接收流量

迁移失败时不写完成标记，下次请求重试，避免网关运行在半迁移的凭据上。`channel_id` 列保留但不再使用，不做表重建——为省一个整数字段去 copy-and-rename 有丢数据的风险，不值得。
