import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbGetMock = vi.fn();
const getPreferredAccountTokenMock = vi.fn();
const getOauthInfoFromAccountMock = vi.fn();
const buildOauthProviderHeadersMock = vi.fn();
const resolveChannelProxyUrlMock = vi.fn();
const withSiteRecordProxyRequestInitMock = vi.fn();
const resolveUpstreamEndpointCandidatesMock = vi.fn();
const buildUpstreamEndpointRequestMock = vi.fn();
const executeEndpointFlowMock = vi.fn();

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ args }),
}));

vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            get: dbGetMock,
          }),
        }),
      }),
    })),
  },
  schema: {
    accounts: {
      id: 'accounts.id',
      siteId: 'accounts.siteId',
    },
    sites: {
      id: 'sites.id',
    },
  },
}));

vi.mock('./accountTokenService.js', () => ({
  getPreferredAccountToken: (...args: unknown[]) => getPreferredAccountTokenMock(...args),
}));

vi.mock('./oauth/oauthAccount.js', () => ({
  getOauthInfoFromAccount: (...args: unknown[]) => getOauthInfoFromAccountMock(...args),
}));

vi.mock('./oauth/service.js', () => ({
  buildOauthProviderHeaders: (...args: unknown[]) => buildOauthProviderHeadersMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  resolveChannelProxyUrl: (...args: unknown[]) => resolveChannelProxyUrlMock(...args),
  withSiteRecordProxyRequestInit: (...args: unknown[]) => withSiteRecordProxyRequestInitMock(...args),
}));

vi.mock('./upstreamEndpointRuntime.js', () => ({
  resolveUpstreamEndpointCandidates: (...args: unknown[]) => resolveUpstreamEndpointCandidatesMock(...args),
  buildUpstreamEndpointRequest: (...args: unknown[]) => buildUpstreamEndpointRequestMock(...args),
}));

vi.mock('../proxy-core/orchestration/endpointFlow.js', () => ({
  executeEndpointFlow: (...args: unknown[]) => executeEndpointFlowMock(...args),
}));

vi.mock('./runtimeDispatch.js', () => ({
  dispatchRuntimeRequest: vi.fn(),
}));

describe('accountProbeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbGetMock.mockResolvedValue({
      accounts: {
        id: 1,
        siteId: 1,
        username: 'alpha',
        accessToken: 'session-token',
        apiToken: null,
        extraConfig: JSON.stringify({ credentialMode: 'session' }),
      },
      sites: {
        id: 1,
        name: 'Site A',
        url: 'https://probe.example.com',
        platform: 'new-api',
      },
    });
    getPreferredAccountTokenMock.mockResolvedValue({ token: 'sk-managed-default' });
    getOauthInfoFromAccountMock.mockReturnValue(null);
    buildOauthProviderHeadersMock.mockReturnValue({});
    resolveChannelProxyUrlMock.mockReturnValue(null);
    withSiteRecordProxyRequestInitMock.mockImplementation((_site: unknown, init: unknown) => init);
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    buildUpstreamEndpointRequestMock.mockImplementation((input: { modelName?: string; tokenValue?: string }) => ({
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: {
        model: input.modelName || 'unknown-model',
        tokenValue: input.tokenValue || '',
      },
      runtime: {
        executor: 'default',
        modelName: input.modelName || 'unknown-model',
        stream: false,
      },
    }));
    executeEndpointFlowMock.mockImplementation(async (input: {
      endpointCandidates: string[];
      buildRequest: (endpoint: string) => unknown;
    }) => {
      input.buildRequest(input.endpointCandidates[0] || 'chat');
      return {
        ok: true,
        upstream: new Response(JSON.stringify({
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
          headers: { 'content-type': 'application/json' },
        }),
        upstreamPath: '/v1/chat/completions',
      };
    });
  });

  it('uses the preferred managed token for session connections and normalizes the reply text', async () => {
    const { probeAccountChat } = await import('./accountProbeService.js');
    const result = await probeAccountChat({ accountId: 1, modelName: 'gpt-4.1' });

    expect(result).toMatchObject({
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

  it('returns a friendly failure when the session connection has no usable managed token', async () => {
    getPreferredAccountTokenMock.mockResolvedValue(null);

    const { probeAccountChat } = await import('./accountProbeService.js');
    const result = await probeAccountChat({ accountId: 1, modelName: 'gpt-4.1' });

    expect(result).toMatchObject({
      success: false,
      statusText: '测活失败',
      errorMessage: '该连接暂无可用账号令牌，请先同步或设置默认令牌',
      latencyMs: null,
      model: 'gpt-4.1',
    });
    expect(buildUpstreamEndpointRequestMock).not.toHaveBeenCalled();
  });

  it('uses direct apiToken for API key connections', async () => {
    dbGetMock.mockResolvedValue({
      accounts: {
        id: 2,
        siteId: 1,
        username: 'beta',
        accessToken: '',
        apiToken: 'sk-direct-account',
        extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
      },
      sites: {
        id: 1,
        name: 'Site A',
        url: 'https://probe.example.com',
        platform: 'new-api',
      },
    });

    const { probeAccountChat } = await import('./accountProbeService.js');
    const result = await probeAccountChat({ accountId: 2, modelName: 'gpt-4.1-mini' });

    expect(result).toMatchObject({
      success: true,
      statusText: '服务正常',
      replyText: '你好，我在线。',
    });
    expect(buildUpstreamEndpointRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      tokenValue: 'sk-direct-account',
      modelName: 'gpt-4.1-mini',
    }));
  });
});
