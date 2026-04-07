import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const resolveUpstreamEndpointCandidatesMock = vi.fn();
const buildUpstreamEndpointRequestMock = vi.fn();
const dispatchRuntimeRequestMock = vi.fn();
const resolveChannelProxyUrlMock = vi.fn();
const withSiteRecordProxyRequestInitMock = vi.fn();

vi.mock('../../services/upstreamEndpointRuntime.js', () => ({
  resolveUpstreamEndpointCandidates: (...args: unknown[]) => resolveUpstreamEndpointCandidatesMock(...args),
  buildUpstreamEndpointRequest: (...args: unknown[]) => buildUpstreamEndpointRequestMock(...args),
}));

vi.mock('../../services/runtimeDispatch.js', () => ({
  dispatchRuntimeRequest: (...args: unknown[]) => dispatchRuntimeRequestMock(...args),
}));

vi.mock('../../services/siteProxy.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/siteProxy.js')>('../../services/siteProxy.js');
  return {
    ...actual,
    resolveChannelProxyUrl: (...args: unknown[]) => resolveChannelProxyUrlMock(...args),
    withSiteRecordProxyRequestInit: (...args: unknown[]) => withSiteRecordProxyRequestInitMock(...args),
  };
});

type DbModule = typeof import('../../db/index.js');

function hasBetterSqliteBinding() {
  const base = resolve(process.cwd(), 'node_modules/better-sqlite3');
  const candidates = [
    'build/better_sqlite3.node',
    'build/Debug/better_sqlite3.node',
    'build/Release/better_sqlite3.node',
    'out/Debug/better_sqlite3.node',
    'out/Release/better_sqlite3.node',
    'Release/better_sqlite3.node',
    'build/default/better_sqlite3.node',
  ];
  return candidates.some((candidate) => existsSync(resolve(base, candidate)));
}

const describeIfBetterSqlite = hasBetterSqliteBinding() ? describe : describe.skip;

describeIfBetterSqlite('accounts connection probe route', { timeout: 15_000 }, () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-connection-probe-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    resolveUpstreamEndpointCandidatesMock.mockReset();
    buildUpstreamEndpointRequestMock.mockReset();
    dispatchRuntimeRequestMock.mockReset();
    resolveChannelProxyUrlMock.mockReset();
    withSiteRecordProxyRequestInitMock.mockReset();

    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    buildUpstreamEndpointRequestMock.mockImplementation((input: { modelName?: string; tokenValue?: string }) => ({
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: {
        model: input.modelName || 'unknown-model',
        probeToken: input.tokenValue || '',
      },
      runtime: {
        executor: 'default',
        modelName: input.modelName || 'unknown-model',
        stream: false,
      },
    }));
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_probe',
      model: 'gpt-4.1',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '你好，我在线。',
          },
        },
      ],
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }));
    resolveChannelProxyUrlMock.mockReturnValue(null);
    withSiteRecordProxyRequestInitMock.mockImplementation((_site: unknown, init: unknown) => init);

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    if (app) await app.close();
    delete process.env.DATA_DIR;
  });

  it('probes session connections with the preferred managed token', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Session Site',
      url: 'https://session-probe.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'session-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-managed-default',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/probe-chat`,
      payload: { model: 'gpt-4.1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      statusText: '服务正常',
      replyText: '你好，我在线。',
      model: 'gpt-4.1',
    });
    expect(buildUpstreamEndpointRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      tokenValue: 'sk-managed-default',
      modelName: 'gpt-4.1',
    }));
  });

  it('probes API key connections with the direct account credential', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'API Key Site',
      url: 'https://apikey-probe.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'apikey-user',
      accessToken: '',
      apiToken: 'sk-direct-account',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/probe-chat`,
      payload: { model: 'gpt-4.1-mini' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      statusText: '服务正常',
      replyText: '你好，我在线。',
      model: 'gpt-4.1',
    });
    expect(buildUpstreamEndpointRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      tokenValue: 'sk-direct-account',
      modelName: 'gpt-4.1-mini',
    }));
  });

  it('returns a failed probe result when upstream omits reply text entirely', async () => {
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_probe_empty',
      model: 'gpt-5.4',
      choices: [
        {
          message: {
            role: 'assistant',
          },
          finish_reason: 'stop',
        },
      ],
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }));

    const site = await db.insert(schema.sites).values({
      name: 'Empty Reply Site',
      url: 'https://empty-reply.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'empty-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-managed-default',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/probe-chat`,
      payload: { model: 'gpt-5.4' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      statusText: '测活失败',
      errorMessage: '上游已响应，但未返回任何可展示文本',
      model: 'gpt-5.4',
    });
  });

  it('rejects malformed probe payloads at the route boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/1/probe-chat',
      payload: { model: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: 'Invalid model. Expected non-empty string.',
    });
  });
});
