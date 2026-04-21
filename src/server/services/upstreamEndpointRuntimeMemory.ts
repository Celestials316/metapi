import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ConversationFileInputSummary } from '../proxy-core/capabilities/conversationFileCapabilities.js';
import type { DownstreamFormat } from '../transformers/shared/normalized.js';
import {
  isEndpointDispatchDeniedError,
  isUnsupportedMediaTypeError,
} from '../transformers/shared/endpointCompatibility.js';

export type UpstreamEndpointRuntimeEndpoint = 'chat' | 'messages' | 'responses';
export type UpstreamEndpointRuntimePreference = DownstreamFormat | 'responses';
export type UpstreamEndpointRuntimeMemoryWrite =
  | {
    action: 'success';
    endpoint: UpstreamEndpointRuntimeEndpoint;
    preferredEndpoint: UpstreamEndpointRuntimeEndpoint;
    stateKey: string;
    timestampMs: number;
  }
  | {
    action: 'failure';
    endpoint: UpstreamEndpointRuntimeEndpoint;
    blockedEndpoint: UpstreamEndpointRuntimeEndpoint;
    preferredEndpoint: UpstreamEndpointRuntimeEndpoint | null;
    stateKey: string;
    timestampMs: number;
  };

export type EndpointCapabilityProfile = {
  modelKey: string;
  preferMessagesForClaudeModel: boolean;
  hasImageInput: boolean;
  hasAudioInput: boolean;
  hasNonImageFileInput: boolean;
  hasRemoteDocumentUrl: boolean;
  wantsNativeResponsesReasoning: boolean;
  wantsContinuationAwareResponses: boolean;
};

type UpstreamEndpointPersistenceContext = {
  db: typeof import('../db/index.js').db;
  schema: typeof import('../db/index.js').schema;
  upsertSetting: typeof import('../db/upsertSetting.js').upsertSetting;
};

type EndpointRuntimeState = {
  preferredEndpoint: UpstreamEndpointRuntimeEndpoint | null;
  preferredUpdatedAtMs: number;
  lastTouchedAtMs: number;
  blockedUntilMsByEndpoint: Partial<Record<UpstreamEndpointRuntimeEndpoint, number>>;
};

const ENDPOINT_RUNTIME_PREFERRED_TTL_MS = 24 * 60 * 60 * 1000;
const ENDPOINT_RUNTIME_BLOCK_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENDPOINT_RUNTIME_STATES = 512;
const ENDPOINT_RUNTIME_PERSIST_DEBOUNCE_MS = 500;
const ENDPOINT_RUNTIME_REFRESH_INTERVAL_MS = 1_000;
const ENDPOINT_RUNTIME_SETTING_KEY_PREFIX = 'upstream_endpoint_runtime_state_v1:';
export const MAX_ENDPOINT_RUNTIME_MODEL_KEY_LENGTH = 64;
export const MODEL_KEY_HASH_SUFFIX_LENGTH = 8;

const endpointRuntimeStates = new Map<string, EndpointRuntimeState>();
const endpointRuntimeLoadedBySite = new Map<number, number>();
const endpointRuntimeDirtyBySite = new Set<number>();
const endpointRuntimeMutationVersionBySite = new Map<number, number>();
const endpointRuntimeLoadPromisesBySite = new Map<number, Promise<void>>();
const endpointRuntimeSaveTimersBySite = new Map<number, ReturnType<typeof setTimeout>>();
const endpointRuntimePersistInFlightBySite = new Map<number, Promise<void>>();
let upstreamEndpointPersistenceContextPromise: Promise<UpstreamEndpointPersistenceContext> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isMissingSettingsTableError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || error || '');
  const causeMessage = String((error as { cause?: { message?: unknown } })?.cause?.message || '');
  return message.includes('no such table: settings') || causeMessage.includes('no such table: settings');
}

