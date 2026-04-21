# sub2api 优点吸收与 metapi 稳态治理实施 / 追踪文档

> **目标**：把 `sub2api` 在请求兼容、错误分类、挑战/WAF 识别、refresh 治理、运行时健康治理、运营可观测性上的高价值优点尽量完整吸收到 `metapi`，并把整个推进过程写成可持续更新的仓库内文档，避免会话压缩后丢失进度。
>
> **任务完成定义**：只有当 **P0 / P1 / P2 全部条目完成**、每个条目都有对应的小测试通过记录、最后再完成一轮完整审查与全量回归测试且**没有引入新问题**，这个任务才算真正完成。

---

## 1. 执行规则（必须遵守）

### 1.1 小步完成规则

后续每完成一个条目，必须立刻做这 4 件事：

1. 写/补对应的最小测试或定向验证。
2. 运行该条目的小测试。
3. 只有小测试通过，才把该条目标记为完成。
4. 立即回写本文档中的状态、测试命令、结果与日期。

### 1.2 最终收口规则

**不能**在中途某几个点做完后就宣布任务完成。

只有当本文档中：
- P0 全部为 `[x]`
- P1 全部为 `[x]`
- P2 全部为 `[x]`

才允许进入最终收口，最终收口必须至少完成：

```bash
npm run typecheck
npm run repo:drift-check
npm test
npm run docs:build
```

并补一轮：
- 与 `sub2api` 的最终差异复查
- 代码审查（correctness / regression / consistency）
- 文档回写：最终结果、风险点、是否完全闭环

### 1.3 文档更新规则

之后每次推进，都必须同步更新本文档：
- 状态：`未开始 / 进行中 / 已完成 / 已完成但待最终回归确认`
- 完成内容
- 涉及文件
- 小测试命令
- 小测试结果
- 是否还存在后续依赖

---

## 2. 当前总状态（2026-04-21）

> 说明：以下状态基于当前仓库代码与最近一轮已通过的测试结果整理。

### 2.1 当前全量验证记录

最近一轮已完成并通过：

```bash
npm run typecheck
npm run repo:drift-check
npm run docs:build
npm test
```

结果（最近一次已记录通过）：
- `npm run typecheck` ✅
- `npm run repo:drift-check` ✅
- `npm run docs:build` ✅
- `npm test` ✅
  - `Test Files 448 passed | 1 skipped (449)`
  - `Tests 2490 passed | 8 skipped (2498)`

> 注意：这表示 **P1 当前收口范围** 已完成最终回归，不代表整个 P0/P1/P2 计划都已结案；P2 仍待后续推进。

### 2.2 总体完成度判断

> **本轮执行优先级调整（2026-04-21）**：P0 已全部收口并完成一轮全量回归；本轮继续推进 **P1 全部收口**，当前已完成 **P1-1 / P1-2 / P1-3 / P1-5** 的实现、定向测试、独立审查与最终全量验证。后续主线切换到 **P2**。

- **已完成**：
  - P0-1 ~ P0-5 全部收口
  - P1-1 Codex body 兼容进一步硬化
  - P1-2 Codex header / UA / Version / Originator 官方模板进一步硬化
  - P1-3 retry policy 按 failure taxonomy 细分
  - P1-5 常驻 ops 错误流水线 / covered failures 闭环
- **本轮 P1 收口结论**：
  - P1-1：已完成 unsupported 字段收敛，Codex body 标准化与回归测试已补齐
  - P1-2：已完成 Codex 官方 header 模板收紧，并验证 strict fallback / websocket / oauth 路径未回归
  - P1-3：已完成 failure taxonomy 联动 retry 决策，并修正 endpoint compatibility 不应误伤 same-site endpoint fallback
  - P1-5：已完成 Proxy Ops snapshot / Proxy Logs failureClass / covered failures 观测闭环，并补齐 24h SQL datetime 边界测试
- **当前主要缺口**：P1 已无阻塞项；后续剩余工作集中在 P2 的工程化与长期稳态增强
- **当前验证结论（2026-04-21）**：P1 范围相关实现已完成定向回归、独立审查以及 `npm run typecheck` / `npm run repo:drift-check` / `npm run docs:build` / `npm test` 全量通过

---

## 3. P0：必须优先闭环的核心项

