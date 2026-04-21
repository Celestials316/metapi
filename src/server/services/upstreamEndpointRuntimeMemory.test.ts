import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type RuntimeMemoryModule = typeof import('./upstreamEndpointRuntimeMemory.js');

describe('upstreamEndpointRuntimeMemory', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let ensureUpstreamEndpointRuntimeStateLoaded: RuntimeMemoryModule['ensureUpstreamEndpointRuntimeStateLoaded'];
  let flushUpstreamEndpointRuntimePersistence: RuntimeMemoryModule['flushUpstreamEndpointRuntimePersistence'];
  let getUpstreamEndpointRuntimeStateSnapshot: RuntimeMemoryModule['getUpstreamEndpointRuntimeStateSnapshot'];
  let recordUpstreamEndpointFailure: RuntimeMemoryModule['recordUpstreamEndpointFailure'];
  let recordUpstreamEndpointSuccess: RuntimeMemoryModule['recordUpstreamEndpointSuccess'];
  let resetUpstreamEndpointRuntimeState: RuntimeMemoryModule['resetUpstreamEndpointRuntimeState'];
  let dataDir = '';

  const baseInput = {
    siteId: 17,
    downstreamFormat: 'responses' as const,
    modelName: 'gpt-5.4',
    hasConversationFiles: false,
    wantsRemoteImageUrl: false,
    reasoningEffort: null,
    wantsContinuationAwareResponses: false,
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-endpoint-runtime-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const runtimeModule = await import('./upstreamEndpointRuntimeMemory.js');
    db = dbModule.db;
    schema = dbModule.schema;
    ensureUpstreamEndpointRuntimeStateLoaded = runtimeModule.ensureUpstreamEndpointRuntimeStateLoaded;
    flushUpstreamEndpointRuntimePersistence = runtimeModule.flushUpstreamEndpointRuntimePersistence;
    getUpstreamEndpointRuntimeStateSnapshot = runtimeModule.getUpstreamEndpointRuntimeStateSnapshot;
    recordUpstreamEndpointFailure = runtimeModule.recordUpstreamEndpointFailure;
    recordUpstreamEndpointSuccess = runtimeModule.recordUpstreamEndpointSuccess;
    resetUpstreamEndpointRuntimeState = runtimeModule.resetUpstreamEndpointRuntimeState;
  });

  beforeEach(async () => {
    resetUpstreamEndpointRuntimeState();
    await db.delete(schema.settings).run();
  });

  afterAll(() => {
    resetUpstreamEndpointRuntimeState();
    delete process.env.DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists endpoint preference across a reset and reload', async () => {
    await ensureUpstreamEndpointRuntimeStateLoaded(baseInput.siteId);

    recordUpstreamEndpointSuccess({
      ...baseInput,
      endpoint: 'responses',
    });
    await flushUpstreamEndpointRuntimePersistence();

    resetUpstreamEndpointRuntimeState();
    await ensureUpstreamEndpointRuntimeStateLoaded(baseInput.siteId);

    const snapshot = getUpstreamEndpointRuntimeStateSnapshot(baseInput);
    expect(snapshot.preferredEndpoint).toBe('responses');
    expect(snapshot.blockedEndpoints).toEqual([]);
  });

  it('persists endpoint block state across a reset and reload', async () => {
    await ensureUpstreamEndpointRuntimeStateLoaded(baseInput.siteId);

    recordUpstreamEndpointFailure({
      ...baseInput,
      endpoint: 'chat',
      status: 415,
      errorText: 'unsupported endpoint for this payload',
    });
    await flushUpstreamEndpointRuntimePersistence();

    resetUpstreamEndpointRuntimeState();
    await ensureUpstreamEndpointRuntimeStateLoaded(baseInput.siteId);

    const snapshot = getUpstreamEndpointRuntimeStateSnapshot(baseInput);
    expect(snapshot.blockedEndpoints).toContain('chat');
  });

  it('persists site-scoped endpoint runtime state across multiple flushes without leaking across sites', async () => {
    await ensureUpstreamEndpointRuntimeStateLoaded(baseInput.siteId);
    await ensureUpstreamEndpointRuntimeStateLoaded(baseInput.siteId + 1);

    recordUpstreamEndpointSuccess({
      ...baseInput,
      endpoint: 'responses',
    });
    await flushUpstreamEndpointRuntimePersistence();

    recordUpstreamEndpointFailure({
      ...baseInput,
      siteId: baseInput.siteId + 1,
      endpoint: 'messages',
      status: 415,
      errorText: 'unsupported endpoint for this payload',
    });
    await flushUpstreamEndpointRuntimePersistence();

    resetUpstreamEndpointRuntimeState();
    await ensureUpstreamEndpointRuntimeStateLoaded(baseInput.siteId);
    await ensureUpstreamEndpointRuntimeStateLoaded(baseInput.siteId + 1);

    const siteOneSnapshot = getUpstreamEndpointRuntimeStateSnapshot(baseInput);
    const siteTwoSnapshot = getUpstreamEndpointRuntimeStateSnapshot({
      ...baseInput,
      siteId: baseInput.siteId + 1,
    });

    expect(siteOneSnapshot.preferredEndpoint).toBe('responses');
    expect(siteOneSnapshot.blockedEndpoints).toEqual([]);
    expect(siteTwoSnapshot.preferredEndpoint).toBeNull();
    expect(siteTwoSnapshot.blockedEndpoints).toContain('messages');
  });

  it('persists overlapped site runtime updates that arrive during an in-flight save', async () => {
    const upsertSettingModule = await import('../db/upsertSetting.js');
    const realUpsertSetting = upsertSettingModule.upsertSetting;
    let releaseFirstPersist: (() => void) | null = null;
    let shouldBlockFirstPersist = true;
    const upsertSettingSpy = vi.spyOn(upsertSettingModule, 'upsertSetting').mockImplementation(async (...args) => {
      if (shouldBlockFirstPersist) {
        shouldBlockFirstPersist = false;
        await new Promise<void>((resolve) => {
          releaseFirstPersist = resolve;
        });
      }
      return realUpsertSetting(...args);
    });

    try {
      recordUpstreamEndpointSuccess({
        ...baseInput,
        endpoint: 'responses',
      });
      const firstFlushPromise = flushUpstreamEndpointRuntimePersistence(baseInput.siteId);
      await vi.waitFor(() => expect(releaseFirstPersist).not.toBeNull());

      recordUpstreamEndpointFailure({
        ...baseInput,
        endpoint: 'messages',
        status: 415,
        errorText: 'unsupported endpoint for this payload',
      });
      const secondFlushPromise = flushUpstreamEndpointRuntimePersistence(baseInput.siteId);

      releaseFirstPersist?.();
      await firstFlushPromise;
      await secondFlushPromise;

      resetUpstreamEndpointRuntimeState();
      await ensureUpstreamEndpointRuntimeStateLoaded(baseInput.siteId);

      const snapshot = getUpstreamEndpointRuntimeStateSnapshot(baseInput);
      expect(snapshot.preferredEndpoint).toBe('responses');
      expect(snapshot.blockedEndpoints).toContain('messages');
    } finally {
      upsertSettingSpy.mockRestore();
    }
  });
});
