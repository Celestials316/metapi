import Fastify, { type FastifyInstance } from 'fastify';
import { registerProxyActiveRuntime, resetProxyActiveRuntimeRegistry } from '../../services/proxyActiveRuntimeRegistry.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');
type StoreModule = typeof import('../../services/proxyDebugTraceStore.js');

describe('stats proxy debug api', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-stats-proxy-debug-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const storeModule = await import('../../services/proxyDebugTraceStore.js');
    const statsRoutesModule = await import('./stats.js');

    db = dbModule.db;
    schema = dbModule.schema;
    store = storeModule;

    app = Fastify();
    await app.register(statsRoutesModule.statsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.proxyDebugAttempts).run();
    await db.delete(schema.proxyDebugTraces).run();
    resetProxyActiveRuntimeRegistry();
  });

  afterAll(async () => {
    await app.close();
    const dbModule = await import('../../db/index.js');
    await dbModule.closeDbConnections();
    delete process.env.DATA_DIR;
  });


  it('includes runtime diagnostics alongside proxy debug trace detail', async () => {
    const trace = await store.createProxyDebugTrace({
      downstreamPath: '/v1/responses',
      clientKind: 'codex',
      sessionId: 'sess-runtime-1',
      traceHint: 'trace-runtime-1',
      requestedModel: 'gpt-5.4',
      requestHeaders: { authorization: 'Bearer test' },
      requestBody: { model: 'gpt-5.4' },
    });

    registerProxyActiveRuntime({
      traceId: trace.id,
      downstreamPath: '/v1/responses',
      nowMs: 123,
    });

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/stats/proxy-debug/traces/${trace.id}`,
    });

    expect(detailResponse.statusCode).toBe(200);
    const detailBody = detailResponse.json() as {
      runtimeDiagnostics?: {
        activeRuntime?: { traceId?: number; downstreamPath?: string; stage?: string } | null;
        websocketRuntime?: unknown;
      };
    };
    expect(detailBody.runtimeDiagnostics?.activeRuntime).toMatchObject({
      traceId: trace.id,
      downstreamPath: '/v1/responses',
      stage: 'accepted',
    });
    expect(detailBody.runtimeDiagnostics?.websocketRuntime).toBeNull();
  });

  it('lists and returns proxy debug traces with attempt details', async () => {
    const trace = await store.createProxyDebugTrace({
      downstreamPath: '/v1/chat/completions',
      clientKind: 'codex',
      sessionId: 'sess-9',
      traceHint: 'trace-x',
      requestedModel: 'gpt-4.1',
      requestHeaders: { authorization: 'Bearer test' },
      requestBody: { model: 'gpt-4.1' },
    });
    await store.insertProxyDebugAttempt({
      traceId: trace.id,
      attemptIndex: 0,
      endpoint: 'chat',
      requestPath: '/v1/chat/completions',
      targetUrl: 'https://example.com/v1/chat/completions',
      runtimeExecutor: 'default',
      requestHeaders: { authorization: 'Bearer test' },
      requestBody: { model: 'gpt-4.1' },
      responseStatus: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: { id: 'chatcmpl_123' },
      rawErrorText: null,
      recoverApplied: false,
      downgradeDecision: false,
      downgradeReason: null,
      memoryWrite: { action: 'success', preferredEndpoint: 'chat' },
    });
    await store.finalizeProxyDebugTrace(trace.id, {
      finalStatus: 'success',
      finalHttpStatus: 200,
      finalUpstreamPath: '/v1/chat/completions',
      finalResponseHeaders: { 'content-type': 'application/json' },
      finalResponseBody: { id: 'chatcmpl_123' },
    });

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/stats/proxy-debug/traces?limit=10',
    });
    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json() as { items?: Array<{ id: number; finalStatus: string }> };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items?.[0]?.finalStatus).toBe('success');

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/stats/proxy-debug/traces/${trace.id}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detailBody = detailResponse.json() as {
      trace?: { requestedModel?: string; sessionId?: string };
      attempts?: Array<{ endpoint?: string; responseStatus?: number }>;
    };
    expect(detailBody.trace).toMatchObject({
      requestedModel: 'gpt-4.1',
      sessionId: 'sess-9',
    });
    expect(detailBody.attempts?.[0]).toMatchObject({
      endpoint: 'chat',
      responseStatus: 200,
    });
  });
});
