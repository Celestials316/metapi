# Hermes / Codex 卡住与错误路由根因修复追踪文档

## 文档目标

本追踪文档用于指导 `metapi` 对以下问题做**根因级修复**，而不是局部止血：

- Hermes / Codex 请求被错误路由到不支持的上游、协议或端点
- 请求在服务端实际已失败，但客户端仍表现为“正在输入 / typing / pending”
- 弱 continuity 信号被误当作强 session continuity，导致 sticky / queue / anchor / websocket 复用污染后续请求
- 进程重启后恢复正常，暴露出 runtime state / stream lifecycle / sticky state 清理不完整的问题

本文档的目标不是压缩改动范围，而是定义一套**面向长期稳定性、解释性、可观测性、可恢复性**的完整修复方案。后续实现必须以本文档为准，优先满足架构正确性与根因闭环，而不是优先追求“改动小”。

---

## 当前进展（2026-04-24）

### 已完成：P0 — continuity 真值收束

以下根因修复已完成并通过定向回归：

- `conversation_id` 已降级为 trace-only，不再进入 strong session continuity lane。
- weak continuity 已禁止进入：
  - sticky
  - anchor
  - queue
  - websocket reuse
  - `previous_response_id` inference
- Codex 已切为 strict responses-only。
- stream idle timeout 与 failure finalize 基础闭环已落地。

### 已完成：P1 — endpoint strict policy 真值层收束

以下能力真值层收束已完成：

- `resolveUpstreamEndpointCandidates()` 已支持显式 strict endpoint policy。
- Codex strict policy 已上提到 endpoint candidate 真值层，而不再只靠 surface 事后 filter。
- `applyUpstreamEndpointRuntimePreference()` 已支持 strict bypass，runtime endpoint memory 不再能重排 strict 请求。
- 已新增测试锁定 strict 请求不受 runtime success / failure memory 干扰。

### 已完成：P2 — runtime hygiene / orphan cleanup / diagnostics 聚合

以下运行态清理与可观测性增强已完成：

#### 1) runtime hygiene 落地

- 已新增 `src/server/services/proxyRuntimeHygieneService.ts`。
- 启动时执行 `runStartupProxyRuntimeReconciliation()`：
  - 将 stale unfinished trace 扫成 `finalStatus: 'orphaned'`
  - 补写 runtime reason
  - 清理 sticky 与 Codex session response anchor 残留
- 定时执行 `startProxyRuntimeHygieneScheduler()`：
  - 周期性清扫 orphan / stale runtime
  - 将“只有重启才能恢复”的进程内脏状态清理前移到正常运行周期中

#### 2) HTTP / SSE active runtime registry 落地

- 已新增 `src/server/services/proxyActiveRuntimeRegistry.ts`。
- `responses` / `chat` stream 已接入 register / touch / finalize。
- hygiene sweep 已纳入 `evictStaleProxyActiveRuntimes(...)`。
- 当前可以按 trace 关联出：
  - `acceptedAtMs`
  - `firstByteAtMs`
  - `lastActivityAtMs`
  - `finalizedAtMs`
  - `stage`

#### 3) websocket runtime hygiene 落地

- `CodexWebsocketSession` 已补充：
  - `createdAtMs`
  - `lastActivityAtMs`
  - `lastTerminalAtMs`
  - `lastTerminalReason`
  - `lastCloseReason`
- `sharedCodexWebsocketRuntime.evictStaleSessions(...)` 已落地。
- stale websocket eviction 会记录：
  - `lastTerminalReason: 'websocket_stale_evicted'`
  - `lastCloseReason: 'proxy-runtime-hygiene'`（或调用侧传入的 closeReason）

#### 4) 只读式 runtime diagnostics 聚合已落地

- 已新增 `src/server/services/proxyDebugDiagnosticsService.ts`。
- `/api/stats/proxy-debug/traces/:id` 已返回：
  - `trace`
  - `attempts`
  - `runtimeDiagnostics`
- `runtimeDiagnostics.activeRuntime` 来自 `proxyActiveRuntimeRegistry`。
- `runtimeDiagnostics.websocketRuntime` 来自 `sharedCodexWebsocketRuntime.listSessionSnapshots()`。
- 聚合方式为按 `traceId / sessionId / traceHint` 做**只读关联**，不反向改写热路径状态。

#### 5) Proxy Logs 详情页已可读展示 runtime diagnostics

