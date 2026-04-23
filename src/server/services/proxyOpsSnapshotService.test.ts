import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatUtcSqlDateTime } from './localTimeService.js';

type DbModule = typeof import('../db/index.js');
type ProxyOpsSnapshotModule = typeof import('./proxyOpsSnapshotService.js');
type RuntimeMemoryModule = typeof import('./accountDispatchRuntimeMemory.js');
type ProxyChannelCoordinatorModule = typeof import('./proxyChannelCoordinator.js');

describe('proxyOpsSnapshotService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let getProxyOpsSnapshot: ProxyOpsSnapshotModule['getProxyOpsSnapshot'];
  let recordAccountDispatchFailure: RuntimeMemoryModule['recordAccountDispatchFailure'];
  let resetAccountDispatchRuntimeMemory: RuntimeMemoryModule['resetAccountDispatchRuntimeMemory'];
  let proxyChannelCoordinator: ProxyChannelCoordinatorModule['proxyChannelCoordinator'];
  let dataDir = '';
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-ops-snapshot-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const proxyOpsSnapshotModule = await import('./proxyOpsSnapshotService.js');
    const runtimeMemoryModule = await import('./accountDispatchRuntimeMemory.js');
    const proxyChannelCoordinatorModule = await import('./proxyChannelCoordinator.js');

    db = dbModule.db;
    schema = dbModule.schema;
    getProxyOpsSnapshot = proxyOpsSnapshotModule.getProxyOpsSnapshot;
    recordAccountDispatchFailure = runtimeMemoryModule.recordAccountDispatchFailure;
    resetAccountDispatchRuntimeMemory = runtimeMemoryModule.resetAccountDispatchRuntimeMemory;
    proxyChannelCoordinator = proxyChannelCoordinatorModule.proxyChannelCoordinator;
  });

  beforeEach(async () => {
    resetAccountDispatchRuntimeMemory();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  it('keeps overview totals aggregated from all matching accounts even when the list is limited', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'proxy-ops-site',
      url: 'https://proxy-ops.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      displayName: 'GTP Route',
      enabled: true,
    }).returning().get();

    const challengedAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'challenged-user',
      accessToken: 'token-a',
      status: 'active',
      extraConfig: JSON.stringify({
        proxyOps: {
          protectionSignals: [{
            className: 'challenge_shield',
            title: 'WAF Challenge',
            summary: 'Cloudflare challenge page',
            status: 403,
            recordedAt: '2026-04-21T12:00:00.000Z',
          }],
          modelProbe: {
            lastProbeAt: '2026-04-21T12:10:00.000Z',
            scanned: 3,
            supported: 2,
            unsupported: 1,
            inconclusive: 0,
            skipped: 0,
            updatedRows: 1,
            status: 'failed',
            message: 'probe failed once',
          },
        },
      }),
    }).returning().get();

    const healthyAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'healthy-user',
      accessToken: 'token-b',
      status: 'active',
    }).returning().get();

    const idleAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'idle-user',
      accessToken: 'token-c',
      status: 'active',
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: route.id,
        accountId: challengedAccount.id,
        enabled: true,
        consecutiveFailCount: 2,
        cooldownLevel: 1,
        cooldownUntil: '2026-04-21T12:30:00.000Z',
      },
      {
        routeId: route.id,
        accountId: healthyAccount.id,
        enabled: true,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
        cooldownUntil: null,
      },
    ]).run();

    const baseTime = Date.now();
    const timestamps = [
      formatUtcSqlDateTime(new Date(baseTime - 4 * 60 * 1000)),
      formatUtcSqlDateTime(new Date(baseTime - 3 * 60 * 1000)),
      formatUtcSqlDateTime(new Date(baseTime - 2 * 60 * 1000)),
      formatUtcSqlDateTime(new Date(baseTime - 1 * 60 * 1000)),
    ];

    await db.insert(schema.proxyLogs).values([
      {
        routeId: route.id,
        accountId: challengedAccount.id,
        status: 'retried',
        httpStatus: 429,
        errorMessage: 'rate limit before fallback success',
        createdAt: timestamps[0],
      },
      {
        routeId: route.id,
        accountId: challengedAccount.id,
        status: 'success',
        httpStatus: 200,
        createdAt: timestamps[1],
      },
      {
        routeId: route.id,
        accountId: healthyAccount.id,
        status: 'success',
        httpStatus: 200,
        createdAt: timestamps[2],
      },
      {
        routeId: route.id,
        accountId: idleAccount.id,
        status: 'failed',
        httpStatus: 500,
        errorMessage: 'upstream temporarily unavailable',
        createdAt: timestamps[3],
      },
    ]).run();

    const snapshot = await getProxyOpsSnapshot({ limit: 1 });

    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.overview).toMatchObject({
      totalAccounts: 3,
      degradedAccounts: 2,
      challengeAffectedAccounts: 1,
      coveredFailures24h: 1,
      totalRequests24h: 4,
      successRequests24h: 2,
      successRate24h: 50,
    });
    expect(snapshot.accounts[0]).toMatchObject({
      accountId: challengedAccount.id,
      username: 'challenged-user',
      proxy24h: {
        total: 2,
        success: 1,
        failed: 0,
        retried: 1,
        successRate: 50,
      },
      channelHealth: {
        total: 1,
        cooling: 1,
        degraded: 1,
      },
    });
    expect(snapshot.accounts[0]?.protectionSignals[0]).toMatchObject({
      className: 'challenge_shield',
      title: 'WAF Challenge',
    });
    expect(snapshot.accounts[0]?.failureBuckets).toEqual([
      {
        className: 'rate_limit',
        title: '限流',
        count: 1,
      },
    ]);
  });

  it('counts logs from the SQL-datetime lower-bound day inside the rolling 24h window', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'proxy-ops-boundary-site',
      url: 'https://proxy-ops-boundary.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'boundary-user',
      accessToken: 'boundary-token',
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      displayName: 'Boundary Route',
      enabled: true,
    }).returning().get();

    const within24hOnBoundaryDay = formatUtcSqlDateTime(new Date(Date.now() - (23 * 60 * 60 * 1000 + 30 * 60 * 1000)));
    const olderThan24h = formatUtcSqlDateTime(new Date(Date.now() - (25 * 60 * 60 * 1000)));

    await db.insert(schema.proxyLogs).values([
      {
        routeId: route.id,
        accountId: account.id,
        status: 'retried',
        httpStatus: 429,
        errorMessage: 'rate limit before fallback success',
        createdAt: within24hOnBoundaryDay,
      },
      {
        routeId: route.id,
        accountId: account.id,
        status: 'failed',
        httpStatus: 500,
        errorMessage: 'too old to count',
        createdAt: olderThan24h,
      },
    ]).run();

    const snapshot = await getProxyOpsSnapshot();

    expect(snapshot.overview.totalRequests24h).toBe(1);
    expect(snapshot.overview.coveredFailures24h).toBe(1);
    expect(snapshot.accounts[0]?.proxy24h).toMatchObject({
      total: 1,
      retried: 1,
      failed: 0,
    });
  });

  it('includes live lease pressure and typed suppression reasons for account rows', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'proxy-ops-live-site',
      url: 'https://proxy-ops-live.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o',
      displayName: 'Live Route',
      enabled: true,
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'session-user',
      accessToken: 'session-token',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      enabled: true,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
      cooldownUntil: null,
    }).returning().get();

    const lease1 = await proxyChannelCoordinator.acquireChannelLease({
      channelId: channel.id,
      accountExtraConfig: account.extraConfig,
      accountOauthProvider: account.oauthProvider,
    });
    const lease2 = await proxyChannelCoordinator.acquireChannelLease({
      channelId: channel.id,
      accountExtraConfig: account.extraConfig,
      accountOauthProvider: account.oauthProvider,
    });
    const waitingLeasePromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: channel.id,
      accountExtraConfig: account.extraConfig,
      accountOauthProvider: account.oauthProvider,
    });
    await Promise.resolve();

    recordAccountDispatchFailure({
      routeId: route.id,
      modelName: 'gpt-4o',
      accountId: account.id,
      kind: 'soft',
      reason: 'pending_overload',
      nowMs: Date.now() - 60 * 1000,
    });

    const snapshot = await getProxyOpsSnapshot({ accountId: account.id });

    expect(snapshot.accounts[0]).toMatchObject({
      accountId: account.id,
      liveLoad: {
        activeLeaseCount: 2,
        waitingCount: 1,
        saturatedChannels: 1,
        sessionScopedChannels: 1,
      },
      dispatchSuppression: {
        total: 1,
        reasons: [
          {
            reason: 'pending_overload',
            count: 1,
          },
        ],
      },
    });
    expect(snapshot.accounts[0]?.dispatchSuppression.entries[0]).toMatchObject({
      routeId: route.id,
      modelName: 'gpt-4o',
      status: 'degraded',
      suppressionReason: 'pending_overload',
    });

    if (lease1.status === 'acquired') lease1.lease.release();
    if (lease2.status === 'acquired') lease2.lease.release();
    const waitingLease = await waitingLeasePromise;
    if (waitingLease.status === 'acquired') waitingLease.lease.release();
  });
});