async function getUpstreamEndpointPersistenceContext(): Promise<UpstreamEndpointPersistenceContext> {
  if (!upstreamEndpointPersistenceContextPromise) {
    upstreamEndpointPersistenceContextPromise = Promise.all([
      import('../db/index.js'),
      import('../db/upsertSetting.js'),
    ]).then(([dbModule, upsertSettingModule]) => ({
      db: dbModule.db,
      schema: dbModule.schema,
      upsertSetting: upsertSettingModule.upsertSetting,
    }));
  }
  return upstreamEndpointPersistenceContextPromise;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isClaudeFamilyModel(modelName: string): boolean {
  const normalized = asTrimmedString(modelName).toLowerCase();
  if (!normalized) return false;
  return normalized === 'claude' || normalized.startsWith('claude-') || normalized.includes('claude');
}

export function boundEndpointRuntimeModelKey(value: string): string {
  if (value.length <= MAX_ENDPOINT_RUNTIME_MODEL_KEY_LENGTH) {
    return value;
  }

  const prefix = value.slice(0, MAX_ENDPOINT_RUNTIME_MODEL_KEY_LENGTH);
  const hash = createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, MODEL_KEY_HASH_SUFFIX_LENGTH);
  return `${prefix}-${hash}`;
}

function normalizeEndpointRuntimeModelKey(...values: Array<unknown>): string {
  for (const value of values) {
    const normalized = asTrimmedString(value).toLowerCase();
    if (normalized) return boundEndpointRuntimeModelKey(normalized);
  }
  return boundEndpointRuntimeModelKey('unknown-model');
}

export function buildEndpointCapabilityProfile(input?: {
  modelName?: string;
  requestedModelHint?: string;
  requestCapabilities?: {
    hasNonImageFileInput?: boolean;
    conversationFileSummary?: ConversationFileInputSummary;
    wantsNativeResponsesReasoning?: boolean;
    wantsContinuationAwareResponses?: boolean;
  };
}): EndpointCapabilityProfile {
  const conversationFileSummary = input?.requestCapabilities?.conversationFileSummary;
  return {
    modelKey: normalizeEndpointRuntimeModelKey(input?.modelName, input?.requestedModelHint),
    preferMessagesForClaudeModel: (
      isClaudeFamilyModel(asTrimmedString(input?.modelName))
      || isClaudeFamilyModel(asTrimmedString(input?.requestedModelHint))
    ),
    hasImageInput: conversationFileSummary?.hasImage === true,
    hasAudioInput: conversationFileSummary?.hasAudio === true,
    hasNonImageFileInput: (
      conversationFileSummary?.hasDocument === true
      || input?.requestCapabilities?.hasNonImageFileInput === true
    ),
    hasRemoteDocumentUrl: (
      conversationFileSummary?.hasRemoteDocumentUrl === true
    ),
    wantsNativeResponsesReasoning: input?.requestCapabilities?.wantsNativeResponsesReasoning === true,
    wantsContinuationAwareResponses: input?.requestCapabilities?.wantsContinuationAwareResponses === true,
  };
}

function shouldUseEndpointRuntimeMemory(capabilityProfile: EndpointCapabilityProfile): boolean {
  return (
    !capabilityProfile.hasImageInput
    && !capabilityProfile.hasAudioInput
    && !capabilityProfile.hasNonImageFileInput
  );
}

function buildEndpointRuntimeStateKey(input: {
  siteId: number;
  downstreamFormat: UpstreamEndpointRuntimePreference;
  capabilityProfile: EndpointCapabilityProfile;
}): string {
  const capabilityProfile = input.capabilityProfile;
  return [
    String(input.siteId),
    input.downstreamFormat,
    capabilityProfile.modelKey,
    capabilityProfile.hasNonImageFileInput ? 'files' : 'nofiles',
    capabilityProfile.hasRemoteDocumentUrl ? 'remoteurl' : 'noremoteurl',
    capabilityProfile.wantsNativeResponsesReasoning ? 'reasoning' : 'noreasoning',
    capabilityProfile.wantsContinuationAwareResponses ? 'continuation' : 'nocontinuation',
  ].join(':');
}