- `src/web/api.ts` 已补充 `runtimeDiagnostics` 类型。
- `src/web/pages/ProxyLogs.tsx` 已展示：
  - `Trace Summary`
  - `Runtime Diagnostics`
  - `Attempt 记录`
- 当前详情页可直接看到：
  - Active Runtime 的 stage / downstreamPath / acceptedAt / firstByte / lastActivity / finalizedAt
  - Websocket Runtime 的 sessionId / open socket / last terminal reason / last close reason / createdAt / lastActivity

### 当前已落地 reason 词表

当前不改 schema，直接复用既有字段承载细化原因：

- `finalResponseBody.metapiRuntimeReason`
- runtime reconciliation 的 `error.reason`
- websocket owner snapshot / runtime diagnostics snapshot

已落地的关键 reason 包括：

- `stream_idle_timeout`
- `stream_failed`
- `startup_reconciled_orphan`
- `runtime_scavenged_orphan`
- `response.completed`
- `websocket_stale_evicted`
- `socket_closed`
- `terminal_event`
- `proxy-runtime-hygiene`

### 已完成回归

以下关键回归已通过：

- `src/web/pages/ProxyLogs.server-driven.test.tsx`
- `src/server/routes/api/stats.proxy-debug.test.ts`
- `src/server/services/proxyDebugTraceStore.test.ts`
- `src/server/proxy-core/runtime/codexWebsocketRuntime.test.ts`
- `src/server/services/proxyRuntimeHygieneService.test.ts`
- `src/server/routes/proxy/responses.websocket.test.ts`
- `src/server/routes/proxy/responses.codex-oauth.test.ts`
- `src/server/transformers/openai/responses/proxyStream.test.ts`
- `src/server/transformers/openai/chat/proxyStream.test.ts`
- `src/server/routes/proxy/upstreamEndpoint.test.ts`
- `npm run typecheck`
- `npm run repo:drift-check`

---

## 文档范围与非目标

### 适用范围

本文档覆盖以下模块与能力边界：

- 下游客户端识别与 route class 判定
- capability contract / gate / breaker / probe
- `responses` / `chat` / `messages` / `completions` 的 family 资格约束
- continuity 决策、sticky、response anchor、session queue、websocket reuse
- 流式请求 lifecycle、runtime state、orphan cleanup、startup reconciliation
- Proxy Ops / debug trace / runtime state 运维接口与观测能力

### 非目标

以下内容不属于本次修复的主目标，不应反客为主：

- 单纯为了兼容更多“表面 OpenAI-compatible”站点而放宽 strict client 能力门槛
- 以牺牲协议正确性为代价维持旧的 sticky 命中率或 continuation 命中率
- 通过延长超时来掩盖 stream lifecycle 问题
- 用更多 fallback/retry 取代 capability gate
- 用人工重启替代 runtime reconciliation / soft recovery

---

## 决策记录与设计取舍

### 决策 1：优先正确性与可解释性，不优先保留旧行为

本次修复将允许以下“短期退化”发生：

- 某些旧的弱 continuation 路径不再自动续接
- 某些原本能“碰运气跑通”的宽松站点不再进入严格客户端候选池
- sticky/channel affinity 命中率短期下降

这些变化属于预期取舍，不能视为回归。

### 决策 2：把 `conversation_id` 降级是架构结论，不是可选优化

只要没有显式强 session continuity，`conversation_id` 就只能用于 trace correlation。后续实现不得通过其它旁路再次把 `conversation_id` 隐式提升为 routing/anchor/session lane 主键。

### 决策 3：严格客户端失败要更早、更明确，而不是更“柔和”

对 Codex/Hermes 这类 route class，本次修复后允许更早失败，但不允许更晚失败。换言之：

- 可以更早返回“无合格候选”
- 不允许继续把请求送到不兼容路径后再靠 fallback 拖延失败

### 决策 4：stream lifecycle 失败属于一等失败，不低于 403

以下失败必须被视为与协议/模型能力失败同等级别的系统错误：

- `stream_idle_timeout`
- `stream_no_terminal_event`
- `transport_half_open`
- `orphaned`

这些失败不仅要可观测，还必须参与 breaker、quarantine、recovery。

### 决策 5：放弃在 websocket route 热路径里同步 finalize debug trace

该方案已验证**不应继续推进**，原因如下：

