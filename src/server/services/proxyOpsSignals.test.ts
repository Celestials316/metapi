import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type AccountExtraConfigModule = typeof import('./accountExtraConfig.js');
type ProxyOpsSignalsModule = typeof import('./proxyOpsSignals.js');
type AccountHealthModule = typeof import('./accountHealthService.js');

describe('proxyOpsSignals compare-and-swap merge', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let mergeAccountExtraConfigWithRetry: AccountExtraConfigModule['mergeAccountExtraConfigWithRetry'];
  let getProxyOpsState: ProxyOpsSignalsModule['getProxyOpsState'];
  let extractRuntimeHealth: AccountHealthModule['extractRuntimeHealth'];
  let dataDir = '';
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-ops-cas-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const accountExtraConfigModule = await import('./accountExtraConfig.js');
    const proxyOpsSignalsModule = await import('./proxyOpsSignals.js');
    const accountHealthModule = await import('./accountHealthService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    mergeAccountExtraConfigWithRetry = accountExtraConfigModule.mergeAccountExtraConfigWithRetry;
    getProxyOpsState = proxyOpsSignalsModule.getProxyOpsState;
    extractRuntimeHealth = accountHealthModule.extractRuntimeHealth;
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

  it('preserves proxyOps and runtimeHealth branches under concurrent compare-and-swap updates', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'proxy-ops-cas-site',
      url: 'https://proxy-ops-cas.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'proxy-ops-cas-user',
      accessToken: 'proxy-ops-cas-token',
      status: 'active',
      extraConfig: null,
    }).returning().get();

    let waiting = 0;
    let releaseBarrier: (() => void) | null = null;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const waitForSameSnapshotWindow = async () => {
      waiting += 1;
      if (waiting === 2) {
        releaseBarrier?.();
      }
      await barrier;
    };

    const protectionWrite = mergeAccountExtraConfigWithRetry(account.id, async () => {
      await waitForSameSnapshotWindow();
      return {
        patch: {
          proxyOps: {
            protectionSignals: [
              {
                className: 'challenge_html',
                title: 'Cloudflare HTML Challenge',
                summary: 'challenge page returned',
                status: 403,
                recordedAt: '2026-04-22T00:10:00.000Z',
              },
            ],
          },
        },
        result: 'proxyOps',
      };
    });

    const runtimeHealthWrite = mergeAccountExtraConfigWithRetry(account.id, async () => {
      await waitForSameSnapshotWindow();
      return {
        patch: {
          runtimeHealth: {
            state: 'degraded',
            reason: 'oauth refresh backoff active',
            source: 'oauth-refresh',
            checkedAt: '2026-04-22T00:11:00.000Z',
          },
        },
        result: 'runtimeHealth',
      };
    });

    await Promise.all([protectionWrite, runtimeHealthWrite]);

    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();

    const proxyOps = getProxyOpsState(refreshedAccount?.extraConfig);
    const runtimeHealth = extractRuntimeHealth(refreshedAccount?.extraConfig);

    expect(proxyOps.protectionSignals).toHaveLength(1);
    expect(proxyOps.protectionSignals?.[0]).toMatchObject({
      className: 'challenge_html',
      title: 'Cloudflare HTML Challenge',
    });
    expect(runtimeHealth).toMatchObject({
      state: 'degraded',
      source: 'oauth-refresh',
      reason: 'oauth refresh backoff active',
    });
  });
});
