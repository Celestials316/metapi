import { parseExtraConfig } from '../accountExtraConfig.js';

export type OauthRefreshLease = {
  ownerId: string;
  startedAt: string;
  expiresAt: string;
};

export type OauthRefreshRuntimeState = {
  status: 'idle' | 'refreshing' | 'success' | 'backoff' | 'terminal';
  consecutiveFailures: number;
  backoffUntil: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string;
  lease: OauthRefreshLease | null;
};

export const OAUTH_REFRESH_LEASE_TTL_MS = 20_000;
export const OAUTH_REFRESH_WAIT_TIMEOUT_MS = 25_000;
export const OAUTH_REFRESH_WAIT_POLL_MS = 250;
export const OAUTH_REFRESH_POST_LEASE_GRACE_MS = Math.max(1_000, OAUTH_REFRESH_WAIT_POLL_MS * 4);
const OAUTH_REFRESH_BACKOFF_STEPS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const;

function asIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function asPositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function normalizeLease(raw: unknown): OauthRefreshLease | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const ownerId = typeof source.ownerId === 'string' ? source.ownerId.trim() : '';
  const startedAt = asIso(source.startedAt);
  const expiresAt = asIso(source.expiresAt);
  if (!ownerId || !startedAt || !expiresAt) return null;
  return { ownerId, startedAt, expiresAt };
}

export function getOauthRefreshRuntimeState(extraConfig?: string | Record<string, unknown> | null): OauthRefreshRuntimeState {
  const parsed = parseExtraConfig(extraConfig);
  const raw = parsed.oauthRefreshRuntime;
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const status = ['idle', 'refreshing', 'success', 'backoff', 'terminal'].includes(String(source.status || ''))
    ? String(source.status) as OauthRefreshRuntimeState['status']
    : 'idle';
  const consecutiveFailures = Math.max(0, asPositiveInt(source.consecutiveFailures) || 0);
  const backoffUntil = asIso(source.backoffUntil);
  const lastAttemptAt = asIso(source.lastAttemptAt);
  const lastSuccessAt = asIso(source.lastSuccessAt);
  const lastFailureAt = asIso(source.lastFailureAt);
  const lastError = typeof source.lastError === 'string' ? source.lastError.trim().slice(0, 500) : '';
  return {
    status,
    consecutiveFailures,
    backoffUntil,
    lastAttemptAt,
    lastSuccessAt,
    lastFailureAt,
    lastError,
    lease: normalizeLease(source.lease),
  };
}

