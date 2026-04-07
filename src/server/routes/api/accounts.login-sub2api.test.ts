import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const loginMock = vi.fn();
const getApiTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const convergeAccountMutationMock = vi.fn();
const insertAndGetByIdMock = vi.fn();
const selectGetMock = vi.fn();
const selectAllMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    login: (...args: unknown[]) => loginMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
}));

vi.mock('../../services/accountMutationWorkflow.js', () => ({
  convergeAccountMutation: (...args: unknown[]) => convergeAccountMutationMock(...args),
  rebuildRoutesBestEffort: vi.fn(),
}));

vi.mock('../../db/insertHelpers.js', () => ({
  getInsertedRowId: vi.fn(),
  insertAndGetById: (...args: unknown[]) => insertAndGetByIdMock(...args),
}));

vi.mock('../../db/index.js', () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    innerJoin: () => selectChain,
    all: () => selectAllMock(),
    get: () => selectGetMock(),
  };

  return {
    db: {
      select: () => selectChain,
      update: () => ({
        set: () => ({ where: () => ({ run: vi.fn() }) }),
      }),
      insert: () => ({
        values: () => ({
          run: vi.fn(),
          returning: () => ({ get: vi.fn() }),
        }),
      }),
      delete: () => ({ run: vi.fn() }),
    },
    runtimeDbDialect: 'sqlite',
    schema: {
      accounts: {
        id: 'accounts.id',
        siteId: 'accounts.siteId',
        username: 'accounts.username',
        sortOrder: 'accounts.sortOrder',
      },
      sites: {
        id: 'sites.id',
      },
      checkinLogs: {},
      proxyLogs: {},
      routeChannels: {},
      tokenRoutes: {},
      tokenModelAvailability: {},
      modelAvailability: {},
      accountTokens: {},
    },
  };
});

describe('accounts login sub2api', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const routesModule = await import('./accounts.js');
    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(() => {
    loginMock.mockReset();
    getApiTokenMock.mockReset();
    getApiTokensMock.mockReset();
    convergeAccountMutationMock.mockReset();
    insertAndGetByIdMock.mockReset();
    selectGetMock.mockReset();
    selectAllMock.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('stores managed sub2api refresh metadata when login succeeds', async () => {
    const site = {
      id: 1,
      name: 'Sub2 Login Site',
      url: 'https://sub2.example.com',
      platform: 'sub2api',
    };
    const insertedAccount = {
      id: 101,
      siteId: 1,
      username: 'user@example.com',
      accessToken: 'jwt-session-token',
      apiToken: 'sk-sub2-default',
      checkinEnabled: true,
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        autoRelogin: {
          username: 'user@example.com',
          passwordCipher: 'cipher-placeholder',
        },
        sub2apiAuth: {
          refreshToken: 'rt-managed-refresh-token',
          tokenExpiresAt: 1760000000000,
        },
      }),
    };

    selectAllMock.mockReturnValueOnce([]);
    selectGetMock
      .mockReturnValueOnce(site)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(insertedAccount)
      .mockReturnValueOnce(insertedAccount);

    loginMock.mockResolvedValue({
      success: true,
      accessToken: 'jwt-session-token',
      refreshToken: 'rt-managed-refresh-token',
      tokenExpiresAt: 1760000000000,
    });
    getApiTokenMock.mockResolvedValue('sk-sub2-default');
    getApiTokensMock.mockResolvedValue([{ key: 'sk-sub2-default', name: 'default', enabled: true }]);
    insertAndGetByIdMock.mockResolvedValue({ id: 101 });
    convergeAccountMutationMock.mockResolvedValue(undefined);

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: {
        siteId: 1,
        username: 'user@example.com',
        password: 'pass-123',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      apiTokenFound: true,
      tokenCount: 1,
      reusedAccount: false,
    });

    expect(insertAndGetByIdMock).toHaveBeenCalledTimes(1);
    const insertPayload = insertAndGetByIdMock.mock.calls[0]?.[0] as {
      values?: { extraConfig?: string; accessToken?: string; apiToken?: string; username?: string };
    };
    expect(insertPayload.values?.accessToken).toBe('jwt-session-token');
    expect(insertPayload.values?.apiToken).toBe('sk-sub2-default');
    expect(insertPayload.values?.username).toBe('user@example.com');

    const extra = JSON.parse(String(insertPayload.values?.extraConfig || '{}')) as {
      credentialMode?: string;
      autoRelogin?: { username?: string };
      sub2apiAuth?: { refreshToken?: string; tokenExpiresAt?: number };
    };
    expect(extra.credentialMode).toBe('session');
    expect(extra.autoRelogin?.username).toBe('user@example.com');
    expect(extra.sub2apiAuth).toEqual({
      refreshToken: 'rt-managed-refresh-token',
      tokenExpiresAt: 1760000000000,
    });
  });
});
