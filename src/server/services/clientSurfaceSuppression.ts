import type { CliProfileId } from '../proxy-core/cliProfiles/types.js';
import type { UpstreamEndpoint } from '../proxy-core/orchestration/upstreamRequest.js';

export type ClientSurfaceSuppressionReason = 'upstream_blocked_generic_responses';

export type ClientSurfaceSuppressionKeyInput = {
  channelId: number;
  endpoint: UpstreamEndpoint;
  clientKind: CliProfileId;
  model: string;
};

type ClientSurfaceSuppressionRecord = ClientSurfaceSuppressionKeyInput & {
  reason: ClientSurfaceSuppressionReason;
  expiresAtMs: number;
  createdAtMs: number;
};

const DEFAULT_GENERIC_RESPONSES_BLOCKED_TTL_MS = 30 * 60 * 1000;
const suppressions = new Map<string, ClientSurfaceSuppressionRecord>();

function normalizeChannelId(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
  return Math.trunc(numeric);
}

function normalizeModel(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function buildSuppressionKey(input: ClientSurfaceSuppressionKeyInput): string | null {
  const channelId = normalizeChannelId(input.channelId);
  const model = normalizeModel(input.model);
  const endpoint = String(input.endpoint || '').trim().toLowerCase();
  const clientKind = String(input.clientKind || '').trim().toLowerCase();
  if (channelId === null || !model || !endpoint || !clientKind) return null;
  return `${channelId}|${endpoint}|${clientKind}|${model}`;
}

function pruneExpired(nowMs = Date.now()): void {
  for (const [key, record] of suppressions.entries()) {
    if (record.expiresAtMs <= nowMs) {
      suppressions.delete(key);
    }
  }
}

export function resetClientSurfaceSuppressions(): void {
  suppressions.clear();
}

export function suppressClientSurface(input: ClientSurfaceSuppressionKeyInput & {
  reason: ClientSurfaceSuppressionReason;
  ttlMs?: number;
  nowMs?: number;
}): boolean {
  const key = buildSuppressionKey(input);
  if (!key) return false;
  const nowMs = Number.isFinite(input.nowMs) ? Math.trunc(input.nowMs!) : Date.now();
  const ttlMs = Number.isFinite(input.ttlMs) && (input.ttlMs ?? 0) > 0
    ? Math.trunc(input.ttlMs!)
    : DEFAULT_GENERIC_RESPONSES_BLOCKED_TTL_MS;
  const channelId = normalizeChannelId(input.channelId)!;
  const model = normalizeModel(input.model)!;
  suppressions.set(key, {
    channelId,
    endpoint: input.endpoint,
    clientKind: input.clientKind,
    model,
    reason: input.reason,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  });
  return true;
}

export function isClientSurfaceSuppressed(input: ClientSurfaceSuppressionKeyInput & {
  nowMs?: number;
}): boolean {
  const key = buildSuppressionKey(input);
  if (!key) return false;
  const nowMs = Number.isFinite(input.nowMs) ? Math.trunc(input.nowMs!) : Date.now();
  const record = suppressions.get(key);
  if (!record) return false;
  if (record.expiresAtMs <= nowMs) {
    suppressions.delete(key);
    return false;
  }
  return true;
}

export function getSuppressedClientSurfaceChannelIds(input: Omit<ClientSurfaceSuppressionKeyInput, 'channelId'> & {
  nowMs?: number;
}): number[] {
  const nowMs = Number.isFinite(input.nowMs) ? Math.trunc(input.nowMs!) : Date.now();
  pruneExpired(nowMs);
  const endpoint = String(input.endpoint || '').trim().toLowerCase();
  const clientKind = String(input.clientKind || '').trim().toLowerCase();
  const model = normalizeModel(input.model);
  if (!endpoint || !clientKind || !model) return [];

  return [...suppressions.values()]
    .filter((record) => (
      String(record.endpoint).trim().toLowerCase() === endpoint
      && String(record.clientKind).trim().toLowerCase() === clientKind
      && record.model === model
    ))
    .map((record) => record.channelId)
    .sort((left, right) => left - right);
}

export function maybeSuppressClientSurfaceFromFailure(input: ClientSurfaceSuppressionKeyInput & {
  sitePlatform?: string | null;
  status?: number | null;
  errorText?: string | null;
  nowMs?: number;
}): boolean {
  const sitePlatform = String(input.sitePlatform || '').trim().toLowerCase();
  const errorText = String(input.errorText || '');
  if (input.endpoint !== 'responses') return false;
  if (input.clientKind !== 'generic') return false;
  if (sitePlatform !== 'new-api') return false;
  if (input.status !== 403) return false;
  if (!/your request was blocked/i.test(errorText)) return false;
  return suppressClientSurface({
    channelId: input.channelId,
    endpoint: input.endpoint,
    clientKind: input.clientKind,
    model: input.model,
    reason: 'upstream_blocked_generic_responses',
    ttlMs: DEFAULT_GENERIC_RESPONSES_BLOCKED_TTL_MS,
    nowMs: input.nowMs,
  });
}
