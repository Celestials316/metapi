import { eq } from 'drizzle-orm';

type ResponsesContinuityPersistenceContext = {
  db: typeof import('../db/index.js').db;
  schema: typeof import('../db/index.js').schema;
  upsertSetting: typeof import('../db/upsertSetting.js').upsertSetting;
};

type SessionResponseAnchorState = {
  responseId: string;
  updatedAtMs: number;
};

type StickyBindingState = {
  channelId: number;
  expiresAtMs: number;
  updatedAtMs: number;
};

export type StoredSessionResponseAnchorSnapshot = {
  key: string;
  responseId: string;
  updatedAtMs: number;
};

export type StoredStickyBindingSnapshot = {
  key: string;
  channelId: number;
  expiresAtMs: number;
  updatedAtMs: number;
};

type ResponsesContinuityPersistencePayload = {
  version: 1;
  savedAtMs: number;
  sessionResponseAnchors: Record<string, SessionResponseAnchorState>;
  stickyBindings: Record<string, StickyBindingState>;
};

const RESPONSES_CONTINUITY_SETTING_KEY = 'responses_continuity_state_v1';
const RESPONSES_CONTINUITY_PERSIST_DEBOUNCE_MS = 500;
const RESPONSES_CONTINUITY_REFRESH_INTERVAL_MS = 1_000;
const SESSION_RESPONSE_ANCHOR_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_RESPONSE_ANCHORS = 10_000;
const MAX_STICKY_BINDINGS = 10_000;

const sessionResponseAnchors = new Map<string, SessionResponseAnchorState>();
const stickyBindings = new Map<string, StickyBindingState>();

let responsesContinuityLoaded = false;
let responsesContinuityDirty = false;
let responsesContinuityLoadedAtMs = 0;
let responsesContinuityMutationVersion = 0;
let responsesContinuityLoadPromise: Promise<void> | null = null;
let responsesContinuitySaveTimer: ReturnType<typeof setTimeout> | null = null;
let responsesContinuityPersistInFlight: Promise<void> | null = null;
let responsesContinuityPersistenceContextPromise: Promise<ResponsesContinuityPersistenceContext> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isMissingSettingsTableError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || error || '');
  const causeMessage = String((error as { cause?: { message?: unknown } })?.cause?.message || '');
  return message.includes('no such table: settings') || causeMessage.includes('no such table: settings');
}

async function getResponsesContinuityPersistenceContext(): Promise<ResponsesContinuityPersistenceContext> {
  if (!responsesContinuityPersistenceContextPromise) {
    responsesContinuityPersistenceContextPromise = Promise.all([
      import('../db/index.js'),
      import('../db/upsertSetting.js'),
    ]).then(([dbModule, upsertSettingModule]) => ({
      db: dbModule.db,
      schema: dbModule.schema,
      upsertSetting: upsertSettingModule.upsertSetting,
    }));
  }
  return responsesContinuityPersistenceContextPromise;
}

function normalizeResponseAnchor(raw: unknown): SessionResponseAnchorState | null {
  if (!isRecord(raw)) return null;
  const responseId = String(raw.responseId || '').trim();
  const updatedAtMs = Math.trunc(Number(raw.updatedAtMs) || 0);
  if (!responseId || updatedAtMs <= 0) return null;
  return {
    responseId,
    updatedAtMs,
  };
}

function normalizeStickyBinding(raw: unknown): StickyBindingState | null {
  if (!isRecord(raw)) return null;
  const channelId = Math.trunc(Number(raw.channelId) || 0);
  const expiresAtMs = Math.trunc(Number(raw.expiresAtMs) || 0);
  const updatedAtMs = Math.trunc(Number(raw.updatedAtMs) || 0);
  if (channelId <= 0 || expiresAtMs <= 0 || updatedAtMs <= 0) return null;
  return {
    channelId,
    expiresAtMs,
    updatedAtMs,
  };
}

function isSessionResponseAnchorFresh(state: SessionResponseAnchorState, nowMs = Date.now()): boolean {
  return (state.updatedAtMs + SESSION_RESPONSE_ANCHOR_TTL_MS) > nowMs;
}

