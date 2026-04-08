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
  let routesModule: typeof import('./accounts.js');
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-batch-probe-route-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    routesModule = await import('./accounts.js');

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

  it('keeps POST sse streams alive on a real network connection until events are written', async () => {
    const networkApp = Fastify();
    await networkApp.register(routesModule.accountsRoutes);

    executeAccountBatchProbeMock.mockImplementation(async (input: {
      onStart?: (payload: unknown) => void | Promise<void>;
      onResult?: (payload: unknown) => void | Promise<void>;
    }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await input.onStart?.({
        totalAccounts: 1,
        scheduledAccounts: 1,
        hiddenDisabledAccounts: 0,
        concurrency: 1,
      });
      await input.onResult?.({
        accountId: 1,
        accountName: 'alpha',
        siteName: 'Site A',
        status: 'success',
        latencyMs: 88,
        model: 'gpt-5.4',
        usedFallbackModel: false,
        message: 'hello',
      });
      return {
        totalAccounts: 1,
        scheduledAccounts: 1,
        hiddenDisabledAccounts: 0,
        completedAccounts: 1,
        success: 1,
        failed: 0,
        skipped: 0,
        durationMs: 18,
      };
    });

    const baseUrl = await networkApp.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);

    try {
      const response = await fetch(`${baseUrl}/api/accounts/probe-chat/batch`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          accountIds: [1],
          preferredModel: 'gpt-5.4',
          includeDisabled: false,
          concurrency: 3,
        }),
        signal: controller.signal,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') || '').toContain('text/event-stream');

      const body = await response.text();
      expect(body).toContain('event: start');
      expect(body).toContain('event: result');
      expect(body).toContain('event: done');
      expect(body).toContain('"model":"gpt-5.4"');
    } finally {
      clearTimeout(timeout);
      await networkApp.close();
    }
  });
});
