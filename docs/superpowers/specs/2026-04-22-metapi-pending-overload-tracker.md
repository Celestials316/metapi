# metapi pending-overload 治理追踪文档

> **For Hermes:** 先按本文档顺序推进；每完成一个条目先跑对应小测试，通过后再把状态从 `[ ]` 改成 `[x]`；全部完成后再做独立审查、门禁回归、提交与推送。

## 1. 目标

针对近期 `Codex /responses` 多分支并发后出现的：

- `Upstream returned HTTP 429: Too many pending requests, please retry later`
- `fetch failed: read ECONNRESET`
- 通用 `An error occurred while processing your request`

补齐 metapi 在 **pending-overload / 单账号并发挤压** 方向的工程化治理，重点把“失败后降权”往“派发前避让 / 短时摘除过热账号”推进。

## 2. 完成定义

本轮至少完成以下首批收口：

1. `pending_overload` 成为稳定 failure taxonomy，而不是继续混在 generic `rate_limit` 里。
2. `TokenRouter` 在识别到 pending-overload 后，会对对应 `account / credential scope` 建立短时过载冷却，新的选路不会继续命中该账号。
3. 成功恢复或探测成功后，会清理对应过载状态，避免账号被永久卡死。
4. 相关设置项可在 runtime settings 中查看/调整，并能通过前端 Settings 页面保存。
5. 至少补齐：
   - taxonomy 单测
   - selection / cooldown 行为单测
   - settings 前后端单测
6. 实现完成后必须经过：
   - 定向 vitest 门禁
   - 独立 reviewer 线程审查 diff
   - 审查通过后再 commit / push

## 3. 执行规则

- 完成一个点 → 跑一个小测试 → 通过后更新本文档状态。
- 所有代码改动都以最小改动原则推进，不重做既有 routing / runtime health 主链。
- 本轮优先做 **P0 首批收口**；P1 / P2 先写清单，不在本轮一次性全做完。
- push 前必须：
  - 先跑定向门禁
  - 再开独立线程做 diff 审查
  - 审查通过后使用仓库归属账号提交并推送

## 4. 当前真实基线

### 4.1 线上已确认事实

- `019db34d*` 这批 session 的主错误不是 metapi 本地 `Channel busy`，而是上游：
  - `Too many pending requests, please retry later`
  - `ECONNRESET`
  - 通用 processing error
- 近期事故集中在：
  - `route_id = 1088`
  - `channel_id = 2492`
  - `account_id = 61`
- 同时段无 `Channel busy`，说明并不是单纯被现有 `proxySessionChannelConcurrencyLimit` 挡住，而是**上游账号被 pending request 挤压后返回 429 / transport 抖动**。

### 4.2 当前代码基线

- 已有：
  - `proxyFailureTaxonomy.ts`
  - `proxyRetryPolicy.ts`
  - `proxyChannelCoordinator.ts`
  - `sharedSurface.ts`
  - `Proxy Ops / Proxy Logs`
- 当前缺口：
  - `pending requests` 没有 failure taxonomy 专项类
  - 选路前没有 account pending-overload 的硬 gate
  - 只有 channel/session lease 与失败后 cooldown，不足以避免同一账号被持续打满

## 5. 当前总状态

- 当前阶段：**本轮 pending_overload 治理闭环已完成并推送到 `main`**
- 当前轮次目标：**P0-1 ~ P0-3 最小闭环**
- 用户追加验收：**此前对比 sub2api / new-api 提炼出的高价值吸收点，必须确认已在现有代码或本次改动中全部落地到位**
- 当前阻塞：无；后续如需继续增强，转入新增需求而非本轮阻塞

## 6. P0 清单（本轮）

### P0-1 `pending_overload` failure taxonomy
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 在 `proxyFailureTaxonomy.ts` 中把 `Too many pending requests / pending requests / retry later` 这类错误归类为 `pending_overload`
  - 与 generic `rate_limit`、`quota_exceeded` 分开
- 计划落点：
  - `src/server/services/proxyFailureTaxonomy.ts`
  - `src/server/services/proxyRetryPolicy.ts`
  - 相关测试文件
- 小测试：
  ```bash
  npx vitest run src/server/services/proxyFailureTaxonomy.test.ts src/server/services/proxyRetryPolicy.test.ts
  ```
- 完成标准：
  - `Too many pending requests, please retry later` 被稳定识别成 `pending_overload`
  - retry policy 对新类保持明确语义