- 在 `responsesWebsocket.ts` 热路径里同步桥接 trace finalize，会显著增加 websocket / HTTP fallback 的时序耦合。
- 实测会打坏 `responses.websocket.test.ts` 的 fallback / sequencing 主链路，出现超时与主链路行为污染。
- 这类同步写 trace 的做法让调试面反向干扰协议面，违背“观测不改写主流程”的根因修复原则。

因此当前已明确切换为：

- runtime owner 自己维护 snapshot 真值
- stats detail API 做只读聚合
- 前端直接展示聚合结果

这也是本轮 P2 的正式架构结论。

---

## 回滚与发布策略

### 发布策略

本次修复必须按阶段灰度启用，建议顺序：

1. 先上线观测字段与 explain/reason 输出
2. 再启用 strict route class 与 capability gate
3. 再启用 continuity 收紧
4. 最后启用 orphan scavenger / startup reconciliation / soft recovery

### 回滚原则

允许回滚的仅限：

- 具体阈值
- 某个 breaker TTL
- 某个 probe 频率
- 某个 route class 的灰度开关

不允许回滚的架构原则：

- `conversation_id` trace-only
- weak continuity 不进入 sticky/anchor/queue
- Codex strict responses-only eligibility
- stream 必须进入明确终态

### 灰度要求

每个阶段的行为收紧都应具备：

- feature flag / runtime switch
- explain reason 输出
- 指标对比能力
- 回滚不破坏数据结构的迁移策略

---

## 背景与现象

近期在 Hermes 对接 `metapi` 的实际运行中出现如下现象：

1. 推送或更新后，Hermes 偶发出现“持续正在输入 / 没有最终回复”。
2. 某些请求命中 403 `Model not allowed for this API key` 等错误。
3. 同类问题在重启 Hermes 后恢复正常。
4. 代码侧近期对 `responses continuity`、`sticky channel`、`channel affinity`、`tokenRouter`、`upstream endpoint runtime memory`、`runtime state ops`、`settings runtime`、`responses/codex compatibility` 做了大规模增强，说明问题并非孤立在某一模块。

这些现象共同表明：

- 当前系统对 **能力路由、会话连续性、流式终态、运行态清理** 的边界不够清晰。
- 某些错误并不是没有被感知，而是**在错误层面、错误时机、错误状态空间**中被处理，最终在客户端侧表现为 403、长时间 typing、或只有重启才能恢复。

---

## 根因总结

本问题不是单点 bug，而是以下三类架构性问题叠加：

### 根因 A：系统仍偏“模型路由”，而非“能力路由”

当前候选路由选择更多是在回答：

- “哪个 channel 看起来最可能跑这个 model？”

而不是：

- “哪个 channel / site / token / endpoint family / transport 有资格承接本次请求的完整能力契约？”

这导致：

- 先选中模型名可用的 channel
- 再由 `upstreamEndpoint` / fallback / retry 在发出请求之后补救
- 一旦 endpoint family、client compatibility、transport capability、continuation capability 不匹配，就会出现 403、unsupported endpoint、stream hang、长时间 pending

### 根因 B：continuity / sticky / anchor / queue 语义被错误耦合

当前系统里至少存在三类连续性：

1. **trace continuity**：仅用于日志、观测、关联
2. **routing continuity**：用于 sticky channel / queue / websocket lane / 租约
3. **responses continuation**：用于 `previous_response_id` / response anchor / 上游 continuation

但当前实现中，`session_id`、`conversation_id`、`continuityKey`、本地派生 session、header 推断 continuity 等信号在多个模块中被近似等价对待，导致：

- `conversation_id` 被误当作 `session_id`
- 弱 continuity 被提升成强 session identity
- sticky / anchor / queue / websocket reuse 共享同一个 session-like key 空间
- Hermes 这类没有稳定 `session_id` / `previous_response_id` 的客户端，被错误纳入 Codex 式强 continuation 体系

### 根因 C：流式请求生命周期没有统一终态模型

当前系统已具备：

- first-byte timeout
- debug trace
- runtime state ops
- failure taxonomy
- route/runtime memory

但尚未形成一套统一的流式请求终态模型，导致：

- 服务端逻辑上已失败，但客户端未收到明确终态
- 首包后静默卡死无法被统一识别为 `stream_idle_timeout`
- finalize / cleanup 没有明确 SLA
- sticky / session / runtime state 在失败后失效条件不完整
- orphaned request / half-open transport / stale active runtime 缺少系统性清理

