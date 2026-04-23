# sub2api 最新增量对 metapi 的吸收清单 / 追踪文档

> **目标**：把 `sub2api` 在 `23def40bc5415c04ca3a05bb6d67a6ff1e4a3566..0b85a8da888b5390e022f35c4594ee2eb7779210` 这段更新里，**仍值得 metapi 吸收的增量**拆成一份可持续推进的仓库内真值源，避免后续实现时丢上下文、重复审查或把“不值得照搬”的业务系统误带进来。
>
> **范围说明**：本清单只记录“值得吸收和学习”的 9 个点，外加用户额外指定的 **`gpt-image-2 / OpenAI Images` 支持同步**。不包含整套 `sub2api` 的 auth identity / payment 业务系统照搬。
>
> **任务完成定义**：只有当本文档中的条目全部完成、每项都有对应小测试通过记录，并最终通过一轮：
>
> ```bash
> npm run typecheck
> npm run repo:drift-check
> npm run docs:build
> npm test
> ```
>
> 才能宣布这一轮“sub2api 增量吸收”真正完成。

---

## 1. 执行规则（必须遵守）

### 1.1 小步完成规则

后续每完成一个条目，必须立刻做这 4 件事：

1. 写/补对应的最小测试或定向验证。
2. 运行该条目的小测试。
3. 只有小测试通过，才把该条目标记为完成。
4. 立即回写本文档中的状态、涉及文件、测试命令与结果。

### 1.2 范围控制规则

本轮**只吸收以下两类东西**：

1. `metapi` 代理核心仍缺的稳态护栏与兼容能力。
2. 可以抽象迁移的工程模式（例如 remediation report、最小 non-secret snapshot、keyed lease/CAS）。

本轮**明确不做**：

- 照搬 `sub2api` 的用户身份系统：
  - `auth_identities`
  - `auth_identity_channels`
  - `identity_adoption_decisions`
  - `pending_auth_sessions`
- 照搬 `sub2api` 的支付系统：
  - payment routing / webhook / refund / provider snapshot 业务链路
- 原样复制 `sub2api` 的 scheduler cache 数据结构

### 1.3 文档更新规则

之后每次推进，都必须同步更新本文档：

- 状态：`未开始 / 进行中 / 已完成 / 已完成但待最终回归确认`
- 当前已完成内容
- 涉及文件
- 小测试命令
- 小测试结果
- 剩余风险 / 后续依赖

---

## 2. 当前已确认事实（2026-04-23）

### 2.1 本次已完成的只读审查结论

已对以下范围做只读审查：

- `sub2api`：`23def40bc5415c04ca3a05bb6d67a6ff1e4a3566..0b85a8da888b5390e022f35c4594ee2eb7779210`
- `metapi` 当前本地仓库：`/home/hermesops/workspace/metapi-repo`

并行审查后，确认：

1. `metapi` 已经吸收了大量早期 `sub2api` 思路：
   - messages / responses / gateway 主链兼容
   - `previous_response_id + session` continuity
   - runtime-state / Proxy Ops / typed suppression
   - refresh 治理 / tokenRouter 稳态
2. 这轮真正还值得补的，不是重造大系统，而是：
   - **body size / image size / cache invalidation / runtime-state export 一致性** 这类护栏
   - **content-based continuity fallback / codex 硬编码清理** 这类兼容增强
   - **remediation report / minimal snapshot / keyed lease-CAS** 这类工程模式
3. `gpt-image-2 / OpenAI Images` 在 `sub2api` 本轮有明确增强，`metapi` 当前虽然已支持 `/v1/images/generations` 和 `/v1/images/edits`，但：
   - 默认模型仍是 `gpt-image-1`
   - 测试/定价现状仍偏 `gpt-image-1`
   - 还没有把 `sub2api` 那种图片专属边界控制和模型/定价同步完整吸收过来

### 2.2 关键证据（当前现状）

#### sub2api 侧

- `backend/internal/service/openai_images.go`
  - 默认模型已是 `gpt-image-2`
  - 对图片请求做 JSON / multipart 区分解析
  - 有图片下载 / multipart part 的大小上限
- `backend/internal/service/pricing_service.go`
  - 已把 `gpt-image-2` 纳入图片模型定价候选
- `backend/internal/pkg/openai/constants.go`
  - 已含 `gpt-image-2`