function isStickyBindingFresh(state: StickyBindingState, nowMs = Date.now()): boolean {
  return state.expiresAtMs > nowMs;
}

function sweepResponsesContinuityState(nowMs = Date.now()): void {
  for (const [key, state] of sessionResponseAnchors.entries()) {
    if (isSessionResponseAnchorFresh(state, nowMs)) continue;
    sessionResponseAnchors.delete(key);
  }
  for (const [key, state] of stickyBindings.entries()) {
    if (isStickyBindingFresh(state, nowMs)) continue;
    stickyBindings.delete(key);
  }
}

function trimMapToLimit<T extends { updatedAtMs: number }>(target: Map<string, T>, limit: number): void {
  if (target.size <= limit) return;
  const overflow = target.size - limit;
  const oldestKeys = [...target.entries()]
    .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs)
    .slice(0, overflow)
    .map(([key]) => key);
  for (const key of oldestKeys) {
    target.delete(key);
  }
}

function enforceResponsesContinuityLimits(): void {
  trimMapToLimit(sessionResponseAnchors, MAX_SESSION_RESPONSE_ANCHORS);
  trimMapToLimit(stickyBindings, MAX_STICKY_BINDINGS);
}

function cloneResponseAnchorState(state: SessionResponseAnchorState): SessionResponseAnchorState {
  return {
    responseId: state.responseId,
    updatedAtMs: state.updatedAtMs,
  };
}

function cloneStickyBindingState(state: StickyBindingState): StickyBindingState {
  return {
    channelId: state.channelId,
    expiresAtMs: state.expiresAtMs,
    updatedAtMs: state.updatedAtMs,
  };
}

function queueResponsesContinuityPersistence(): void {
  if (responsesContinuitySaveTimer) return;
  responsesContinuitySaveTimer = setTimeout(() => {
    responsesContinuitySaveTimer = null;
    void persistResponsesContinuityState().catch((error) => {
      console.error('Failed to persist responses continuity state', error);
    });
  }, RESPONSES_CONTINUITY_PERSIST_DEBOUNCE_MS);
}

function scheduleResponsesContinuityPersistence(): void {
  responsesContinuityDirty = true;
  responsesContinuityMutationVersion += 1;
  queueResponsesContinuityPersistence();
}

function buildResponsesContinuityPersistencePayload(nowMs = Date.now()): ResponsesContinuityPersistencePayload {
  sweepResponsesContinuityState(nowMs);
  const responseAnchorPayload: Record<string, SessionResponseAnchorState> = {};
  const stickyBindingPayload: Record<string, StickyBindingState> = {};

  for (const [key, state] of sessionResponseAnchors.entries()) {
    if (!isSessionResponseAnchorFresh(state, nowMs)) continue;
    responseAnchorPayload[key] = cloneResponseAnchorState(state);
  }
  for (const [key, state] of stickyBindings.entries()) {
    if (!isStickyBindingFresh(state, nowMs)) continue;
    stickyBindingPayload[key] = cloneStickyBindingState(state);
  }

  return {
    version: 1,
    savedAtMs: nowMs,
    sessionResponseAnchors: responseAnchorPayload,
    stickyBindings: stickyBindingPayload,
  };
}

async function loadResponsesContinuityStateFromSettings(): Promise<void> {
  const { db, schema } = await getResponsesContinuityPersistenceContext();
  sessionResponseAnchors.clear();
  stickyBindings.clear();
  if (!schema?.settings?.value || !schema?.settings?.key) {
    responsesContinuityLoadedAtMs = Date.now();
    return;
  }

  let row: { value?: string | null } | undefined;
  try {
    row = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, RESPONSES_CONTINUITY_SETTING_KEY))
      .get();
  } catch (error) {
    if (isMissingSettingsTableError(error)) {
      responsesContinuityLoadedAtMs = Date.now();
      return;
    }
    throw error;
  }

  if (!row?.value) {
    responsesContinuityLoadedAtMs = Date.now();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    responsesContinuityLoadedAtMs = Date.now();
    return;
  }

  if (!isRecord(parsed)) {
    responsesContinuityLoadedAtMs = Date.now();
    return;
  }

  const nowMs = Date.now();
  if (isRecord(parsed.sessionResponseAnchors)) {
    for (const [key, rawState] of Object.entries(parsed.sessionResponseAnchors)) {
      const state = normalizeResponseAnchor(rawState);
      if (!state || !isSessionResponseAnchorFresh(state, nowMs)) continue;
      sessionResponseAnchors.set(String(key), state);
    }
  }
  if (isRecord(parsed.stickyBindings)) {
    for (const [key, rawState] of Object.entries(parsed.stickyBindings)) {
      const state = normalizeStickyBinding(rawState);
      if (!state || !isStickyBindingFresh(state, nowMs)) continue;
      stickyBindings.set(String(key), state);
    }
  }
  enforceResponsesContinuityLimits();
  responsesContinuityLoadedAtMs = nowMs;
}

