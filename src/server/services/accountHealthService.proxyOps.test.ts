import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type AccountHealthModule = typeof import('./accountHealthService.js');
type ProxyOpsSignalsModule = typeof import('./proxyOpsSignals.js');

describe('accountHealthService proxy ops signals', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let setAccountRuntimeHealth: AccountHealthModule['setAccountRuntimeHealth'];
  let getProxyOpsState: ProxyOpsSignalsModule['getProxyOpsState'];
  let dataDir = '';
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-health-proxy-ops-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const accountHealthModule = await import('./accountHealthService.js');
    const proxyOpsSignalsModule = await import('./proxyOpsSignals.js');

    db = dbModule.db;
    schema = dbModule.schema;
    setAccountRuntimeHealth = accountHealthModule.setAccountRuntimeHealth;
    getProxyOpsState = proxyOpsSignalsModule.getProxyOpsState;
  });

  beforeEach(async () => {
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

  it('does not record refresh signals for non-oauth runtime health updates', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'proxy-ops-health-site',
      url: 'https://proxy-ops-health.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'proxy-ops-health-user',
      accessToken: 'access-token',
      apiToken: null,
      status: 'active',
      extraConfig: null,
    }).returning().get();

    await expect(setAccountRuntimeHealth(account.id, {
      state: 'healthy',
      reason: '模型探测成功',
      source: 'model-discovery',
      checkedAt: '2026-04-21T12:00:00.000Z',
    })).resolves.toMatchObject({
      state: 'healthy',
      source: 'model-discovery',
    });

    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();

    expect(getProxyOpsState(refreshedAccount?.extraConfig).refresh ?? null).toBeNull();
  });

  it('keeps writing refresh signals for oauth-refresh health updates', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'proxy-ops-refresh-site',
      url: 'https://proxy-ops-refresh.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'proxy-ops-refresh-user',
      accessToken: 'access-token',
      apiToken: null,
      status: 'active',
      extraConfig: null,
    }).returning().get();

    await expect(setAccountRuntimeHealth(account.id, {
      state: 'unhealthy',
      reason: 'refresh cooldown active',
      source: 'oauth-refresh',
      checkedAt: '2026-04-21T12:05:00.000Z',
    })).resolves.toMatchObject({
      state: 'unhealthy',
      source: 'oauth-refresh',
    });

    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();

    expect(getProxyOpsState(refreshedAccount?.extraConfig).refresh).toMatchObject({
      lastRefreshAt: '2026-04-21T12:05:00.000Z',
      status: 'failed',
      message: 'refresh cooldown active',
    });
  });
});