function buildEndpointRuntimeSettingKey(siteId: number): string {
  return `${ENDPOINT_RUNTIME_SETTING_KEY_PREFIX}${Math.trunc(siteId || 0)}`;
}

function getSiteIdFromEndpointStateKey(stateKey: string): number {
  const siteIdRaw = String(stateKey || '').split(':', 1)[0] || '0';
  return Math.trunc(Number(siteIdRaw) || 0);
}

function clearEndpointRuntimeStatesForSite(siteId: number): void {
  const prefix = `${Math.trunc(siteId || 0)}:`;
  for (const key of endpointRuntimeStates.keys()) {
    if (key.startsWith(prefix)) {
      endpointRuntimeStates.delete(key);
    }
  }
}

function cloneEndpointRuntimeState(state: EndpointRuntimeState): EndpointRuntimeState {
  return {
    preferredEndpoint: state.preferredEndpoint,
    preferredUpdatedAtMs: state.preferredUpdatedAtMs,
    lastTouchedAtMs: state.lastTouchedAtMs,
    blockedUntilMsByEndpoint: { ...state.blockedUntilMsByEndpoint },
  };
}

function hasActiveEndpointBlock(state: EndpointRuntimeState, nowMs = Date.now()): boolean {
  return Object.values(state.blockedUntilMsByEndpoint).some((untilMs) => (
    typeof untilMs === 'number' && untilMs > nowMs
  ));
}

