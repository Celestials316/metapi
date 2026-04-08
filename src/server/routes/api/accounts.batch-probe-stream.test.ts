import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { executeAccountBatchProbeMock } = vi.hoisted(() => ({
  executeAccountBatchProbeMock: vi.fn(),
}));

vi.mock('../../services/accountBatchProbeService.js', () => ({
  executeAccountBatchProbe: (...args: unknown[]) => executeAccountBatchProbeMock(...args),
}));

describe('accounts batch probe stream route', () => {
  let app: FastifyInstance;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-batch-probe-route-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const routesModule = await import('./accounts.js');

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  }, 30_000);

  beforeEach(() => {
    executeAccountBatchProbeMock.mockReset();
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.DATA_DIR;
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('rejects invalid batch probe payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/probe-chat/batch',
      payload: {
        accountIds: [1],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: expect.stringContaining('preferredModel'),
    });
  });

  it('streams start, result and done events over sse', async () => {
    executeAccountBatchProbeMock.mockImplementation(async (input: {
      onStart?: (payload: unknown) => void | Promise<void>;
      onResult?: (payload: unknown) => void | Promise<void>;
    }) => {
      await input.onStart?.({
        totalAccounts: 2,
        scheduledAccounts: 2,
        hiddenDisabledAccounts: 0,
        concurrency: 2,
      });
      await input.onResult?.({
        accountId: 1,
        accountName: 'alpha',
        siteName: 'Site A',
        status: 'success',
        latencyMs: 120,
        model: 'gpt-4.1-mini',
        usedFallbackModel: false,
        message: 'hello',
      });
      return {
        totalAccounts: 2,
        scheduledAccounts: 2,
        hiddenDisabledAccounts: 0,
        completedAccounts: 1,
        success: 1,
        failed: 0,
        skipped: 0,
        durationMs: 12,
      };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/probe-chat/batch',
      headers: {
        accept: 'text/event-stream',
      },
      payload: {
        accountIds: [1, 2],
        preferredModel: 'gpt-4.1-mini',
        includeDisabled: false,
        concurrency: 4,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: start');
    expect(response.body).toContain('event: result');
    expect(response.body).toContain('"accountName":"alpha"');
    expect(response.body).toContain('event: done');
    expect(executeAccountBatchProbeMock).toHaveBeenCalledWith(expect.objectContaining({
      accountIds: [1, 2],
      preferredModel: 'gpt-4.1-mini',
      includeDisabled: false,
      concurrency: 4,
      onStart: expect.any(Function),
      onResult: expect.any(Function),
    }));
  });
});
