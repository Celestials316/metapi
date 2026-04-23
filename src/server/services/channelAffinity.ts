import { createHash } from 'node:crypto';
import type { DownstreamClientContext } from '../proxy-core/downstreamClientContext.js';

export type ChannelAffinityKeySource = {
  type: 'body_path' | 'header' | 'client_context';
  key?: string;
  path?: string;
};

export type ChannelAffinityRule = {
  name: string;
  modelRegex: string[];
  pathRegex: string[];
  keySources: ChannelAffinityKeySource[];
  valueRegex: string | null;
  ttlSeconds: number | null;
  skipRetryOnFailure: boolean;
  includeGroup: boolean;
  includeModel: boolean;
  includeRule: boolean;
};

export type ChannelAffinityConfig = {
  enabled: boolean;
  switchOnSuccess: boolean;
  maxEntries: number;
  defaultTtlSeconds: number;
  rules: ChannelAffinityRule[];
};

export type ChannelAffinityResolution = {
  ruleName: string;
  cacheKey: string;
  fingerprint: string;
  selectedGroup: string;
  preferredChannelId: number | null;
  skipRetryOnFailure: boolean;
  ttlSeconds: number;
};

export type ChannelAffinityBindingSnapshot = {
  cacheKey: string;
  channelId: number;
  expiresAtMs: number;
  updatedAtMs: number;
};

type ChannelAffinityCacheEntry = {
  channelId: number;
  expiresAtMs: number;
  updatedAtMs: number;
};

type ResolveChannelAffinityRequestInput = {
  config?: ChannelAffinityConfig | null;
  requestedModel: string;
  downstreamPath: string;
  headers?: Record<string, unknown> | null;
  body?: unknown;
  clientContext?: DownstreamClientContext | null;
  downstreamGroup?: string | null;
  downstreamApiKeyId?: number | null;
};

const DEFAULT_CHANNEL_AFFINITY_CONFIG: ChannelAffinityConfig = {
  enabled: false,
  switchOnSuccess: true,
  maxEntries: 100_000,
  defaultTtlSeconds: 3_600,
  rules: [],
};

const channelAffinityCache = new Map<string, ChannelAffinityCacheEntry>();

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => toTrimmedString(item))
      .filter((item) => item.length > 0);
  }
  const single = toTrimmedString(value);
  return single ? [single] : [];
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

function normalizeOptionalPositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.trunc(parsed));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeKeySource(value: unknown): ChannelAffinityKeySource | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const type = toTrimmedString(raw.type).toLowerCase();
  if (type !== 'body_path' && type !== 'header' && type !== 'client_context') {
    return null;
  }
  const key = toTrimmedString(raw.key);
  const path = toTrimmedString(raw.path);
  return {
    type,
    key: key || undefined,
    path: path || undefined,
  };
}

function normalizeRule(value: unknown): ChannelAffinityRule | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const name = toTrimmedString(raw.name);
  if (!name) return null;
  const rawKeySources = Array.isArray(raw.keySources ?? raw.key_sources)
    ? (raw.keySources ?? raw.key_sources) as unknown[]
    : [];
  const normalizedKeySources = rawKeySources
    .map((item) => normalizeKeySource(item))
    .filter((item): item is ChannelAffinityKeySource => item !== null);
  if (normalizedKeySources.length === 0) return null;
  const valueRegex = toTrimmedString(raw.valueRegex ?? raw.value_regex);
  return {
    name,
    modelRegex: normalizeStringList(raw.modelRegex ?? raw.model_regex),
    pathRegex: normalizeStringList(raw.pathRegex ?? raw.path_regex),
    keySources: normalizedKeySources,
    valueRegex: valueRegex || null,
    ttlSeconds: normalizeOptionalPositiveInteger(raw.ttlSeconds ?? raw.ttl_seconds),
    skipRetryOnFailure: normalizeBoolean(raw.skipRetryOnFailure ?? raw.skip_retry_on_failure, false),
    includeGroup: normalizeBoolean(raw.includeGroup ?? raw.include_group, true),
    includeModel: normalizeBoolean(raw.includeModel ?? raw.include_model, true),
    includeRule: normalizeBoolean(raw.includeRule ?? raw.include_rule, true),
  };
}