function isEndpointPreferredFresh(state: EndpointRuntimeState, nowMs = Date.now()): boolean {
  return !!state.preferredEndpoint && (state.preferredUpdatedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs;
}

function shouldKeepEndpointRuntimeState(state: EndpointRuntimeState, nowMs = Date.now()): boolean {
  const recentlyTouched = (state.lastTouchedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs;
  return hasActiveEndpointBlock(state, nowMs) || isEndpointPreferredFresh(state, nowMs) || recentlyTouched;
}

function normalizePersistedEndpointRuntimeState(raw: unknown): EndpointRuntimeState | null {
  if (!isRecord(raw)) return null;
  const preferredEndpoint = raw.preferredEndpoint;
  const normalizedPreferredEndpoint = (
    preferredEndpoint === 'chat' || preferredEndpoint === 'messages' || preferredEndpoint === 'responses'
  ) ? preferredEndpoint : null;
  const preferredUpdatedAtMs = Math.trunc(Number(raw.preferredUpdatedAtMs) || 0);
  const lastTouchedAtMs = Math.trunc(Number(raw.lastTouchedAtMs) || 0);
  if (preferredUpdatedAtMs <= 0 || lastTouchedAtMs <= 0) return null;
  const blockedUntilMsByEndpoint: Partial<Record<UpstreamEndpointRuntimeEndpoint, number>> = {};
  if (isRecord(raw.blockedUntilMsByEndpoint)) {
    for (const endpoint of ['chat', 'messages', 'responses'] as UpstreamEndpointRuntimeEndpoint[]) {
      const untilMs = Number(raw.blockedUntilMsByEndpoint[endpoint]);
      if (Number.isFinite(untilMs) && untilMs > 0) {
        blockedUntilMsByEndpoint[endpoint] = untilMs;
      }
    }
  }
  return {
    preferredEndpoint: normalizedPreferredEndpoint,
    preferredUpdatedAtMs,
    lastTouchedAtMs,
    blockedUntilMsByEndpoint,
  };
}

function buildEndpointRuntimePersistencePayload(siteId: number, nowMs = Date.now()) {
  sweepEndpointRuntimeStates(nowMs);
  const states: Record<string, EndpointRuntimeState> = {};
  for (const [key, state] of endpointRuntimeStates.entries()) {
    if (getSiteIdFromEndpointStateKey(key) !== siteId) continue;
    if (!shouldKeepEndpointRuntimeState(state, nowMs)) continue;
    states[key] = cloneEndpointRuntimeState(state);
  }
  return {
    version: 1 as const,
    savedAtMs: nowMs,
    states,
  };
}

async function persistEndpointRuntimeStateForSite(siteId: number): Promise<void> {
  const normalizedSiteId = Math.trunc(siteId || 0);
  if (normalizedSiteId <= 0) return;
  const inFlight = endpointRuntimePersistInFlightBySite.get(normalizedSiteId);
  if (inFlight) {
    await inFlight;
    return;
  }
  const targetMutationVersion = endpointRuntimeMutationVersionBySite.get(normalizedSiteId) || 0;
  const task = (async () => {
    const { upsertSetting } = await getUpstreamEndpointPersistenceContext();
    const payload = buildEndpointRuntimePersistencePayload(normalizedSiteId);
    await upsertSetting(buildEndpointRuntimeSettingKey(normalizedSiteId), payload);
    endpointRuntimeLoadedBySite.set(normalizedSiteId, Date.now());
    if ((endpointRuntimeMutationVersionBySite.get(normalizedSiteId) || 0) === targetMutationVersion) {
      endpointRuntimeDirtyBySite.delete(normalizedSiteId);
      return;
    }
    endpointRuntimeDirtyBySite.add(normalizedSiteId);
  })();
  const wrappedTask = task.finally(() => {
    if (endpointRuntimePersistInFlightBySite.get(normalizedSiteId) === wrappedTask) {
      endpointRuntimePersistInFlightBySite.delete(normalizedSiteId);
    }
    if (endpointRuntimeDirtyBySite.has(normalizedSiteId)) {
      queueEndpointRuntimePersistence(normalizedSiteId);
    }
  });
  endpointRuntimePersistInFlightBySite.set(normalizedSiteId, wrappedTask);
  await wrappedTask;
}

function queueEndpointRuntimePersistence(siteId: number): void {
  const normalizedSiteId = Math.trunc(siteId || 0);
  if (normalizedSiteId <= 0) return;
  if (endpointRuntimeSaveTimersBySite.has(normalizedSiteId)) return;
  const timer = setTimeout(() => {
    endpointRuntimeSaveTimersBySite.delete(normalizedSiteId);
    void persistEndpointRuntimeStateForSite(normalizedSiteId).catch((error) => {
      console.error('Failed to persist upstream endpoint runtime state', error);
    });
  }, ENDPOINT_RUNTIME_PERSIST_DEBOUNCE_MS);
  endpointRuntimeSaveTimersBySite.set(normalizedSiteId, timer);
}

function scheduleEndpointRuntimePersistence(siteId: number): void {
  const normalizedSiteId = Math.trunc(siteId || 0);
  if (normalizedSiteId <= 0) return;
  endpointRuntimeDirtyBySite.add(normalizedSiteId);
  endpointRuntimeMutationVersionBySite.set(
    normalizedSiteId,
    (endpointRuntimeMutationVersionBySite.get(normalizedSiteId) || 0) + 1,
  );
  queueEndpointRuntimePersistence(normalizedSiteId);
}

async function loadEndpointRuntimeStateForSiteFromSettings(siteId: number): Promise<void> {
  const { db, schema } = await getUpstreamEndpointPersistenceContext();
  const normalizedSiteId = Math.trunc(siteId || 0);
  clearEndpointRuntimeStatesForSite(normalizedSiteId);
  if (!schema?.settings?.value || !schema?.settings?.key) {
    endpointRuntimeLoadedBySite.set(normalizedSiteId, Date.now());
    return;
  }

  let row: { value?: string | null } | undefined;
  try {
    row = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, buildEndpointRuntimeSettingKey(normalizedSiteId)))
      .get();
  } catch (error) {
    if (isMissingSettingsTableError(error)) {
      endpointRuntimeLoadedBySite.set(normalizedSiteId, Date.now());
      return;
    }
    throw error;
  }
  if (!row?.value) {
    endpointRuntimeLoadedBySite.set(normalizedSiteId, Date.now());
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    endpointRuntimeLoadedBySite.set(normalizedSiteId, Date.now());
    return;
  }
  if (!isRecord(parsed) || !isRecord(parsed.states)) {
    endpointRuntimeLoadedBySite.set(normalizedSiteId, Date.now());
    return;
  }

  const nowMs = Date.now();
  for (const [key, rawState] of Object.entries(parsed.states)) {
    if (getSiteIdFromEndpointStateKey(key) !== normalizedSiteId) continue;
    const state = normalizePersistedEndpointRuntimeState(rawState);
    if (!state) continue;
    if (!shouldKeepEndpointRuntimeState(state, nowMs)) continue;
    endpointRuntimeStates.set(key, state);
  }
  enforceEndpointRuntimeStateLimit();
  endpointRuntimeLoadedBySite.set(normalizedSiteId, nowMs);
}