### P0-2 account pending-overload 冷却与选路阻断
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - `TokenRouter.recordFailure(...)` 识别 pending-overload 后，为对应账号写入短时过载冷却
  - `getCandidateEligibilityReasons(...)` / route unit member eligibility 会排除仍在过载窗口内的账号
  - `recordSuccess(...)` / `recordProbeSuccess(...)` 恢复成功后清理状态
- 计划落点：
  - `src/server/services/tokenRouter.ts`
  - 如需拆模块：`src/server/services/accountOverloadRuntimeMemory.ts`
  - `src/server/services/tokenRouter.selection.test.ts`
- 小测试：
  ```bash
  npx vitest run src/server/services/tokenRouter.selection.test.ts
  ```
- 完成标准：
  - 同账号触发 pending-overload 后，新的选路会避开该账号
  - 成功恢复后可重新参与选路

### P0-3 runtime settings 暴露 pending-overload knob
- 状态：**已完成**
- 任务标记：`[x]`
- 目标：
  - 增加 pending-overload 冷却时长配置
  - 后端 settings hydrate / save / get 接线
  - 前端 Settings 页面可展示并保存
- 计划落点：
  - `src/server/config.ts`
  - `src/server/runtimeSettingsHydration.ts`
  - `src/server/routes/api/settings.ts`
  - `src/web/api.ts`
  - `src/web/pages/Settings.tsx`
  - `src/web/pages/settings.proxy-transport.test.tsx`
- 小测试：
  ```bash
  npx vitest run src/web/pages/settings.proxy-transport.test.tsx src/server/runtimeSettingsHydration.test.ts src/server/routes/api/settings.events.test.ts
  ```
- 完成标准：
  - runtime settings 能读写新配置
  - Settings 页面可见并保存

## 7. P1 清单（暂不在本轮阻塞）

### P1-1 Proxy Ops 热点 / pending-overload 可视化
- 状态：**待执行**
- 任务标记：`[ ]`
- 计划：在 Proxy Ops / Proxy Logs 中把 `pending_overload` 作为独立 failure bucket 和筛选项展示

### P1-2 account-aware live load / waiting 观测
- 状态：**待执行**
- 任务标记：`[ ]`
- 计划：把 route / channel / account 的 waiting / active 热点做成常驻可观测项

## 8. P2 清单（暂不在本轮阻塞）

### P2-1 account/credential 级并发预算
- 状态：**待执行**
- 任务标记：`[ ]`
- 计划：从仅 channel/session lease 进一步升级到 account/credential-level 的并发预算

### P2-2 overload runtime state 跨实例共享
- 状态：**待执行**
- 任务标记：`[ ]`
- 计划：把 pending-overload runtime 从进程内态推进到共享真值源

## 9. 本轮推进顺序

1. 建立追踪文档并回填真实基线
2. 做 P0-1：taxonomy
3. 做 P0-2：router 过载冷却 / eligibility gate
4. 做 P0-3：settings 接线
5. 跑定向门禁
6. 开独立线程审查 diff / 潜在回归
7. 审查通过后 commit / push

## 10. 最终收口清单

- [x] 追踪文档已创建并与真实状态一致
- [x] P0-1 完成且小测试通过
- [x] P0-2 完成且小测试通过
- [x] P0-3 完成且小测试通过
- [x] 定向门禁通过
- [x] 独立 reviewer 审查通过
- [x] git diff / status 清晰可提交
- [x] 使用正确 GitHub 账号提交并推送

## 11. 最终收口记录

- 当前：已完成
- 备注：
  - 定向门禁：`npx vitest run src/server/services/tokenRouter.selection.test.ts src/server/services/proxyRetryPolicy.test.ts src/server/services/proxyFailureTaxonomy.test.ts src/server/runtimeSettingsHydration.test.ts src/server/routes/api/settings.events.test.ts src/web/pages/settings.proxy-transport.test.tsx src/server/services/proxyOpsSnapshotService.test.ts src/server/routes/api/stats.proxy-logs.test.ts src/web/pages/ProxyOps.test.tsx src/web/pages/ProxyLogs.server-driven.test.tsx` ✅（`10 files passed / 110 tests passed`）
  - 额外门禁：`npm run typecheck` ✅；`npm run repo:drift-check` ✅（`Violations: 0`）
  - 独立 reviewer：通过，确认 pending_overload 闭环与此前 sub2api / new-api 高价值吸收点在当前仓库 + 本次改动下无新的 must-fix 缺口
  - 提交：`7f54af505c80fcff71ab95f1b5245b534bee7504` `完善 pending_overload 治理闭环与设置链路`