## P0-1 Proxy Ops / 失败分类 / 基础运营观测
- 状态：**已完成（按当前 P0 范围收口）**
- 任务标记：`[x]`
- 当前已完成：
  - 新增统一失败分类：`src/server/services/proxyFailureTaxonomy.ts`
  - 新增 Proxy Ops 信号存储：`src/server/services/proxyOpsSignals.ts`
  - 新增 Proxy Ops 聚合快照：`src/server/services/proxyOpsSnapshotService.ts`
  - 新增运维页：`src/web/pages/ProxyOps.tsx`
  - 新增日志过滤增强：`src/server/routes/api/stats.ts`
  - 前端联动 `accountId / channelId / failureClass`：`src/web/pages/ProxyLogs.tsx`、`src/web/api.ts`
  - 已接入恢复 / 模型探测 / refresh 信号写入：
    - `src/server/services/channelRecoveryProbeService.ts`
    - `src/server/services/modelAvailabilityProbeService.ts`
    - `src/server/services/accountHealthService.ts`
  - 已补 protection signal 真正失败链路接线：`src/server/services/proxyLogStore.ts`
  - 已补 Proxy Ops 页面定向测试与 failureClass 深链：`src/web/pages/ProxyOps.test.tsx`
- 关键文件：
  - `src/server/services/proxyFailureTaxonomy.ts`
  - `src/server/services/proxyOpsSignals.ts`
  - `src/server/services/proxyOpsSnapshotService.ts`
  - `src/server/services/proxyLogStore.ts`
  - `src/server/routes/api/stats.ts`
  - `src/web/pages/ProxyOps.tsx`
  - `src/web/pages/ProxyOps.test.tsx`
  - `src/web/pages/ProxyLogs.tsx`
- 当前已通过的小测试：
  ```bash
  npx vitest run src/server/services/proxyLogStore.test.ts src/web/pages/ProxyOps.test.tsx src/server/routes/api/stats.proxy-logs.test.ts src/web/pages/ProxyLogs.server-driven.test.tsx
  npm run typecheck
  ```
- 当前结果：
  - `proxyLogStore + ProxyOps + stats.proxy-logs + ProxyLogs.server-driven` ✅
  - `npm run typecheck` ✅
- 收口说明：
  - protection signal 已不再停留在定义层，而是随实际失败日志落库进入 Proxy Ops
  - Proxy Ops → Proxy Logs 跳转已携带 `failureClass`，形成闭环
  - 后续若要做更细的挑战来源分层/站点级聚合，可留作增强项，不再阻塞当前 P0

## P0-2 Codex 判定收紧
- 状态：**已完成**
- 任务标记：`[x]`
- 已完成内容：
  - 官方 Codex 标识优先识别
  - 避免普通 OpenAI SDK 因 `openai-beta` / `x-stainless-*` 被误判为 Codex
  - 保住 strict compatibility fallback 与 websocket transport 的合法链路
- 关键文件：
  - `src/server/proxy-core/cliProfiles/codexProfile.ts`
  - `src/server/proxy-core/cliProfiles/codexProfile.test.ts`
- 已完成的小测试：
  ```bash
  npx vitest run src/server/proxy-core/cliProfiles/codexProfile.test.ts
  npx vitest run src/server/routes/proxy/chat.stream.test.ts -t "minimal headers for strict compatibility fallback"
  ```
- 当前结果：已通过

## P0-3 `conversation_id` continuity 主链
- 状态：**已完成**
- 任务标记：`[x]`
- 已完成内容：
  - `conversation_id / conversation-id` 接入 responses continuity 识别
  - continuity id 进入 `clientContext.sessionId / traceHint`
  - websocket fast-path / sticky rebind 主链打通
  - continuity 头优先级固定：`session_id > session-id > conversation_id > conversation-id`
- 关键文件：
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - `src/server/proxy-core/cliProfiles/codexProfile.ts`
  - `src/server/routes/proxy/responses.codex-oauth.test.ts`
- 已完成的小测试：
  ```bash
  npx vitest run src/server/routes/proxy/responses.codex-oauth.test.ts -t "conversation id|session id|fast-path successes"
  npx vitest run src/server/routes/proxy/responses.websocket.test.ts
  ```
- 当前结果：已通过

