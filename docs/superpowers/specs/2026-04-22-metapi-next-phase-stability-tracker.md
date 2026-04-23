# metapi 下一阶段稳态治理追踪文档（对标 sub2api / new-api）

> **目标**：在 `metapi` 现有 hardening 与 `pending_overload` 最小闭环基础上，继续吸收 `sub2api` 与 `new-api` 的高价值机制，优先减少或缓解以下问题：
> - `fetch failed: read ECONNRESET`
> - `Too many pending requests, please retry later`
> - generic `processing error`
> - session / continuity 看起来卡住、漂移、后续请求像是没再真正打到上游
> - retry 放大故障
> - 同一 account / credential 被并发打热
>
> **本文档定位**：这是后续实现阶段的仓库内真值源。下一步落地、回归、复盘都以本文档为准，而不是以聊天上下文为准。
>
> **任务完成定义**：只有当本文档中的 **P0 / P1 / P2 条目全部完成**、每项都有对应小测试与结果记录，且最终完成一轮全量回归后，整个任务才算真正完成。

---

## 1. 执行规则（必须遵守）

### 1.1 小步完成规则

后续每完成一个条目，必须立即做这 4 件事：

1. 补对应最小测试或定向验证。
2. 运行该条目的小测试。
3. 只有测试通过，才把该条目标记为完成。
4. 立即回写本文档中的状态、涉及文件、测试命令、测试结果与日期。

### 1.2 最终收口规则

在 P0 / P1 / P2 全部完成之前，不能宣布任务完成。

> 续做约定（2026-04-23）：若会话因工具额度/上下文中断，需要先简短回写已完成内容，然后**直接继续推进下一步**，不等待用户再次确认。

最终收口至少要通过：

```bash
npm run typecheck
npm run repo:drift-check
npm run docs:build
npm test
```

并补一轮：

- 与 `sub2api` / `new-api` 目标机制的最终差异复查
- correctness / regression / consistency 代码审查
- 文档回写：最终完成范围、遗留风险、是否完全闭环

### 1.3 文档更新规则

之后每次推进都必须同步回写本文档：

- 状态：`未开始 / 进行中 / 已完成 / 已完成但待最终回归确认`
- 完成内容
- 涉及文件
- 小测试命令
- 小测试结果
- 后续依赖 / 风险

---

## 2. 本轮建立文档时的基线（2026-04-22）

### 2.1 当前仓库与运行基线

- 本地仓库：`/home/hermesops/workspace/metapi-repo`
- 分支状态：`main...origin/main`，工作区干净
- 文档建立时间：`2026-04-22 19:32:22 CST`
- 线上容器：`metapi`
- 当前线上 revision：`9f427603a79e12a02254ecb34054c889b834ad61`
- 当前线上探活：`http://127.0.0.1:4000/` 返回 `200`

### 2.2 已完成的基础能力（本轮不重复发明轮子）

以下能力已经在 `main` 中落地，本轮不再从零重做，而是在此基础上继续推进：

- failure taxonomy 已成型，`pending_overload` 已从普通 `rate_limit` 中独立
- `pending_overload` 已接入 credential-scope cooldown，不再只是日志告警
- `pending_overload` 不再误伤 site breaker
- `conversation_id / session_id` continuity 主链已补上
- session sticky / channel lease / queue wait 基础链路已存在
- Proxy Ops / Proxy Logs / failureClass 已形成基础观测闭环
- refresh 治理、runtime persistence、部分 CAS merge 与恢复能力已存在

### 2.3 当前核心判断（后续实现默认以此为前提）

1. `fetch failed: read ECONNRESET` 更像上游或中间链路 reset，不是 `metapi` 自己主动拒绝。
2. 在当前 `metapi` 中，它主要属于 `network`，不是 `pending_overload`。
3. `pending_overload` 已有专项冷却，但 `ECONNRESET` 仍主要走普通网络失败路径。
4. “超时后感觉后续不再发新请求”不是纯错觉，可能与 session-scoped lease / queue wait / sticky / breaker / cooldown 共同作用有关。
5. 当前 `metapi` 更强的是“失败后分类、冷却、降权”；还不够强的是“派发前避免同一账号被打爆”。
6. `sub2api` 最值得吸收的方向是 account / credential 级预算与 continuity 真锚点；`new-api` 最值得吸收的方向是规则化 affinity、可配置 retry/disable、override 与运维热修中枢。

---

## 3. 本轮分析来源与结论摘要

### 3.1 对 `metapi` 当前状态的结论

当前 `metapi` 的真实缺口，已经不是“完全没有分类 / 没有日志 / 没有 cooldown”，而是以下几类：

1. **execution error 路径仍然过宽地重试**
   - 所有 execution error 仍可能进入相近 fanout 逻辑
   - 容易把局部错误扩大成多 channel 失败

2. **仍缺 account / credential 级派发前预算**
   - 现有 lease 更偏 channel / session
   - 无稳定 session 的请求仍可能把同一账号打热

3. **generic processing error 还没有单独 failure class**
   - 仍可能混入 `upstream_5xx` 或 `unknown`
   - 导致 retry 与观测都不够精准

4. **session / sticky / continuity 真值源仍偏进程内**
   - 单机内可用，多实例 / 重启 / 漂移场景下不够稳

5. **当前观测更偏事后，不够 live hotness**
   - 还缺 account / credential 热点、waiting、suppression 原因的实时聚合视图

### 3.2 `sub2api` 最值得吸收的机制

1. `previous_response_id + session` 双锚点 continuity 路由
2. account / credential 级并发预算与 bounded wait-plan
3. typed suppression / recovery 状态机
4. stream timeout 独立阈值治理
5. layered filter + final fresh recheck
6. account-aware observability
7. quota / reset-aware 429 治理

### 3.3 `new-api` 最值得吸收的机制

1. 规则化 channel affinity
2. `SwitchOnSuccess` / `SkipRetryOnFailure` 语义
3. 可配置状态码重试 / 自动禁用矩阵
4. 自动禁用 → 探活恢复闭环
5. override 中枢：param / header / status code mapping
6. 双阈值限流语义：总请求数 vs 成功请求数

### 3.4 本轮明确“不照搬”的点

1. 不照搬 new-api 默认 CLI 专用 affinity 规则，只吸收机制。
2. 不照搬 affinity 原始业务 key 直存，metapi 中应只存 hash / fingerprint。
3. 不照搬宽泛关键词自动禁用词表，优先状态码 + provider 明确错误码。
4. 不照搬散落各 relay handler 的状态码改写实现，应集中到统一错误归一层。
5. 不照搬 new-api 当前限流实现细节，只吸收产品语义与运维能力。

---

## 4. 多线程分析与实施主线

后续实现按 6 条主线推进，避免“只修一个点，其他链路继续漏”。

### 线程 A：错误分类与 retry gate
目标：把 `ECONNRESET / timeout / processing error / deterministic config error / bad_response_body` 区分开，避免无差别放大。

### 线程 B：派发前并发治理
目标：在请求真正打上游前，就限制同一 account / credential 的 active / waiting / hotness，而不是等报错后再冷却。

### 线程 C：continuity / sticky / session 真锚点
目标：让 `previous_response_id / conversation_id / session_id` 的 continuity 更稳定，减少多 turn / websocket / CLI follow-up 漂移。

