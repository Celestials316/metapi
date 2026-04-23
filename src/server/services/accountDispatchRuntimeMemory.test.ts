import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type RuntimeMemoryModule = typeof import('./accountDispatchRuntimeMemory.js');

describe('accountDispatchRuntimeMemory', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let ensureAccountDispatchRuntimeStateLoaded: RuntimeMemoryModule['ensureAccountDispatchRuntimeStateLoaded'];
  let flushAccountDispatchRuntimePersistence: RuntimeMemoryModule['flushAccountDispatchRuntimePersistence'];
  let clearAccountDispatchRuntimeStatesForAccount: RuntimeMemoryModule['clearAccountDispatchRuntimeStatesForAccount'];
  let getAccountDispatchRuntimeSnapshot: RuntimeMemoryModule['getAccountDispatchRuntimeSnapshot'];
  let recordAccountDispatchFailure: RuntimeMemoryModule['recordAccountDispatchFailure'];
  let recordAccountDispatchProbeSuccess: RuntimeMemoryModule['recordAccountDispatchProbeSuccess'];
  let recordAccountDispatchSelectionBlocked: RuntimeMemoryModule['recordAccountDispatchSelectionBlocked'];
  let recordAccountDispatchSuccess: RuntimeMemoryModule['recordAccountDispatchSuccess'];
  let resetAccountDispatchRuntimeMemory: RuntimeMemoryModule['resetAccountDispatchRuntimeMemory'];
  let dataDir = '';

  const routeId = 7;
  const modelName = 'gpt-5.4';
  const accountId = 11;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-dispatch-runtime-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const runtimeModule = await import('./accountDispatchRuntimeMemory.js');
    db = dbModule.db;
    schema = dbModule.schema;
    ensureAccountDispatchRuntimeStateLoaded = runtimeModule.ensureAccountDispatchRuntimeStateLoaded;
    flushAccountDispatchRuntimePersistence = runtimeModule.flushAccountDispatchRuntimePersistence;
    clearAccountDispatchRuntimeStatesForAccount = runtimeModule.clearAccountDispatchRuntimeStatesForAccount;
    getAccountDispatchRuntimeSnapshot = runtimeModule.getAccountDispatchRuntimeSnapshot;
    recordAccountDispatchFailure = runtimeModule.recordAccountDispatchFailure;
    recordAccountDispatchProbeSuccess = runtimeModule.recordAccountDispatchProbeSuccess;
    recordAccountDispatchSelectionBlocked = runtimeModule.recordAccountDispatchSelectionBlocked;
    recordAccountDispatchSuccess = runtimeModule.recordAccountDispatchSuccess;
    resetAccountDispatchRuntimeMemory = runtimeModule.resetAccountDispatchRuntimeMemory;
  });

  beforeEach(async () => {
    resetAccountDispatchRuntimeMemory();
    await db.delete(schema.settings).run();
  });

  afterAll(() => {
    resetAccountDispatchRuntimeMemory();
    delete process.env.DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stays healthy after one soft failure and degrades after the threshold', () => {
    const firstFailure = recordAccountDispatchFailure({
      routeId,
      modelName,
      accountId,
      kind: 'soft',
      nowMs: 1_000,
    });
    expect(firstFailure.status).toBe('healthy');
    expect(firstFailure.consecutiveSoftFailureCount).toBe(1);

    const secondFailure = recordAccountDispatchFailure({
      routeId,
      modelName,
      accountId,
      kind: 'soft',
      nowMs: 2_000,
    });
    expect(secondFailure.status).toBe('degraded');
    expect(secondFailure.consecutiveSoftFailureCount).toBe(0);
    expect(secondFailure.degradedAtMs).toBe(2_000);
  });

  it('degrades immediately on hard failure or selection blocked', () => {
    const hardFailure = recordAccountDispatchFailure({
      routeId,
      modelName,
      accountId,
      kind: 'hard',
      nowMs: 5_000,
    });
    expect(hardFailure.status).toBe('degraded');

    const blocked = recordAccountDispatchSelectionBlocked(routeId, modelName, accountId, 6_000);
    expect(blocked.status).toBe('degraded');
    expect(blocked.lastFailureAtMs).toBe(6_000);
  });

  it('moves degraded primary into recovering after probe success and into failback hold after real success', () => {
    recordAccountDispatchSelectionBlocked(routeId, modelName, accountId, 10_000);

    const recovering = recordAccountDispatchProbeSuccess(routeId, modelName, accountId, 20_000);
    expect(recovering.status).toBe('recovering');
    expect(recovering.recoveringAtMs).toBe(20_000);

    const failbackHold = recordAccountDispatchSuccess(routeId, modelName, accountId, 21_000);
    expect(failbackHold.status).toBe('failback_hold');
    expect((failbackHold.holdUntilMs || 0)).toBeGreaterThan(21_000);
  });

  it('returns to healthy after hold window expires', () => {
    recordAccountDispatchSelectionBlocked(routeId, modelName, accountId, 100_000);
    recordAccountDispatchProbeSuccess(routeId, modelName, accountId, 101_000);
    const hold = recordAccountDispatchSuccess(routeId, modelName, accountId, 102_000);
    expect(hold.status).toBe('failback_hold');

    const snapshot = getAccountDispatchRuntimeSnapshot(
      routeId,
      modelName,
      accountId,
      (hold.holdUntilMs || 102_000) + 1,
    );
    expect(snapshot.status).toBe('healthy');
  });

  it('drops back to degraded when recovery traffic fails again', () => {
    recordAccountDispatchSelectionBlocked(routeId, modelName, accountId, 200_000);
    recordAccountDispatchProbeSuccess(routeId, modelName, accountId, 201_000);

    const failedDuringRecovery = recordAccountDispatchFailure({
      routeId,
      modelName,
      accountId,
      kind: 'soft',
      nowMs: 202_000,
    });
    expect(failedDuringRecovery.status).toBe('degraded');
  });

  it('preserves typed pending-overload suppression through recovery stages and clears it after hold expiry', () => {
    const recordFailureWithReason = recordAccountDispatchFailure as unknown as (input: {
      routeId: number;
      modelName: string;
      accountId: number;
      kind: 'soft' | 'hard';
      reason: string;
      nowMs: number;
    }) => Record<string, unknown>;

    const degraded = recordFailureWithReason({
      routeId,
      modelName,
      accountId,
      kind: 'soft',
      reason: 'pending_overload',
      nowMs: 400_000,
    });
    expect(degraded.status).toBe('degraded');
    expect(degraded.suppressionReason).toBe('pending_overload');

    const recovering = recordAccountDispatchProbeSuccess(routeId, modelName, accountId, 401_000) as Record<string, unknown>;
    expect(recovering.status).toBe('recovering');
    expect(recovering.suppressionReason).toBe('pending_overload');

    const hold = recordAccountDispatchSuccess(routeId, modelName, accountId, 402_000) as Record<string, unknown>;
    expect(hold.status).toBe('failback_hold');
    expect(hold.suppressionReason).toBe('pending_overload');

    const healthy = getAccountDispatchRuntimeSnapshot(
      routeId,
      modelName,
      accountId,
      ((hold.holdUntilMs as number | undefined) || 402_000) + 1,
    ) as Record<string, unknown>;
    expect(healthy.status).toBe('healthy');
    expect(healthy.suppressionReason).toBeNull();
  });

  it('records typed timeout suppression once soft failures cross the threshold', () => {
    const recordFailureWithReason = recordAccountDispatchFailure as unknown as (input: {
      routeId: number;
      modelName: string;
      accountId: number;
      kind: 'soft' | 'hard';
      reason: string;
      nowMs: number;
    }) => Record<string, unknown>;

    const firstFailure = recordFailureWithReason({
      routeId,
      modelName,
      accountId,
      kind: 'soft',
      reason: 'timeout',
      nowMs: 500_000,
    });
    expect(firstFailure.status).toBe('healthy');
    expect(firstFailure.suppressionReason).toBeNull();

    const secondFailure = recordFailureWithReason({
      routeId,
      modelName,
      accountId,
      kind: 'soft',
      reason: 'timeout',
      nowMs: 501_000,
    });
    expect(secondFailure.status).toBe('degraded');
    expect(secondFailure.suppressionReason).toBe('timeout');
  });

  it('clears all runtime states for a specific account only', async () => {
    recordAccountDispatchSelectionBlocked(routeId, modelName, accountId, 300_000);
    recordAccountDispatchSelectionBlocked(routeId + 1, `${modelName}-mini`, accountId, 301_000);
    recordAccountDispatchSelectionBlocked(routeId, modelName, accountId + 1, 302_000);

    await clearAccountDispatchRuntimeStatesForAccount(accountId);

    expect(getAccountDispatchRuntimeSnapshot(routeId, modelName, accountId, 303_000).status).toBe('healthy');
    expect(getAccountDispatchRuntimeSnapshot(routeId + 1, `${modelName}-mini`, accountId, 303_000).status).toBe('healthy');
    expect(getAccountDispatchRuntimeSnapshot(routeId, modelName, accountId + 1, 303_000).status).toBe('degraded');
  });

  it('persists runtime state across a reset and reload', async () => {
    await ensureAccountDispatchRuntimeStateLoaded();

    const nowMs = Date.now();
    recordAccountDispatchSelectionBlocked(routeId, modelName, accountId, nowMs);
    await flushAccountDispatchRuntimePersistence();

    resetAccountDispatchRuntimeMemory();
    await ensureAccountDispatchRuntimeStateLoaded();

    const restored = getAccountDispatchRuntimeSnapshot(routeId, modelName, accountId, nowMs + 1);
    expect(restored.status).toBe('degraded');
    expect(restored.degradedAtMs).toBe(nowMs);
    expect(restored.recoveringAtMs).toBeNull();
    expect(restored.holdUntilMs).toBeNull();
    expect(restored.lastSuccessAtMs).toBeNull();
    expect(restored.lastFailureAtMs).toBe(nowMs);
  });

  it('normalizes zero-valued nullable timestamps to null when restoring persisted state', async () => {
    const persistedAtMs = Date.now();
    await db.insert(schema.settings).values({
      key: 'account_dispatch_runtime_v1',
      value: JSON.stringify({
        version: 1,
        savedAtMs: persistedAtMs,
        states: {
          [`${routeId}:${modelName}:${accountId}`]: {
            status: 'degraded',
            consecutiveSoftFailureCount: 0,
            degradedAtMs: 0,
            recoveringAtMs: 0,
            holdUntilMs: 0,
            updatedAtMs: persistedAtMs,
            lastSuccessAtMs: 0,
            lastFailureAtMs: 0,
          },
        },
      }),
    }).run();

    await ensureAccountDispatchRuntimeStateLoaded();

    const restored = getAccountDispatchRuntimeSnapshot(routeId, modelName, accountId, persistedAtMs + 1);
    expect(restored.status).toBe('degraded');
    expect(restored.degradedAtMs).toBeNull();
    expect(restored.recoveringAtMs).toBeNull();
    expect(restored.holdUntilMs).toBeNull();
    expect(restored.lastSuccessAtMs).toBeNull();
    expect(restored.lastFailureAtMs).toBeNull();
  });

  it('persists account-scoped runtime state clearing across a reset and reload', async () => {
    await ensureAccountDispatchRuntimeStateLoaded();

    const nowMs = Date.now();
    recordAccountDispatchSelectionBlocked(routeId, modelName, accountId, nowMs);
    recordAccountDispatchSelectionBlocked(routeId, modelName, accountId + 1, nowMs + 1);
    await flushAccountDispatchRuntimePersistence();

    await clearAccountDispatchRuntimeStatesForAccount(accountId);
    await flushAccountDispatchRuntimePersistence();

    resetAccountDispatchRuntimeMemory();
    await ensureAccountDispatchRuntimeStateLoaded();

    expect(getAccountDispatchRuntimeSnapshot(routeId, modelName, accountId, nowMs + 2).status).toBe('healthy');
    expect(getAccountDispatchRuntimeSnapshot(routeId, modelName, accountId + 1, nowMs + 2).status).toBe('degraded');
  });

  it('clears persisted account runtime state even before the in-memory cache has been loaded', async () => {
    await ensureAccountDispatchRuntimeStateLoaded();

    const nowMs = Date.now();
    recordAccountDispatchSelectionBlocked(routeId, modelName, accountId, nowMs);
    await flushAccountDispatchRuntimePersistence();

    resetAccountDispatchRuntimeMemory();
    await clearAccountDispatchRuntimeStatesForAccount(accountId);
    await flushAccountDispatchRuntimePersistence();

    resetAccountDispatchRuntimeMemory();
    await ensureAccountDispatchRuntimeStateLoaded();

    expect(getAccountDispatchRuntimeSnapshot(routeId, modelName, accountId, nowMs + 1).status).toBe('healthy');
  });

  it('persists overlapped runtime state changes that arrive during an in-flight save', async () => {
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
      const nowMs = Date.now();
      recordAccountDispatchSelectionBlocked(routeId, modelName, accountId, nowMs);
      const firstFlushPromise = flushAccountDispatchRuntimePersistence();
      await vi.waitFor(() => expect(releaseFirstPersist).not.toBeNull());

      await clearAccountDispatchRuntimeStatesForAccount(accountId);
      const secondFlushPromise = flushAccountDispatchRuntimePersistence();

      releaseFirstPersist?.();
      await firstFlushPromise;
      await secondFlushPromise;

      resetAccountDispatchRuntimeMemory();
      await ensureAccountDispatchRuntimeStateLoaded();

      expect(getAccountDispatchRuntimeSnapshot(routeId, modelName, accountId, nowMs + 1).status).toBe('healthy');
    } finally {
      upsertSettingSpy.mockRestore();
    }
  });
});