export function isOauthRefreshLeaseActive(
  stateOrExtraConfig?: OauthRefreshRuntimeState | string | Record<string, unknown> | null,
  nowMs = Date.now(),
): boolean {
  const state = isRuntimeState(stateOrExtraConfig)
    ? stateOrExtraConfig
    : getOauthRefreshRuntimeState(stateOrExtraConfig);
  const expiresAtMs = state.lease?.expiresAt ? Date.parse(state.lease.expiresAt) : Number.NaN;
  return !!state.lease && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

export function isOauthRefreshBackoffActive(
  stateOrExtraConfig?: OauthRefreshRuntimeState | string | Record<string, unknown> | null,
  nowMs = Date.now(),
): boolean {
  const state = isRuntimeState(stateOrExtraConfig)
    ? stateOrExtraConfig
    : getOauthRefreshRuntimeState(stateOrExtraConfig);
  const backoffUntilMs = state.backoffUntil ? Date.parse(state.backoffUntil) : Number.NaN;
  return Number.isFinite(backoffUntilMs) && backoffUntilMs > nowMs;
}

export function buildOauthRefreshLease(ownerId: string, nowMs = Date.now(), ttlMs = OAUTH_REFRESH_LEASE_TTL_MS): OauthRefreshLease {
  const startedAt = new Date(nowMs).toISOString();
  return {
    ownerId,
    startedAt,
    expiresAt: new Date(nowMs + Math.max(1_000, Math.trunc(ttlMs || OAUTH_REFRESH_LEASE_TTL_MS))).toISOString(),
  };
}

export function getOauthRefreshBackoffMs(consecutiveFailures: number): number {
  const normalized = Math.max(1, Math.trunc(consecutiveFailures || 0));
  return OAUTH_REFRESH_BACKOFF_STEPS_MS[Math.min(normalized - 1, OAUTH_REFRESH_BACKOFF_STEPS_MS.length - 1)] || OAUTH_REFRESH_BACKOFF_STEPS_MS[0];
}

export function buildRefreshingOauthRefreshRuntime(
  previous: OauthRefreshRuntimeState,
  input: { ownerId: string; nowMs?: number; ttlMs?: number },
): OauthRefreshRuntimeState {
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  return {
    ...previous,
    status: 'refreshing',
    lastAttemptAt: new Date(nowMs).toISOString(),
    lease: buildOauthRefreshLease(input.ownerId, nowMs, input.ttlMs),
  };
}

export function buildSuccessfulOauthRefreshRuntime(
  previous: OauthRefreshRuntimeState,
  nowMs = Date.now(),
): OauthRefreshRuntimeState {
  return {
    ...previous,
    status: 'success',
    consecutiveFailures: 0,
    backoffUntil: null,
    lastError: '',
    lastAttemptAt: new Date(nowMs).toISOString(),
    lastSuccessAt: new Date(nowMs).toISOString(),
    lease: null,
  };
}

export function isTerminalOauthRefreshError(error: unknown): boolean {
  const message = String((error as Error | undefined)?.message || error || '').toLowerCase();
  if (!message) return false;
  return [
    'invalid_grant',
    'invalid_client',
    'oauth refresh token missing',
    'refresh token missing',
    'refresh token revoked',
    'refresh token invalid',
    'invalid refresh token',
    'revoked refresh token',
    'unsupported oauth provider',
    'oauth account not found',
    'token exchange response missing required fields',
    'missing chatgpt_account_id',
  ].some((pattern) => message.includes(pattern));
}

export function buildFailedOauthRefreshRuntime(
  previous: OauthRefreshRuntimeState,
  input: { error: unknown; nowMs?: number },
): OauthRefreshRuntimeState {
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const consecutiveFailures = Math.max(1, (previous.consecutiveFailures || 0) + 1);
  return {
    ...previous,
    status: 'backoff',
    consecutiveFailures,
    backoffUntil: new Date(nowMs + getOauthRefreshBackoffMs(consecutiveFailures)).toISOString(),
    lastAttemptAt: new Date(nowMs).toISOString(),
    lastFailureAt: new Date(nowMs).toISOString(),
    lastError: String((input.error as Error | undefined)?.message || input.error || 'oauth refresh failed').slice(0, 500),
    lease: null,
  };
}

export function buildTerminalOauthRefreshRuntime(
  previous: OauthRefreshRuntimeState,
  input: { error: unknown; nowMs?: number },
): OauthRefreshRuntimeState {
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const consecutiveFailures = Math.max(1, (previous.consecutiveFailures || 0) + 1);
  return {
    ...previous,
    status: 'terminal',
    consecutiveFailures,
    backoffUntil: null,
    lastAttemptAt: new Date(nowMs).toISOString(),
    lastFailureAt: new Date(nowMs).toISOString(),
    lastError: String((input.error as Error | undefined)?.message || input.error || 'oauth refresh failed').slice(0, 500),
    lease: null,
  };
}

export function buildIdleOauthRefreshRuntime(previous: OauthRefreshRuntimeState): OauthRefreshRuntimeState {
  return {
    ...previous,
    status: 'idle',
    lease: null,
  };
}

export function getOauthRefreshBackoffReason(
  stateOrExtraConfig?: OauthRefreshRuntimeState | string | Record<string, unknown> | null,
  nowMs = Date.now(),
): string | null {
  const state = isRuntimeState(stateOrExtraConfig)
    ? stateOrExtraConfig
    : getOauthRefreshRuntimeState(stateOrExtraConfig);
  if (state.status === 'terminal') {
    return state.lastError
      ? `OAuth 刷新已终止：${state.lastError}`
      : 'OAuth 刷新已终止';
  }
  if (!isOauthRefreshBackoffActive(state, nowMs) || !state.backoffUntil) return null;
  return state.lastError
    ? `OAuth 刷新冷却中，需等待到 ${state.backoffUntil}：${state.lastError}`
    : `OAuth 刷新冷却中，需等待到 ${state.backoffUntil}`;
}

function isRuntimeState(value: unknown): value is OauthRefreshRuntimeState {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'status' in (value as Record<string, unknown>);
}