### 线程 D：endpoint / channel suppression 与恢复
目标：让 pending overload、stream timeout、401、5xx、坏 key 等进入统一状态机，并通过 probe / test 恢复，而不是靠时间盲恢复。

### 线程 E：Proxy Ops / Logs / live hotness
目标：把“哪个账号正在热、正在排队、正在 suppress”实时可见，不只是在出事后翻日志。

### 线程 F：运维 override 与策略开关
目标：把 affinity、header/param override、status code mapping、retry / disable rule 变成可调能力，而不是每次都改代码。

---

## 5. P0：必须优先闭环的核心项

## P0-1 execution error retry 去放大化
- 状态：**已完成（2026-04-22）**
- 任务标记：`[x]`
- 当前已完成：
  - `handleExecutionError(...)` 不再对所有 execution error 无差别进入 retry
  - 改为先用 `shouldRetryProxyRequest(0, errorMessage)` 判断 execution error 是否属于可重试路径
  - 这样 `fetch failed: read ECONNRESET` / timeout 之类的 transient execution error 仍可有限重试
  - `bad response body`、generic unknown execution error 等不会再仅因为还没到 `maxRetries` 就继续 fanout
- 为什么收口：
  - 当前最核心的故障放大点在于 execution error 路径原先完全绕过 retry policy
  - 先把 execution error 接回已有 taxonomy / retry gate，就能立即减少无意义扩散
  - 更细的 `processing_error` 语义继续在 P0-2 处理
- 吸收来源：
  - `metapi` 当前缺口分析
  - `new-api` 的“确定性错误 no-retry”思路
- 实际改动：
  - `sharedSurface.ts` 的 `handleExecutionError(...)` 改为仅在 `shouldRetryProxyRequest(0, errorMessage)` 为真时才尝试 retry
  - 新增回归测试，覆盖：
    - retry policy 拒绝时，execution error 直接终止
    - retry policy 接受时，`fetch failed: read ECONNRESET` 仍走 retry
