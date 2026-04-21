import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { mergeAccountExtraConfig } from '../accountExtraConfig.js';
import { setAccountRuntimeHealth } from '../accountHealthService.js';
import { invalidateTokenRouterCache } from '../tokenRouter.js';
import { getOauthInfoFromAccount } from './oauthAccount.js';
import {
  buildFailedOauthRefreshRuntime,
  buildRefreshingOauthRefreshRuntime,
  buildSuccessfulOauthRefreshRuntime,
  buildTerminalOauthRefreshRuntime,
  getOauthRefreshBackoffReason,
  getOauthRefreshRuntimeState,
  isOauthRefreshLeaseActive,
  isTerminalOauthRefreshError,
  OAUTH_REFRESH_POST_LEASE_GRACE_MS,
  OAUTH_REFRESH_WAIT_POLL_MS,
  OAUTH_REFRESH_WAIT_TIMEOUT_MS,
  type OauthRefreshRuntimeState,
} from './refreshGovernance.js';
import { refreshOauthAccessToken } from './service.js';

const refreshInFlight = new Map<number, Promise<Awaited<ReturnType<typeof refreshOauthAccessToken>>>>();
let refreshOwnerSeq = 0;

type AccountRow = typeof schema.accounts.$inferSelect;

type LeaseAcquireResult =
  | { kind: 'owned'; leaseStartedAt: string; ownerId: string }
  | { kind: 'remote'; observedLeaseStartedAt: string | null };

