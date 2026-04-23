import { and, desc, eq, gte } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { classifyProxyFailure, type ProxyFailureClass } from './proxyFailureTaxonomy.js';
import { getProxyOpsState } from './proxyOpsSignals.js';
import {
  listAccountDispatchRuntimeSnapshots,
  type AccountDispatchRuntimeStatus,
  type AccountDispatchSuppressionReason,
} from './accountDispatchRuntimeMemory.js';
import { proxyChannelCoordinator } from './proxyChannelCoordinator.js';

type ProxyOpsAccountLiveLoad = {
  activeLeaseCount: number;
  waitingCount: number;
  saturatedChannels: number;
  sessionScopedChannels: number;
};

type ProxyOpsAccountSuppressionEntry = {
  routeId: number;
  modelName: string;
  status: AccountDispatchRuntimeStatus;
  suppressionReason: AccountDispatchSuppressionReason | null;
  updatedAt: string;
  holdUntil: string | null;
};

export type ProxyOpsAccountSnapshot = {
  accountId: number;
  username: string | null;
  siteId: number;
  siteName: string | null;
  siteUrl: string | null;
  accountStatus: string | null;
  channelHealth: {
    total: number;
    cooling: number;
    degraded: number;
  };
  proxy24h: {
    total: number;
    success: number;
    failed: number;
    retried: number;
    successRate: number;
  };
  failureBuckets: Array<{
    className: ProxyFailureClass;
    title: string;
    count: number;
  }>;
  latestFailure: {
    className: ProxyFailureClass;
    title: string;
    summary: string;
    recordedAt: string;
    httpStatus: number | null;
  } | null;
  modelProbe: ReturnType<typeof getProxyOpsState>['modelProbe'];
  refresh: ReturnType<typeof getProxyOpsState>['refresh'];
  recoverySignals: ReturnType<typeof getProxyOpsState>['recoverySignals'];
  protectionSignals: ReturnType<typeof getProxyOpsState>['protectionSignals'];
  liveLoad: ProxyOpsAccountLiveLoad;
  dispatchSuppression: {
    total: number;
    reasons: Array<{
      reason: AccountDispatchSuppressionReason;
      count: number;
    }>;
    entries: ProxyOpsAccountSuppressionEntry[];
  };
  opsScore: number;
};