- 关键文件：
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.test.ts`
  - 已复核：`src/server/services/proxyRetryPolicy.ts`
  - 已复核：`src/server/services/proxyFailureTaxonomy.ts`
- 本轮小测试：
  ```bash
  npx vitest run src/server/proxy-core/surfaces/sharedSurface.test.ts
  npx vitest run src/server/services/proxyRetryPolicy.test.ts src/server/services/proxyFailureTaxonomy.test.ts
  npm run typecheck
  ```
- 本轮结果：
  - `sharedSurface.test.ts` ✅（27 passed）
  - `proxyRetryPolicy.test.ts + proxyFailureTaxonomy.test.ts` ✅（8 passed）
  - `npm run typecheck` ✅
- 最小验收点：
  - `ECONNRESET` 最多只做有限重试 ✅
  - `bad response body: invalid json` 不再因为剩余重试次数而继续 fanout ✅
  - execution error 已正式接回 retry policy，而不是独立绕过 ✅
- 遗留说明：
  - `processing_error` 仍未从 taxonomy 中独立拉出，继续由 P0-2 完成

## P0-2 引入 `processing_error` 独立 failure class
- 状态：**已完成（2026-04-22）**
- 任务标记：`[x]`
- 当前已完成：
  - taxonomy 已新增 `processing_error` 独立 failure class
  - 典型文本 `An error occurred while processing your request` / `processing error` 不再落入 `unknown` 或 `upstream_5xx`
  - `429 + processing error` 不再误伤 `pending_overload`
  - retry policy 与 same-site endpoint fallback 已接入 `processing_error` 语义
- 为什么收口：
  - `processing_error` 是用户明确提到的高频症状之一
  - 若继续把它混在 `unknown / upstream_5xx / rate_limit` 里，后续治理与观测都会失真
  - 当前先把 failure class 与 retry/abort 语义拉出来，Proxy Ops / Logs 会自动沿用新的分类标题
- 吸收来源：
  - `metapi` 当前缺口分析
  - `new-api` 的状态码 / 错误归一思路
- 实际改动：
  - `proxyFailureTaxonomy.ts` 新增 `processing_error` 类型、pattern 与分类标题 `上游处理错误`
  - 分类顺序调整为：`pending_overload` 仍优先；`processing_error` 在 `rate_limit` / `upstream_5xx` 之前识别
  - `proxyRetryPolicy.ts` 将 `processing_error` 纳入 retryable failure class 与 same-site abort class
- 关键文件：
  - `src/server/services/proxyFailureTaxonomy.ts`
  - `src/server/services/proxyRetryPolicy.ts`
  - `src/server/services/proxyFailureTaxonomy.test.ts`
  - `src/server/services/proxyRetryPolicy.test.ts`
  - 自动受益链路：`src/server/services/proxyOpsSnapshotService.ts`、`src/server/routes/api/stats.ts`、`src/server/services/proxyLogStore.ts`
- 本轮小测试：
  ```bash
  npx vitest run src/server/services/proxyFailureTaxonomy.test.ts src/server/services/proxyRetryPolicy.test.ts
  npm run typecheck
  ```
- 本轮结果：
  - `proxyFailureTaxonomy.test.ts + proxyRetryPolicy.test.ts` ✅（10 passed）
  - `npm run typecheck` ✅
- 最小验收点：
  - `HTTP 500 + processing error` 被稳定归类为 `processing_error` ✅
  - `429 + processing error` 不误伤 `pending_overload` ✅
  - retry / same-site fallback 已能基于 `processing_error` 作出独立决策 ✅
- 遗留说明：
  - Proxy Ops / Logs 已能自动看到新分类，但更细的 live hotness / suppression 面板仍在 P1-2

## P0-3 account / credential 级派发前预算
- 状态：**已完成（2026-04-22）**
- 任务标记：`[x]`
- 当前已完成：
  - `tokenRouter` 已从“只看单 channel runtime load soft penalty”推进到“同账号 session-scoped channel 的派发前硬 gate”
  - 同一账号下多个 session-scoped sibling channel 不再因为分散到不同 channel 而绕过预算保护
  - `explainSelection()` / `previewSelectedChannel()` 已能直接给出 `账号预算已满（活跃=x/y，等待=z）`
  - 原有 runtime load 软惩罚仍保留，但预算耗尽时优先走 eligibility fail-fast
- 为什么现在能收口：
  - 这轮先完成最小闭环，把“同账号多 channel 继续被打”的明显漏洞堵住
  - 当前实现不新建独立 runtime service，而是复用 `proxyChannelCoordinator` 的 channel load snapshot 做 account 聚合预算
- 实际改动：
  - `CandidateEligibilityOptions` 新增 `candidatePool` / `accountDispatchBudgetSnapshots`
  - `tokenRouter.ts` 新增 account budget 聚合逻辑：
    - 仅对 direct session-scoped 候选生效
    - 以 `account:${accountId}` 作为最小预算 scope
    - 聚合同账号所有候选 channel 的 `activeLeaseCount / waitingCount`
    - 预算上限取该 scope 下 channel concurrency limit 的最大值
  - `getCandidateEligibilityReasons(...)` 新增硬 gate：
    - 当 `activeLeaseCount >= concurrencyLimit` 时，直接标记 `账号预算已满`
  - 关键调用点已统一传入预聚合 snapshot，避免每个候选重复单独计算
  - `tokenRouter.selection.test.ts` 新增 sibling channel 回归测试，并把原 runtime-load 用例更新到新语义
- 当前最小实现边界：
  - **已覆盖**：非 route-unit 的 direct session-scoped / OAuth 直连账号，在同账号多 channel 下的预算绕过问题
  - **暂未扩展**：route-unit member 级独立预算、设置页可调预算参数、独立 runtime 持久层
  - 这些继续留给后续 `P0-4 / P1` 收口，不影响本轮最小闭环生效
- 关键文件：
  - `src/server/services/tokenRouter.ts`
  - `src/server/services/tokenRouter.selection.test.ts`
  - 复用链路：`src/server/services/proxyChannelCoordinator.ts`
- 本轮小测试：
  ```bash
  npx vitest run src/server/services/tokenRouter.selection.test.ts -t "blocks sibling session-scoped channels from the same account when the credential budget is already full"
  npx vitest run src/server/services/tokenRouter.selection.test.ts
  npm run typecheck
  ```
- 本轮结果：
  - 新增 sibling budget gate 回归测试 ✅
  - `tokenRouter.selection.test.ts` 全量 ✅（36 passed）
  - `npm run typecheck` ✅
- 最小验收点：
  - 两个 channel 指向同一账号时，预算耗尽后能避开热账号 ✅
  - 无 `session_id` 的新请求不会再仅因换 sibling channel 就绕过预算保护 ✅
  - explain / preview 路径能显式暴露 `账号预算已满` 原因 ✅
- 风险与后续：
  - 当前还是“基于现有 channel lease 聚合”的最小实现，不是完整的 account runtime service
  - 若后续要支持更复杂的 route-unit / typed suppression / 可配置预算，继续在 `P0-4 / P1` 上演进

## P0-4 typed suppression / recovery 状态机
- 状态：**已完成（2026-04-22）**
- 任务标记：`[x]`
- 当前进展：
  - 已完成 P0-1 / P0-2 / P0-3 / P0-4
  - 已把 account dispatch runtime 从仅有 `healthy / degraded / recovering / failback_hold`，补成带 typed suppression reason 的可追踪状态机
  - 已把 pending overload / timeout / auth invalid / selection blocked 的恢复判断收口到统一的 recovery gate
- 完成内容：
  - `accountDispatchRuntimeMemory.ts` 新增 `suppressionReason`
  - `recordAccountDispatchFailure(...)` 支持 typed suppression reason，并对 `pending_overload` / `auth_invalid` 做即时降级
  - `recordAccountDispatchProbeSuccess(...)` / `recordAccountDispatchSuccess(...)` 现在会保留并最终清理 suppression reason
  - `tokenRouter.ts` 会把 `pending_overload / timeout / auth_invalid / hard_error / soft_error` 传入 runtime memory，并在 manual recovery 阶段按 typed reason 决定是否继续 probe
- 涉及文件：
  - `src/server/services/accountDispatchRuntimeMemory.ts`
  - `src/server/services/accountDispatchRuntimeMemory.test.ts`
  - `src/server/services/tokenRouter.ts`
  - `src/server/services/tokenRouter.selection.test.ts`
- 小测试命令：
  ```bash
  npx vitest run src/server/services/accountDispatchRuntimeMemory.test.ts src/server/services/tokenRouter.selection.test.ts
  npm run typecheck
  ```
- 小测试结果：
  - `50 passed`
  - `typecheck` 通过
- 风险 / 遗留：
  - 当前 suppression reason 仍是最小闭环，后续可继续细化到 route-unit / live ops 可视化 / 独立持久层

## P0-5 `previous_response_id + session` 双锚点 continuity
- 状态：**已完成（2026-04-22）**
- 任务标记：`[x]`
- 当前进展：
  - 已完成 P0-1 / P0-2 / P0-3 / P0-4 / P0-5
  - 已把 `/responses` 入口的 sticky continuity 从“仅 session 锚点”补成“`previous_response_id + session` 双锚点”最小闭环
  - follow-up 若显式携带 `previous_response_id`，或同 session 已记住上一跳 response id，现在都会更早命中 continuity sticky key
- 完成内容：
  - `proxyChannelCoordinator.buildStickySessionKey(...)` 新增 `continuityKey`，把 continuity 锚点纳入 sticky key 计算，同时保留无 continuity 时的降级语义
  - `sharedSurface.buildSurfaceStickySessionKey(...)` 现在支持显式传入 `sessionId` / `continuityKey`
  - `openAiResponsesSurface.ts` 在选路前就会从请求体 `previous_response_id` 或已记住的 session response anchor 中提取 continuity key，再参与 sticky channel 命中
  - 这样 orphan tool-output follow-up、显式 `previous_response_id` follow-up、以及 websocket/HTTP continuation replay，在进入实际选路前就能共用同一套双锚点 sticky 命中逻辑
- 涉及文件：
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/services/proxyChannelCoordinator.test.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
- 小测试命令：
  ```bash
  npm test -- --run src/server/services/proxyChannelCoordinator.test.ts
  npm test -- --run src/server/proxy-core/surfaces/sharedSurface.test.ts
  npm test -- --run src/server/routes/proxy/responses.codex-oauth.test.ts
  npm test -- --run src/server/routes/proxy/responses.websocket.test.ts
  npm run typecheck
  ```
- 小测试结果：
  - `11 passed`
  - `27 passed`
  - `26 passed`
  - `30 passed`
  - `typecheck` 通过
  - 合计 `94 passed`
- 风险 / 遗留：
  - 本轮先落“sticky dual-anchor 最小闭环”，尚未新增独立 `responsesContinuityStore.ts` 做 account/channel 持久映射
  - 多实例 / 进程重启后的 continuity 共享化仍留给 `P1-3 session / sticky / continuity 状态共享化` 继续收口

---

## 6. P1：高价值增强项

## P1-1 stream timeout 独立阈值治理
- 状态：**已完成（2026-04-22）**
- 任务标记：`[x]`
- 当前进展：
  - 已完成 `P1-1`，把 stream timeout / 断流从 generic soft failure 中单独拉出
  - `/responses` / websocket 常见断流文本现在会稳定命中 `timeout` suppression，而不是继续沉到 `soft_error`
  - prefer-mode manual recovery 对 `timeout` 现已走独立冷却，不再和 generic soft failure 共用 60s probe 节奏
- 完成内容：
  - `proxyFailureTaxonomy.ts` 把 `stream closed before response.completed`、`response.incomplete` 纳入 `timeout` 分类
  - `proxyRetryPolicy.ts` 同步把上述断流文本视为 retryable timeout，并继续保持 same-site abort 语义
  - `tokenRouter.ts` 在普通 route channel 的 `recordFailure(...)` 路径中不再丢失 typed suppression reason，timeout 现在会正确写入 `accountDispatchRuntimeMemory`
  - `shouldAttemptManualDispatchRecovery(...)` 对 `timeout` 新增独立冷却阈值，读取 `config.tokenRouterTimeoutCooldownSec`
  - runtime settings 已新增 `tokenRouterTimeoutCooldownSec`，支持环境变量 / settings hydration / `/api/settings/runtime` 热更新与持久化
- 涉及文件：
  - `src/server/services/proxyFailureTaxonomy.ts`
  - `src/server/services/proxyFailureTaxonomy.test.ts`
  - `src/server/services/proxyRetryPolicy.ts`
  - `src/server/services/proxyRetryPolicy.test.ts`
  - `src/server/services/tokenRouter.ts`
  - `src/server/services/tokenRouter.selection.test.ts`
  - `src/server/config.ts`
  - `src/server/runtimeSettingsHydration.ts`
  - `src/server/runtimeSettingsHydration.test.ts`
  - `src/server/routes/api/settings.ts`
  - `src/server/routes/api/settings.events.test.ts`
- 小测试命令：
  ```bash
  npx vitest run src/server/services/accountHealthService.test.ts src/server/services/accountHealthService.proxyOps.test.ts src/server/services/tokenRouter.selection.test.ts src/server/runtimeSettingsHydration.test.ts src/server/routes/api/settings.events.test.ts src/server/services/proxyFailureTaxonomy.test.ts src/server/services/proxyRetryPolicy.test.ts
  npm run typecheck
  ```
- 小测试结果：
  - `99 passed`
  - `typecheck` 通过
- 风险 / 遗留：
  - 当前先做的是 stream timeout cooldown 的最小闭环；live hotness / waiting / suppression 面板仍留给 `P1-2`
  - 目前 timeout 冷却仍是全局统一秒数，尚未细化到 account/site/model 分层阈值

## P1-2 live hotness / waiting / suppression 可观测性
- 状态：**已完成（2026-04-22）**
- 任务标记：`[x]`
- 当前进展：
  - 已完成 `P1-2`，Proxy Ops 现已直接暴露 account 级 live hotness / waiting / suppression reason
  - 运维在不翻 debug trace 的前提下，就能看到 session 通道实时活跃数、排队数、饱和通道数，以及当前被压制的 runtime reason
  - `/api/stats/proxy-ops` 现在把这些信号直接带到前端，页面展开详情即可看到
- 完成内容：
  - `proxyOpsSnapshotService.ts` 接入 `proxyChannelCoordinator.getChannelLoadSnapshots(...)`，按账号聚合 `activeLeaseCount / waitingCount / saturatedChannels / sessionScopedChannels`
  - 同文件接入 `listAccountDispatchRuntimeSnapshots(...)`，把 typed suppression reason 汇总为 `dispatchSuppression.total / reasons / entries`
  - `accountDispatchRuntimeMemory.ts` 新增只读枚举函数，允许 Proxy Ops 读取现有 runtime state，而不额外创建健康态条目
  - `ProxyOps.tsx` 在详情区新增“实时负载 / 抑制原因”面板，直接展示 `活跃 x · 等待 y`、reason 聚合，以及 route/model 级 suppression 条目
  - `web/api.ts` 同步补齐新字段类型；`stats.proxy-ops` 路由测试也已覆盖新 payload
- 涉及文件：
  - `src/server/services/accountDispatchRuntimeMemory.ts`
  - `src/server/services/proxyOpsSnapshotService.ts`
  - `src/server/services/proxyOpsSnapshotService.test.ts`
  - `src/server/routes/api/stats.proxy-ops.test.ts`
  - `src/web/api.ts`
  - `src/web/pages/ProxyOps.tsx`
  - `src/web/pages/ProxyOps.test.tsx`
- 小测试命令：
  ```bash
  npx vitest run src/server/services/proxyOpsSnapshotService.test.ts src/server/routes/api/stats.proxy-ops.test.ts src/web/pages/ProxyOps.test.tsx
  npm run typecheck
  ```
- 小测试结果：
  - `6 passed`
  - `typecheck` 通过
- 风险 / 遗留：
  - 当前仍是 account 级聚合视角，尚未在 Proxy Ops 里做更细的 site/model 维度热力拆分
  - 页面当前展示的是实时 snapshot，不含历史时序图；若后续要看峰值/趋势，仍需继续扩展到 `P2` 级别的时序面板

## P1-3 session / sticky / continuity 状态共享化
- 状态：**已完成（2026-04-23）**
- 任务标记：`[x]`
- 当前进展：
  - 已完成 P1-3，把 `/responses` continuity 相关的 response anchor 与 sticky binding 从“仅进程内 Map”推进到“settings 持久化 + 入口自动加载”的最小共享化闭环
  - 当前先共享 `session response anchor` 与 `sticky channel binding`，未把 lease / queue 一并持久化，保持实现边界最小且可回归
  - 这样至少在单实例重启 / 进程重载后，不会再把前一轮 continuity 与 sticky 命中全部丢光
- 完成内容：
  - 新增 `src/server/services/responsesContinuityStore.ts`，统一持久化两类状态：
    - `sessionResponseAnchors`
    - `stickyBindings`
  - `codexSessionResponseStore.ts` 改为复用统一 store，只保留 scoped-session key 组装、bare fallback 与 drift/reconcile 语义
  - `proxyChannelCoordinator.ts` 的 sticky 读写/清理已改走统一 store，并新增 `ensure/flush` 接口供选路前加载
  - `channelSelection.ts` 在 sticky 选路前会先加载 continuity state；`openAiResponsesSurface.ts` 与 `codexWebsocketRuntime.ts` 在读取 response anchor 前也会先加载
  - 保留原有 drift / roundtrip 兼容语义：当 bare fallback 命中后，会清理同 bare session 下的旧 scoped sibling key，避免漂回旧 scope 时读到陈旧 response id
- 为什么现在能收口：
  - 本轮目标是“最小共享化闭环”，不是一次性把 Redis、多实例 lease 协调、session queue 全做完
  - 当前实现已经覆盖用户最在意的“重启后 previous_response_id / sticky continuity 全丢”的核心缺口
  - 继续向多实例强一致扩展，可放到后续更高成本阶段，而不阻塞本轮 P1 收口
- 吸收来源：
  - `sub2api` 的共享状态存储思路
  - `new-api` 的内存 + TTL cache 设计思路
- 涉及文件：
  - `src/server/services/responsesContinuityStore.ts`
  - `src/server/proxy-core/runtime/codexSessionResponseStore.ts`
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/proxy-core/channelSelection.ts`
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - `src/server/proxy-core/runtime/codexWebsocketRuntime.ts`
  - `src/server/proxy-core/runtime/codexSessionResponseStore.test.ts`
  - `src/server/services/proxyChannelCoordinator.test.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.test.ts`
