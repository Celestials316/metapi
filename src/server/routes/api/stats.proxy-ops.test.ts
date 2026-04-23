import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';

const {
  getProxyOpsSnapshotMock,
  runChannelRecoveryProbeSweepMock,
  getProxyOpsRuntimeStateSnapshotMock,
  clearProxyOpsRuntimeStateMock,
} = vi.hoisted(() => ({
  getProxyOpsSnapshotMock: vi.fn(),
  runChannelRecoveryProbeSweepMock: vi.fn(),
  getProxyOpsRuntimeStateSnapshotMock: vi.fn(),
  clearProxyOpsRuntimeStateMock: vi.fn(),
}));

vi.mock('../../services/proxyOpsSnapshotService.js', () => ({
  getProxyOpsSnapshot: getProxyOpsSnapshotMock,
}));

vi.mock('../../services/channelRecoveryProbeService.js', () => ({
  runChannelRecoveryProbeSweep: runChannelRecoveryProbeSweepMock,
}));

vi.mock('../../services/proxyOpsRuntimeStateService.js', () => ({
  getProxyOpsRuntimeStateSnapshot: getProxyOpsRuntimeStateSnapshotMock,
  clearProxyOpsRuntimeState: clearProxyOpsRuntimeStateMock,
}));

describe('stats proxy ops routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const routesModule = await import('./stats.js');
    app = Fastify();
    await app.register(routesModule.statsRoutes);
  });

  beforeEach(() => {
    getProxyOpsSnapshotMock.mockReset();
    runChannelRecoveryProbeSweepMock.mockReset();
    getProxyOpsRuntimeStateSnapshotMock.mockReset();
    clearProxyOpsRuntimeStateMock.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('normalizes query params before delegating to proxy ops snapshot service', async () => {
    getProxyOpsSnapshotMock.mockResolvedValue({
      generatedAt: '2026-04-21T12:00:00.000Z',
      overview: {
        totalAccounts: 3,
        degradedAccounts: 1,
        challengeAffectedAccounts: 1,
        coveredFailures24h: 2,
        totalRequests24h: 10,
        successRequests24h: 8,
        successRate24h: 80,
      },
      failureBuckets24h: [],
      accounts: [
        {
          accountId: 12,
          username: 'ops-user',
          siteId: 3,
          siteName: 'Codex Site',
          siteUrl: 'https://codex.example.com',
          accountStatus: 'active',
          channelHealth: { total: 1, cooling: 0, degraded: 0 },
          proxy24h: { total: 3, success: 2, failed: 1, retried: 0, successRate: 66.7 },
          failureBuckets: [],
          latestFailure: null,
          modelProbe: null,
          refresh: null,
          recoverySignals: [],
          protectionSignals: [],
          opsScore: 88,
          liveLoad: {
            activeLeaseCount: 2,
            waitingCount: 1,
            saturatedChannels: 1,
            sessionScopedChannels: 1,
          },
          dispatchSuppression: {
            total: 1,
            reasons: [{ reason: 'pending_overload', count: 1 }],
            entries: [{
              routeId: 9,
              modelName: 'gpt-4o',
              status: 'degraded',
              suppressionReason: 'pending_overload',
              updatedAt: '2026-04-21T12:00:00.000Z',
              holdUntil: null,
            }],
          },
        },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/proxy-ops?accountId=12&limit=999',
    });

    expect(response.statusCode).toBe(200);
    expect(getProxyOpsSnapshotMock).toHaveBeenCalledWith({
      accountId: 12,
      limit: 200,
    });
    expect(response.json()).toMatchObject({
      overview: {
        totalAccounts: 3,
        challengeAffectedAccounts: 1,
      },
    });
  });

  it('triggers a recovery sweep and returns an acknowledgement payload', async () => {
    runChannelRecoveryProbeSweepMock.mockResolvedValue(undefined);

    const response = await app.inject({
      method: 'POST',
      url: '/api/stats/proxy-ops/recovery-sweep',
    });

    expect(response.statusCode).toBe(200);
    expect(runChannelRecoveryProbeSweepMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      success: true,
    });
    expect(typeof response.json().triggeredAt).toBe('string');
  });

  it('returns the runtime-state snapshot used for minimal ops inspection', async () => {
    getProxyOpsRuntimeStateSnapshotMock.mockResolvedValue({
      generatedAt: '2026-04-23T10:20:00.000Z',
      channelAffinity: {
        total: 1,
        entries: [{ cacheKey: 'channel-affinity:v1|fp:abc', channelId: 11 }],
      },
      continuity: {
        sessionAnchors: [{ handle: 'sess-handle-1', responseIdHash: 'resp-hash-1' }],
        stickyBindings: [{ handle: 'sticky-handle-1', channelId: 11 }],
      },
      suppression: {
        total: 1,
        entries: [{ accountId: 33, suppressionReason: 'auth_invalid' }],
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/proxy-ops/runtime-state',
    });

    expect(response.statusCode).toBe(200);
    expect(getProxyOpsRuntimeStateSnapshotMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      channelAffinity: { total: 1 },
      continuity: { sessionAnchors: [{ handle: 'sess-handle-1' }] },
      suppression: { total: 1 },
    });
    expect(response.body).not.toContain('resp-1');
    expect(response.body).not.toContain('sess:1');
    expect(response.body).not.toContain('7:gpt-5.4:33');
  });

  it('passes clear instructions to the runtime-state service and returns cleared counts', async () => {
    clearProxyOpsRuntimeStateMock.mockResolvedValue({
      clearedAt: '2026-04-23T10:21:00.000Z',
      cleared: {
        channelAffinity: 1,
        sessionAnchors: 1,
        stickyBindings: 1,
        suppression: 1,
      },
    });

    const payload = {
      affinity: { cacheKeys: ['channel-affinity:v1|fp:abc'] },
      continuity: { sessionAnchorHandles: ['sess-handle-1'], stickyHandles: ['sticky-handle-1'] },
      suppression: { accountIds: [33] },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/stats/proxy-ops/runtime-state/clear',
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(clearProxyOpsRuntimeStateMock).toHaveBeenCalledWith(payload);
    expect(response.json()).toMatchObject({
      cleared: {
        channelAffinity: 1,
        sessionAnchors: 1,
        stickyBindings: 1,
        suppression: 1,
      },
    });
  });
});