function buildRefreshOwnerId(): string {
  refreshOwnerSeq += 1;
  return `pid:${process.pid}:oauth-refresh:${Date.now()}:${refreshOwnerSeq}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAccountSnapshotWhere(account: Pick<AccountRow, 'id' | 'updatedAt' | 'extraConfig'>) {
  return and(
    eq(schema.accounts.id, account.id),
    account.updatedAt == null ? isNull(schema.accounts.updatedAt) : eq(schema.accounts.updatedAt, account.updatedAt),
    account.extraConfig == null ? isNull(schema.accounts.extraConfig) : eq(schema.accounts.extraConfig, account.extraConfig),
  );
}

function extractChanges(result: unknown): number {
  if (result && typeof result === 'object') {
    const direct = Number((result as { changes?: unknown }).changes);
    if (Number.isFinite(direct)) return direct;
    const rows = (result as { rows?: Array<{ changes?: unknown }> }).rows;
    const nested = Number(rows?.[0]?.changes);
    if (Number.isFinite(nested)) return nested;
  }
  return 0;
}

function toComparableTs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTsAtOrAfter(value?: string | null, reference?: string | null): boolean {
  if (!value) return false;
  if (!reference) return true;
  const left = toComparableTs(value);
  const right = toComparableTs(reference);
  if (left == null || right == null) return false;
  return left >= right;
}

function hasObservedRemoteSuccess(runtime: OauthRefreshRuntimeState, observedLeaseStartedAt?: string | null): boolean {
  return runtime.status === 'success' && isTsAtOrAfter(runtime.lastSuccessAt, observedLeaseStartedAt);
}

function buildCurrentRefreshResult(account: AccountRow): Awaited<ReturnType<typeof refreshOauthAccessToken>> {
  const oauth = getOauthInfoFromAccount(account);
  return {
    accountId: account.id,
    accessToken: account.accessToken,
    accountKey: oauth?.accountKey || oauth?.accountId,
    extraConfig: typeof account.extraConfig === 'string'
      ? account.extraConfig
      : mergeAccountExtraConfig(account.extraConfig, {}),
  };
}

async function loadAccount(accountId: number): Promise<AccountRow> {
  const account = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) {
    throw new Error('oauth account not found');
  }
  return account;
}

async function waitForRemoteRefresh(
  accountId: number,
  observedLeaseStartedAt?: string | null,
): Promise<Awaited<ReturnType<typeof refreshOauthAccessToken>> | null> {
  const deadline = Date.now() + OAUTH_REFRESH_WAIT_TIMEOUT_MS;
  let latestObservedLeaseStartedAt = observedLeaseStartedAt ?? null;
  let leaseLostAtMs: number | null = null;

  while (Date.now() < deadline) {
    const account = await loadAccount(accountId);
    const runtime = getOauthRefreshRuntimeState(account.extraConfig);
    const backoffReason = getOauthRefreshBackoffReason(runtime);
    if (backoffReason) {
      throw new Error(backoffReason);
    }

    if (isOauthRefreshLeaseActive(runtime)) {
      latestObservedLeaseStartedAt = runtime.lease?.startedAt || latestObservedLeaseStartedAt;
      leaseLostAtMs = null;
      await sleep(OAUTH_REFRESH_WAIT_POLL_MS);
      continue;
    }

    if (hasObservedRemoteSuccess(runtime, latestObservedLeaseStartedAt)) {
      return buildCurrentRefreshResult(account);
    }

    if (latestObservedLeaseStartedAt) {
      const nowMs = Date.now();
      const graceMs = Math.max(OAUTH_REFRESH_WAIT_POLL_MS, OAUTH_REFRESH_POST_LEASE_GRACE_MS);
      leaseLostAtMs ??= nowMs;
      if (nowMs < Math.min(deadline, leaseLostAtMs + graceMs)) {
        await sleep(OAUTH_REFRESH_WAIT_POLL_MS);
        continue;
      }
    }

    return null;
  }

  throw new Error('oauth refresh wait timed out');
}

async function acquireOauthRefreshLease(accountId: number, ownerId: string): Promise<LeaseAcquireResult> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const account = await loadAccount(accountId);
    const runtime = getOauthRefreshRuntimeState(account.extraConfig);

    const blockedReason = getOauthRefreshBackoffReason(runtime);
    if (blockedReason) {
      throw new Error(blockedReason);
    }

    if (isOauthRefreshLeaseActive(runtime)) {
      return {
        kind: 'remote',
        observedLeaseStartedAt: runtime.lease?.startedAt || runtime.lastAttemptAt || null,
      };
    }

    const nextRuntime = buildRefreshingOauthRefreshRuntime(runtime, { ownerId });
    const nextExtraConfig = mergeAccountExtraConfig(account.extraConfig, {
      oauthRefreshRuntime: nextRuntime,
    });
    const result = await db.update(schema.accounts)
      .set({
        extraConfig: nextExtraConfig,
        updatedAt: new Date().toISOString(),
      })
      .where(buildAccountSnapshotWhere(account))
      .run();

    if (extractChanges(result) > 0) {
      return {
        kind: 'owned',
        leaseStartedAt: nextRuntime.lease?.startedAt || nextRuntime.lastAttemptAt || new Date().toISOString(),
        ownerId,
      };
    }

    await sleep(25);
  }

  throw new Error('oauth refresh lease acquisition exhausted');
}

async function finalizeOauthRefreshSuccess(
  accountId: number,
  ownerId: string,
  refreshed: Awaited<ReturnType<typeof refreshOauthAccessToken>>,
  leaseStartedAt?: string | null,
): Promise<Awaited<ReturnType<typeof refreshOauthAccessToken>>> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const account = await loadAccount(accountId);
    const runtime = getOauthRefreshRuntimeState(account.extraConfig);

    if (runtime.lease?.ownerId !== ownerId) {
      if (refreshed.accessToken && account.accessToken === refreshed.accessToken) {
        const nextRuntime = buildSuccessfulOauthRefreshRuntime(runtime);
        const nextExtraConfig = mergeAccountExtraConfig(account.extraConfig, {
          oauthRefreshRuntime: nextRuntime,
        });
        const healResult = await db.update(schema.accounts)
          .set({
            extraConfig: nextExtraConfig,
            status: 'active',
            updatedAt: new Date().toISOString(),
          })
          .where(buildAccountSnapshotWhere(account))
          .run();
        if (extractChanges(healResult) > 0) {
          await setAccountRuntimeHealth(accountId, {
            state: 'healthy',
            reason: 'OAuth 刷新成功',
            source: 'oauth-refresh',
          });
          invalidateTokenRouterCache();
          return {
            ...buildCurrentRefreshResult({
              ...account,
              extraConfig: nextExtraConfig,
              status: 'active',
            }),
            accessToken: account.accessToken,
            extraConfig: nextExtraConfig,
          };
        }
        const reloadedAccount = await loadAccount(accountId);
        if (reloadedAccount.accessToken === refreshed.accessToken) {
          return buildCurrentRefreshResult(reloadedAccount);
        }
      }
      if (hasObservedRemoteSuccess(runtime, leaseStartedAt)) {
        return buildCurrentRefreshResult(account);
      }
      const waited = await waitForRemoteRefresh(accountId, runtime.lease?.startedAt || leaseStartedAt || runtime.lastAttemptAt || null);
      if (waited) {
        return waited;
      }
      return executeRefreshWithGovernance(accountId);
    }

    const nextRuntime = buildSuccessfulOauthRefreshRuntime(runtime);
    const nextExtraConfig = mergeAccountExtraConfig(account.extraConfig, {
      oauthRefreshRuntime: nextRuntime,
    });
    const nextAccessToken = refreshed.accessToken || account.accessToken;
    const result = await db.update(schema.accounts)
      .set({
        accessToken: nextAccessToken,
        extraConfig: nextExtraConfig,
        status: 'active',
        updatedAt: new Date().toISOString(),
      })
      .where(buildAccountSnapshotWhere(account))
      .run();

    if (extractChanges(result) > 0) {
      await setAccountRuntimeHealth(accountId, {
        state: 'healthy',
        reason: 'OAuth 刷新成功',
        source: 'oauth-refresh',
      });
      invalidateTokenRouterCache();
      return {
        ...refreshed,
        accountId,
        accessToken: nextAccessToken,
        extraConfig: nextExtraConfig,
      };
    }
  }

  throw new Error('oauth refresh success finalize exhausted');
}

async function finalizeOauthRefreshFailure(
  accountId: number,
  ownerId: string,
  error: unknown,
  leaseStartedAt?: string | null,
): Promise<never> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const account = await loadAccount(accountId);
    const runtime = getOauthRefreshRuntimeState(account.extraConfig);

    if (runtime.lease?.ownerId !== ownerId) {
      if (hasObservedRemoteSuccess(runtime, leaseStartedAt)) {
        const remoteResult = buildCurrentRefreshResult(account);
        return remoteResult as never;
      }
      const waited = await waitForRemoteRefresh(accountId, runtime.lease?.startedAt || leaseStartedAt || runtime.lastAttemptAt || null);
      if (waited) {
        return waited as never;
      }
      return executeRefreshWithGovernance(accountId) as never;
    }

    const nextRuntime = isTerminalOauthRefreshError(error)
      ? buildTerminalOauthRefreshRuntime(runtime, { error })
      : buildFailedOauthRefreshRuntime(runtime, { error });
    const nextExtraConfig = mergeAccountExtraConfig(account.extraConfig, {
      oauthRefreshRuntime: nextRuntime,
    });
    const result = await db.update(schema.accounts)
      .set({
        extraConfig: nextExtraConfig,
        updatedAt: new Date().toISOString(),
      })
      .where(buildAccountSnapshotWhere(account))
      .run();

    if (extractChanges(result) > 0) {
      await setAccountRuntimeHealth(accountId, {
        state: nextRuntime.consecutiveFailures >= 3 ? 'unhealthy' : 'degraded',
        reason: `OAuth 刷新失败：${nextRuntime.lastError || 'unknown error'}`,
        source: 'oauth-refresh',
      });
      invalidateTokenRouterCache();
      throw (error instanceof Error ? error : new Error(String(error || 'oauth refresh failed')));
    }
  }

  throw (error instanceof Error ? error : new Error(String(error || 'oauth refresh failed')));
}

async function executeRefreshWithGovernance(accountId: number): Promise<Awaited<ReturnType<typeof refreshOauthAccessToken>>> {
  while (true) {
    const ownerId = buildRefreshOwnerId();
    const acquired = await acquireOauthRefreshLease(accountId, ownerId);

    if (acquired.kind === 'remote') {
      const waited = await waitForRemoteRefresh(accountId, acquired.observedLeaseStartedAt);
      if (waited) {
        return waited;
      }
      continue;
    }

    try {
      const refreshed = await refreshOauthAccessToken(accountId);
      return await finalizeOauthRefreshSuccess(accountId, acquired.ownerId, refreshed, acquired.leaseStartedAt);
    } catch (error) {
      return finalizeOauthRefreshFailure(accountId, acquired.ownerId, error, acquired.leaseStartedAt);
    }
  }
}

export async function refreshOauthAccessTokenSingleflight(accountId: number) {
  const existing = refreshInFlight.get(accountId);
  if (existing) {
    return existing;
  }

  const promise = executeRefreshWithGovernance(accountId).finally(() => {
    refreshInFlight.delete(accountId);
  });
  refreshInFlight.set(accountId, promise);
  return promise;
}

export async function __resetRefreshSingleflightForTests(): Promise<void> {
  refreshInFlight.clear();
  refreshOwnerSeq = 0;
}