export async function ensureUpstreamEndpointRuntimeStateLoaded(siteId: number, nowMs = Date.now()): Promise<void> {
  const normalizedSiteId = Math.trunc(siteId || 0);
  if (normalizedSiteId <= 0) return;
  const loadedAtMs = endpointRuntimeLoadedBySite.get(normalizedSiteId) || 0;
  if (
    loadedAtMs > 0
    && (endpointRuntimeDirtyBySite.has(normalizedSiteId) || (nowMs - loadedAtMs) < ENDPOINT_RUNTIME_REFRESH_INTERVAL_MS)
  ) {
    return;
  }
  if (!endpointRuntimeLoadPromisesBySite.has(normalizedSiteId)) {
    endpointRuntimeLoadPromisesBySite.set(normalizedSiteId, (async () => {
      try {
        await loadEndpointRuntimeStateForSiteFromSettings(normalizedSiteId);
      } catch (error) {
        console.warn('Failed to restore upstream endpoint runtime state from settings', error);
        endpointRuntimeLoadedBySite.delete(normalizedSiteId);
      } finally {
        endpointRuntimeLoadPromisesBySite.delete(normalizedSiteId);
      }
    })());
  }
  await endpointRuntimeLoadPromisesBySite.get(normalizedSiteId);
}

export async function flushUpstreamEndpointRuntimePersistence(siteId?: number): Promise<void> {
  const normalizedSiteId = Math.trunc(siteId || 0);
  if (normalizedSiteId > 0) {
    while (true) {
      const timer = endpointRuntimeSaveTimersBySite.get(normalizedSiteId);
      if (timer) {
        clearTimeout(timer);
        endpointRuntimeSaveTimersBySite.delete(normalizedSiteId);
        await persistEndpointRuntimeStateForSite(normalizedSiteId);
        continue;
      }
      const inFlight = endpointRuntimePersistInFlightBySite.get(normalizedSiteId);
      if (inFlight) {
        await inFlight;
        continue;
      }
      if (endpointRuntimeDirtyBySite.has(normalizedSiteId)) {
        await persistEndpointRuntimeStateForSite(normalizedSiteId);
        continue;
      }
      return;
    }
  }

  const siteIds = new Set<number>([
    ...endpointRuntimeSaveTimersBySite.keys(),
    ...endpointRuntimePersistInFlightBySite.keys(),
    ...endpointRuntimeDirtyBySite.values(),
  ]);
  for (const pendingSiteId of siteIds) {
    await flushUpstreamEndpointRuntimePersistence(pendingSiteId);
  }
}

