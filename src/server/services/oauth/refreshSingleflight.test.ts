import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const refreshOauthAccessTokenMock = vi.fn();

vi.mock('./service.js', () => ({
  refreshOauthAccessToken: (...args: unknown[]) => refreshOauthAccessTokenMock(...args),
}));

type DbModule = typeof import('../../db/index.js');
type RefreshSingleflightModule = typeof import('./refreshSingleflight.js');

function buildOauthExtraConfig(input: {
  provider?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  oauthRefreshRuntime?: Record<string, unknown>;
} = {}): string {
  return JSON.stringify({
    credentialMode: 'session',
    oauth: {
      provider: input.provider || 'codex',
      refreshToken: input.refreshToken || 'refresh-token',
      tokenExpiresAt: input.tokenExpiresAt || (Date.now() + 60 * 60 * 1000),
    },
    ...(input.oauthRefreshRuntime ? { oauthRefreshRuntime: input.oauthRefreshRuntime } : {}),
  });
}

describe('refreshOauthAccessTokenSingleflight', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let refreshOauthAccessTokenSingleflight: RefreshSingleflightModule['refreshOauthAccessTokenSingleflight'];
  let resetRefreshSingleflightForTests: RefreshSingleflightModule['__resetRefreshSingleflightForTests'];
  let dataDir = '';
  let originalDataDir: string | undefined;

  async function waitForAccountExtraConfig(accountId: number, predicate: (parsed: Record<string, any>) => boolean): Promise<Record<string, any>> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const account = await db.select().from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();
      const parsed = JSON.parse(String(account?.extraConfig || '{}')) as Record<string, any>;
      if (predicate(parsed)) {
        return parsed;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('timed out waiting for account extraConfig predicate');
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-refresh-singleflight-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const refreshSingleflightModule = await import('./refreshSingleflight.js');

    db = dbModule.db;
    schema = dbModule.schema;
    refreshOauthAccessTokenSingleflight = refreshSingleflightModule.refreshOauthAccessTokenSingleflight;
    resetRefreshSingleflightForTests = refreshSingleflightModule.__resetRefreshSingleflightForTests;
  });

  beforeEach(async () => {
    refreshOauthAccessTokenMock.mockReset();
    await resetRefreshSingleflightForTests();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.oauthRouteUnitMembers).run();
    await db.delete(schema.oauthRouteUnits).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await resetRefreshSingleflightForTests();
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  it('records refresh backoff after a failure and suppresses immediate reattempts', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'refresh-backoff-site',
      url: 'https://refresh-backoff.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'refresh-backoff-user',
      accessToken: 'access-token-old',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'refresh-backoff-user',
      extraConfig: buildOauthExtraConfig(),
    }).returning().get();

    refreshOauthAccessTokenMock.mockRejectedValue(new Error('temporary upstream 503'));

    await expect(refreshOauthAccessTokenSingleflight(account.id)).rejects.toThrow('temporary upstream 503');
    await expect(refreshOauthAccessTokenSingleflight(account.id)).rejects.toThrow(/backoff|cooldown|冷却|稍后/i);

    expect(refreshOauthAccessTokenMock).toHaveBeenCalledTimes(1);

    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();

    const parsedExtraConfig = JSON.parse(String(refreshedAccount?.extraConfig || '{}')) as Record<string, any>;
    expect(parsedExtraConfig.oauthRefreshRuntime).toEqual(expect.objectContaining({
      status: 'backoff',
      consecutiveFailures: 1,
      lastError: expect.stringContaining('temporary upstream 503'),
    }));
    expect(typeof parsedExtraConfig.oauthRefreshRuntime.backoffUntil).toBe('string');
  });

  it('clears expired refresh backoff after a successful refresh and persists the new token', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'refresh-success-site',
      url: 'https://refresh-success.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const expiredBackoffUntil = new Date(Date.now() - 60_000).toISOString();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'refresh-success-user',
      accessToken: 'access-token-old',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'refresh-success-user',
      extraConfig: buildOauthExtraConfig({
        oauthRefreshRuntime: {
          status: 'backoff',
          consecutiveFailures: 3,
          backoffUntil: expiredBackoffUntil,
          lastError: 'stale refresh failure',
        },
      }),
    }).returning().get();

    refreshOauthAccessTokenMock.mockResolvedValue({
      accountId: account.id,
      accessToken: 'access-token-new',
      accountKey: 'refresh-success-user',
      extraConfig: buildOauthExtraConfig(),
    });

    await expect(refreshOauthAccessTokenSingleflight(account.id)).resolves.toEqual(expect.objectContaining({
      accountId: account.id,
      accessToken: 'access-token-new',
    }));

    expect(refreshOauthAccessTokenMock).toHaveBeenCalledTimes(1);

    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();

    expect(refreshedAccount?.accessToken).toBe('access-token-new');
    const parsedExtraConfig = JSON.parse(String(refreshedAccount?.extraConfig || '{}')) as Record<string, any>;
    expect(parsedExtraConfig.oauthRefreshRuntime).toEqual(expect.objectContaining({
      consecutiveFailures: 0,
      status: 'success',
      lastError: '',
    }));
    expect(parsedExtraConfig.oauthRefreshRuntime.backoffUntil ?? null).toBeNull();
  });

  it('marks invalid refresh credentials as terminal and blocks immediate reattempts', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'refresh-terminal-site',
      url: 'https://refresh-terminal.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'refresh-terminal-user',
      accessToken: 'access-token-old',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'refresh-terminal-user',
      extraConfig: buildOauthExtraConfig(),
    }).returning().get();

    refreshOauthAccessTokenMock.mockRejectedValue(new Error('invalid_grant: refresh token revoked'));

    await expect(refreshOauthAccessTokenSingleflight(account.id)).rejects.toThrow('invalid_grant: refresh token revoked');
    await expect(refreshOauthAccessTokenSingleflight(account.id)).rejects.toThrow(/invalid_grant|terminal|终止|失效/i);

    expect(refreshOauthAccessTokenMock).toHaveBeenCalledTimes(1);

    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();

    const parsedExtraConfig = JSON.parse(String(refreshedAccount?.extraConfig || '{}')) as Record<string, any>;
    expect(parsedExtraConfig.oauthRefreshRuntime).toEqual(expect.objectContaining({
      status: 'terminal',
      consecutiveFailures: 1,
      lastError: expect.stringContaining('invalid_grant: refresh token revoked'),
    }));
    expect(parsedExtraConfig.oauthRefreshRuntime.backoffUntil ?? null).toBeNull();
  });

  it('returns the already-persisted refreshed token when a newer owner later marks the runtime terminal', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'refresh-stale-success-terminal-site',
      url: 'https://refresh-stale-success-terminal.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'refresh-stale-success-terminal-user',
      accessToken: 'access-token-old',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'refresh-stale-success-terminal-user',
      extraConfig: buildOauthExtraConfig(),
    }).returning().get();

    let releaseRefresh: ((value: unknown) => void) | null = null;
    refreshOauthAccessTokenMock.mockImplementation(() => new Promise((resolve) => {
      releaseRefresh = resolve;
    }));

    const refreshPromise = refreshOauthAccessTokenSingleflight(account.id);
    const parsedWithLease = await waitForAccountExtraConfig(
      account.id,
      (parsed) => typeof parsed.oauthRefreshRuntime?.lease?.ownerId === 'string',
    );
    const staleOwnerId = String(parsedWithLease.oauthRefreshRuntime.lease.ownerId);

    await db.update(schema.accounts)
      .set({
        accessToken: 'access-token-from-stale-owner',
        extraConfig: buildOauthExtraConfig({
          oauthRefreshRuntime: {
            status: 'terminal',
            consecutiveFailures: 1,
            lastAttemptAt: new Date().toISOString(),
            lastFailureAt: new Date().toISOString(),
            lastError: 'invalid_grant: refresh token revoked',
            lease: null,
            backoffUntil: null,
          },
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.accounts.id, account.id))
      .run();

    releaseRefresh?.({
      accountId: account.id,
      accessToken: 'access-token-from-stale-owner',
      accountKey: 'refresh-stale-success-terminal-user',
      extraConfig: buildOauthExtraConfig({
        oauthRefreshRuntime: {
          status: 'refreshing',
          lease: {
            ownerId: staleOwnerId,
            startedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          },
        },
      }),
    });

    await expect(refreshPromise).resolves.toEqual(expect.objectContaining({
      accountId: account.id,
      accessToken: 'access-token-from-stale-owner',
    }));

    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    const parsedExtraConfig = JSON.parse(String(refreshedAccount?.extraConfig || '{}'));
    expect(parsedExtraConfig.oauthRefreshRuntime).toEqual(expect.objectContaining({
      status: 'success',
      consecutiveFailures: 0,
      backoffUntil: null,
      lease: null,
    }));
  });

  it('does not let a stale owner overwrite a newer remote refresh success', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'refresh-owner-race-site',
      url: 'https://refresh-owner-race.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'refresh-owner-race-user',
      accessToken: 'access-token-old',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'refresh-owner-race-user',
      extraConfig: buildOauthExtraConfig(),
    }).returning().get();

    let releaseRefresh: ((value: unknown) => void) | null = null;
    refreshOauthAccessTokenMock.mockImplementation(() => new Promise((resolve) => {
      releaseRefresh = resolve;
    }));

    const refreshPromise = refreshOauthAccessTokenSingleflight(account.id);
    await waitForAccountExtraConfig(account.id, (parsed) => typeof parsed.oauthRefreshRuntime?.lease?.ownerId === 'string');

    await db.update(schema.accounts)
      .set({
        accessToken: 'access-token-from-remote-owner',
        extraConfig: buildOauthExtraConfig({
          oauthRefreshRuntime: {
            status: 'success',
            consecutiveFailures: 0,
            lastSuccessAt: new Date().toISOString(),
            lastAttemptAt: new Date().toISOString(),
            lastError: '',
            lease: null,
            backoffUntil: null,
          },
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.accounts.id, account.id))
      .run();

    releaseRefresh?.({
      accountId: account.id,
      accessToken: 'access-token-from-stale-owner',
      accountKey: 'refresh-owner-race-user',
      extraConfig: buildOauthExtraConfig(),
    });

    await expect(refreshPromise).resolves.toEqual(expect.objectContaining({
      accountId: account.id,
      accessToken: 'access-token-from-remote-owner',
    }));

    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(refreshedAccount?.accessToken).toBe('access-token-from-remote-owner');
  });

  it('takes over refresh instead of returning a stale token when a remote lease disappears', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'refresh-remote-disappear-site',
      url: 'https://refresh-remote-disappear.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const leaseStartedAt = new Date().toISOString();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'refresh-remote-disappear-user',
      accessToken: 'access-token-old',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'refresh-remote-disappear-user',
      extraConfig: buildOauthExtraConfig({
        oauthRefreshRuntime: {
          status: 'refreshing',
          consecutiveFailures: 0,
          lastAttemptAt: leaseStartedAt,
          lease: {
            ownerId: 'remote-worker',
            startedAt: leaseStartedAt,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          },
        },
      }),
    }).returning().get();

    refreshOauthAccessTokenMock.mockResolvedValue({
      accountId: account.id,
      accessToken: 'access-token-recovered-locally',
      accountKey: 'refresh-remote-disappear-user',
      extraConfig: buildOauthExtraConfig(),
    });

    const refreshPromise = refreshOauthAccessTokenSingleflight(account.id);

    setTimeout(async () => {
      await db.update(schema.accounts)
        .set({
          extraConfig: buildOauthExtraConfig({
            oauthRefreshRuntime: {
              status: 'idle',
              consecutiveFailures: 0,
              lastAttemptAt: leaseStartedAt,
              lease: null,
              backoffUntil: null,
              lastError: '',
            },
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.accounts.id, account.id))
        .run();
    }, 50);

    await expect(refreshPromise).resolves.toEqual(expect.objectContaining({
      accountId: account.id,
      accessToken: 'access-token-recovered-locally',
    }));
    expect(refreshOauthAccessTokenMock).toHaveBeenCalledTimes(1);

    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(refreshedAccount?.accessToken).toBe('access-token-recovered-locally');
  });
});