- 本轮小测试：
  ```bash
  npx vitest run src/server/proxy-core/runtime/codexSessionResponseStore.test.ts src/server/services/proxyChannelCoordinator.test.ts
  npx vitest run src/server/proxy-core/runtime/codexSessionResponseStore.test.ts src/server/services/proxyChannelCoordinator.test.ts src/server/proxy-core/runtime/codexWebsocketRuntime.test.ts src/server/proxy-core/surfaces/sharedSurface.test.ts src/server/routes/proxy/responses.codex-oauth.test.ts src/server/routes/proxy/responses.websocket.test.ts
  npm run typecheck
  ```
- 本轮结果：
  - `codexSessionResponseStore.test.ts + proxyChannelCoordinator.test.ts` ✅（19 passed）
  - P1-3 相关 HTTP / websocket / sticky / continuation 回归 ✅（108 passed）
  - `npm run typecheck` ✅
- 最小验收点：
  - reset / reload 后，scoped response anchor 仍可恢复 ✅
  - reset / reload 后，sticky session binding 仍可恢复 ✅
  - drift / bare fallback / roundtrip 旧语义未回退 ✅
  - `/responses` HTTP 与 websocket continuation 回归保持通过 ✅
- 风险 / 遗留：
  - 当前仍未共享 channel lease / queue wait，本轮只共享 continuity 与 sticky 命中真值
  - 持久层先复用 settings 表，尚未演进到 Redis / 多实例实时协同
  - 更强的一致性与跨实例并发协调，仍可留待后续更高成本阶段