export function normalizeChannelAffinityConfig(value: unknown): ChannelAffinityConfig {
  const raw = asRecord(value);
  if (!raw) {
    return {
      ...DEFAULT_CHANNEL_AFFINITY_CONFIG,
      rules: [],
    };
  }

  const rules = Array.isArray(raw.rules)
    ? raw.rules
      .map((item) => normalizeRule(item))
      .filter((item): item is ChannelAffinityRule => item !== null)
    : [];

  return {
    enabled: normalizeBoolean(raw.enabled, DEFAULT_CHANNEL_AFFINITY_CONFIG.enabled),
    switchOnSuccess: normalizeBoolean(raw.switchOnSuccess ?? raw.switch_on_success, DEFAULT_CHANNEL_AFFINITY_CONFIG.switchOnSuccess),
    maxEntries: normalizePositiveInteger(raw.maxEntries ?? raw.max_entries, DEFAULT_CHANNEL_AFFINITY_CONFIG.maxEntries),
    defaultTtlSeconds: normalizePositiveInteger(raw.defaultTtlSeconds ?? raw.default_ttl_seconds, DEFAULT_CHANNEL_AFFINITY_CONFIG.defaultTtlSeconds),
    rules,
  };
}

function matchesRegexList(patterns: string[], value: string): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return false;
    }
  });
}

function getValueByBodyPath(body: unknown, path: string): string {
  if (!path) return '';
  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return '';
  let current: unknown = body;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return '';
      current = current[index];
      continue;
    }
    const record = asRecord(current);
    if (!record || !(segment in record)) return '';
    current = record[segment];
  }
  return toTrimmedString(current);
}

function getHeaderValue(headers: Record<string, unknown> | null | undefined, key: string): string {
  const normalizedKey = key.trim().toLowerCase();
  if (!headers || !normalizedKey) return '';
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== normalizedKey) continue;
    if (typeof rawValue === 'string') return rawValue.trim();
    if (Array.isArray(rawValue)) {
      const first = rawValue.find((item) => typeof item === 'string' && item.trim().length > 0);
      return typeof first === 'string' ? first.trim() : '';
    }
    if (rawValue != null) return String(rawValue).trim();
  }
  return '';
}

function getClientContextValue(clientContext: DownstreamClientContext | null | undefined, key: string): string {
  const normalizedKey = key.trim();
  if (!clientContext || !normalizedKey) return '';
  if (normalizedKey === 'sessionId') return toTrimmedString(clientContext.sessionId);
  if (normalizedKey === 'traceHint') return toTrimmedString(clientContext.traceHint);
  if (normalizedKey === 'clientKind') return toTrimmedString(clientContext.clientKind);
  return '';
}

function extractAffinityValue(input: ResolveChannelAffinityRequestInput, rule: ChannelAffinityRule): string {
  for (const source of rule.keySources) {
    let candidate = '';
    if (source.type === 'body_path') {
      candidate = getValueByBodyPath(input.body, source.path || '');
    } else if (source.type === 'header') {
      candidate = getHeaderValue(input.headers, source.key || source.path || '');
    } else if (source.type === 'client_context') {
      candidate = getClientContextValue(input.clientContext, source.key || source.path || '');
    }
    if (candidate) return candidate;
  }
  return '';
}

function buildSelectedGroup(input: ResolveChannelAffinityRequestInput): string {
  const group = toTrimmedString(input.downstreamGroup);
  if (group) return group;
  const keyId = Math.trunc(Number(input.downstreamApiKeyId || 0));
  if (keyId > 0) return `key:${keyId}`;
  return 'global';
}

function buildFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildCacheKey(rule: ChannelAffinityRule, input: ResolveChannelAffinityRequestInput, selectedGroup: string, fingerprint: string): string {
  const parts: string[] = ['channel-affinity:v1'];
  if (rule.includeGroup) parts.push(`group:${selectedGroup}`);
  if (rule.includeModel) parts.push(`model:${input.requestedModel}`);
  if (rule.includeRule) parts.push(`rule:${rule.name}`);
  parts.push(`fp:${fingerprint}`);
  return parts.join('|');
}

function getActiveEntry(cacheKey: string): ChannelAffinityCacheEntry | null {
  const entry = channelAffinityCache.get(cacheKey) || null;
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    channelAffinityCache.delete(cacheKey);
    return null;
  }
  return entry;
}