async function persistResponsesContinuityState(): Promise<void> {
  if (responsesContinuityPersistInFlight) {
    await responsesContinuityPersistInFlight;
    return;
  }
  const targetMutationVersion = responsesContinuityMutationVersion;
  const task = (async () => {
    const { upsertSetting } = await getResponsesContinuityPersistenceContext();
    const payload = buildResponsesContinuityPersistencePayload();
    await upsertSetting(RESPONSES_CONTINUITY_SETTING_KEY, payload);
    responsesContinuityLoaded = true;
    responsesContinuityLoadedAtMs = Date.now();
    responsesContinuityDirty = targetMutationVersion !== responsesContinuityMutationVersion;
  })();
  const wrappedTask = task.finally(() => {
    if (responsesContinuityPersistInFlight === wrappedTask) {
      responsesContinuityPersistInFlight = null;
    }
    if (responsesContinuityDirty) {
      queueResponsesContinuityPersistence();
    }
  });
  responsesContinuityPersistInFlight = wrappedTask;
  await wrappedTask;
}

export async function ensureResponsesContinuityStateLoaded(nowMs = Date.now()): Promise<void> {
  if (
    responsesContinuityLoaded
    && (responsesContinuityDirty || (nowMs - responsesContinuityLoadedAtMs) < RESPONSES_CONTINUITY_REFRESH_INTERVAL_MS)
  ) {
    return;
  }
  if (!responsesContinuityLoadPromise) {
    responsesContinuityLoadPromise = (async () => {
      try {
        await loadResponsesContinuityStateFromSettings();
        responsesContinuityLoaded = true;
      } catch (error) {
        console.warn('Failed to restore responses continuity state from settings', error);
        responsesContinuityLoaded = false;
        responsesContinuityLoadedAtMs = 0;
      } finally {
        responsesContinuityLoadPromise = null;
      }
    })();
  }
  await responsesContinuityLoadPromise;
}

export async function flushResponsesContinuityPersistence(): Promise<void> {
  while (true) {
    if (responsesContinuitySaveTimer) {
      clearTimeout(responsesContinuitySaveTimer);
      responsesContinuitySaveTimer = null;
      await persistResponsesContinuityState();
      continue;
    }
    if (responsesContinuityPersistInFlight) {
      await responsesContinuityPersistInFlight;
      continue;
    }
    if (responsesContinuityDirty) {
      await persistResponsesContinuityState();
      continue;
    }
    return;
  }
}

export function getStoredSessionResponseId(key: string, nowMs = Date.now()): string | null {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  sweepResponsesContinuityState(nowMs);
  const state = sessionResponseAnchors.get(normalizedKey);
  if (!state || !isSessionResponseAnchorFresh(state, nowMs)) return null;
  return state.responseId;
}

export function setStoredSessionResponseId(key: string, responseId: string, nowMs = Date.now()): void {
  const normalizedKey = String(key || '').trim();
  const normalizedResponseId = String(responseId || '').trim();
  if (!normalizedKey || !normalizedResponseId) return;
  sweepResponsesContinuityState(nowMs);
  if (sessionResponseAnchors.has(normalizedKey)) {
    sessionResponseAnchors.delete(normalizedKey);
  }
  sessionResponseAnchors.set(normalizedKey, {
    responseId: normalizedResponseId,
    updatedAtMs: nowMs,
  });
  enforceResponsesContinuityLimits();
  scheduleResponsesContinuityPersistence();
}