- `backend/internal/service/upstream_response_limit.go`
  - 已抽统一上游响应体读取上限与 too-large 错误处理

#### metapi 侧

- `src/server/routes/proxy/images.ts`
  - 已支持 `/v1/images/generations` 与 `/v1/images/edits`
  - 但默认模型仍是 `gpt-image-1`
- `src/server/services/modelPricingService.ts`
  - 当前测试只显式覆盖 `gpt-image-1`
- `src/server/proxy-core/executors/types.ts`
  - 当前统一 whole-body 读取路径还缺明确字节上限护栏
- `src/server/services/responsesContinuityStore.ts`
- `src/server/services/accountDispatchRuntimeMemory.ts`
- `src/server/services/upstreamEndpointRuntimeMemory.ts`
- `src/server/services/tokenRouter.ts`
  - 都已有 debounce + persistence，但 backup/export/migrate 前尚未统一 flush

---

## 3. 当前总状态（2026-04-23）

- P0：**已完成**
- P1：**已完成**
- P2：**已完成**
- 当前下一步：**推送 main → 等 CI 通过 → 更新镜像并重启容器**

---

## 4. P0：必须优先闭环的直接收益项

## P0-1 统一上游响应体读取大小上限与 too-large 错误
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 给 `metapi` 当前整包读取上游响应体的公共路径补统一字节上限
  - 对超限响应返回明确、可观测的 too-large 错误，而不是继续无上限 `text()` / `arrayBuffer()`
- 当前为什么值得做：
  - `sub2api` 已在 `upstream_response_limit.go` 完成统一护栏
  - `metapi` 当前仍有多处 whole-body 读取路径
- 本轮落地：
  - 在 `src/server/proxy-core/executors/types.ts` 增加统一默认上限（`2 MiB`）的 bounded reader、`Upstream response too large` 错误语义和 `materializeErrorResponse` 兜底
  - 在 `src/server/routes/proxy/upstreamResponseBody.ts` 抽 route 侧共享读取 helper，避免各路由继续裸调 `response.text()`
  - 已把 `images.ts`、`completions.ts`、`embeddings.ts`、`search.ts`、`videos.ts`、`endpointFlow.ts` 接到统一限额路径
  - 新增 / 更新回归覆盖：`types.test.ts`、`endpointFlow.test.ts`、`search.test.ts`、`images.edits.test.ts`
- 小测试命令（已通过）：
  ```bash
  npm run typecheck
  npx vitest run src/server/proxy-core/executors/types.test.ts src/server/routes/proxy/*.test.ts
  ```
- 完成标准：
  - 整包读取路径不再默认无上限
  - 超限有明确错误语义与回归测试

## P0-2 图片链路专属边界控制（multipart part / download bound)
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 给 `/v1/images/generations`、`/v1/images/edits` 增加图片专属的体积护栏
  - 不只依赖全局 `bodyLimit`
- 当前为什么值得做：
  - `sub2api` 已为图片下载与 multipart part 加 `LimitReader`
  - `metapi` 当前更偏“全局限制 + 直接 parse/透传”
- 本轮落地：
  - 在 `src/server/routes/proxy/multipart.ts` 增加显式 multipart 文件 part 上限错误 `MultipartFilePartTooLargeError`
  - 在 `src/server/routes/proxy/images.ts` 的 `/v1/images/edits` 入口对 `image` / `mask` part 做 20 MiB 专属拦截，bodyLimit 放大时也会直接返回 400
  - 新增回归：`src/server/routes/proxy/images.edits.test.ts`
  - 说明：metapi 当前没有独立的图片下载后处理链路，本轮只对现有 multipart 图片上传入口落地专属边界；后续若引入下载接入再补下载上限
- 小测试命令（已通过）：
  ```bash
  npm run typecheck
  npx vitest run src/server/routes/proxy/*.test.ts
  ```
- 完成标准：
  - 图片上传 / 编辑 / 上游图片读取路径具备单独边界控制
  - 大 payload / 异常 payload 有回归测试

## P0-3 backup / export / migrate 前统一 flush runtime-state
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 在 backup/export/migrate 前，把 debounce 持久化的 runtime-state 统一刷盘
  - 避免导出/迁移时拿到旧状态