## P0-4 OAuth refresh 强治理（对标 sub2api refresh recovery）
- 状态：**已完成（按当前 P0 范围收口）**
- 任务标记：`[x]`
- 当前现状：
  - `src/server/services/oauth/refreshSingleflight.ts` 已从“仅进程内 `Map` 去重”升级为“进程内 singleflight + DB 中 `extraConfig.oauthRefreshRuntime` lease/backoff 治理”
  - 已落地：
    - 基于账号快照 CAS 的 refresh lease 抢占
    - refresh 失败后写入 `backoffUntil / consecutiveFailures / lastError`
    - scheduler 在 refresh backoff 期间跳过账号：`src/server/services/oauth/oauthRefreshScheduler.ts`
    - token router 在 refresh backoff 期间不选该账号：`src/server/services/tokenRouter.ts`
    - stale owner / remote lease disappear 两个竞态已有回归测试覆盖：`src/server/services/oauth/refreshSingleflight.test.ts`
    - 新增治理常量与约束测试：`src/server/services/oauth/refreshGovernance.ts`、`src/server/services/oauth/refreshGovernance.test.ts`
    - refresh 运营信号已与通用 runtime health 语义隔离：`src/server/services/accountHealthService.ts`、`src/server/services/accountHealthService.proxyOps.test.ts`
- 当前已通过的小测试：
  ```bash
  npx vitest run src/server/services/accountHealthService.proxyOps.test.ts src/server/services/oauth/*.test.ts src/server/routes/proxy/responses.codex-oauth.test.ts src/server/services/tokenRouter.selection.test.ts
  npm run typecheck
  ```
- 当前结果：
  - `accountHealthService.proxyOps + oauth/*.test + responses.codex-oauth + tokenRouter.selection` ✅
  - `npm run typecheck` ✅
- 收口说明：
  - refresh 已不再只是单进程 Map，且失败 backoff 会影响 scheduler / token router 选路
  - refresh 运营信号现在只由 `oauth-refresh` 语义路径写入，不再混入模型探测等普通健康事件
  - 更成熟的跨实例事件广播仍可继续增强，但不再阻塞当前 P0 收口

## P0-5 account / endpoint runtime state 共享化
- 状态：**已完成（按当前 P0 范围收口）**
- 任务标记：`[x]`
- 当前现状：
  - `src/server/services/accountDispatchRuntimeMemory.ts` 已增加持久化 / 重载逻辑，状态不再只停留在进程内 `Map`
  - `src/server/services/upstreamEndpointRuntimeMemory.ts` 已按 site 落到 settings 并支持重载
  - `src/server/services/accountDispatchPreferenceMutationService.ts` 已在清理账号 runtime state 后显式 `flushAccountDispatchRuntimePersistence()`，避免账号偏好切换后只清内存不清持久化
  - 已修复两处 runtime persistence 的 `persistInFlight` 清理与重叠写入补刷逻辑，确保**第一次 flush 进行中产生的新写入不会被吞掉**
  - 已补 nullable 时间字段恢复归一化，避免 persisted `0` 被错误恢复成有效时间戳
- 当前已通过的小测试：
  ```bash
  npx vitest run src/server/services/accountDispatchRuntimeMemory.test.ts src/server/services/upstreamEndpointRuntimeMemory.test.ts --maxWorkers 1
  ```
- 当前结果：
  - `accountDispatchRuntimeMemory + upstreamEndpointRuntimeMemory` ✅
  - 已覆盖：持久化重载、账号级清理后再次持久化、冷启动未加载缓存时的持久化清理、同一 site / 同一账号在 in-flight save 期间的重叠写入补刷、按 site 隔离且跨多次 flush 持久化、nullable 时间字段的 `0 -> null` 恢复归一化 ✅
- 收口说明：
  - 运行状态已不再完全依赖单进程内存 `Map`
  - 调度健康与 endpoint 偏好状态已具备共享化 / 持久化能力，并有针对“清理后再持久化”“冷启动先清理后落库”“in-flight save 期间新写入不丢失”的回归测试兜底
  - 更成熟的跨实例广播 / 更强 CAS 真值源仍可作为 P2 增强项继续做，但不再阻塞当前 P0 收口

---

## 4. P1：提升成功率与运营闭环的关键增强

