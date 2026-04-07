export type AccountDispatchRuntimeStatus = 'healthy' | 'degraded' | 'recovering' | 'failback_hold';
export type AccountDispatchFailureKind = 'soft' | 'hard';

export type AccountDispatchRuntimeSnapshot = {
  key: string;
  routeId: number;
  modelName: string;
  accountId: number;
  status: AccountDispatchRuntimeStatus;
  consecutiveSoftFailureCount: number;
  degradedAtMs: number | null;
  recoveringAtMs: number | null;
  holdUntilMs: number | null;
  updatedAtMs: number;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
};

type AccountDispatchRuntimeState = Omit<AccountDispatchRuntimeSnapshot, 'key' | 'routeId' | 'modelName' | 'accountId'>;

const ACCOUNT_DISPATCH_FAILBACK_HOLD_MS = 3 * 60 * 1000;
const ACCOUNT_DISPATCH_SOFT_FAILURE_THRESHOLD = 2;
const ACCOUNT_DISPATCH_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACCOUNT_DISPATCH_RUNTIME_STATES = 2048;

const accountDispatchRuntimeStates = new Map<string, AccountDispatchRuntimeState>();

function normalizeModelName(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'unknown-model';
}

export function buildAccountDispatchRuntimeKey(routeId: number, modelName: string, accountId: number): string {
  return `${Math.trunc(routeId || 0)}:${normalizeModelName(modelName)}:${Math.trunc(accountId || 0)}`;
}

function parseAccountDispatchRuntimeKey(key: string): {
  routeId: number;
  modelName: string;
  accountId: number;
} {
  const [routeIdRaw, ...rest] = String(key || '').split(':');
  const accountIdRaw = rest.pop() || '0';
  const modelName = rest.join(':') || 'unknown-model';
  return {
    routeId: Math.trunc(Number(routeIdRaw) || 0),
    modelName,
    accountId: Math.trunc(Number(accountIdRaw) || 0),
  };
}

function createHealthyState(nowMs: number): AccountDispatchRuntimeState {
  return {
    status: 'healthy',
    consecutiveSoftFailureCount: 0,
    degradedAtMs: null,
    recoveringAtMs: null,
    holdUntilMs: null,
    updatedAtMs: nowMs,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
  };
}

function sweepExpiredStates(nowMs = Date.now()): void {
  for (const [key, state] of accountDispatchRuntimeStates.entries()) {
    const holdActive = typeof state.holdUntilMs === 'number' && state.holdUntilMs > nowMs;
    if ((state.updatedAtMs + ACCOUNT_DISPATCH_STATE_TTL_MS) > nowMs || holdActive) {
      continue;
    }
    accountDispatchRuntimeStates.delete(key);
  }
}

function enforceStateLimit(): void {
  if (accountDispatchRuntimeStates.size <= MAX_ACCOUNT_DISPATCH_RUNTIME_STATES) return;
  const entries = [...accountDispatchRuntimeStates.entries()]
    .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs);
  const overflow = accountDispatchRuntimeStates.size - MAX_ACCOUNT_DISPATCH_RUNTIME_STATES;
  for (const [key] of entries.slice(0, overflow)) {
    accountDispatchRuntimeStates.delete(key);
  }
}

function ensureFreshState(state: AccountDispatchRuntimeState, nowMs = Date.now()): AccountDispatchRuntimeState {
  if (state.status === 'failback_hold' && typeof state.holdUntilMs === 'number' && state.holdUntilMs <= nowMs) {
    state.status = 'healthy';
    state.holdUntilMs = null;
    state.updatedAtMs = nowMs;
  }
  return state;
}

function getOrCreateState(key: string, nowMs = Date.now()): AccountDispatchRuntimeState {
  sweepExpiredStates(nowMs);
  const existing = accountDispatchRuntimeStates.get(key);
  if (existing) return ensureFreshState(existing, nowMs);

  const initial = createHealthyState(nowMs);
  accountDispatchRuntimeStates.set(key, initial);
  enforceStateLimit();
  return initial;
}

function toSnapshot(key: string, state: AccountDispatchRuntimeState, nowMs = Date.now()): AccountDispatchRuntimeSnapshot {
  const fresh = ensureFreshState(state, nowMs);
  return {
    key,
    ...parseAccountDispatchRuntimeKey(key),
    status: fresh.status,
    consecutiveSoftFailureCount: fresh.consecutiveSoftFailureCount,
    degradedAtMs: fresh.degradedAtMs,
    recoveringAtMs: fresh.recoveringAtMs,
    holdUntilMs: fresh.holdUntilMs,
    updatedAtMs: fresh.updatedAtMs,
    lastSuccessAtMs: fresh.lastSuccessAtMs,
    lastFailureAtMs: fresh.lastFailureAtMs,
  };
}

