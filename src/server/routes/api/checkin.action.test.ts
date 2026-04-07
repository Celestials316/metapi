import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveAccountExternalCheckinActionByIdMock = vi.fn();

vi.mock('../../services/checkinService.js', () => ({
  checkinAll: vi.fn(),
  checkinAccount: vi.fn(),
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

describe('GET /api/checkin/action/:id', () => {
  beforeEach(() => {
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