## P1-1 Codex body 兼容进一步硬化
- 状态：**已完成**
- 任务标记：`[x]`
- 当前已完成：
  - `src/server/transformers/openai/responses/codexCompatibility.ts` 已继续保留并收紧：
    - `store=false`
    - 补空 `instructions`
    - `system -> developer`
    - 删除 `max_output_tokens / max_completion_tokens / max_tokens`
    - 额外剥离 `metadata / user / service_tier`
  - 已把 body 收敛语义同步到相关路由回归，避免只改 transformer 不改真实转发断言
- 关键文件：
  - `src/server/transformers/openai/responses/codexCompatibility.ts`
  - `src/server/transformers/openai/responses/codexCompatibility.test.ts`
  - `src/server/routes/proxy/chat.stream.test.ts`
  - `src/server/routes/proxy/responses.codex-oauth.test.ts`
  - `src/server/routes/proxy/upstreamEndpoint.test.ts`
- 当前已通过的小测试：
  ```bash
  npx vitest run src/server/transformers/openai/responses/codexCompatibility.test.ts
  npx vitest run src/server/routes/proxy/chat.stream.test.ts src/server/routes/proxy/responses.codex-oauth.test.ts src/server/routes/proxy/upstreamEndpoint.test.ts
  ```
- 当前结果：
  - Codex body 兼容新增字段清理与标准化断言 ✅
  - route 级真实转发请求体回归 ✅
- 完成标准：
  - 对 Codex 请求的 body 兼容不再只是最小收敛
  - 新增字段清理/整形具备对应回归测试覆盖

## P1-2 Codex header / UA / Version / Originator 官方模板进一步硬化
- 状态：**已完成**
- 任务标记：`[x]`
- 当前已完成：
  - `src/server/proxy-core/providers/headerUtils.ts` 与 Codex provider profile 已收紧官方模板优先级
  - 已明确 `User-Agent / Version / Originator / OpenAI-Beta` 的 Codex 模板化输出
  - 已验证 strict fallback、websocket fast-path、oauth 路径与 generic SDK 合法路径未被打坏
- 关键文件：
  - `src/server/proxy-core/providers/headerUtils.ts`
  - `src/server/proxy-core/providers/codexProviderProfile.ts`
  - `src/server/proxy-core/providers/codexProviderProfile.test.ts`
  - `src/server/routes/proxy/downstreamClientContext.test.ts`
  - `src/server/routes/proxy/responses.websocket.test.ts`
  - `src/server/routes/proxy/responses.codex-oauth.test.ts`
  - `src/server/routes/proxy/upstreamEndpoint.test.ts`
- 当前已通过的小测试：
  ```bash
  npx vitest run src/server/proxy-core/providers/codexProviderProfile.test.ts src/server/proxy-core/providers/headerUtils.test.ts
  npx vitest run src/server/routes/proxy/downstreamClientContext.test.ts src/server/routes/proxy/responses.websocket.test.ts src/server/routes/proxy/responses.codex-oauth.test.ts src/server/routes/proxy/upstreamEndpoint.test.ts
  ```
- 当前结果：
  - 官方模板优先级与透传边界已收紧 ✅
  - strict fallback / websocket / oauth / generic SDK 相关回归 ✅
- 完成标准：
  - 官方模板优先级与透传边界明确
  - 不破坏 strict fallback、websocket fast-path、generic SDK 合法路径

## P1-3 retry policy 按 failure taxonomy 细分
- 状态：**已完成**
- 任务标记：`[x]`
- 当前已完成：
  - `src/server/services/proxyRetryPolicy.ts` 已接入 `classifyProxyFailure(...)` 的 failure taxonomy 决策
  - challenge / auth / rate_limit / request_shape / model_unsupported / upstream_5xx 已按差异化语义处理
  - 已修正 endpoint compatibility 错误（如 `Unsupported legacy protocol` / `Please use /v1/responses`）不会误伤 same-site endpoint fallback
- 关键文件：
  - `src/server/services/proxyRetryPolicy.ts`
  - `src/server/services/proxyRetryPolicy.test.ts`
  - `src/server/routes/proxy/chat.stream.test.ts`
  - `src/server/routes/proxy/responses.codex-oauth.test.ts`
  - `src/server/routes/proxy/upstreamEndpoint.test.ts`
- 当前已通过的小测试：
  ```bash
  npx vitest run src/server/services/proxyRetryPolicy.test.ts
  npx vitest run src/server/routes/proxy/chat.stream.test.ts src/server/routes/proxy/responses.codex-oauth.test.ts src/server/routes/proxy/upstreamEndpoint.test.ts
  ```