这也是“重启后恢复正常”的核心解释：

> 当前系统存在某些进程内或持久化/半持久化 runtime state 的脏状态，只在进程生命周期结束时被被动清掉，而不是在协议终态到来时主动清掉。

---

## 不可妥协原则

后续所有实现与评审必须遵守以下原则，不能因为实现成本或改动范围而妥协：

### 原则 1：严格客户端走严格路由

- `Codex`、`Hermes` 等对 endpoint/continuation/transport 有强要求的客户端，必须走严格 route class。
- 严格客户端不能依赖“先发出请求再 fallback”的弱保证。
- 对这些客户端，错误路径必须在 dispatch 前被 capability gate 拦下，而不是 dispatch 后再补救。

### 原则 2：弱 continuity 不能驱动强状态复用

- `conversation_id`、本地派生 continuity、profile/header 猜测得到的 continuity 只允许用于 trace 或弱 hint。
- 只有显式强 continuity（例如稳定 `session_id`）才允许驱动 sticky / queue / websocket reuse / anchor inference。
- 任何弱 continuity 都不得默认派生为长期稳定 `session_id`。

### 原则 3：所有流式请求必须进入显式终态

每个 stream 在有限时间内必须进入以下终态之一：

- `completed`
- `failed`
- `aborted`
- `orphaned`

不能存在无限期“逻辑上已失败但 transport 仍像活着”的灰色状态。

### 原则 4：能力真值必须统一，且默认保守

- 未声明 ≠ 支持
- 未验证 ≠ 可用
- 文档声称支持 ≠ 可路由给严格客户端
- 真实运行样本验证通过后，才可提升为强能力真值

### 原则 5：失败不是只拿来重试，还要拿来摘除错误路径

任何明确的能力错配、协议错配、stalled stream、no terminal event、strict 403，都必须参与 breaker / gate / quarantine，而不是只影响 retry。

---

## 总体目标架构

本次修复完成后，系统应具备以下总体结构：

1. 统一由 route class 与 endpoint strict policy 决定严格客户端资格。
2. 统一由 continuity 强弱分层决定 sticky / queue / anchor / websocket reuse 是否允许。
3. 统一由 runtime owner 维护当前运行态真值，再由 diagnostics 层只读聚合展示。
4. 统一要求所有 stream 在有限时间内进入显式终态，并让 orphan / stale runtime 在启动期与运行期都可被清扫。

---

## 下一阶段建议

当前主链路根因修复已经成形，下一阶段建议聚焦在**观测消费层与运维效率**，而不是重新触碰 websocket 热路径：

### 建议 1：继续增强 Proxy Logs / Stats 的诊断可读性

优先做轻量增强，而不是扩大写路径：

- 将 runtime reason 映射为更可读的 UI 文案
- 在列表页增加轻量级 runtime 摘要 / reason badge（如确有运维价值再做）
- 把 orphan / stale runtime 的终态原因与当前 trace 状态并列展示

### 建议 2：继续补强 reason taxonomy 的消费闭环

- 让 breaker / quarantine / recovery 能更系统地消费 `stream_idle_timeout`、`runtime_scavenged_orphan` 等 reason
- 让 explain / stats / logs 使用同一套 reason vocabulary
- 保持“不改 schema、先统一真值词表”的路线，避免过早做数据库结构升级

### 建议 3：继续坚持只读聚合，不回退到热路径桥接

若后续仍需要更多 diagnostics：

- 优先从 runtime owner snapshot 增字段
- 再通过 debug diagnostics service 暴露
- 最后由前端只读展示

不要再回到 websocket route 同步 finalize trace 的设计。

---

## 结论

截至 2026-04-24，本轮 Hermes / Codex 根因修复已经不再停留在“重启可恢复”的止血层面，而是完成了以下关键闭环：

- strict client 的 endpoint 真值层收束
- weak continuity 与 strong session lane 的结构性隔离
- stream idle / failure / orphan 的显式终态闭环
- startup + runtime 双阶段 hygiene 清扫
- HTTP/SSE + websocket runtime 的统一诊断视角
- 前端可直接消费 runtime diagnostics，而不让观测反向污染热路径

后续实现应继续沿着**统一真值、只读诊断聚合、根因级 runtime hygiene**的方向推进，而不是为追求小改动重新引入旁路状态或热路径调试桥接。
