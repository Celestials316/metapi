import { eq } from 'drizzle-orm';

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

type AccountDispatchRuntimePersistencePayload = {
  version: 1;
  savedAtMs: number;
  states: Record<string, AccountDispatchRuntimeState>;
};

type AccountDispatchPersistenceContext = {
  db: typeof import('../db/index.js').db;
  schema: typeof import('../db/index.js').schema;
  upsertSetting: typeof import('../db/upsertSetting.js').upsertSetting;
};

const ACCOUNT_DISPATCH_FAILBACK_HOLD_MS = 3 * 60 * 1000;
const ACCOUNT_DISPATCH_SOFT_FAILURE_THRESHOLD = 2;
const ACCOUNT_DISPATCH_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACCOUNT_DISPATCH_RUNTIME_STATES = 2048;
const ACCOUNT_DISPATCH_RUNTIME_SETTING_KEY = 'account_dispatch_runtime_v1';
const ACCOUNT_DISPATCH_PERSIST_DEBOUNCE_MS = 500;
const ACCOUNT_DISPATCH_REFRESH_INTERVAL_MS = 1_000;

const accountDispatchRuntimeStates = new Map<string, AccountDispatchRuntimeState>();

let accountDispatchRuntimeLoaded = false;
let accountDispatchRuntimeDirty = false;
let accountDispatchRuntimeLoadedAtMs = 0;
let accountDispatchRuntimeMutationVersion = 0;
let accountDispatchRuntimeLoadPromise: Promise<void> | null = null;
let accountDispatchRuntimeSaveTimer: ReturnType<typeof setTimeout> | null = null;
let accountDispatchRuntimePersistInFlight: Promise<void> | null = null;
let accountDispatchPersistenceContextPromise: Promise<AccountDispatchPersistenceContext> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isMissingSettingsTableError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || error || '');
  const causeMessage = String((error as { cause?: { message?: unknown } })?.cause?.message || '');
  return message.includes('no such table: settings') || causeMessage.includes('no such table: settings');
}

async function getAccountDispatchPersistenceContext(): Promise<AccountDispatchPersistenceContext> {
  if (!accountDispatchPersistenceContextPromise) {
    accountDispatchPersistenceContextPromise = Promise.all([
      import('../db/index.js'),
      import('../db/upsertSetting.js'),
    ]).then(([dbModule, upsertSettingModule]) => ({
      db: dbModule.db,
      schema: dbModule.schema,
      upsertSetting: upsertSettingModule.upsertSetting,
    }));
  }
  return accountDispatchPersistenceContextPromise;
}

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

function cloneState(state: AccountDispatchRuntimeState): AccountDispatchRuntimeState {
  return {
    status: state.status,
    consecutiveSoftFailureCount: state.consecutiveSoftFailureCount,
    degradedAtMs: state.degradedAtMs,
    recoveringAtMs: state.recoveringAtMs,
    holdUntilMs: state.holdUntilMs,
    updatedAtMs: state.updatedAtMs,
    lastSuccessAtMs: state.lastSuccessAtMs,
    lastFailureAtMs: state.lastFailureAtMs,
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

function shouldPersistState(state: AccountDispatchRuntimeState, nowMs = Date.now()): boolean {
  const fresh = ensureFreshState(state, nowMs);
  const holdActive = typeof fresh.holdUntilMs === 'number' && fresh.holdUntilMs > nowMs;
  return holdActive || ((fresh.updatedAtMs + ACCOUNT_DISPATCH_STATE_TTL_MS) > nowMs);
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

function queueAccountDispatchRuntimePersistence(): void {
  if (accountDispatchRuntimeSaveTimer) return;
  accountDispatchRuntimeSaveTimer = setTimeout(() => {
    accountDispatchRuntimeSaveTimer = null;
    void persistAccountDispatchRuntimeState().catch((error) => {
      console.error('Failed to persist account dispatch runtime state', error);
    });
  }, ACCOUNT_DISPATCH_PERSIST_DEBOUNCE_MS);
}

function scheduleAccountDispatchRuntimePersistence(): void {
  accountDispatchRuntimeDirty = true;
  accountDispatchRuntimeMutationVersion += 1;
  queueAccountDispatchRuntimePersistence();
}

function buildAccountDispatchRuntimePersistencePayload(nowMs = Date.now()): AccountDispatchRuntimePersistencePayload {
  sweepExpiredStates(nowMs);
  const states: Record<string, AccountDispatchRuntimeState> = {};
  for (const [key, state] of accountDispatchRuntimeStates.entries()) {
    if (!shouldPersistState(state, nowMs)) continue;
    states[key] = cloneState(state);
  }
  return {
    version: 1,
    savedAtMs: nowMs,
    states,
  };
}

function normalizePersistedState(raw: unknown): AccountDispatchRuntimeState | null {
  if (!isRecord(raw)) return null;
  const status = raw.status;
  if (status !== 'healthy' && status !== 'degraded' && status !== 'recovering' && status !== 'failback_hold') {
    return null;
  }
  const updatedAtMs = Math.trunc(Number(raw.updatedAtMs) || 0);
  if (updatedAtMs <= 0) return null;
  const asNullableNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
  };
  return {
    status,
    consecutiveSoftFailureCount: Math.max(0, Math.trunc(Number(raw.consecutiveSoftFailureCount) || 0)),
    degradedAtMs: asNullableNumber(raw.degradedAtMs),
    recoveringAtMs: asNullableNumber(raw.recoveringAtMs),
    holdUntilMs: asNullableNumber(raw.holdUntilMs),
    updatedAtMs,
    lastSuccessAtMs: asNullableNumber(raw.lastSuccessAtMs),
    lastFailureAtMs: asNullableNumber(raw.lastFailureAtMs),
  };
}

async function loadAccountDispatchRuntimeStateFromSettings(): Promise<void> {
  const { db, schema } = await getAccountDispatchPersistenceContext();
  accountDispatchRuntimeStates.clear();
  if (!schema?.settings?.value || !schema?.settings?.key) {
    accountDispatchRuntimeLoadedAtMs = Date.now();
    return;
  }

  let row: { value?: string | null } | undefined;
  try {
    row = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, ACCOUNT_DISPATCH_RUNTIME_SETTING_KEY))
      .get();
  } catch (error) {
    if (isMissingSettingsTableError(error)) {
      accountDispatchRuntimeLoadedAtMs = Date.now();
      return;
    }
    throw error;
  }
  if (!row?.value) {
    accountDispatchRuntimeLoadedAtMs = Date.now();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    accountDispatchRuntimeLoadedAtMs = Date.now();
    return;
  }
  if (!isRecord(parsed) || !isRecord(parsed.states)) {
    accountDispatchRuntimeLoadedAtMs = Date.now();
    return;
  }

  const nowMs = Date.now();
  for (const [key, stateRaw] of Object.entries(parsed.states)) {
    const normalized = normalizePersistedState(stateRaw);
    if (!normalized) continue;
    if (!shouldPersistState(normalized, nowMs)) continue;
    accountDispatchRuntimeStates.set(String(key), normalized);
  }
  enforceStateLimit();
  accountDispatchRuntimeLoadedAtMs = nowMs;
}

