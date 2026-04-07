import { describe, expect, it } from 'vitest';
import {
  getAccountDispatchRuntimeSnapshot,
  recordAccountDispatchFailure,
  recordAccountDispatchProbeSuccess,
  recordAccountDispatchSelectionBlocked,
  recordAccountDispatchSuccess,
  resetAccountDispatchRuntimeMemory,
} from './accountDispatchRuntimeMemory.js';

describe('accountDispatchRuntimeMemory', () => {
  const routeId = 7;
  const modelName = 'gpt-5.4';
  const accountId = 11;

  it('stays healthy after one soft failure and degrades after the threshold', () => {
    resetAccountDispatchRuntimeMemory();

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
    resetAccountDispatchRuntimeMemory();

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
    resetAccountDispatchRuntimeMemory();

    recordAccountDispatchSelectionBlocked(routeId, modelName, accountId, 10_000);

    const recovering = recordAccountDispatchProbeSuccess(routeId, modelName, accountId, 20_000);
    expect(recovering.status).toBe('recovering');
    expect(recovering.recoveringAtMs).toBe(20_000);

    const failbackHold = recordAccountDispatchSuccess(routeId, modelName, accountId, 21_000);
    expect(failbackHold.status).toBe('failback_hold');
    expect((failbackHold.holdUntilMs || 0)).toBeGreaterThan(21_000);
  });

  it('returns to healthy after hold window expires', () => {
    resetAccountDispatchRuntimeMemory();

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
    resetAccountDispatchRuntimeMemory();

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
});
