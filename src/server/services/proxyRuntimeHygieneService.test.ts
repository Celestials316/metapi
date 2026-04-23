import { beforeEach, describe, expect, it, vi } from 'vitest';

const finalizeProxyDebugTraceMock = vi.fn(async () => {});
const clearStickyChannelMock = vi.fn();
const clearStickyChannelsByChannelIdsMock = vi.fn();
const clearCodexSessionResponseIdMock = vi.fn();
const evictStaleSessionsMock = vi.fn(async () => 0);
const evictStaleProxyActiveRuntimesMock = vi.fn(() => 0);
const dbSelectAllMock = vi.fn(async () => []);

vi.mock('./proxyDebugTraceStore.js', () => ({
  finalizeProxyDebugTrace: (...args: unknown[]) => finalizeProxyDebugTraceMock(...args),
}));

vi.mock('./proxyChannelCoordinator.js', () => ({
  proxyChannelCoordinator: {
    clearStickyChannel: (...args: unknown[]) => clearStickyChannelMock(...args),
    clearStickyChannelsByChannelIds: (...args: unknown[]) => clearStickyChannelsByChannelIdsMock(...args),
  },
}));

vi.mock('../proxy-core/runtime/codexSessionResponseStore.js', () => ({
  clearCodexSessionResponseId: (...args: unknown[]) => clearCodexSessionResponseIdMock(...args),
}));

vi.mock('../proxy-core/runtime/codexWebsocketRuntime.js', () => ({
  sharedCodexWebsocketRuntime: {
    evictStaleSessions: (...args: unknown[]) => evictStaleSessionsMock(...args),
  },
}));

vi.mock('./proxyActiveRuntimeRegistry.js', () => ({
  evictStaleProxyActiveRuntimes: (...args: unknown[]) => evictStaleProxyActiveRuntimesMock(...args),
}));

vi.mock('../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            all: () => dbSelectAllMock(),
          }),
        }),
      }),
    }),
  },
  schema: {
    proxyDebugTraces: {
      id: 'id',
      sessionId: 'sessionId',
      traceHint: 'traceHint',
      stickySessionKey: 'stickySessionKey',
      selectedChannelId: 'selectedChannelId',
      updatedAt: 'updatedAt',
      createdAt: 'createdAt',
      finalStatus: 'finalStatus',
    },
  },
}));

describe('proxyRuntimeHygieneService', () => {
  beforeEach(() => {
    finalizeProxyDebugTraceMock.mockClear();
    clearStickyChannelMock.mockClear();
    clearStickyChannelsByChannelIdsMock.mockClear();
    clearCodexSessionResponseIdMock.mockClear();
    dbSelectAllMock.mockReset();
    evictStaleSessionsMock.mockReset();
    evictStaleSessionsMock.mockResolvedValue(0);
    evictStaleProxyActiveRuntimesMock.mockReset();
    evictStaleProxyActiveRuntimesMock.mockReturnValue(0);
  });

  it('marks stale unfinished traces as orphaned and clears sticky bindings plus session anchors', async () => {
    dbSelectAllMock.mockResolvedValueOnce([
      {
        id: 1,
        sessionId: 'session-reconcile-1',
        traceHint: 'trace-reconcile-1',
        stickySessionKey: 'sticky-key-1',
        selectedChannelId: 123,
        updatedAt: '2026-04-23 00:00:00',
        createdAt: '2026-04-23 00:00:00',
      },
    ]);

    const { runProxyRuntimeHygieneSweep } = await import('./proxyRuntimeHygieneService.js');
    const count = await runProxyRuntimeHygieneSweep(Date.now());

    expect(count).toBe(1);
    expect(finalizeProxyDebugTraceMock).toHaveBeenCalledWith(1, expect.objectContaining({
      finalStatus: 'orphaned',
      finalHttpStatus: 499,
      finalResponseBody: expect.objectContaining({
        metapiRuntimeReason: 'runtime_scavenged_orphan',
        error: expect.objectContaining({
          reason: 'runtime_scavenged_orphan',
        }),
      }),
    }));
    expect(clearStickyChannelMock).toHaveBeenCalledWith('sticky-key-1', 123);
    expect(clearStickyChannelsByChannelIdsMock).toHaveBeenCalledWith([123]);
    expect(clearCodexSessionResponseIdMock).toHaveBeenCalledWith('session-reconcile-1');
    expect(clearCodexSessionResponseIdMock).toHaveBeenCalledWith('trace-reconcile-1');
    expect(evictStaleSessionsMock).toHaveBeenCalledTimes(1);
    expect(evictStaleSessionsMock).toHaveBeenCalledWith(expect.objectContaining({
      staleBeforeMs: expect.any(Number),
      closeReason: 'proxy-runtime-hygiene',
    }));
    expect(evictStaleProxyActiveRuntimesMock).toHaveBeenCalledTimes(1);
    expect(evictStaleProxyActiveRuntimesMock).toHaveBeenCalledWith(expect.objectContaining({
      staleBeforeMs: expect.any(Number),
    }));
  });
});