function pruneChannelAffinityCache(maxEntries: number): void {
  if (channelAffinityCache.size < maxEntries) return;
  const oldestKey = channelAffinityCache.keys().next().value;
  if (typeof oldestKey === 'string') {
    channelAffinityCache.delete(oldestKey);
  }
}

export function resetChannelAffinityState(): void {
  channelAffinityCache.clear();
}

export function clearChannelAffinityBinding(cacheKey?: string | null, expectedChannelId?: number | null): void {
  const normalizedCacheKey = toTrimmedString(cacheKey);
  if (!normalizedCacheKey) return;
  const entry = channelAffinityCache.get(normalizedCacheKey);
  if (!entry) return;
  const normalizedExpectedChannelId = Math.trunc(Number(expectedChannelId || 0));
  if (normalizedExpectedChannelId > 0 && entry.channelId !== normalizedExpectedChannelId) {
    return;
  }
  channelAffinityCache.delete(normalizedCacheKey);
}

export function listChannelAffinityBindings(nowMs = Date.now()): ChannelAffinityBindingSnapshot[] {
  const snapshots: ChannelAffinityBindingSnapshot[] = [];
  for (const [cacheKey, entry] of channelAffinityCache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      channelAffinityCache.delete(cacheKey);
      continue;
    }
    snapshots.push({
      cacheKey,
      channelId: entry.channelId,
      expiresAtMs: entry.expiresAtMs,
      updatedAtMs: entry.updatedAtMs,
    });
  }
  return snapshots.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function clearChannelAffinityBindingsByChannelIds(channelIds: number[]): number {
  const normalizedChannelIds = new Set(
    (Array.isArray(channelIds) ? channelIds : [])
      .filter((channelId): channelId is number => Number.isFinite(channelId) && channelId > 0)
      .map((channelId) => Math.trunc(channelId)),
  );
  if (normalizedChannelIds.size <= 0) return 0;
  let cleared = 0;
  for (const [cacheKey, entry] of channelAffinityCache.entries()) {
    if (!normalizedChannelIds.has(entry.channelId)) continue;
    channelAffinityCache.delete(cacheKey);
    cleared += 1;
  }
  return cleared;
}

export function resolveChannelAffinityRequest(input: ResolveChannelAffinityRequestInput): ChannelAffinityResolution | null {
  const config = normalizeChannelAffinityConfig(input.config);
  if (!config.enabled || config.rules.length === 0) return null;

  for (const rule of config.rules) {
    if (!matchesRegexList(rule.modelRegex, input.requestedModel)) continue;
    if (!matchesRegexList(rule.pathRegex, input.downstreamPath)) continue;

    const affinityValue = extractAffinityValue(input, rule);
    if (!affinityValue) continue;
    if (rule.valueRegex && !matchesRegexList([rule.valueRegex], affinityValue)) continue;

    const selectedGroup = buildSelectedGroup(input);
    const fingerprint = buildFingerprint(affinityValue);
    const cacheKey = buildCacheKey(rule, input, selectedGroup, fingerprint);
    const entry = getActiveEntry(cacheKey);

    return {
      ruleName: rule.name,
      cacheKey,
      fingerprint,
      selectedGroup,
      preferredChannelId: entry?.channelId ?? null,
      skipRetryOnFailure: rule.skipRetryOnFailure,
      ttlSeconds: rule.ttlSeconds ?? config.defaultTtlSeconds,
    };
  }

  return null;
}

export function recordChannelAffinitySuccess(input: {
  config?: ChannelAffinityConfig | null;
  resolution?: ChannelAffinityResolution | null;
  selectedChannelId: number;
}): void {
  const config = normalizeChannelAffinityConfig(input.config);
  if (!config.enabled) return;
  const resolution = input.resolution;
  if (!resolution) return;
  const selectedChannelId = Math.trunc(Number(input.selectedChannelId || 0));
  if (selectedChannelId <= 0) return;

  if (
    resolution.preferredChannelId
    && resolution.preferredChannelId !== selectedChannelId
    && !config.switchOnSuccess
  ) {
    return;
  }

  pruneChannelAffinityCache(config.maxEntries);
  channelAffinityCache.set(resolution.cacheKey, {
    channelId: selectedChannelId,
    expiresAtMs: Date.now() + (Math.max(1, resolution.ttlSeconds) * 1000),
    updatedAtMs: Date.now(),
  });
}
