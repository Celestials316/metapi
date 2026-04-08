import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { probeAccountChatMock } = vi.hoisted(() => ({
  probeAccountChatMock: vi.fn(),
}));

vi.mock('./accountProbeService.js', () => ({
  probeAccountChat: (...args: unknown[]) => probeAccountChatMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./accountBatchProbeService.js');

describe('accountBatchProbeService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let executeAccountBatchProbe: ServiceModule['executeAccountBatchProbe'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-batch-probe-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./accountBatchProbeService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    executeAccountBatchProbe = serviceModule.executeAccountBatchProbe;
  });

  beforeEach(async () => {
    probeAccountChatMock.mockReset();

    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accountDispatchPreferences).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('prefers the requested model when the account supports it', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Site A',
      url: 'https://site-a.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alpha',
      accessToken: 'session-alpha',
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      { accountId: account.id, modelName: 'gpt-4.1', available: true },
      { accountId: account.id, modelName: 'gpt-4.1-mini', available: true },
    ]).run();

    probeAccountChatMock.mockResolvedValue({
      success: true,
      statusText: '服务正常',
      replyText: 'hi from upstream',
      latencyMs: 123,
      model: 'gpt-4.1-mini',
    });

    const seenResults: Array<{ model: string | null; usedFallbackModel: boolean }> = [];
    const summary = await executeAccountBatchProbe({
      accountIds: [account.id],
      preferredModel: 'gpt-4.1-mini',
      includeDisabled: false,
      concurrency: 4,
      onResult: (result) => {
        seenResults.push({ model: result.model, usedFallbackModel: result.usedFallbackModel });
      },
    });

    expect(probeAccountChatMock).toHaveBeenCalledWith({
      accountId: account.id,
      modelName: 'gpt-4.1-mini',
    });
    expect(seenResults).toEqual([
      { model: 'gpt-4.1-mini', usedFallbackModel: false },
    ]);
    expect(summary).toMatchObject({
      scheduledAccounts: 1,
      success: 1,
      failed: 0,
      skipped: 0,
      hiddenDisabledAccounts: 0,
    });
  });

  it('falls back to the first enabled model and skips disabled accounts when requested', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Site B',
      url: 'https://site-b.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const activeAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'beta',
      accessToken: 'session-beta',
      status: 'active',
    }).returning().get();
    const disabledAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'gamma',
      accessToken: 'session-gamma',
      status: 'disabled',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      { accountId: activeAccount.id, modelName: 'fallback-model', available: true },
      { accountId: disabledAccount.id, modelName: 'disabled-model', available: true },
    ]).run();

    probeAccountChatMock.mockResolvedValue({
      success: true,
      statusText: '服务正常',
      replyText: 'fallback reply',
      latencyMs: 88,
      model: 'fallback-model',
    });

    const seenStatuses: string[] = [];
    const summary = await executeAccountBatchProbe({
      accountIds: [activeAccount.id, disabledAccount.id],
      preferredModel: 'missing-model',
      includeDisabled: false,
      concurrency: 3,
      onResult: (result) => {
        seenStatuses.push(`${result.accountId}:${result.status}:${result.model}:${result.usedFallbackModel}`);
      },
    });

    expect(seenStatuses).toEqual([
      `${activeAccount.id}:success:fallback-model:true`,
    ]);
    expect(summary).toMatchObject({
      totalAccounts: 2,
      scheduledAccounts: 1,
      hiddenDisabledAccounts: 1,
      success: 1,
    });
  });

  it('streams completed results in finish order and keeps running after a failed account', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Site C',
      url: 'https://site-c.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const firstAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'slow-one',
      accessToken: 'session-slow',
      status: 'active',
    }).returning().get();
    const secondAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'fast-two',
      accessToken: 'session-fast',
      status: 'active',
    }).returning().get();
    const thirdAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'empty-three',
      accessToken: 'session-empty',
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      { accountId: firstAccount.id, modelName: 'm1', available: true },
      { accountId: secondAccount.id, modelName: 'm2', available: true },
      { accountId: thirdAccount.id, modelName: 'm3', available: true },
    ]).run();

    let releaseSlow: (() => void) | null = null;
    probeAccountChatMock.mockImplementation(({ accountId }: { accountId: number }) => {
      if (accountId === firstAccount.id) {
        return new Promise((resolve) => {
          releaseSlow = () => resolve({
            success: true,
            statusText: '服务正常',
            replyText: 'slow ok',
            latencyMs: 120,
            model: 'm1',
          });
        });
      }
      if (accountId === secondAccount.id) {
        return Promise.resolve({
          success: false,
          statusText: '测活失败',
          errorMessage: 'upstream boom',
          latencyMs: 66,
          model: 'm2',
        });
      }
      return Promise.resolve({
        success: true,
        statusText: '服务正常',
        replyText: 'third ok',
        latencyMs: 33,
        model: 'm3',
      });
    });

    const seenOrder: Array<{ accountId: number; status: string }> = [];
    const probePromise = executeAccountBatchProbe({
      accountIds: [firstAccount.id, secondAccount.id, thirdAccount.id],
      preferredModel: 'missing-model',
      includeDisabled: false,
      concurrency: 3,
      onResult: (result) => {
        seenOrder.push({ accountId: result.accountId, status: result.status });
      },
    });

    for (let attempt = 0; attempt < 200 && !releaseSlow; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    releaseSlow?.();

    const summary = await probePromise;

    expect(seenOrder).toEqual([
      { accountId: secondAccount.id, status: 'failed' },
      { accountId: thirdAccount.id, status: 'success' },
      { accountId: firstAccount.id, status: 'success' },
    ]);
    expect(summary).toMatchObject({
      success: 2,
      failed: 1,
      skipped: 0,
      scheduledAccounts: 3,
    });
  });
});