- 当前结果：
  - failure taxonomy 与 retry / abort same-site fallback 决策联动 ✅
  - “该重试 / 不该重试 / 该换路 / 不该换路” 关键场景回归 ✅
- 完成标准：
  - failure taxonomy 与 retry 决策真正联动
  - 相关用例覆盖“该重试 / 不该重试 / 该换路 / 不该换路”

## P1-4 protection signal 真接线
- 状态：**已完成（已并入 P0-1 当前范围）**
- 任务标记：`[x]`
- 当前现状：
  - `recordProxyOpsProtectionSignal(...)` 已在 `src/server/services/proxyLogStore.ts` 中接入 challenge / WAF / protection 类失败日志落点
  - Proxy Ops 聚合与页面读取链路已可展示相关 protection 信号
  - 本项已被并入当前 P0-1 收口，不再作为独立未完成项阻塞后续推进
- 已通过的小测试：
  ```bash
  npx vitest run src/server/services/proxyLogStore.test.ts src/web/pages/ProxyOps.test.tsx src/server/routes/api/stats.proxy-logs.test.ts src/web/pages/ProxyLogs.server-driven.test.tsx
  ```
- 当前结果：已通过

## P1-5 常驻 ops 错误流水线 / covered failures 闭环
- 状态：**已完成**
- 任务标记：`[x]`
- 当前已完成：
  - `src/server/services/proxyOpsSnapshotService.ts` 已把 `retried`、protection signals、refresh / model probe 信息聚合进 Proxy Ops snapshot
  - 已修正 `overview.totalAccounts` 使用全量账户数聚合，不受列表 limit 影响
  - 已统一 24h 窗口到 SQL datetime 口径，避免边界日志漏算
  - `src/server/routes/api/stats.ts` 已把 `failureClass` 过滤切到 taxonomy-based filtering，并重算分页 / summary / clientOptions
- 关键文件：
  - `src/server/services/proxyOpsSnapshotService.ts`
  - `src/server/services/proxyOpsSnapshotService.test.ts`
  - `src/server/routes/api/stats.ts`
  - `src/server/routes/api/stats.proxy-ops.test.ts`
  - `src/server/routes/api/stats.proxy-logs.test.ts`
- 当前已通过的小测试：
  ```bash
  npx vitest run src/server/services/proxyOpsSnapshotService.test.ts
  npx vitest run src/server/routes/api/stats.proxy-ops.test.ts src/server/routes/api/stats.proxy-logs.test.ts
  ```
- 当前结果：
  - 中间失败可被保留与聚合 ✅
  - 最终成功请求也能回看其失败轨迹 ✅
  - Proxy Ops 深链到 Proxy Logs 的 `failureClass` 过滤与统一 taxonomy 对齐 ✅
- 完成标准：
  - 中间失败可被保留与聚合
  - 最终成功请求也能回看其失败轨迹

---

## 5. P2：工程化收口与生产级稳态增强

## P2-1 Proxy Ops / Proxy Logs 运营化完善
- 状态：**已完成**
- 任务标记：`[x]`
- 审计后的真实起点：
  - `ProxyOps.tsx` 已有基础概览、账号卡片、恢复扫一轮、模型探测、失败日志深链
  - `ProxyLogs.tsx` 已支持 `accountId / channelId / failureClass / from / to` 路由态，并已有服务端驱动分页
  - 但仍有几个明显运营断点：
    - Proxy Logs 顶部筛选区没有把来自 Proxy Ops 深链的 `accountId / channelId / failureClass` 明示出来，也不能一键清掉 scope
    - Proxy Ops 顶部 KPI 与 failure buckets 仍是纯展示，不能直接深链到对应日志范围
    - Proxy Ops 卡片异常摘要还不够聚焦，缺少更直接的失败 class / 作用域入口
- 当前已落地：
  - Proxy Logs 新增 route scope chips，明确显示 `accountId / channelId / failureClass`
  - Proxy Logs 新增 `清除范围` 按钮，并修复 clear scope 后 URL / 请求参数仍残留 `accountId / channelId` 的问题
  - `清空筛选` 已改为真正清掉 URL 中的筛选态，不再只清本地 state
  - Proxy Ops 顶部 overview cards、24h failure buckets、账号卡片“看失败日志”都已可直接 deep-link 到 `/logs`
  - Proxy Ops → Proxy Logs 的 24h deep-link 已补齐 `from / to`，不再出现点进日志后时间窗口继续漂移的问题