## P1-4 自动禁用 → 探活恢复闭环
- 状态：**已完成（2026-04-23）**
- 任务标记：`[x]`
- 当前进展：
  - 已补上“明显坏 key / 坏账号 / provider hard failure”在普通选路中的自动摘除逻辑，不再只限于 manual prefer 场景
  - 已把 recovery sweep 从 `cooldown / active` 扩到 `suppressed`，因此被 `auth_invalid / hard_error` 摘除的账号也会进入后台探活闭环
  - 当前恢复语义改为：`degraded(auth_invalid|hard_error)` -> `probe success => recovering` -> `real success => failback_hold/healthy`，不会靠时间到自动回池
- 目标：
  - 对明显坏 key / 坏账号 / provider hard failure 做自动摘除
  - 只在探活成功后恢复，而不是盲目时间到就回池
- 吸收来源：`new-api`
- 完成内容：
  - `tokenRouter.ts` 新增通用自动摘除判定与候选过滤：
    - `auth_invalid / hard_error` 失败会进入 account dispatch runtime state，即使不是 prefer 手动派发场景也会生效
    - 普通候选筛选阶段会直接拦下处于自动禁用中的账号，并给出“自动禁用中（等待探活恢复）”原因
  - `recordFailure / recordProbeSuccess / recordSuccess` 已统一改为：只要存在非 healthy 运行时状态，或当前失败属于 `auth_invalid / hard_error`，就会推进 runtime suppression / recovery 状态机，而不再只靠 prefer 模式驱动
  - `channelRecoveryProbeService.ts` 新增 `suppressed` recovery source：
    - 会从 `accountDispatchRuntimeMemory` 扫出处于 `degraded(auth_invalid|hard_error)` 的账号/模型对
    - 再映射回 route channel 做后台探活
    - 探活成功后写回 `recordProbeSuccess(...)`，进入 `recovering`
  - `proxyOpsSignals.ts` 的 recovery signal 已扩展支持 `suppressed` 来源，便于后续 ops 面看到“这是从自动禁用恢复链路打回来的探活”
- 关键文件：
  - `src/server/services/tokenRouter.ts`
  - `src/server/services/channelRecoveryProbeService.ts`
  - `src/server/services/proxyOpsSignals.ts`
  - `src/server/services/tokenRouter.selection.test.ts`
  - `src/server/services/channelRecoveryProbeService.test.ts`
  - `src/server/services/accountHealthService.test.ts`
  - `src/server/services/accountHealthService.proxyOps.test.ts`
  - `src/server/services/proxyOpsSignals.test.ts`
- 本轮小测试：
  ```bash
  npx vitest run src/server/services/channelRecoveryProbeService.test.ts src/server/services/tokenRouter.selection.test.ts
  npx vitest run src/server/services/channelRecoveryProbeService.test.ts src/server/services/tokenRouter.selection.test.ts src/server/services/accountHealthService.test.ts src/server/services/accountHealthService.proxyOps.test.ts src/server/services/proxyOpsSignals.test.ts
  npm run typecheck
  ```
- 本轮结果：
  - `channelRecoveryProbeService.test.ts + tokenRouter.selection.test.ts` ✅（44 passed）
  - 加上 `accountHealthService* / proxyOpsSignals.test.ts` 的 P1-4 相关回归 ✅（56 passed）
  - `npm run typecheck` ✅
- 最小验收点：
  - 普通选路里，`auth_invalid` 账号会自动摘除，不再继续参与选择 ✅
  - `auth_invalid / hard_error` 不会靠冷却时间自动恢复，必须先经过 recovery probe success 才会进入 recovering ✅
  - recovery sweep 能扫到被自动摘除的 suppressed 账号并主动探活 ✅
  - 探活成功后 runtime state 会进入 `recovering`，后续真实成功再进入 `failback_hold / healthy` ✅
- 风险 / 遗留：
  - 当前自动摘除主打 `auth_invalid / hard_error` 两类明显坏账号/坏 key 语义；更细的 provider-specific hard failure taxonomy 以后还可以再扩
  - 本轮仍是应用内 settings/runtime-memory 闭环，不是多实例共享探活协调；如果后面要做更强一致，需要继续上更重的共享调度层

## P1-5 override 中枢：param / header / status code mapping
- 状态：**已完成（2026-04-23）**
- 任务标记：`[x]`
- 目标：
  - 给运维提供非发版热修能力，减少为个别 provider 差异反复改代码
- 吸收来源：`new-api`
- 关键文件：
  - `src/server/services/payloadRules.ts`
  - `src/server/routes/proxy/upstreamEndpoint.ts`
  - `src/server/proxy-core/orchestration/endpointFlow.ts`
  - `src/server/routes/api/settings.ts`
  - `src/server/routes/api/settings.events.test.ts`
  - `src/web/api.ts`
- 当前已完成：
  - 在既有 `payload_rules` 单一配置源上扩容 `headerOverride / headerFilter / statusCodeMap`
  - `prepareRequest` 之后统一套用 header override/filter，保持 provider 内部逻辑不分叉
  - 在 `endpointFlow` 收口层统一套用上游失败状态码映射
  - 运行时设置 API 现已支持读取/保存 `payloadRules`，无需新开第二套 override setting key
  - 兼容旧配置：即使运行中的 `payloadRules` 只有旧版 `default / override / filter` 字段，也不会因新字段缺失而崩掉
- 建议小测试：
  ```bash
  npx vitest run src/server/routes/proxy/*.test.ts src/server/services/payloadRules.test.ts src/server/routes/api/settings.events.test.ts
  npm run typecheck
  ```
- 本轮小测试结果：
  - `npx vitest run src/server/services/payloadRules.test.ts src/server/routes/proxy/upstreamEndpoint.test.ts src/server/routes/proxy/endpointFlow.test.ts`
  - `npx vitest run src/server/routes/api/settings.events.test.ts --testNamePattern="payload override rules"`
  - `npx vitest run src/server/routes/proxy/*.test.ts src/server/services/payloadRules.test.ts src/server/routes/api/settings.events.test.ts`
  - `npm run typecheck`
  - 以上均已通过
- 备注：
  - 先做后端最小能力，再考虑富 UI；当前已经具备热修 header / status 的后端闭环

---

## 7. P2：长期稳态增强项

## P2-1 规则化 channel affinity 最小闭环
- 状态：**已完成（2026-04-23）**
- 任务标记：`[x]`
- 目标：
  - 支持从请求上下文字段提取 affinity key
  - 支持 `SwitchOnSuccess` / `SkipRetryOnFailure`
  - 支持 group / model / rule 隔离
- 完成内容：
  - 新增 `src/server/services/channelAffinity.ts`，落地最小规则化 affinity 配置、key 提取、哈希化 cache key、TTL/LRU 风格内存存储与 `SwitchOnSuccess` 语义
  - `openAiResponsesSurface` 现在会基于请求头 / body / client context 解析 affinity 规则，在首次选路时优先尝试命中的 affinity channel，并在成功后回写绑定
  - 同一 affinity 命中的首次失败现在支持 `SkipRetryOnFailure`，避免把错误 affinity 继续扩散成多 channel fanout
  - `channelSelection` / `sharedSurface` 扩展了 `affinityPreferredChannelId` 入口，保持 `forced > sticky > affinity > 默认选路` 的优先级
  - group / model / rule 三层隔离已经进入 cache key 组成；原始业务 key 不入缓存，只保留 SHA-256 指纹
  - 默认配置保持关闭，通过 `CHANNEL_AFFINITY_JSON` / `CHANNEL_AFFINITY_RULES` 注入，不影响现有默认行为