function sweepEndpointRuntimeStates(nowMs = Date.now()): void {
  for (const [key, state] of endpointRuntimeStates.entries()) {
    if (shouldKeepEndpointRuntimeState(state, nowMs)) {
      continue;
    }
    endpointRuntimeStates.delete(key);
  }
}

function enforceEndpointRuntimeStateLimit(): void {
  if (endpointRuntimeStates.size <= MAX_ENDPOINT_RUNTIME_STATES) return;

  const entries = [...endpointRuntimeStates.entries()]
    .sort((left, right) => left[1].lastTouchedAtMs - right[1].lastTouchedAtMs);
  const overflowCount = endpointRuntimeStates.size - MAX_ENDPOINT_RUNTIME_STATES;
  for (const [key] of entries.slice(0, overflowCount)) {
    endpointRuntimeStates.delete(key);
  }
}

function getOrCreateEndpointRuntimeState(key: string, nowMs = Date.now()): EndpointRuntimeState {
  sweepEndpointRuntimeStates(nowMs);
  const existing = endpointRuntimeStates.get(key);
  if (existing) {
    existing.lastTouchedAtMs = nowMs;
    return existing;
  }

  const initial: EndpointRuntimeState = {
    preferredEndpoint: null,
    preferredUpdatedAtMs: nowMs,
    lastTouchedAtMs: nowMs,
    blockedUntilMsByEndpoint: {},
  };
  endpointRuntimeStates.set(key, initial);
  enforceEndpointRuntimeStateLimit();
  return initial;
}

function maybeDeleteEndpointRuntimeState(key: string, nowMs = Date.now()): void {
  const state = endpointRuntimeStates.get(key);
  if (!state) return;
  if (!shouldKeepEndpointRuntimeState(state, nowMs)) {
    endpointRuntimeStates.delete(key);
  }
}

function inferSuggestedEndpointFromError(errorText?: string | null): UpstreamEndpointRuntimeEndpoint | null {
  const text = (errorText || '').toLowerCase();
  if (!text) return null;
  if (text.includes('/v1/responses')) return 'responses';
  if (text.includes('/v1/messages')) return 'messages';
  if (text.includes('/v1/chat/completions')) return 'chat';
  return null;
}

function shouldBlockEndpointByError(status: number, errorText?: string | null): boolean {
  if (isEndpointDispatchDeniedError(status, errorText)) return true;
  if (status === 404 || status === 405 || status === 415 || status === 501) return true;
  if (isUnsupportedMediaTypeError(status, errorText)) return true;

  const text = (errorText || '').toLowerCase();
  return (
    text.includes('convert_request_failed')
    || text.includes('endpoint_not_found')
    || text.includes('unknown_endpoint')
    || text.includes('unsupported_endpoint')
    || text.includes('unsupported_path')
    || text.includes('not_found_error')
    || text.includes('unsupported legacy protocol')
    || text.includes('please use /v1/')
    || text.includes('does not allow /v1/')
    || text.includes('unknown endpoint')
    || text.includes('unsupported endpoint')
    || text.includes('unsupported path')
    || text.includes('unrecognized request url')
    || text.includes('no route matched')
    || text.includes('does not exist')
  );
}

function shouldRememberSuccessfulEndpoint(input: {
  endpoint: UpstreamEndpointRuntimeEndpoint;
  downstreamFormat: UpstreamEndpointRuntimePreference;
}): boolean {
  if (input.downstreamFormat !== 'responses') return true;
  return input.endpoint === 'responses';
}

