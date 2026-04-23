import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const estimateProxyCostMock = vi.fn(async () => 0);
const shouldRetryProxyRequestMock = vi.fn();
const dbInsertMock = vi.fn((_arg?: any) => ({
  values: () => ({
    run: () => undefined,
  }),
}));

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
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: () => false,
}));

vi.mock('../../services/modelPricingService.js', () => ({
  estimateProxyCost: (arg: any) => estimateProxyCostMock(arg),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: (...args: unknown[]) => shouldRetryProxyRequestMock(...args),
  shouldAbortSameSiteEndpointFallback: () => false,
  RETRYABLE_TIMEOUT_PATTERNS: [/(request timed out|connection timed out|read timeout|\btimed out\b)/i],
}));

vi.mock('../../db/index.js', () => ({
  db: {
    insert: (arg: any) => dbInsertMock(arg),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            all: async () => [],
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: async () => undefined,
        }),
      }),
    }),
  },
  hasProxyLogBillingDetailsColumn: async () => false,
  hasProxyLogClientColumns: async () => false,
  hasProxyLogDownstreamApiKeyIdColumn: async () => false,
  hasProxyLogStreamTimingColumns: async () => false,
  schema: {
    proxyLogs: {},
    siteApiEndpoints: {
      id: {},
      siteId: {},
      sortOrder: {},
    },
  },
}));

function buildMultipartBody(boundary: string) {
  return Buffer.from(
    `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="model"\r\n\r\n`
      + `gpt-image-1\r\n`
      + `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="prompt"\r\n\r\n`
      + `edit this\r\n`
      + `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="image"; filename="cat.png"\r\n`
      + `Content-Type: image/png\r\n\r\n`
      + `pngdata\r\n`
      + `--${boundary}--\r\n`,
  );
}