- 涉及文件：
  - `src/server/services/channelAffinity.ts`
  - `src/server/services/channelAffinity.test.ts`
  - `src/server/proxy-core/channelSelection.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.test.ts`
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - `src/server/routes/proxy/responses.codex-oauth.test.ts`
  - `src/server/config.ts`
- 小测试命令：
  - `npx vitest run src/server/services/channelAffinity.test.ts src/server/proxy-core/surfaces/sharedSurface.test.ts src/server/routes/proxy/responses.codex-oauth.test.ts`
  - `npx vitest run src/server/routes/proxy/*.test.ts src/server/proxy-core/surfaces/sharedSurface.test.ts src/server/services/channelAffinity.test.ts && npm run typecheck`
- 小测试结果：
  - 定向 affinity 测试通过：`59` tests passed
  - 扩大回归通过：`35` test files passed / `436` tests passed
  - `npm run typecheck` 通过
- 吸收来源：`new-api`
- 风险 / 遗留：
  - 当前最小闭环优先覆盖 `/responses`；其余 surface 的统一铺开留给后续 P2-4
  - managed downstream key 目前以现有 key name / key id 参与 group 级隔离兜底，若后续需要更细 group 语义，再在运维 API 与 runtime settings 中补齐
  - 规则能力目前只做最小必要字段，先避免过度设计

## P2-2 双阈值限流语义：总请求数 vs 成功请求数
- 状态：**已完成（2026-04-23）**
- 任务标记：`[x]`
- 目标：
  - 控制失败风暴与正常吞吐，支持 downstream / group 差异化治理
- 完成内容：
  - 新增 `src/server/services/downstreamRateLimit.ts`，实现双阈值窗口配置归一化、group override 解析、按 managed downstream key 维度的内存窗口计数，以及 `total` / `success` 两类限流决策
  - `proxyAuthMiddleware` 现在会在 managed key 鉴权成功后，先按 `config.downstreamRateLimit` 做窗口检查；超过总请求阈值直接返回 `429`，并在放行时立即记一次 total request，保证失败请求也会消耗总请求额度
  - 成功请求路径复用现有 `recordDownstreamCostUsage(...)` 成功记账点，在下游 key 成功计费时同步记一次 success request，形成“总请求数包含失败、成功请求数只统计成功”的闭环
  - 运行时配置已接入 `config.ts` / `runtimeSettingsHydration.ts` / `settings.ts` / `src/web/api.ts`，支持通过 `DOWNSTREAM_RATE_LIMIT_JSON` / `DOWNSTREAM_RATE_LIMIT` 或后台 runtime settings 的 `downstreamRateLimit` 热更新
  - group 差异化治理采用 `group: { [groupName]: [totalCount, successCount] }` 覆盖全局默认阈值；managed key 继续按 key 自身隔离计数，不会把不同 key 的请求混成一个桶
- 涉及文件：
  - `src/server/services/downstreamRateLimit.ts`
  - `src/server/services/downstreamRateLimit.test.ts`
  - `src/server/middleware/auth.ts`
  - `src/server/middleware/auth.proxy.test.ts`
  - `src/server/routes/proxy/downstreamPolicy.ts`
  - `src/server/routes/api/settings.ts`
  - `src/server/routes/api/settings.events.test.ts`
  - `src/server/runtimeSettingsHydration.ts`
  - `src/server/config.ts`
  - `src/web/api.ts`
- 小测试命令：
  - `npx vitest run src/server/services/downstreamRateLimit.test.ts src/server/middleware/auth.proxy.test.ts src/server/routes/api/settings.events.test.ts --testNamePattern="downstream|threshold|payload override rules"`
  - `npx vitest run src/server/routes/proxy/*.test.ts src/server/services/downstreamRateLimit.test.ts src/server/middleware/auth.proxy.test.ts src/server/routes/api/settings.events.test.ts --testTimeout=20000 && npm run typecheck`
- 小测试结果：
  - 定向双阈值 / 鉴权 / runtime settings 测试通过：`6` passed
  - 扩大回归通过：`36` test files passed / `449` tests passed
  - `npm run typecheck` 通过
- 吸收来源：`new-api`
- 风险 / 遗留：
  - 当前窗口计数仍为进程内内存态；服务重启后窗口会重置，多实例共享计数留给后续更强状态共享/运维能力处理
  - 当前只对 managed downstream key 生效，全局 `proxyToken` 仍保持现有行为
  - group override 目前按 managed key 自身 `groupName` 选阈值，但计数桶仍按 key 隔离；若后续需要真正的 group 聚合桶，再在 P2-5 运维 API 与状态持久化阶段扩展

## P2-3 layered filter + final fresh recheck
- 状态：**已完成（2026-04-23）**
- 任务标记：`[x]`
- 目标：
  - 先按 cheap runtime state 剪枝，再对最终入选对象做 fresh eligibility recheck，减小 stale cache / stale state 误判
- 完成内容：
  - 在 `src/server/services/tokenRouter.ts` 中把 enabled-routes / route-match 的 DB 读取拆成“缓存快照”和“fresh 快照”两条路径，新增 `readEnabledRoutesSnapshot()`、`buildRouteMatchFromEnabledRoutes()`、`loadRouteMatchFresh()`，让最终派发前可以不依赖 TTL 缓存直接拿最新 route/channel/account/site 视图
  - `finalizeSelectedCandidateForDispatch(...)` 现在会在真正返回 selected channel 之前，先用 fresh route match 找回当前候选，再按最新 `enabled / cooldown / token / downstream exclusion / runtime suppression / budget` 等 eligibility 规则重跑一次最终校验；fresh 校验不通过则直接放弃该候选，让上层按既有逻辑继续 fallback / retry / refresh
  - 这次改动同时覆盖普通 channel 与 oauth route-unit member：外层 channel fresh 校验通过后，再按最新成员状态重新挑 member，避免缓存里还是旧 member/旧 token 的情况
  - 没有推翻前面的 cheap layered filter；仍然先用缓存态做低成本大盘筛选，只把最终候选做一次 fresh recheck，避免把每次全量选路都变成重 DB 查询
- 涉及文件：
  - `src/server/services/tokenRouter.ts`
  - `src/server/services/tokenRouter.selection.test.ts`
- 小测试命令：
  - `npx vitest run src/server/services/tokenRouter.selection.test.ts --testNamePattern="rechecks cached|reuses a preferred channel only while it remains healthy"`
  - `npx vitest run src/server/services/tokenRouter.selection.test.ts src/server/routes/proxy/*.test.ts src/server/services/downstreamRateLimit.test.ts src/server/middleware/auth.proxy.test.ts src/server/routes/api/settings.events.test.ts --testTimeout=20000 && npm run typecheck:server`
- 小测试结果：
  - 定向 stale-cache fresh-recheck 测试通过：`3` passed
  - 扩大回归通过：`37` test files passed / `490` tests passed
  - `npm run typecheck:server` 通过