function updateState(
  key: string,
  apply: (state: AccountDispatchRuntimeState, nowMs: number) => void,
  nowMs = Date.now(),
): AccountDispatchRuntimeSnapshot {
  const state = getOrCreateState(key, nowMs);
  apply(state, nowMs);
  state.updatedAtMs = nowMs;
  accountDispatchRuntimeStates.set(key, state);
  return toSnapshot(key, state, nowMs);
}

export function getAccountDispatchRuntimeSnapshot(
  routeId: number,
  modelName: string,
  accountId: number,
  nowMs = Date.now(),
): AccountDispatchRuntimeSnapshot {
  const key = buildAccountDispatchRuntimeKey(routeId, modelName, accountId);
  const state = getOrCreateState(key, nowMs);
  return toSnapshot(key, state, nowMs);
}

export function recordAccountDispatchSelectionBlocked(
  routeId: number,
  modelName: string,
  accountId: number,
  nowMs = Date.now(),
): AccountDispatchRuntimeSnapshot {
  const key = buildAccountDispatchRuntimeKey(routeId, modelName, accountId);
  return updateState(key, (state) => {
    state.status = 'degraded';
    state.consecutiveSoftFailureCount = 0;
    state.degradedAtMs = nowMs;
    state.recoveringAtMs = null;
    state.holdUntilMs = null;
    state.lastFailureAtMs = nowMs;
  }, nowMs);
}

export function recordAccountDispatchFailure(input: {
  routeId: number;
  modelName: string;
  accountId: number;
  kind: AccountDispatchFailureKind;
  nowMs?: number;
}): AccountDispatchRuntimeSnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const key = buildAccountDispatchRuntimeKey(input.routeId, input.modelName, input.accountId);
  return updateState(key, (state) => {
    state.lastFailureAtMs = nowMs;
    if (
      input.kind === 'hard'
      || state.status === 'recovering'
      || state.status === 'failback_hold'
      || (state.consecutiveSoftFailureCount + 1) >= ACCOUNT_DISPATCH_SOFT_FAILURE_THRESHOLD
    ) {
      state.status = 'degraded';
      state.consecutiveSoftFailureCount = 0;
      state.degradedAtMs = nowMs;
      state.recoveringAtMs = null;
      state.holdUntilMs = null;
      return;
    }

    state.status = 'healthy';
    state.consecutiveSoftFailureCount += 1;
  }, nowMs);
}

export function recordAccountDispatchProbeSuccess(
  routeId: number,
  modelName: string,
  accountId: number,
  nowMs = Date.now(),
): AccountDispatchRuntimeSnapshot {
  const key = buildAccountDispatchRuntimeKey(routeId, modelName, accountId);
  return updateState(key, (state) => {
    if (state.status === 'degraded' || state.status === 'recovering') {
      state.status = 'recovering';
      state.recoveringAtMs = nowMs;
      state.consecutiveSoftFailureCount = 0;
      state.holdUntilMs = null;
    }
  }, nowMs);
}

export function recordAccountDispatchSuccess(
  routeId: number,
  modelName: string,
  accountId: number,
  nowMs = Date.now(),
): AccountDispatchRuntimeSnapshot {
  const key = buildAccountDispatchRuntimeKey(routeId, modelName, accountId);
  return updateState(key, (state) => {
    state.lastSuccessAtMs = nowMs;
    state.consecutiveSoftFailureCount = 0;
    if (state.status === 'recovering') {
      state.status = 'failback_hold';
      state.holdUntilMs = nowMs + ACCOUNT_DISPATCH_FAILBACK_HOLD_MS;
      return;
    }
    if (state.status === 'failback_hold') {
      if (typeof state.holdUntilMs !== 'number' || state.holdUntilMs <= nowMs) {
        state.status = 'healthy';
        state.holdUntilMs = null;
      }
      return;
    }
    state.status = 'healthy';
    state.degradedAtMs = null;
    state.recoveringAtMs = null;
    state.holdUntilMs = null;
  }, nowMs);
}

export function resetAccountDispatchRuntimeMemory(): void {
  accountDispatchRuntimeStates.clear();
}