- 本轮落地：
  - 新增 `src/server/services/runtimeStateMaintenance.ts`，聚合 account dispatch / responses continuity(sticky) / upstream endpoint runtime / site runtime health 的统一 flush 与 reset 能力
  - `src/server/services/backupService.ts` 在 `exportBackup()` 与 `importBackup()` 前统一 `flushAllRuntimeStatePersistence()`
  - `importBackup()` 完成后统一 `resetAllRuntimeStateCaches()`，并对账号导入场景按 site 维度做最小 warm，避免旧内存态继续漏活
  - `src/server/services/databaseMigrationService.ts` 在 `migrateCurrentDatabase()` 做 live snapshot 前先统一 flush runtime-state
  - 修回并补齐 `backupService.test.ts`，覆盖“导出/导入前 flush，导入后 reset”回归
- 重点文件：
  - `src/server/services/runtimeStateMaintenance.ts`
  - `src/server/services/backupService.ts`
  - `src/server/services/databaseMigrationService.ts`
  - `src/server/services/backupService.test.ts`
  - `src/server/services/databaseMigrationService.test.ts`
- 小测试命令（已通过）：
  ```bash
  npm run typecheck
  npx vitest run src/server/services/backupService.test.ts src/server/services/databaseMigrationService.test.ts
  ```
- 完成标准：
  - backup/export/migrate 前有统一 flush 入口
  - 导入后不会继续沿用旧 runtime cache

## P0-4 settings / import 后补齐 routing cache / snapshot / affinity invalidation
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 让运行时设置更新、backup import 后，对路由结果有影响的配置都能触发正确失效
- 本轮落地：
  - 在 `src/server/routes/api/settings.ts` 新增统一 `invalidateRoutingDerivedRuntimeState(...)`
  - 当 `routing_weights / routing_fallback_unit_cost / payload_rules / downstream_rate_limit` 更新时，统一清掉 token-router cache 并清空 `route decision snapshot`
  - 当 `channel_affinity` 更新或导入时，统一 `resetChannelAffinityState()`，防止旧 binding 继续命中
  - 补上 imported `system_proxy_url` 热应用时的 `invalidateSiteProxyCache()`，避免 backup import 后仍沿用旧系统代理解析结果
  - 让普通 backup import 与 WebDAV import 都在热应用设置后执行同口径 invalidation
  - `settings.events.test.ts` 新增/补强回归：既验证 direct runtime settings，也验证 backup import 会清 route snapshot 与 affinity binding
- 重点文件：
  - `src/server/routes/api/settings.ts`
  - `src/server/services/channelAffinity.ts`
  - `src/server/services/routeDecisionSnapshotStore.ts`
  - `src/server/services/tokenRouter.ts`
  - `src/server/routes/api/settings.events.test.ts`
- 小测试命令（已通过）：
  ```bash
  npm run typecheck
  npx vitest run src/server/routes/api/settings.events.test.ts src/server/services/tokenRouter.cache.test.ts src/server/services/channelAffinity.test.ts
  ```
- 完成标准：
  - `routingWeights / payloadRules / downstreamRateLimit / channelAffinity` 等变化后，不再让旧 cache / snapshot 漏活

## P0-5 同步 `gpt-image-2 / OpenAI Images` 支持到 metapi
- 状态：**已完成**
- 任务标记：`[x]`
- 当前判断：**已吸收当前 P0 范围内最值主线**
- 本轮落地：
  1. `src/server/routes/proxy/images.ts` 将 `/v1/images/generations` 与 `/v1/images/edits` 的默认模型从 `gpt-image-1` 切到 `gpt-image-2`
  2. `src/server/routes/proxy/images.edits.test.ts` 已有默认模型回归，按真实 `selectChannel(model, policy)` 签名修正断言并跑绿
  3. `src/server/services/modelPricingService.test.ts` 已覆盖 `gpt-image-2` 的按次计费语义，确认图片主线默认模型与定价测试口径一致
  4. 本轮只读复核后未发现还存在必须先改的 `supportedEndpointTypes` / 兼容层硬编码阻塞点；当前 P0 收口先以默认模型与测试一致性为主
- 重点文件：
  - `src/server/routes/proxy/images.ts`
  - `src/server/routes/proxy/images.edits.test.ts`
  - `src/server/services/modelPricingService.test.ts`
- 小测试命令（已通过）：
  ```bash
  npm run typecheck
  npx vitest run src/server/routes/proxy/images.edits.test.ts src/server/services/modelPricingService.test.ts
  ```