describe('/v1/images/edits route', () => {
  let app: FastifyInstance;
  const originalChannelAffinity = config.channelAffinity;

  beforeAll(async () => {
    const { imagesProxyRoute } = await import('./images.js');
    app = Fastify({ bodyLimit: 25 * 1024 * 1024 });
    await app.register(imagesProxyRoute);
  });

  beforeEach(() => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    selectPreferredChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    estimateProxyCostMock.mockClear();
    shouldRetryProxyRequestMock.mockReset();
    dbInsertMock.mockClear();

    shouldRetryProxyRequestMock.mockReturnValue(false);
    resetChannelAffinityState();
    config.channelAffinity = normalizeChannelAffinityConfig(undefined);

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt-image',
    });
    selectNextChannelMock.mockReturnValue(null);
  });

  afterAll(async () => {
    resetChannelAffinityState();
    config.channelAffinity = originalChannelAffinity;
    if (app) {
      await app.close();
    }
  });

  it('reuses a recorded affinity binding for repeated image generation requests', async () => {
    config.channelAffinity = normalizeChannelAffinityConfig({
      enabled: true,
      rules: [
        {
          name: 'images-prompt-affinity',
          pathRegex: ['^/v1/images/generations$'],
          keySources: [{ type: 'body_path', path: 'prompt' }],
          ttlSeconds: 600,
        },
      ],
    });

    const selected = {
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt-image',
    };
    selectChannelMock.mockReturnValue(selected);
    selectPreferredChannelMock.mockReturnValue(selected);
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { authorization: 'Bearer sk-demo' },
      payload: { model: 'gpt-image-1', prompt: 'affinity image prompt' },
    });
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { authorization: 'Bearer sk-demo' },
      payload: { model: 'gpt-image-1', prompt: 'affinity image prompt' },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(selectChannelMock).toHaveBeenCalledTimes(1);
    expect(selectPreferredChannelMock).toHaveBeenCalledTimes(1);
  });

  it('does not fan out to another channel when an affinity-bound image edit request enables skipRetryOnFailure', async () => {
    config.channelAffinity = normalizeChannelAffinityConfig({
      enabled: true,
      rules: [
        {
          name: 'images-edit-affinity-skip-retry',
          pathRegex: ['^/v1/images/edits$'],
          keySources: [{ type: 'body_path', path: 'prompt' }],
          ttlSeconds: 600,
          skipRetryOnFailure: true,
        },
      ],
    });
    shouldRetryProxyRequestMock.mockReturnValue(true);

    const selected = {
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt-image',
    };
    selectChannelMock.mockReturnValue(selected);
    selectPreferredChannelMock.mockReturnValue(selected);
    selectNextChannelMock.mockReturnValue({
      ...selected,
      channel: { id: 12, routeId: 23 },
      tokenValue: 'sk-next',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        created: 1,
        data: [{ b64_json: 'iVBORw0KGgo=' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('retryable upstream failure', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }));

    const boundary = 'metapi-boundary-affinity';
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer sk-demo',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody(boundary),
    });
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer sk-demo',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody(boundary),
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(503);
    expect(selectPreferredChannelMock).toHaveBeenCalledTimes(1);
    expect(selectNextChannelMock).not.toHaveBeenCalled();
  });

  it('accepts multipart image edit requests and forwards them to /v1/images/edits', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const boundary = 'metapi-boundary';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer sk-demo',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody(boundary),
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://upstream.example.com/v1/images/edits');
  });

  it('defaults image generation requests to gpt-image-2 when model is omitted', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        prompt: 'draw a cat',
      },
    });

    expect(response.statusCode).toBe(200);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      model: 'upstream-gpt-image',
      prompt: 'draw a cat',
    });
    expect(selectChannelMock).toHaveBeenCalledWith(
      'gpt-image-2',
      expect.any(Object),
    );
  });

  it('defaults image edit requests to gpt-image-2 when model is omitted', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer sk-demo',
        'content-type': 'application/json',
      },
      payload: {
        prompt: 'edit this',
      },
    });

    expect(response.statusCode).toBe(200);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      model: 'upstream-gpt-image',
      prompt: 'edit this',
    });
    expect(selectChannelMock).toHaveBeenCalledWith(
      'gpt-image-2',
      expect.any(Object),
    );
  });

  it('rejects multipart image parts larger than 20MB even when bodyLimit is higher', async () => {
    const boundary = 'metapi-boundary-large-image';
    const oversizedImage = Buffer.alloc((20 << 20) + 1, 0x61);
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n`
          + `Content-Disposition: form-data; name="model"\r\n\r\n`
          + `gpt-image-1\r\n`
          + `--${boundary}\r\n`
          + `Content-Disposition: form-data; name="prompt"\r\n\r\n`
          + `edit this\r\n`
          + `--${boundary}\r\n`
          + `Content-Disposition: form-data; name="image"; filename="cat.png"\r\n`
          + `Content-Type: image/png\r\n\r\n`,
      ),
      oversizedImage,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer sk-demo',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: 'multipart field "image" is too large (max 20 MiB)',
        type: 'invalid_request_error',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an explicit too-large upstream error when the image response body exceeds the default limit', async () => {
    fetchMock.mockResolvedValue(new Response('a'.repeat((2 << 20) + 16), {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        model: 'gpt-image-1',
        prompt: 'draw a cat',
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        message: 'Upstream response too large',
        type: 'upstream_error',
      },
    });
  });

  it('retries the next channel when image generation JSON is malformed', async () => {
    shouldRetryProxyRequestMock.mockReturnValue(true);
    selectNextChannelMock.mockReturnValueOnce({
      channel: { id: 12, routeId: 23 },
      site: { id: 45, name: 'fallback-site', url: 'https://fallback.example.com', platform: 'openai' },
      account: { id: 34, username: 'fallback-user' },
      tokenName: 'fallback',
      tokenValue: 'sk-fallback',
      actualModel: 'fallback-gpt-image',
    });
    fetchMock
      .mockResolvedValueOnce(new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        created: 2,
        data: [{ b64_json: 'ZmFsbGJhY2s=' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        model: 'gpt-image-1',
        prompt: 'draw a cat',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      created: 2,
      data: [{ b64_json: 'ZmFsbGJhY2s=' }],
    });
    expect(selectNextChannelMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps returning a successful image edit response when post-success accounting fails', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    estimateProxyCostMock.mockRejectedValueOnce(new Error('cost failed'));

    const boundary = 'metapi-boundary-accounting';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer sk-demo',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody(boundary),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      created: 1,
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    });
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(recordFailureMock).not.toHaveBeenCalled();
  });

  it('returns explicit not-supported error for /v1/images/variations', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/variations',
      payload: {
        model: 'gpt-image-1',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'Image variations are not supported',
        type: 'invalid_request_error',
      },
    });
  });
});