- 本轮最小落点：
  - `src/web/pages/ProxyOps.tsx`
  - `src/web/pages/ProxyLogs.tsx`
  - `src/web/pages/ProxyOps.test.tsx`
  - `src/web/pages/ProxyLogs.server-driven.test.tsx`
- 完成标准：
  - Proxy Ops 顶部概览与异常 bucket 可以直接跳到 Proxy Logs 对应筛选结果
  - Proxy Logs 会把 route 深链 scope 明确展示为可见 chips / badges
  - Proxy Logs 有“只清 scope / 清空全部筛选”两级动作，不再把隐式 URL 参数藏起来
- 本项小测试门禁：
  ```bash
  npx vitest run src/web/pages/ProxyOps.test.tsx src/web/pages/ProxyLogs.server-driven.test.tsx
  ```

## P2-2 常驻 observability 取代 debug-only 依赖
- 状态：**已完成**
- 任务标记：`[x]`
- 审计后的真实起点：
  - `proxy_logs` 已常驻保存 `routeId / channelId / accountId / httpStatus / retryCount`
  - `errorMessage` 前缀里已常驻带有 `[client:*] [session:*] [downstream:*] [upstream:*] [usage:*]` 元数据
  - `mapProxyLogRow(...)` 当前只把其中一部分解析回前端（client / usage / failure），还没有把 `sessionId / downstreamPath / upstreamPath` 变成稳定前端字段
  - 这导致日常排查时仍要打开 debug trace 才能快速看路径与会话线索
- 当前已落地：
  - `/api/stats/proxy-logs` 已稳定返回 `sessionId / downstreamPath / upstreamPath`
  - `src/web/api.ts` 已同步前端类型契约
  - Proxy Logs 列表与详情已展示 `failureTitle / httpStatus / session / downstream / upstream` 线索
  - 常驻列表已能直接看到 session 和路径，不必先进入 debug trace 面板
- 本轮最小落点：
  - `src/server/routes/api/stats.ts`
  - `src/web/api.ts`
  - `src/web/pages/ProxyLogs.tsx`
  - 相关单测 / 页面测试
- 完成标准：
  - Proxy Logs 列表与详情可以直接看到常驻的 session / downstream / upstream 路径线索
  - 日常“哪个客户端、哪个 session、打到了哪个上游路径”不再依赖 debug trace 才能看见
  - debug trace 回退为精细抓样本手段，而不是默认主观测面板
- 本项小测试门禁：
  ```bash
  npx vitest run src/server/routes/api/stats.proxy-logs.test.ts src/web/pages/ProxyLogs.server-driven.test.tsx
  ```

## P2-3 signal 存储并发治理 / 真值源治理
- 状态：**已完成**
- 任务标记：`[x]`
- 审计后的真实起点：
  - `proxyOpsSignals.ts` 与 `accountHealthService.ts` 都在直接做 `read extraConfig -> merge -> write back`
  - `refreshSingleflight.ts` 已经有基于 `updatedAt + extraConfig` 快照比较的 CAS 写法
  - 当前风险不是“完全没治理”，而是 **治理模式没有复用到 proxyOps / runtimeHealth 这条高频写路径**
- 当前已落地：
  - 新增通用 `mergeAccountExtraConfigWithRetry(...)`，把 account `extraConfig` 更新切到 CAS merge
  - `proxyOpsSignals.ts` 已改为走 CAS merge
  - `accountHealthService.ts` 的 `runtimeHealth` 写入也已切到 CAS merge
  - 已新增并发测试，验证 `proxyOps` 与 `runtimeHealth` 交叉更新时不会互相覆盖
  - `accountExtraConfig.ts` 已改为在 CAS 路径里懒加载 `db/index.js`，避免测试环境在设置 `DATA_DIR` 前被顶层 import 提前初始化 DB
- 本轮最小落点：
  - 提取通用 account extraConfig compare-and-swap helper
  - 让 `proxyOpsSignals.ts` / `accountHealthService.ts` 走同一套 CAS merge
  - 增补并发/交叉写入测试，证明 `proxyOps` 与 `runtimeHealth` 不会互相覆盖