export function getUpstreamEndpointRuntimeStateSnapshot(input: {
  siteId: number;
  downstreamFormat: UpstreamEndpointRuntimePreference;
  modelName?: string;
  requestedModelHint?: string;
  requestCapabilities?: {
    hasNonImageFileInput?: boolean;
    conversationFileSummary?: ConversationFileInputSummary;
    wantsNativeResponsesReasoning?: boolean;
    wantsContinuationAwareResponses?: boolean;
  };
}) {
  const capabilityProfile = buildEndpointCapabilityProfile({
    modelName: input.modelName,
    requestedModelHint: input.requestedModelHint,
    requestCapabilities: input.requestCapabilities,
  });
  const enabled = shouldUseEndpointRuntimeMemory(capabilityProfile);
  const stateKey = buildEndpointRuntimeStateKey({
    siteId: input.siteId,
    downstreamFormat: input.downstreamFormat,
    capabilityProfile,
  });
  const nowMs = Date.now();
  const state = endpointRuntimeStates.get(stateKey);
  const preferredEndpoint = (
    enabled
    && state?.preferredEndpoint
    && (state.preferredUpdatedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs
    && !(
      typeof state.blockedUntilMsByEndpoint[state.preferredEndpoint] === 'number'
      && (state.blockedUntilMsByEndpoint[state.preferredEndpoint] as number) > nowMs
    )
  ) ? state.preferredEndpoint : null;

  return {
    enabled,
    stateKey,
    preferredEndpoint,
    blockedEndpoints: enabled
      ? (['chat', 'messages', 'responses'] as UpstreamEndpointRuntimeEndpoint[]).filter((endpoint) => {
        const untilMs = state?.blockedUntilMsByEndpoint[endpoint];
        return typeof untilMs === 'number' && untilMs > nowMs;
      })
      : [],
  };
}

export function applyUpstreamEndpointRuntimePreference(
  candidates: UpstreamEndpointRuntimeEndpoint[],
  input: {
    siteId: number;
    downstreamFormat: UpstreamEndpointRuntimePreference;
    capabilityProfile: EndpointCapabilityProfile;
  },
  nowMs = Date.now(),
): UpstreamEndpointRuntimeEndpoint[] {
  if (!shouldUseEndpointRuntimeMemory(input.capabilityProfile)) {
    return candidates;
  }

  const key = buildEndpointRuntimeStateKey({
    siteId: input.siteId,
    downstreamFormat: input.downstreamFormat,
    capabilityProfile: input.capabilityProfile,
  });
  const state = endpointRuntimeStates.get(key);
  if (!state || candidates.length <= 1) return candidates;
  state.lastTouchedAtMs = nowMs;

  const blocked = new Set<UpstreamEndpointRuntimeEndpoint>();
  for (const endpoint of candidates) {
    const untilMs = state.blockedUntilMsByEndpoint[endpoint];
    if (typeof untilMs === 'number' && untilMs > nowMs) {
      blocked.add(endpoint);
    }
  }

  let next = candidates.filter((endpoint) => !blocked.has(endpoint));
  if (next.length === 0) {
    next = [...candidates];
  }

  const preferredFresh = (
    !!state.preferredEndpoint
    && (state.preferredUpdatedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs
  );
  if (preferredFresh && state.preferredEndpoint && next.includes(state.preferredEndpoint)) {
    next = [
      state.preferredEndpoint,
      ...next.filter((endpoint) => endpoint !== state.preferredEndpoint),
    ];
  }

  maybeDeleteEndpointRuntimeState(key, nowMs);
  return next;
}

export function resetUpstreamEndpointRuntimeState(): void {
  endpointRuntimeStates.clear();
  endpointRuntimeLoadedBySite.clear();
  endpointRuntimeDirtyBySite.clear();
  endpointRuntimeMutationVersionBySite.clear();
  endpointRuntimeLoadPromisesBySite.clear();
  for (const timer of endpointRuntimeSaveTimersBySite.values()) {
    clearTimeout(timer);
  }
  endpointRuntimeSaveTimersBySite.clear();
  endpointRuntimePersistInFlightBySite.clear();
  upstreamEndpointPersistenceContextPromise = null;
}

export function recordUpstreamEndpointSuccess(input: {
  siteId: number;
  endpoint: UpstreamEndpointRuntimeEndpoint;
  downstreamFormat: UpstreamEndpointRuntimePreference;
  modelName?: string;
  requestedModelHint?: string;
  requestCapabilities?: {
    hasNonImageFileInput?: boolean;
    conversationFileSummary?: ConversationFileInputSummary;
    wantsNativeResponsesReasoning?: boolean;
    wantsContinuationAwareResponses?: boolean;
  };
}): UpstreamEndpointRuntimeMemoryWrite | null {
  const capabilityProfile = buildEndpointCapabilityProfile({
    modelName: input.modelName,
    requestedModelHint: input.requestedModelHint,
    requestCapabilities: input.requestCapabilities,
  });
  if (!shouldUseEndpointRuntimeMemory(capabilityProfile)) return null;
  if (!shouldRememberSuccessfulEndpoint(input)) return null;

  const nowMs = Date.now();
  const key = buildEndpointRuntimeStateKey({
    siteId: input.siteId,
    downstreamFormat: input.downstreamFormat,
    capabilityProfile,
  });
  const state = getOrCreateEndpointRuntimeState(key, nowMs);
  state.preferredEndpoint = input.endpoint;
  state.preferredUpdatedAtMs = nowMs;
  delete state.blockedUntilMsByEndpoint[input.endpoint];
  endpointRuntimeLoadedBySite.set(Math.trunc(input.siteId || 0), nowMs);
  scheduleEndpointRuntimePersistence(input.siteId);
  return {
    action: 'success',
    endpoint: input.endpoint,
    preferredEndpoint: input.endpoint,
    stateKey: key,
    timestampMs: nowMs,
  };
}

export function recordUpstreamEndpointFailure(input: {
  siteId: number;
  endpoint: UpstreamEndpointRuntimeEndpoint;
  downstreamFormat: UpstreamEndpointRuntimePreference;
  status: number;
  errorText?: string | null;
  modelName?: string;
  requestedModelHint?: string;
  requestCapabilities?: {
    hasNonImageFileInput?: boolean;
    conversationFileSummary?: ConversationFileInputSummary;
    wantsNativeResponsesReasoning?: boolean;
    wantsContinuationAwareResponses?: boolean;
  };
}): UpstreamEndpointRuntimeMemoryWrite | null {
  const capabilityProfile = buildEndpointCapabilityProfile({
    modelName: input.modelName,
    requestedModelHint: input.requestedModelHint,
    requestCapabilities: input.requestCapabilities,
  });
  if (!shouldUseEndpointRuntimeMemory(capabilityProfile)) return null;
  if (!shouldBlockEndpointByError(input.status, input.errorText)) return null;

  const nowMs = Date.now();
  const key = buildEndpointRuntimeStateKey({
    siteId: input.siteId,
    downstreamFormat: input.downstreamFormat,
    capabilityProfile,
  });
  const state = getOrCreateEndpointRuntimeState(key, nowMs);
  state.blockedUntilMsByEndpoint[input.endpoint] = nowMs + ENDPOINT_RUNTIME_BLOCK_TTL_MS;

  const suggestedEndpoint = inferSuggestedEndpointFromError(input.errorText);
  if (suggestedEndpoint && suggestedEndpoint !== input.endpoint) {
    state.preferredEndpoint = suggestedEndpoint;
    state.preferredUpdatedAtMs = nowMs;
    delete state.blockedUntilMsByEndpoint[suggestedEndpoint];
  }
  endpointRuntimeLoadedBySite.set(Math.trunc(input.siteId || 0), nowMs);
  scheduleEndpointRuntimePersistence(input.siteId);
  return {
    action: 'failure',
    endpoint: input.endpoint,
    blockedEndpoint: input.endpoint,
    preferredEndpoint: (
      suggestedEndpoint && suggestedEndpoint !== input.endpoint
        ? suggestedEndpoint
        : null
    ),
    stateKey: key,
    timestampMs: nowMs,
  };
}