- 完成标准：
  - `gpt-image-2` 在 `metapi` 中有明确默认路由策略与测试支撑
  - 不只是“能透传字符串”，而是图片主线默认口径已同步

---

## 5. P1：兼容与连续性增强项

## P1-1 content-based continuity fallback
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 当客户端没给 `session_id` / `conversation_id` / `previous_response_id` 时，给 continuity/sticky 提供内容种子兜底
- 本轮落地：
  - 在 `src/server/proxy-core/providers/headerUtils.ts` 新增 `buildContentContinuitySeed(...)`，用 `requestedModel + downstreamPath + canonical body` 生成脱敏后的稳定内容种子，避免直接存原始请求内容
  - 在 `src/server/proxy-core/surfaces/openAiResponsesSurface.ts` 中，把该内容种子接到 **内部 continuity/sticky/store key** 上：
    - 无显式 session / previous_response_id 时，可用内容种子生成 continuity session id
    - 该 continuity session id 参与 `stickySessionKey` 与 `trustedResponsesSessionStoreKey`
    - 从而让 repeated same-content 无 session 请求也能命中既有 sticky channel / continuity store
  - 同时明确把 **内部 continuity key** 与 **对上游发送的 codex session header / queue / lease 语义** 解耦：
    - 无显式 downstream session 时，不再把内容种子派生 key 传给 `codexSessionCacheKey`
    - 无显式 downstream session 时，不再进入 `runCodexHttpSessionTask(...)`
    - 无显式 downstream session 时，不再让 `acquireSurfaceChannelLease(...)` 因 synthetic sticky key 触发会话级 channel 排队
  - 这样保住了 P1-1 需要的“无 session 也能 sticky/continuity”能力，同时不再误伤旧行为：
    - 不会把内部 content seed 泄漏成上游 `Conversation_id`
    - 不会把无 session 请求错误地串行化
    - 不会误改 `prompt_cache_key` 等现有 codex 请求语义
  - 更新定向回归：`src/server/routes/proxy/responses.codex-oauth.test.ts`、`src/server/services/proxyChannelCoordinator.test.ts`