- 计划落点：
  - `src/server/services/accountExtraConfig.ts`
  - `src/server/services/proxyOpsSignals.ts`
  - `src/server/services/accountHealthService.ts`
  - `src/server/services/accountHealthService.proxyOps.test.ts`
  - 新增或补充 `proxyOpsSignals` / CAS 相关测试
- 本项小测试门禁：
  ```bash
  npx vitest run src/server/services/accountHealthService.proxyOps.test.ts src/server/services/proxyOpsSignals.test.ts src/server/services/oauth/refreshSingleflight.test.ts src/server/services/oauth/oauthRefreshScheduler.test.ts
  ```

## P2-4 最终与 sub2api 差异清零复查
- 状态：**已完成**
- 任务标记：`[x]`
- 本轮复查重点与结论：
  - `codexCompatibility.ts` 已前置剥离 `prompt_cache_retention`，不再把该兼容字段留到更底层才清洗
  - OAuth refresh 已补上 `terminal / 不应重试` 分流，且 scheduler / singleflight 都会阻断立即重试
  - OAuth refresh 在 `responses/chat` 上游 401/403 后若刷新成功，现会写入 `status='retried'` 常驻 `proxy_logs`，不再只留在 debug trace
  - stale owner 刷新成功但 newer owner 随后失败的竞态已修复：若新 access token 已先落库，不会再被误报为 refresh 失败，runtime 也会被修正回 success
- 对照基线：
  - `sub2api-repo/backend/internal/service/openai_codex_transform.go`
  - `sub2api-repo/backend/internal/util/httputil/httputil.go`
  - `sub2api-repo/backend/internal/service/token_refresh_service.go`
  - `sub2api-repo/backend/internal/service/temp_unsched.go`
  - `sub2api-repo/backend/internal/handler/ops_error_logger.go`
- 最终复查结论：
  - 已做两轮独立只读审查；中间发现的 stale-owner refresh 竞态已补修并复审通过
  - 当前未再发现必须阻塞 P2 结案的高价值差异项
  - 本项以复查结论 + 最终全量回归通过验收，不再停留在“待执行”

---

## 6. 已完成项的当前证据清单