async function persistAccountDispatchRuntimeState(): Promise<void> {
  if (accountDispatchRuntimePersistInFlight) {
    await accountDispatchRuntimePersistInFlight;
    return;
  }
  const targetMutationVersion = accountDispatchRuntimeMutationVersion;
  const task = (async () => {
    const { upsertSetting } = await getAccountDispatchPersistenceContext();
    const payload = buildAccountDispatchRuntimePersistencePayload();
    await upsertSetting(ACCOUNT_DISPATCH_RUNTIME_SETTING_KEY, payload);
    accountDispatchRuntimeLoaded = true;
    accountDispatchRuntimeLoadedAtMs = Date.now();
    accountDispatchRuntimeDirty = targetMutationVersion !== accountDispatchRuntimeMutationVersion;
  })();
  const wrappedTask = task.finally(() => {
    if (accountDispatchRuntimePersistInFlight === wrappedTask) {
      accountDispatchRuntimePersistInFlight = null;
    }
    if (accountDispatchRuntimeDirty) {
      queueAccountDispatchRuntimePersistence();
    }
  });
  accountDispatchRuntimePersistInFlight = wrappedTask;
  await wrappedTask;
}

export async function ensureAccountDispatchRuntimeStateLoaded(nowMs = Date.now()): Promise<void> {
  if (
    accountDispatchRuntimeLoaded
    && (accountDispatchRuntimeDirty || (nowMs - accountDispatchRuntimeLoadedAtMs) < ACCOUNT_DISPATCH_REFRESH_INTERVAL_MS)
  ) {
    return;
  }
  if (!accountDispatchRuntimeLoadPromise) {
    accountDispatchRuntimeLoadPromise = (async () => {
      try {
        await loadAccountDispatchRuntimeStateFromSettings();
        accountDispatchRuntimeLoaded = true;
      } catch (error) {
        console.warn('Failed to restore account dispatch runtime state from settings', error);
        accountDispatchRuntimeLoaded = false;
        accountDispatchRuntimeLoadedAtMs = 0;
      } finally {
        accountDispatchRuntimeLoadPromise = null;
      }
    })();
  }
  await accountDispatchRuntimeLoadPromise;
}

export async function flushAccountDispatchRuntimePersistence(): Promise<void> {
  while (true) {
    if (accountDispatchRuntimeSaveTimer) {
      clearTimeout(accountDispatchRuntimeSaveTimer);
      accountDispatchRuntimeSaveTimer = null;
      await persistAccountDispatchRuntimeState();
      continue;
    }
    if (accountDispatchRuntimePersistInFlight) {
      await accountDispatchRuntimePersistInFlight;
      continue;
    }
    if (accountDispatchRuntimeDirty) {
      await persistAccountDispatchRuntimeState();
      continue;
    }
    return;
  }
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
  scheduleAccountDispatchRuntimePersistence();
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
  accountDispatchRuntimeLoaded = false;
  accountDispatchRuntimeDirty = false;
  accountDispatchRuntimeLoadedAtMs = 0;
  accountDispatchRuntimeMutationVersion = 0;
  accountDispatchRuntimeLoadPromise = null;
  if (accountDispatchRuntimeSaveTimer) {
    clearTimeout(accountDispatchRuntimeSaveTimer);
    accountDispatchRuntimeSaveTimer = null;
  }
  accountDispatchRuntimePersistInFlight = null;
  accountDispatchPersistenceContextPromise = null;
}

export async function clearAccountDispatchRuntimeStatesForAccount(accountId: number): Promise<void> {
  const normalizedAccountId = Math.trunc(accountId || 0);
  if (normalizedAccountId <= 0) return;

  if (!accountDispatchRuntimeLoaded && accountDispatchRuntimeStates.size <= 0) {
    await ensureAccountDispatchRuntimeStateLoaded();
  }

  let changed = false;
  for (const key of accountDispatchRuntimeStates.keys()) {
    if (parseAccountDispatchRuntimeKey(key).accountId === normalizedAccountId) {
      accountDispatchRuntimeStates.delete(key);
      changed = true;
    }
  }
  if (changed) {
    scheduleAccountDispatchRuntimePersistence();
  }
}
