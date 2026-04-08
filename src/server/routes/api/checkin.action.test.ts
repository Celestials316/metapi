import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  checkinAccountMock,
  checkinAllMock,
  resolveAccountExternalCheckinActionByIdMock,
} = vi.hoisted(() => ({
  checkinAccountMock: vi.fn(),
  checkinAllMock: vi.fn(),
  resolveAccountExternalCheckinActionByIdMock: vi.fn(),
}));

vi.mock('../../services/checkinService.js', () => ({
  checkinAll: (...args: unknown[]) => checkinAllMock(...args),
  checkinAccount: (...args: unknown[]) => checkinAccountMock(...args),
}));

vi.mock('../../services/checkinScheduler.js', () => ({
  updateCheckinSchedule: vi.fn(),
}));

vi.mock('../../services/externalCheckinService.js', () => ({
  resolveAccountExternalCheckinActionById: (...args: unknown[]) => resolveAccountExternalCheckinActionByIdMock(...args),
}));

vi.mock('../../db/index.js', () => {
  const insertChain = {
    values: () => insertChain,
    onConflictDoUpdate: () => insertChain,
    run: () => ({ changes: 1 }),
  };

  const queryChain = {
    where: () => queryChain,
    all: () => [],
    limit: () => queryChain,
    offset: () => queryChain,
    orderBy: () => queryChain,
    innerJoin: () => queryChain,
    from: () => queryChain,
  };

  return {
    db: {
      insert: () => insertChain,
      select: () => queryChain,
    },
    schema: {
      settings: { key: 'key' },
      checkinLogs: { accountId: 'accountId', createdAt: 'createdAt' },
      accounts: { id: 'id' },
      events: { id: 'id' },
    },
  };
});

describe('checkin routes', () => {
  beforeEach(() => {
    checkinAccountMock.mockReset();
    checkinAllMock.mockReset();
    resolveAccountExternalCheckinActionByIdMock.mockReset();
  });

  it('returns the resolved manual jump action', async () => {
    resolveAccountExternalCheckinActionByIdMock.mockResolvedValue({
      mode: 'manual_jump',
      kind: 'manual_oauth',
      entryUrl: 'https://sign.example.com/embed',
      url: 'https://sign.example.com/embed?token=abc',
      message: '站点需要跳转外部签到页手动完成签到',
    });

    const { checkinRoutes } = await import('./checkin.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/checkin/action/12',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      mode: 'manual_jump',
      kind: 'manual_oauth',
      url: 'https://sign.example.com/embed?token=abc',
      message: '站点需要跳转外部签到页手动完成签到',
    });
    await app.close();
  });

  it('returns aisign tier metadata for auto checkin actions', async () => {
    resolveAccountExternalCheckinActionByIdMock.mockResolvedValue({
      mode: 'auto',
      kind: 'aisign',
      entryUrl: 'https://aisign.td.ee',
      url: null,
      message: '签到成功',
      requiresTierSelection: true,
      defaultTierId: 3,
      tierOptions: [
        { id: 1, name: '简单', rewardMin: 1, rewardMax: 5, targetSeconds: 1, difficulty: 19 },
        { id: 2, name: '进阶', rewardMin: 5, rewardMax: 10, targetSeconds: 60, difficulty: 25 },
        { id: 3, name: '挑战', rewardMin: 10, rewardMax: 15, targetSeconds: 120, difficulty: 26 },
        { id: 4, name: '极限', rewardMin: 15, rewardMax: 20, targetSeconds: 200, difficulty: 26 },
      ],
    });

    const { checkinRoutes } = await import('./checkin.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/checkin/action/12',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      mode: 'auto',
      kind: 'aisign',
      url: null,
      message: '签到成功',
      requiresTierSelection: true,
      defaultTierId: 3,
      tierOptions: [
        { id: 1, name: '简单', rewardMin: 1, rewardMax: 5, targetSeconds: 1, difficulty: 19 },
        { id: 2, name: '进阶', rewardMin: 5, rewardMax: 10, targetSeconds: 60, difficulty: 25 },
        { id: 3, name: '挑战', rewardMin: 10, rewardMax: 15, targetSeconds: 120, difficulty: 26 },
        { id: 4, name: '极限', rewardMin: 15, rewardMax: 20, targetSeconds: 200, difficulty: 26 },
      ],
    });
    await app.close();
  });

  it('forwards tier payloads when triggering a single-account checkin', async () => {
    checkinAccountMock.mockResolvedValue({ success: true, status: 'success', message: '签到成功' });

    const { checkinRoutes } = await import('./checkin.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/checkin/trigger/12',
      payload: { tier: 4 },
    });

    expect(response.statusCode).toBe(200);
    expect(checkinAccountMock).toHaveBeenCalledWith(12, { scheduleMode: 'cron', tierOverride: 4 });
    expect(response.json()).toEqual({ success: true, status: 'success', message: '签到成功' });
    await app.close();
  });

  it('returns 404 when account does not exist', async () => {
    resolveAccountExternalCheckinActionByIdMock.mockResolvedValue(null);

    const { checkinRoutes } = await import('./checkin.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/checkin/action/99',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      success: false,
      message: 'account not found',
    });
    await app.close();
  });
});