- 吸收来源：`new-api`
- 风险 / 遗留：
  - 当前 fresh recheck 只对“最终入选对象”走一次 DB fresh 视图，仍属于最小闭环；如果后续要做更激进的 stale-state 收敛，再考虑把更多 selector 中间态也接入增量刷新
  - 目前 fresh recheck 主要保证 route/channel/member eligibility 的新鲜度，不额外引入新的共享状态持久化语义

  - `src/server/services/tokenRouter.ts`
  - `src/server/proxy-core/channelSelection.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`

## P2-4 其余 surface / route 全量铺开统一稳态规则
- 状态：**已完成（2026-04-23）**
- 任务标记：`[x]`
- 目标：
  - 避免只修 `/responses`，其余 route 继续沿用旧式 retry / error handling
- 完成内容：
  - 已将 P2-1 的 channel affinity 最小闭环按统一模板铺到 `completions / search / embeddings / images / videos / chat / gemini` 这些主要 route / surface，统一接入首跳 affinity preferred、`skipRetryOnFailure` 的 retry lock，以及成功后的 binding 写回
  - `search.ts`、`embeddings.ts`、`images.ts`、`videos.ts` 均已补 `resolveChannelAffinityRequest(...)`、`affinityPreferredChannelId`、`canRetryCurrentSelection()`、`recordChannelAffinityIfSuccessful()`，并在定向测试中验证 repeated request 会复用 binding、skip-retry 不再 fanout 到下一 channel
  - `chatSurface.ts` 已同时覆盖主聊天请求与 `count_tokens` 分支，避免 surface 内部语义分叉；`geminiSurface.ts` 也已在 `handleGenerateContent(...)` 中补齐首跳 affinity 命中、失败收口和 JSON/SSE 成功写回 binding
  - `completions.siteApiEndpoint.test.ts`、`chat.siteApiEndpoint.test.ts`、`gemini.test.ts` 等高层回归已补齐，验证铺开后没有破坏既有 site endpoint rotation / downstream transform / bookkeeping 语义
- 关键文件：
  - `src/server/proxy-core/surfaces/chatSurface.ts`
  - `src/server/proxy-core/surfaces/geminiSurface.ts`
  - `src/server/routes/proxy/completions.ts`
  - `src/server/routes/proxy/embeddings.ts`
  - `src/server/routes/proxy/images.ts`
  - `src/server/routes/proxy/search.ts`
  - `src/server/routes/proxy/videos.ts`
  - `src/server/routes/proxy/completions.siteApiEndpoint.test.ts`
  - `src/server/routes/proxy/embeddings.siteApiEndpoint.test.ts`
  - `src/server/routes/proxy/images.edits.test.ts`
  - `src/server/routes/proxy/search.test.ts`
  - `src/server/routes/proxy/videos.test.ts`
  - `src/server/routes/proxy/chat.siteApiEndpoint.test.ts`
  - `src/server/routes/proxy/gemini.test.ts`
- 小测试命令：
  - `npx vitest run src/server/routes/proxy/completions.siteApiEndpoint.test.ts src/server/routes/proxy/search.test.ts src/server/routes/proxy/embeddings.siteApiEndpoint.test.ts src/server/routes/proxy/images.edits.test.ts src/server/routes/proxy/videos.test.ts src/server/routes/proxy/chat.siteApiEndpoint.test.ts src/server/routes/proxy/gemini.test.ts && npm run typecheck`
- 小测试结果：
  - 目标 route / surface 定向回归通过：`7` test files passed / `65` tests passed
  - `npm run typecheck` 通过
- 吸收来源：`new-api`
- 风险 / 遗留：
  - 当前 affinity 铺开仍以进程内状态为主；跨实例共享和持久化运维查询留给 P2-5 最小运维 API 阶段继续收口
  - 这一步优先保证主要入口的选路 / retry 语义一致，没有在本阶段再扩展新的 affinity 规则类型或持久层

## P2-5 最小运维 API：affinity / suppression / continuity 查询与清理
- 状态：**已完成（2026-04-23）**
- 任务标记：`[x]`
- 目标：
  - 当规则配置错误、会话污染、错误 suppression 卡住时，提供最小止血工具
- 完成内容：
  - 新增 `src/server/services/proxyOpsRuntimeStateService.ts`，统一聚合三类运行态：`channel affinity`、`responses continuity / sticky binding`、`account dispatch suppression`，对外提供只读 snapshot 与最小清理能力
  - `stats.ts` 新增两条运维路由：`GET /api/stats/proxy-ops/runtime-state` 用于查询当前 runtime state，`POST /api/stats/proxy-ops/runtime-state/clear` 用于按 cacheKey / session key / sticky key / accountId 做最小清理
  - `channelAffinity.ts` 补 `listChannelAffinityBindings(...)`、`clearChannelAffinityBindingsByChannelIds(...)`；`responsesContinuityStore.ts` 补 `listStoredSessionResponseAnchors(...)`、`listStoredStickyChannelBindings(...)`，让运维 API 不必直接窥探内部 Map
  - 现有 suppression 状态继续复用 `accountDispatchRuntimeMemory.ts` 的 `listAccountDispatchRuntimeSnapshots(...)` 与 `clearAccountDispatchRuntimeStatesForAccount(...)`，没有再新造第二套 suppression store
  - 新增 `stats.proxy-ops.test.ts` 和 `proxyOpsRuntimeStateService.test.ts` 定向覆盖，验证路由能读/清三类状态，且 affinity 输出只暴露 hash/cache key，不泄露原始业务 key
- 关键文件：
  - `src/server/routes/api/stats.ts`
  - `src/server/routes/api/stats.proxy-ops.test.ts`
  - `src/server/services/proxyOpsRuntimeStateService.ts`
  - `src/server/services/proxyOpsRuntimeStateService.test.ts`
  - `src/server/services/channelAffinity.ts`
  - `src/server/services/responsesContinuityStore.ts`
  - `src/server/services/accountDispatchRuntimeMemory.ts`
- 小测试命令：
  - `npx vitest run src/server/routes/api/stats.proxy-ops.test.ts src/server/services/proxyOpsRuntimeStateService.test.ts`
  - `npx vitest run src/server/routes/api/stats.proxy-ops.test.ts src/server/services/proxyOpsRuntimeStateService.test.ts src/server/services/channelAffinity.test.ts src/server/services/accountDispatchRuntimeMemory.test.ts src/server/services/proxyChannelCoordinator.test.ts src/server/proxy-core/runtime/codexSessionResponseStore.test.ts && npm run typecheck`
- 小测试结果：
  - P2-5 定向测试通过：`2` test files passed / `6` tests passed
  - 扩大回归通过：`6` test files passed / `41` tests passed
  - `npm run typecheck` 通过
- 吸收来源：`new-api`
- 风险 / 遗留：
  - 当前最小运维 API 仍以单实例运行态为主，适合止血与排障；若后续要做跨实例统一运维视图，再考虑叠加共享状态或分页/筛选能力
  - 清理能力目前按最小主键粒度（cache key / session key / sticky key / accountId）提供，尚未扩展更复杂的批量筛选表达式

---

## 8. 建议实施顺序

如果下一步要开始真正落地，建议严格按这个顺序做：

