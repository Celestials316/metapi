export type DownstreamRateLimitConfig = {
  enabled: boolean;
  windowMinutes: number;
  totalCount: number;
  successCount: number;
  group: Record<string, [number, number]>;
};

export type DownstreamRateLimitReason = 'total' | 'success' | null;

export type DownstreamRateLimitDecision = {
  allowed: boolean;
  reason: DownstreamRateLimitReason;
  message: string;
};

type DownstreamRateLimitBucket = {
  requestTimestamps: number[];
  successTimestamps: number[];
};

const DEFAULT_CONFIG: DownstreamRateLimitConfig = {
  enabled: false,
  windowMinutes: 1,
  totalCount: 0,
  successCount: 0,
  group: {},
};

const bucketStore = new Map<number, DownstreamRateLimitBucket>();

function toPositiveInteger(value: unknown, minimum: number): number | null {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return null;
  const truncated = Math.trunc(normalized);
  if (truncated < minimum) return null;
  return truncated;
}

function normalizeGroupLimits(value: unknown): Record<string, [number, number]> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, [number, number]> = {};
  for (const [rawName, rawLimits] of Object.entries(value as Record<string, unknown>)) {
    const name = String(rawName || '').trim();
    if (!name || !Array.isArray(rawLimits) || rawLimits.length < 2) continue;
    const total = toPositiveInteger(rawLimits[0], 0);
    const success = toPositiveInteger(rawLimits[1], 1);
    if (total === null || success === null) continue;
    result[name] = [total, success];
  }
  return result;
}

export function normalizeDownstreamRateLimitConfig(value: unknown): DownstreamRateLimitConfig {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CONFIG };
  const raw = value as Record<string, unknown>;
  const windowMinutes = toPositiveInteger(raw.windowMinutes ?? raw.window_minutes, 1) ?? DEFAULT_CONFIG.windowMinutes;
  const totalCount = toPositiveInteger(raw.totalCount ?? raw.total_count, 0) ?? DEFAULT_CONFIG.totalCount;
  const successCount = toPositiveInteger(raw.successCount ?? raw.success_count, 0) ?? DEFAULT_CONFIG.successCount;
  const enabled = raw.enabled === true;
  return {
    enabled,
    windowMinutes,
    totalCount,
    successCount,
    group: normalizeGroupLimits(raw.group),
  };
}

function normalizeGroupName(value: string | null | undefined): string {
  return String(value || '').trim();
}

function getBucket(keyId: number): DownstreamRateLimitBucket {
  const existing = bucketStore.get(keyId);
  if (existing) return existing;
  const created = { requestTimestamps: [], successTimestamps: [] };
  bucketStore.set(keyId, created);
  return created;
}

function pruneBucket(bucket: DownstreamRateLimitBucket, cutoffMs: number) {
  while (bucket.requestTimestamps.length > 0 && bucket.requestTimestamps[0] < cutoffMs) {
    bucket.requestTimestamps.shift();
  }
  while (bucket.successTimestamps.length > 0 && bucket.successTimestamps[0] < cutoffMs) {
    bucket.successTimestamps.shift();
  }
}

function resolveLimits(config: DownstreamRateLimitConfig, groupName: string | null | undefined) {
  const normalizedGroupName = normalizeGroupName(groupName);
  const groupLimits = normalizedGroupName ? config.group[normalizedGroupName] : undefined;
  if (groupLimits) {
    return { totalCount: groupLimits[0], successCount: groupLimits[1] };
  }
  return { totalCount: config.totalCount, successCount: config.successCount };
}

function now(input?: number): number {
  return typeof input === 'number' && Number.isFinite(input) ? input : Date.now();
}

export function evaluateDownstreamRateLimit(input: {
  config: DownstreamRateLimitConfig;
  keyId: number;
  groupName?: string | null;
  nowMs?: number;
}): DownstreamRateLimitDecision {
  const config = normalizeDownstreamRateLimitConfig(input.config);
  if (!config.enabled) {
    return { allowed: true, reason: null, message: '' };
  }
  const { totalCount, successCount } = resolveLimits(config, input.groupName);
  if (totalCount <= 0 && successCount <= 0) {
    return { allowed: true, reason: null, message: '' };
  }
  const currentNow = now(input.nowMs);
  const cutoffMs = currentNow - config.windowMinutes * 60 * 1000;
  const bucket = getBucket(input.keyId);
  pruneBucket(bucket, cutoffMs);
  if (totalCount > 0 && bucket.requestTimestamps.length >= totalCount) {
    return {
      allowed: false,
      reason: 'total',
      message: `You have reached the total request limit: maximum ${totalCount} requests in ${config.windowMinutes} minutes, including failed attempts`,
    };
  }
  if (successCount > 0 && bucket.successTimestamps.length >= successCount) {
    return {
      allowed: false,
      reason: 'success',
      message: `You have reached the request limit: maximum ${successCount} successful requests in ${config.windowMinutes} minutes`,
    };
  }
  return { allowed: true, reason: null, message: '' };
}

export function recordDownstreamRateLimitRequest(input: {
  config: DownstreamRateLimitConfig;
  keyId: number;
  groupName?: string | null;
  nowMs?: number;
}) {
  const config = normalizeDownstreamRateLimitConfig(input.config);
  if (!config.enabled) return;
  const bucket = getBucket(input.keyId);
  const currentNow = now(input.nowMs);
  const cutoffMs = currentNow - config.windowMinutes * 60 * 1000;
  pruneBucket(bucket, cutoffMs);
  bucket.requestTimestamps.push(currentNow);
}

export function recordDownstreamRateLimitSuccess(input: {
  config: DownstreamRateLimitConfig;
  keyId: number;
  groupName?: string | null;
  nowMs?: number;
}) {
  const config = normalizeDownstreamRateLimitConfig(input.config);
  if (!config.enabled) return;
  const bucket = getBucket(input.keyId);
  const currentNow = now(input.nowMs);
  const cutoffMs = currentNow - config.windowMinutes * 60 * 1000;
  pruneBucket(bucket, cutoffMs);
  bucket.successTimestamps.push(currentNow);
}

export function resetDownstreamRateLimitStore() {
  bucketStore.clear();
}
