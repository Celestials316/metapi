import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { normalizeChannelAffinityConfig, resetChannelAffinityState } from '../../services/channelAffinity.js';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const selectPreferredChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const insertProxyLogMock = vi.fn();
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn();
const resolveProxyLogBillingMock = vi.fn();

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    selectPreferredChannel: (...args: unknown[]) => selectPreferredChannelMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
  invalidateTokenRouterCache: vi.fn(),
}));

vi.mock('../../services/routeRefreshWorkflow.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/proxyLogStore.js', () => ({
  insertProxyLog: (...args: unknown[]) => insertProxyLogMock(...args),
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (...args: unknown[]) => resolveProxyUsageWithSelfLogFallbackMock(...args),
}));

vi.mock('./proxyBilling.js', () => ({
  resolveProxyLogBilling: (...args: unknown[]) => resolveProxyLogBillingMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('/v1/completions site api endpoint rotation', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  const originalChannelAffinity = config.channelAffinity;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-completions-site-api-endpoint-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./completions.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.completionsProxyRoute);
  });

  beforeEach(async () => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    selectPreferredChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    insertProxyLogMock.mockReset();
    resolveProxyUsageWithSelfLogFallbackMock.mockReset();
    resolveProxyLogBillingMock.mockReset();

    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    });
    resolveProxyLogBillingMock.mockResolvedValue({
      estimatedCost: 0,
      billingDetails: null,
    });

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();

    resetChannelAffinityState();
    config.channelAffinity = normalizeChannelAffinityConfig(undefined);
  });

  afterAll(async () => {
    resetChannelAffinityState();
    config.channelAffinity = originalChannelAffinity;
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('reuses a recorded affinity binding for repeated completions requests', async () => {
    config.channelAffinity = normalizeChannelAffinityConfig({
      enabled: true,
      rules: [
        {
          name: 'completions-prompt-affinity',
          pathRegex: ['^/v1/completions$'],
          keySources: [{ type: 'body_path', path: 'prompt' }],
          ttlSeconds: 600,
        },
      ],
    });

    const site = await db.insert(schema.sites).values({
      name: 'affinity-panel',
      url: 'https://affinity.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'affinity-user',
      accessToken: '',
      apiToken: 'sk-affinity',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const initialSelected = {
      channel: { id: 11, routeId: 22 },
      site,
      account,
      tokenName: 'default',
      tokenValue: 'sk-affinity',
      actualModel: 'gpt-4o-mini',
    };
    selectChannelMock.mockResolvedValue(initialSelected);
    selectPreferredChannelMock.mockResolvedValue(initialSelected);
    selectNextChannelMock.mockResolvedValue(null);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'cmpl-affinity-ok',
      object: 'text_completion',
      choices: [{ text: 'ok' }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      payload: {
        model: 'gpt-4o-mini',
        prompt: 'affinity prompt',
      },
    });
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      payload: {
        model: 'gpt-4o-mini',
        prompt: 'affinity prompt',
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(selectChannelMock).toHaveBeenCalledTimes(1);
    expect(selectPreferredChannelMock).toHaveBeenCalledTimes(1);
    expect(selectPreferredChannelMock).toHaveBeenCalledWith(
      'gpt-4o-mini',
      11,
      expect.objectContaining({
        allowedRouteIds: [],
        excludedSiteIds: [],
      }),
      []
    );
  });

  it('does not retry to another channel when an affinity-bound completions request enables skipRetryOnFailure', async () => {
    config.channelAffinity = normalizeChannelAffinityConfig({
      enabled: true,
      rules: [
        {
          name: 'completions-prompt-affinity-skip-retry',
          pathRegex: ['^/v1/completions$'],
          keySources: [{ type: 'body_path', path: 'prompt' }],
          ttlSeconds: 600,
          skipRetryOnFailure: true,
        },
      ],
    });

    const site = await db.insert(schema.sites).values({
      name: 'affinity-skip-panel',
      url: 'https://affinity-skip.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'affinity-skip-user',
      accessToken: '',
      apiToken: 'sk-affinity-skip',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const initialSelected = {
      channel: { id: 21, routeId: 31 },
      site,
      account,
      tokenName: 'default',
      tokenValue: 'sk-affinity-skip',
      actualModel: 'gpt-4o-mini',
    };
    selectChannelMock.mockResolvedValue(initialSelected);
    selectPreferredChannelMock.mockResolvedValue(initialSelected);
    selectNextChannelMock.mockResolvedValue({
      channel: { id: 22, routeId: 32 },
      site,
      account,
      tokenName: 'default',
      tokenValue: 'sk-affinity-skip-2',
      actualModel: 'gpt-4o-mini',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cmpl-affinity-seed',
        object: 'text_completion',
        choices: [{ text: 'seed' }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('retryable upstream failure', { status: 503 }));

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      payload: {
        model: 'gpt-4o-mini',
        prompt: 'affinity skip retry prompt',
      },
    });
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      payload: {
        model: 'gpt-4o-mini',
        prompt: 'affinity skip retry prompt',
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(503);
    expect(selectPreferredChannelMock).toHaveBeenCalledTimes(1);
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(reportProxyAllFailedMock).toHaveBeenCalledWith({
      model: 'gpt-4o-mini',
      reason: 'retryable upstream failure',
    });
  });

  it('cools down a retryable failed endpoint and retries the next endpoint within the same site', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'nihao-panel',
      url: 'https://console.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'nihao-user',
      accessToken: '',
      apiToken: 'sk-nihao',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-a.example.com',
        enabled: true,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-b.example.com',
        enabled: true,
        sortOrder: 1,
      },
    ]).run();

    selectChannelMock.mockResolvedValue({
      channel: { id: 11, routeId: 22 },
      site,
      account,
      tokenName: 'default',
      tokenValue: 'sk-nihao',
      actualModel: 'gpt-4o-mini',
    });
    selectNextChannelMock.mockResolvedValue(null);

    fetchMock
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cmpl-ok',
        object: 'text_completion',
        choices: [{ text: 'ok' }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: {
        authorization: 'Bearer sk-downstream',
      },
      payload: {
        model: 'gpt-4o-mini',
        prompt: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'cmpl-ok',
      object: 'text_completion',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0] || '')).toBe('https://api-a.example.com/v1/completions');
    expect(String(fetchMock.mock.calls[1]?.[0] || '')).toBe('https://api-b.example.com/v1/completions');
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);

    const storedEndpoints = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.siteId, site.id))
      .orderBy(asc(schema.siteApiEndpoints.sortOrder), asc(schema.siteApiEndpoints.id))
      .all();
    expect(storedEndpoints[0]).toMatchObject({
      url: 'https://api-a.example.com',
      lastFailureReason: 'HTTP 502: bad gateway',
    });
    expect(storedEndpoints[0]?.cooldownUntil).toBeTruthy();
    expect(storedEndpoints[1]).toMatchObject({
      url: 'https://api-b.example.com',
    });
    expect(storedEndpoints[1]?.lastSelectedAt).toBeTruthy();
  });
});