export type ProxyOpsSnapshot = {
  generatedAt: string;
  overview: {
    totalAccounts: number;
    degradedAccounts: number;
    challengeAffectedAccounts: number;
    coveredFailures24h: number;
    totalRequests24h: number;
    successRequests24h: number;
    successRate24h: number;
  };
  failureBuckets24h: Array<{
    className: ProxyFailureClass;
    title: string;
    count: number;
  }>;
  accounts: ProxyOpsAccountSnapshot[];
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toIsoDateTime(ms?: number | null): string | null {
  if (!Number.isFinite(ms as number) || Number(ms) <= 0) return null;
  return new Date(Number(ms)).toISOString();
}

export async function getProxyOpsSnapshot(input: {
  accountId?: number | null;
  limit?: number;
} = {}): Promise<ProxyOpsSnapshot> {
  const now = new Date();
  const since24h = formatUtcSqlDateTime(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const limit = Number.isFinite(input.limit as number) ? Math.max(1, Math.min(200, Math.trunc(Number(input.limit)))) : 100;

  const accountRowsQuery = db.select({
    account: schema.accounts,
    site: schema.sites,
  }).from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id));
  const accountRows = input.accountId
    ? await accountRowsQuery.where(eq(schema.accounts.id, input.accountId)).all()
    : await accountRowsQuery.all();
  const accountIds = accountRows.map((row) => row.account.id);
  if (accountIds.length <= 0) {
    return {
      generatedAt: now.toISOString(),
      overview: {
        totalAccounts: 0,
        degradedAccounts: 0,
        challengeAffectedAccounts: 0,
        coveredFailures24h: 0,
        totalRequests24h: 0,
        successRequests24h: 0,
        successRate24h: 0,
      },
      failureBuckets24h: [],
      accounts: [],
    };
  }

  const [channelRows, logRows] = await Promise.all([
    db.select().from(schema.routeChannels).all().then((rows) => rows.filter((row) => accountIds.includes(row.accountId))),
    db.select().from(schema.proxyLogs)
      .where(gte(schema.proxyLogs.createdAt, since24h))
      .all()
      .then((rows) => rows.filter((row) => Number.isFinite(row.accountId as number) && accountIds.includes(Number(row.accountId)))),
  ]);

  const channelsByAccount = new Map<number, typeof schema.routeChannels.$inferSelect[]>();
  for (const row of channelRows) {
    const list = channelsByAccount.get(row.accountId) || [];
    list.push(row);
    channelsByAccount.set(row.accountId, list);
  }

  const logsByAccount = new Map<number, typeof schema.proxyLogs.$inferSelect[]>();
  for (const row of logRows) {
    const accountId = Number(row.accountId);
    const list = logsByAccount.get(accountId) || [];
    list.push(row);
    logsByAccount.set(accountId, list);
  }

  const accountById = new Map<number, typeof schema.accounts.$inferSelect>(
    accountRows.map((row) => [row.account.id, row.account]),
  );
  const channelLoadSnapshots = proxyChannelCoordinator.getChannelLoadSnapshots(channelRows.map((row) => {
    const account = accountById.get(row.accountId);
    return {
      channelId: row.id,
      accountExtraConfig: account?.extraConfig,
      accountOauthProvider: account?.oauthProvider,
    };
  }));

  const dispatchRuntimeByAccount = new Map<number, ReturnType<typeof listAccountDispatchRuntimeSnapshots>>();
  for (const accountId of accountIds) {
    dispatchRuntimeByAccount.set(accountId, listAccountDispatchRuntimeSnapshots({ accountId, nowMs: now.getTime() }));
  }

  const globalFailureBuckets = new Map<ProxyFailureClass, { title: string; count: number }>();

  const allAccounts = accountRows.map((row): ProxyOpsAccountSnapshot => {
    const opsState = getProxyOpsState(row.account.extraConfig);
    const accountChannels = channelsByAccount.get(row.account.id) || [];
    const accountLogs = (logsByAccount.get(row.account.id) || []).slice().sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));

    let success = 0;
    let failed = 0;
    let retried = 0;
    let latestFailure: ProxyOpsAccountSnapshot['latestFailure'] = null;
    const perAccountBuckets = new Map<ProxyFailureClass, { title: string; count: number }>();

    for (const log of accountLogs) {
      if (log.status === 'success') success += 1;
      else if (log.status === 'retried') retried += 1;
      else failed += 1;

      if (log.status !== 'success') {
        const classified = classifyProxyFailure({
          status: log.httpStatus,
          errorMessage: log.errorMessage,
        });
        const currentBucket = perAccountBuckets.get(classified.className) || { title: classified.title, count: 0 };
        currentBucket.count += 1;
        perAccountBuckets.set(classified.className, currentBucket);

        const globalBucket = globalFailureBuckets.get(classified.className) || { title: classified.title, count: 0 };
        globalBucket.count += 1;
        globalFailureBuckets.set(classified.className, globalBucket);

        if (!latestFailure) {
          latestFailure = {
            className: classified.className,
            title: classified.title,
            summary: classified.summary,
            recordedAt: String(log.createdAt || new Date().toISOString()),
            httpStatus: Number.isFinite(log.httpStatus as number) ? Number(log.httpStatus) : null,
          };
        }
      }
    }

    const total = accountLogs.length;
    const cooling = accountChannels.filter((item) => !!item.cooldownUntil).length;
    const degradedChannels = accountChannels.filter((item) => !!item.cooldownUntil || (item.consecutiveFailCount ?? 0) > 0 || (item.cooldownLevel ?? 0) > 0).length;
    const protectionSignals = opsState.protectionSignals || [];
    const liveLoadSnapshots = accountChannels
      .map((item) => channelLoadSnapshots.get(item.id))
      .filter((item): item is NonNullable<typeof item> => !!item);
    const liveLoad: ProxyOpsAccountLiveLoad = {
      activeLeaseCount: liveLoadSnapshots.reduce((sum, item) => sum + item.activeLeaseCount, 0),
      waitingCount: liveLoadSnapshots.reduce((sum, item) => sum + item.waitingCount, 0),
      saturatedChannels: liveLoadSnapshots.filter((item) => item.saturated || item.waitingCount > 0).length,
      sessionScopedChannels: liveLoadSnapshots.filter((item) => item.sessionScoped).length,
    };
    const dispatchRuntimeSnapshots = dispatchRuntimeByAccount.get(row.account.id) || [];
    const suppressionEntries = dispatchRuntimeSnapshots
      .filter((item) => !!item.suppressionReason)
      .map((item): ProxyOpsAccountSuppressionEntry => ({
        routeId: item.routeId,
        modelName: item.modelName,
        status: item.status,
        suppressionReason: item.suppressionReason,
        updatedAt: toIsoDateTime(item.updatedAtMs) || now.toISOString(),
        holdUntil: toIsoDateTime(item.holdUntilMs),
      }));
    const suppressionReasonCounts = new Map<AccountDispatchSuppressionReason, number>();
    for (const item of suppressionEntries) {
      if (!item.suppressionReason) continue;
      suppressionReasonCounts.set(item.suppressionReason, (suppressionReasonCounts.get(item.suppressionReason) || 0) + 1);
    }
    const dispatchSuppression = {
      total: suppressionEntries.length,
      reasons: Array.from(suppressionReasonCounts.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason, 'en')),
      entries: suppressionEntries,
    };

    const failureBuckets = Array.from(perAccountBuckets.entries())
      .map(([className, bucket]) => ({ className, title: bucket.title, count: bucket.count }))
      .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title, 'zh-CN'));

    const successRate = total > 0 ? round2((success / total) * 100) : 100;
    let opsScore = 100;
    opsScore -= Math.min(35, degradedChannels * 10);
    opsScore -= Math.min(25, failureBuckets.reduce((sum, bucket) => sum + bucket.count, 0) * 2);
    opsScore -= Math.min(20, retried * 2);
    if (opsState.modelProbe?.status === 'failed') opsScore -= 10;
    if (latestFailure?.className?.startsWith('challenge_')) opsScore -= 10;
    opsScore = Math.max(0, Math.round(opsScore));

    return {
      accountId: row.account.id,
      username: row.account.username || null,
      siteId: row.site.id,
      siteName: row.site.name || null,
      siteUrl: row.site.url || null,
      accountStatus: row.account.status || null,
      channelHealth: {
        total: accountChannels.length,
        cooling,
        degraded: degradedChannels,
      },
      proxy24h: {
        total,
        success,
        failed,
        retried,
        successRate,
      },
      failureBuckets,
      latestFailure,
      modelProbe: opsState.modelProbe || null,
      refresh: opsState.refresh || null,
      recoverySignals: opsState.recoverySignals || [],
      protectionSignals,
      liveLoad,
      dispatchSuppression,
      opsScore,
    };
  }).sort((left, right) => left.opsScore - right.opsScore || right.proxy24h.failed - left.proxy24h.failed);

  const accounts = allAccounts.slice(0, limit);

  const totalRequests24h = allAccounts.reduce((sum, item) => sum + item.proxy24h.total, 0);
  const successRequests24h = allAccounts.reduce((sum, item) => sum + item.proxy24h.success, 0);
  const coveredFailures24h = allAccounts.reduce((sum, item) => sum + item.proxy24h.retried, 0);
  const degradedAccounts = allAccounts.filter((item) => item.channelHealth.degraded > 0 || item.proxy24h.failed > 0 || (item.modelProbe?.status === 'failed')).length;
  const challengeAffectedAccounts = allAccounts.filter((item) => (
    item.failureBuckets.some((bucket) => bucket.className.startsWith('challenge_'))
    || item.protectionSignals.some((signal) => String(signal.className || '').startsWith('challenge_'))
  )).length;

  return {
    generatedAt: now.toISOString(),
    overview: {
      totalAccounts: allAccounts.length,
      degradedAccounts,
      challengeAffectedAccounts,
      coveredFailures24h,
      totalRequests24h,
      successRequests24h,
      successRate24h: totalRequests24h > 0 ? round2((successRequests24h / totalRequests24h) * 100) : 100,
    },
    failureBuckets24h: Array.from(globalFailureBuckets.entries())
      .map(([className, bucket]) => ({ className, title: bucket.title, count: bucket.count }))
      .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title, 'zh-CN')),
    accounts,
  };
}