1. **P0-1 execution error retry 去放大化**
2. **P0-2 `processing_error` 独立 failure class**
3. **P0-3 account / credential 级派发前预算**
4. **P0-4 typed suppression / recovery 状态机**
5. **P0-5 `previous_response_id + session` 双锚点 continuity**
6. **P1-1 stream timeout 独立阈值治理**
7. **P1-2 live hotness / waiting / suppression 可观测性**
8. **P1-3 session / sticky / continuity 状态共享化**
9. **P1-4 自动禁用 → 探活恢复闭环**
10. **P1-5 override 中枢**
11. 再进入 P2 的 affinity / rate-limit / layered filter / 统一铺开

### 为什么这样排

- P0-1 / P0-2 是最快能直接降低错误放大的切口
- P0-3 / P0-4 是从“事后冷却”转向“派发前治理”的关键
- P0-5 才是 continuity 稳态的真正锚点增强
- P1-2 必须建立在 P0-3 / P0-4 产生了 runtime 信号之后才更有价值
- P2 中的 affinity 和双阈值限流属于增强项，不应早于核心稳态规则

---

## 9. 每轮实现后的最小回写模板

后续每完成一个条目，按下面结构补充：

```md
### P0-X / P1-X / P2-X 更新（YYYY-MM-DD）
- 状态：已完成 / 进行中 / 已完成但待最终回归确认
- 完成内容：
- 涉及文件：
- 小测试命令：
- 小测试结果：
- 风险 / 遗留：
```

---

## 10. 当前总状态（2026-04-23）

- P0：**已完成**
  - 已完成：`P0-1 execution error retry 去放大化`、`P0-2 processing_error 独立 failure class`、`P0-3 account / credential 级派发前预算`、`P0-4 typed suppression / recovery 状态机`、`P0-5 previous_response_id + session 双锚点 continuity`
- P1：**已完成**
  - 已完成：`P1-1 stream timeout 独立阈值治理`、`P1-2 live hotness / waiting / suppression 可观测性`、`P1-3 session / sticky / continuity 状态共享化`、`P1-4 自动禁用 → 探活恢复闭环`、`P1-5 override 中枢`
- P2：**已完成**
  - 已完成：`P2-1 规则化 channel affinity 最小闭环`、`P2-2 双阈值限流语义：总请求数 vs 成功请求数`、`P2-3 layered filter + final fresh recheck`、`P2-4 其余 surface / route 全量铺开统一稳态规则`、`P2-5 最小运维 API：affinity / suppression / continuity 查询与清理`
  - 当前收口进度：`最终全量回归已通过，下一步进入推送 / CI / 镜像更新与容器重启`
- 已完成的是：**分析、对标、路线图与追踪文档落地 + P0 / P1 / P2 全部实现点（含 affinity / downstream rate-limit / fresh recheck / 全量铺开 / 最小运维 API）**
- 当前已有新增测试执行记录，后续继续按“完成一个点 -> 跑小测试 -> 回写文档”推进

### 本轮文档建立已完成内容

- 已同步 `metapi` 本地仓库到远端最新
- 已对 `metapi / sub2api / new-api` 做只读多线程对比分析
- 已明确：
  - 哪些能力已经在 `metapi` 中存在
  - 哪些缺口仍然最值得做
  - 哪些机制可以吸收
  - 哪些实现细节不应直接照搬
- 已把下一阶段实现拆成可执行的 P0 / P1 / P2 路线图

### 推送前多线程审计与收口修复（2026-04-23）

- 状态：进行中（已完成审计、阻塞项修复与最终全量回归，待推送 / CI / 部署）
- 审计方式：
  - 在推送前额外做了 3 路并行只读审计，分别覆盖：
    - P0 / P1 核心稳态链路
    - P2 affinity / downstream rate-limit / fresh recheck / runtime-state API
    - settings / runtime hydration / ProxyOps / web typing 暴露面
- 本轮已修复的阻塞 / 高优先级问题：
  - `P2-5 runtime-state` 查询结果已从直接暴露原始 continuity / sticky / suppression key 改为脱敏返回：
    - session anchor 改为 `handle + responseIdHash + updatedAtMs`
    - sticky binding 改为 `handle + channelId + expiresAtMs + updatedAtMs`
    - suppression entries 不再返回原始复合 key
    - 清理接口新增 `sessionAnchorHandles / stickyHandles`，继续兼容原始 key 清理输入
  - `P2-1 channel affinity` 已补进 runtime settings / hydration 闭环：
    - `/api/settings/runtime` GET / PUT 现已支持 `channelAffinity`
    - `runtimeSettingsHydration` 现已支持 `channel_affinity`
    - `settings backup import` 现已支持对 `payload_rules / downstream_rate_limit / channel_affinity` 做即时 hot-apply，不必重启后才生效
    - `src/web/api.ts` 已同步补齐 runtime settings typing，避免前后端契约漂移
  - `P0-5 / P1-3 continuity sticky` 补充了高层回归：
    - 首轮成功记住 `previous_response_id` 后，下一轮仅依赖 remembered anchor 也能命中同通道
    - 实测当前实现已通过该回归，无需额外修代码
- 本轮新增 / 更新回归：
  - `src/server/services/proxyOpsRuntimeStateService.test.ts`
  - `src/server/routes/api/stats.proxy-ops.test.ts`
  - `src/server/routes/api/settings.events.test.ts`
  - `src/server/runtimeSettingsHydration.test.ts`
  - `src/server/routes/proxy/responses.codex-oauth.test.ts`
- 已通过的小回归：
  - `npm run typecheck` 通过
  - `5` test files passed / `78` tests passed
- 最终收口回归（2026-04-23 12:10 左右完成）：
  - `npx vitest run src/server/services/tokenRouter.cache.test.ts` ✅（`13` tests passed）
  - `npm run typecheck` ✅
  - `npm run repo:drift-check` ✅（`Violations: 0`）
  - `npm run docs:build` ✅
  - `npm test` ✅（`454` passed / `1` skipped；`2560` tests passed / `8` skipped）
  - 其中全量回归里额外修正了 `tokenRouter.cache.test.ts` 的旧语义断言：
    - 旧断言仍认为 TTL 内 stale route snapshot 应继续命中
    - 现已改为符合 `P2-3 final fresh recheck` 设计：最终派发前若 fresh recheck 已找不到 route，则返回 `null`
- 审计后暂未作为本轮阻塞项处理的点：
  - account / credential 预算对“无稳定 session 的新请求”是否还存在绕过窗口，仍偏设计层语义核查，需放在最终全量回归观察，不在本轮最小收口里追加大改
  - continuity / suppression 的跨实例 whole-blob upsert 仍属于后续可继续演进项；当前先保证单实例重启恢复与最小运维面安全收口

---

## 11. 最终收口前必须回答的问题

在宣布整个任务完成前，必须逐条确认：

1. `ECONNRESET` 是否不再被无差别 fanout 放大？
2. `processing_error` 是否已从 `unknown` 中拉出并有独立策略？
3. account / credential 是否已有派发前预算，而不是只靠事后 cooldown？
4. suppression state 是否统一、可恢复、可观测？
5. `previous_response_id + session` continuity 是否可稳定命中并合法降级？
6. live hotness / waiting / suppression 原因是否已能在 Proxy Ops 直接看到？
7. 多实例 / 重启后 session / continuity 是否至少不再完全依赖进程内 Map？
8. 这些能力是否已经铺到主要 surface / route，而不是只修一个入口？
9. 最终全量回归是否通过？

只要其中任何一项答案仍然是否定的，就不能宣布整个任务完成。