### 6.1 代码落点
- `src/server/proxy-core/cliProfiles/codexProfile.ts`
- `src/server/proxy-core/cliProfiles/codexProfile.test.ts`
- `src/server/proxy-core/surfaces/chatSurface.ts`
- `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
- `src/server/proxy-core/surfaces/sharedSurface.ts`
- `src/server/routes/api/stats.ts`
- `src/server/routes/proxy/chat.codex-oauth.test.ts`
- `src/server/routes/proxy/downstreamClientContext.test.ts`
- `src/server/routes/proxy/responses.codex-oauth.test.ts`
- `src/server/routes/proxy/responses.websocket.test.ts`
- `src/server/services/accountHealthService.ts`
- `src/server/services/channelRecoveryProbeService.ts`
- `src/server/services/modelAvailabilityProbeService.ts`
- `src/server/services/oauth/oauthRefreshScheduler.ts`
- `src/server/services/oauth/refreshGovernance.ts`
- `src/server/services/oauth/refreshSingleflight.ts`
- `src/server/services/proxyFailureTaxonomy.ts`
- `src/server/services/proxyOpsSignals.ts`
- `src/server/services/proxyOpsSnapshotService.ts`
- `src/server/transformers/openai/responses/codexCompatibility.ts`
- `src/web/App.tsx`
- `src/web/api.ts`
- `src/web/pages/ProxyLogs.tsx`
- `src/web/pages/ProxyOps.tsx`

### 6.2 已通过的小测试 / 回归测试（当前记录）
```bash
npx vitest run src/web/pages/ProxyOps.test.tsx src/server/services/proxyOpsSnapshotService.test.ts src/server/routes/api/accountTokens.sync.test.ts src/server/routes/api/search.route.test.ts src/server/routes/api/sites.subscription-summary.test.ts src/web/pages/ProxyLogs.server-driven.test.tsx src/server/routes/api/stats.proxy-logs.test.ts src/server/services/accountHealthService.proxyOps.test.ts src/server/services/proxyOpsSignals.test.ts src/server/services/oauth/refreshSingleflight.test.ts src/server/services/oauth/oauthRefreshScheduler.test.ts src/server/transformers/openai/responses/codexCompatibility.test.ts src/server/routes/proxy/responses.codex-oauth.test.ts src/server/routes/proxy/chat.codex-oauth.test.ts --maxWorkers 1
npm run typecheck
npm run repo:drift-check
npm run docs:build
npm audit --omit=dev --audit-level=high
npm test
```

### 6.3 当前验证结论（P2 本轮收口）
- 已完成两轮独立只读审查；首轮发现的 stale-owner refresh 竞态已补修，二次复审结论为**无新的 must-fix，可结束本轮 P2 验证收口**
- 定向回归已通过：`109 passed (109)`
- `npm run typecheck`、`npm run repo:drift-check`、`npm run docs:build`、`npm audit --omit=dev --audit-level=high` 均已通过，其中 repo drift `Violations: 0`、audit `found 0 vulnerabilities`
- `npm run docs:build` 最近一次构建耗时约 `39.50s`
- `npm test` 已通过：`449 passed | 1 skipped (450)`，`2494 passed | 8 skipped (2502)`

---

## 7. 后续推进顺序（更新到当前真实状态）

P0 / P1 / P2 的代码与验证范围现已全部收口；接下来进入发布闭环，避免“代码完成但未真正上线验证”：

1. **收口文档并提交到 `main`**
   - 保持本计划文档、测试记录与代码状态一致
2. **等待 `main` CI 通过后打 tag / 等 Release**
   - 以仓库 CI 与 Release 产物作为上线前门禁
3. **更新 `/opt/metapi` 容器并做线上验证**
   - 拉取最新镜像、最小影响更新、核对版本与核心页面/接口可用性

> 说明：原先单列的 P1-4 protection signal 真接线，已在本轮并入 P0-1 收口，不再作为独立未完成步骤。

> 禁止跳过文档更新；禁止跳过小测试；禁止在 CI / Release / 实际部署验证前把“代码收口完成”误写成“生产闭环完成”。

---

## 8. 最终完成清单（全部打勾后才能结案）

### P0
- [x] P0-1 Proxy Ops / 失败分类 / 基础运营观测闭环
- [x] P0-2 Codex 判定收紧
- [x] P0-3 `conversation_id` continuity 主链
- [x] P0-4 OAuth refresh 强治理
- [x] P0-5 account / endpoint runtime state 共享化

### P1
- [x] P1-1 Codex body 兼容进一步硬化
- [x] P1-2 Codex header / UA / Version / Originator 官方模板进一步硬化
- [x] P1-3 retry policy 按 failure taxonomy 细分
- [x] P1-4 protection signal 真接线
- [x] P1-5 常驻 ops 错误流水线 / covered failures 闭环

### P2
- [x] P2-1 Proxy Ops / Proxy Logs 运营化完善
- [x] P2-2 常驻 observability 取代 debug-only 依赖
- [x] P2-3 signal 存储并发治理 / 真值源治理
- [x] P2-4 最终与 sub2api 差异清零复查

---

## 9. 最终收口记录（全部完成后填写）

> 注：本节记录 **P0 / P1 / P2 全部完成后的最终代码收口结论**；CI / tag / 部署上线验证另按发布流程继续推进。

### 9.1 全量命令
```bash
npm run typecheck
npm run repo:drift-check
npm run docs:build
npm audit --omit=dev --audit-level=high
npm test
```

### 9.2 结果
- `npm run typecheck`：已通过
- `npm run repo:drift-check`：已通过，`Violations: 0`
- `npm run docs:build`：已通过（最近一次构建约 `39.50s`）
- `npm audit --omit=dev --audit-level=high`：已通过，`found 0 vulnerabilities`
- `npm test`：已通过，`449 passed | 1 skipped (450)`，`2494 passed | 8 skipped (2502)`

### 9.3 最终审查结论
- 是否已把 P0 / P1 / P2 全部做完：是，当前 hardening 计划内的代码与验证项已全部完成
- 是否确认未引入新问题：在本轮两次独立审查、定向回归与全量测试范围内，未发现新的 must-fix
- 是否仍存在与 `sub2api` 相比的高价值缺口：当前未发现仍需阻塞结案的高价值缺口
- 若仍有缺口，为什么不算完成：不适用；剩余事项转入发布闭环（提交 / CI / tag / 部署验证）
