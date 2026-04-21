import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';

const { getProxyOpsSnapshotMock, runChannelRecoveryProbeSweepMock } = vi.hoisted(() => ({
  getProxyOpsSnapshotMock: vi.fn(),
  runChannelRecoveryProbeSweepMock: vi.fn(),
}));

vi.mock('../../services/proxyOpsSnapshotService.js', () => ({
  getProxyOpsSnapshot: getProxyOpsSnapshotMock,
}));

vi.mock('../../services/channelRecoveryProbeService.js', () => ({
  runChannelRecoveryProbeSweep: runChannelRecoveryProbeSweepMock,
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
      accounts: [],
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
});