export function clearStoredSessionResponseId(key: string): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return;
  if (!sessionResponseAnchors.delete(normalizedKey)) return;
  scheduleResponsesContinuityPersistence();
}

export function listStoredSessionResponseAnchorKeys(nowMs = Date.now()): string[] {
  sweepResponsesContinuityState(nowMs);
  return [...sessionResponseAnchors.keys()];
}

export function listStoredSessionResponseAnchors(nowMs = Date.now()): StoredSessionResponseAnchorSnapshot[] {
  sweepResponsesContinuityState(nowMs);
  return [...sessionResponseAnchors.entries()]
    .map(([key, state]) => ({
      key,
      responseId: state.responseId,
      updatedAtMs: state.updatedAtMs,
    }))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function getStoredStickyChannelId(key: string, nowMs = Date.now()): number | null {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  sweepResponsesContinuityState(nowMs);
  const state = stickyBindings.get(normalizedKey);
  if (!state || !isStickyBindingFresh(state, nowMs)) return null;
  return state.channelId;
}

export function setStoredStickyChannelBinding(input: {
  key: string;
  channelId: number;
  expiresAtMs: number;
  nowMs?: number;
}): void {
  const normalizedKey = String(input.key || '').trim();
  const channelId = Math.trunc(Number(input.channelId) || 0);
  const expiresAtMs = Math.trunc(Number(input.expiresAtMs) || 0);
  const nowMs = input.nowMs ?? Date.now();
  if (!normalizedKey || channelId <= 0 || expiresAtMs <= nowMs) return;
  sweepResponsesContinuityState(nowMs);
  if (stickyBindings.has(normalizedKey)) {
    stickyBindings.delete(normalizedKey);
  }
  stickyBindings.set(normalizedKey, {
    channelId,
    expiresAtMs,
    updatedAtMs: nowMs,
  });
  enforceResponsesContinuityLimits();
  scheduleResponsesContinuityPersistence();
}

export function clearStoredStickyChannelBinding(key: string, channelId?: number | null): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return;
  const existing = stickyBindings.get(normalizedKey);
  if (!existing) return;
  if (typeof channelId === 'number' && Number.isFinite(channelId) && existing.channelId !== Math.trunc(channelId)) {
    return;
  }
  stickyBindings.delete(normalizedKey);
  scheduleResponsesContinuityPersistence();
}

export function clearStoredStickyChannelsByChannelIds(channelIds: number[]): void {
  const normalizedChannelIds = new Set(
    (Array.isArray(channelIds) ? channelIds : [])
      .filter((channelId): channelId is number => Number.isFinite(channelId) && channelId > 0)
      .map((channelId) => Math.trunc(channelId)),
  );
  if (normalizedChannelIds.size <= 0) return;

  let changed = false;
  for (const [key, state] of stickyBindings.entries()) {
    if (!normalizedChannelIds.has(state.channelId)) continue;
    stickyBindings.delete(key);
    changed = true;
  }
  if (changed) {
    scheduleResponsesContinuityPersistence();
  }
}

export function listStoredStickyChannelBindings(nowMs = Date.now()): StoredStickyBindingSnapshot[] {
  sweepResponsesContinuityState(nowMs);
  return [...stickyBindings.entries()]
    .map(([key, state]) => ({
      key,
      channelId: state.channelId,
      expiresAtMs: state.expiresAtMs,
      updatedAtMs: state.updatedAtMs,
    }))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function resetResponsesContinuityStore(): void {
  if (responsesContinuitySaveTimer) {
    clearTimeout(responsesContinuitySaveTimer);
    responsesContinuitySaveTimer = null;
  }
  sessionResponseAnchors.clear();
  stickyBindings.clear();
  responsesContinuityLoaded = false;
  responsesContinuityDirty = false;
  responsesContinuityLoadedAtMs = 0;
  responsesContinuityMutationVersion = 0;
  responsesContinuityLoadPromise = null;
  responsesContinuityPersistInFlight = null;
  responsesContinuityPersistenceContextPromise = null;
}