- 重点文件：
  - `src/server/proxy-core/providers/headerUtils.ts`
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - `src/server/services/responsesContinuityStore.ts`
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/routes/proxy/responses.codex-oauth.test.ts`
  - `src/server/services/proxyChannelCoordinator.test.ts`
- 小测试命令（已通过）：
  ```bash
  npm run typecheck
  npx vitest run src/server/routes/proxy/responses.codex-oauth.test.ts src/server/services/proxyChannelCoordinator.test.ts src/server/proxy-core/providers/headerUtils.test.ts src/server/proxy-core/cliProfiles/registry.test.ts
  ```
- 完成标准：
  - 没显式 session 时也能稳定生成 continuity seed
  - 不误伤现有 `previous_response_id + session` 主链
  - 不把 synthetic continuity 误接成 upstream `Conversation_id` / session queue / lease queue

## P1-2 清理旧 Codex 硬编码模型名 / fallback 假设
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 清查并清理 `metapi` 内仍残留的过时 Codex 默认模型 / probe 模型 / fixture
- 本轮落地：
  - `src/server/services/oauth/quota.ts` 的 Codex quota probe 默认模型从旧 `gpt-5.1-codex` 切到当前仓内主线 `gpt-5.2-codex`
  - `src/server/services/oauth/quota.test.ts` 增加显式回归，锁定 probe model 不再回退到旧 Codex 代际
  - `src/server/services/modelService.discovery.test.ts` 清理 discovery fixture 中过时的 `gpt-5.1-codex* / gpt-5-codex*` 假设，只保留当前测试主线 `gpt-5.2-codex / gpt-5.3-codex / gpt-5.4`
  - 定向复查 `responses.codex-oauth.test.ts` 后确认其已使用 `gpt-5.2-codex`，本轮无需再改
  - 全仓 `src/server` 复搜后已无 `gpt-5.1-codex / gpt-5-codex / gpt-5.1-codex-mini / gpt-5-codex-mini / gpt-5.1-codex-max` 残留
- 重点文件：
  - `src/server/services/oauth/quota.ts`
  - `src/server/services/oauth/quota.test.ts`
  - `src/server/services/modelService.discovery.test.ts`
  - `src/server/routes/proxy/responses.codex-oauth.test.ts`
- 小测试命令（已通过）：
  ```bash
  npm run typecheck
  npx vitest run src/server/services/oauth/quota.test.ts src/server/services/modelService.discovery.test.ts src/server/routes/proxy/responses.codex-oauth.test.ts
  ```
- 完成标准：
  - 仓内不再默认依赖已下线旧 Codex 模型名
  - 新旧兼容逻辑有回归测试

---

## 6. P2：工程模式吸收项

## P2-1 迁移 / backfill 的 remediation report 模式
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 对有歧义/有损的 compat migration，不再“静默修完就算”，而是输出 remediation report
- 本轮落地：
  - `src/server/services/backupService.ts`：`importBackup()` 新增结构化 `remediationReport`，覆盖 legacy ignored sections、跳过的 ALL-API-Hub 账号/凭据、以及导入时排除的 runtime DB settings
  - `src/server/services/databaseMigrationService.ts`：`migrateCurrentDatabase()` summary 新增 `remediationReport`，显式带出迁移时被排除的 `db_type` / `db_url` / `db_ssl`
  - `src/server/db/migrate.ts`：为 SQLite bootstrap / backfill / duplicate-column recovery / duplicate-site dedupe 增加最小结构化 remediation state，并暴露测试可读 getter/reset，避免这类启动期 compat repair 只能靠 console 文本
- 重点文件：
  - `src/server/db/migrate.ts`
  - `src/server/services/databaseMigrationService.ts`
  - `src/server/services/backupService.ts`
- 小测试命令（已通过）：
  ```bash
  npm run typecheck
  npx vitest run src/server/services/backupService.test.ts src/server/services/databaseMigrationService.test.ts src/server/db/migrate.test.ts
  ```
- 完成标准：
  - 模糊迁移场景可审计，不再全靠静默自动修复
  - import / migration / bootstrap backfill 三条最小主路径都有结构化 remediation 输出或状态

## P2-2 最小 non-secret snapshot 模式
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 异步任务 / snapshot 存储只保留后续验证必需字段，不落 secret dump
- 本轮落地：
  - 新增 `src/server/services/nonSecretSnapshot.ts`，统一对 snapshot 做递归脱敏：命中 `authorization / apiKey / token / secret / cookie / password / session` 等敏感键时，统一写成 `[redacted]`
  - `src/server/services/proxyVideoTaskStore.ts` 在写入任务状态快照前统一走 `sanitizeNonSecretSnapshot(...)`，避免上游任务元数据把凭据/会话直接落库
  - `src/server/services/routeDecisionSnapshotStore.ts` 在保存 route decision snapshot 前统一脱敏，避免调试字段或候选项把 token / authorization 混进 `decision_snapshot`
  - `src/server/services/proxyOpsRuntimeStateService.ts` 输出运维态时继续坚持“最小必要信息”：
    - continuity 的 session anchor / sticky key 只暴露 hash handle
    - suppression entries 不再暴露原始 runtime key
    - 快照 JSON 内不出现原始 session / response id / token 值
- 重点文件：
  - `src/server/services/nonSecretSnapshot.ts`
  - `src/server/services/proxyVideoTaskStore.ts`
  - `src/server/services/proxyVideoTaskStore.test.ts`
  - `src/server/services/routeDecisionSnapshotStore.ts`
  - `src/server/services/routeDecisionSnapshotStore.test.ts`
  - `src/server/services/proxyOpsRuntimeStateService.ts`
  - `src/server/services/proxyOpsRuntimeStateService.test.ts`
- 小测试命令（已通过）：
  ```bash
  npm run typecheck
  npx vitest run src/server/services/proxyVideoTaskStore.test.ts src/server/services/routeDecisionSnapshotStore.test.ts src/server/services/proxyOpsRuntimeStateService.test.ts
  ```
- 完成标准：
  - snapshot 有明确最小化与脱敏边界
  - 不再把不必要的 token/secret 放进异步状态存储

## P2-3 keyed lease / CAS 用到高价值后台任务
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 把当前仍偏进程内锁的高价值后台任务，收敛到更稳的 keyed lease / CAS 语义
- 本轮落地：
  - `src/server/services/oauth/refreshSingleflight.ts` 已作为现成样板保留：对账号刷新 runtime 做 owner-aware lease、CAS 更新与远端成功观察，避免只靠进程内 `Map`
  - 本轮新增把 `src/server/services/modelAvailabilityProbeService.ts` 从进程内 `Set<number>` probe lease 收敛到 account `extraConfig.modelAvailabilityProbeRuntime.lease`
  - probe lease 现在具备：
    - `ownerId`
    - `startedAt`
    - `expiresAt`
    - 基于 `mergeAccountExtraConfigWithRetry(...)` 的 compare-and-swap 获取/释放
  - 因而同账号 probe 的并发互斥不再只在单进程内生效；即便遇到旧 lease，也能按 `expiresAt` 接管过期租约，避免崩溃后永久卡死
- 重点文件：
  - `src/server/services/modelAvailabilityProbeService.ts`
  - `src/server/services/modelAvailabilityProbeService.test.ts`
  - `src/server/services/oauth/refreshSingleflight.ts`
  - `src/server/services/oauth/refreshSingleflight.test.ts`
- 小测试命令（已通过）：
  ```bash
  npm run typecheck
  npx vitest run src/server/services/modelAvailabilityProbeService.test.ts src/server/services/oauth/refreshSingleflight.test.ts
  ```
- 完成标准：
  - 至少关键 probe / 调度路径不再只靠单进程 Set/Map 防重

## P2-4 统一 routing/runtime epoch（可选增强）
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 给 route decision snapshot / affinity / continuity / tokenRouter cache 一层统一 epoch / digest，方便判断不同 runtime cache 是否仍处于同一代状态
- 本轮落地：
  - `src/server/services/channelAffinity.ts` 新增 `getChannelAffinityEpochState()`，输出 binding 数、mutation version、lastUpdatedAtMs
  - `src/server/services/responsesContinuityStore.ts` 新增 `getResponsesContinuityEpochState()`，输出 session/sticky 数量、mutation version、loadedAtMs、dirty
  - `src/server/services/tokenRouter.ts` 新增 `getTokenRouterEpochState()`，并在 cache invalidate / runtime health 变化时 bump epoch
  - `src/server/services/routeDecisionSnapshotStore.ts` 新增 `getRouteDecisionSnapshotEpochState()`，输出 snapshot 数与最近刷新时间
  - 新增 `src/server/services/routingRuntimeEpochService.ts`，统一聚合以上 4 层状态并生成稳定 `digest`
- 重点文件：
  - `src/server/services/channelAffinity.ts`
  - `src/server/services/responsesContinuityStore.ts`
  - `src/server/services/tokenRouter.ts`
  - `src/server/services/routeDecisionSnapshotStore.ts`
  - `src/server/services/routingRuntimeEpochService.ts`
  - `src/server/services/routingRuntimeEpochService.test.ts`
- 小测试命令（已通过）：
  ```bash
  npm run typecheck
  npx vitest run src/server/services/routingRuntimeEpochService.test.ts src/server/services/routeDecisionSnapshotStore.test.ts src/server/services/tokenRouter.cache.test.ts src/server/services/modelAvailabilityProbeService.test.ts src/server/services/oauth/refreshSingleflight.test.ts src/server/services/databaseMigrationService.test.ts src/server/services/backupService.test.ts
  ```
- 完成标准：
  - 排障时可以直接判断 route decision snapshot / affinity / continuity / tokenRouter cache 是否处于同一代 runtime 状态

---

## 7. 推进顺序建议

推荐按以下顺序推进：

1. **P0-1** 统一上游响应体读取上限
2. **P0-2** 图片链路专属边界控制
3. **P0-5** `gpt-image-2 / OpenAI Images` 同步
4. **P0-3** backup/export/migrate 前 flush runtime-state
5. **P0-4** settings/import 后 cache invalidation 补齐
6. **P1-2** 清理旧 Codex 硬编码模型名
7. **P1-1** content-based continuity fallback
8. **P2-1** remediation report 模式
9. **P2-2** 最小 non-secret snapshot
10. **P2-3** keyed lease / CAS
11. **P2-4** routing/runtime epoch（若仍需要）

---

## 8. 最终收口清单

在本文档所有条目打勾之前，不能宣布这轮任务完成。

最终收口必须至少通过：

```bash
npm run typecheck
npm run repo:drift-check
npm run docs:build
npm test
```

并补一轮：

- 与 `sub2api` 本次增量范围的最终差异复查
- correctness / regression / consistency 审查
- 文档回写：
  - 哪些点已吸收
  - 哪些点明确不吸收
  - 哪些点延期
  - `gpt-image-2` 最终是否已经完整纳入图片主线
