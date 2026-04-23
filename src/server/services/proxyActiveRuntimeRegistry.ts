export type ProxyActiveRuntimeStage =
  | 'accepted'
  | 'streaming_active'
  | 'stream_idle'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'orphaned';

export type ProxyActiveRuntimeEntry = {
  traceId: number;
  downstreamPath: string;
  acceptedAtMs: number;
  firstByteAtMs: number | null;
  lastActivityAtMs: number;
  finalizedAtMs: number | null;
  stage: ProxyActiveRuntimeStage;
};

const activeRuntimeEntries = new Map<number, ProxyActiveRuntimeEntry>();

export function registerProxyActiveRuntime(input: {
  traceId: number;
  downstreamPath: string;
  nowMs?: number;
}): void {
  const nowMs = Math.trunc(input.nowMs || Date.now());
  if (!Number.isFinite(input.traceId) || input.traceId <= 0) return;
  activeRuntimeEntries.set(input.traceId, {
    traceId: input.traceId,
    downstreamPath: input.downstreamPath,
    acceptedAtMs: nowMs,
    firstByteAtMs: null,
    lastActivityAtMs: nowMs,
    finalizedAtMs: null,
    stage: 'accepted',
  });
}

export function touchProxyActiveRuntime(traceId: number, input?: {
  nowMs?: number;
  stage?: ProxyActiveRuntimeStage;
  markFirstByte?: boolean;
}): void {
  const entry = activeRuntimeEntries.get(Math.trunc(traceId || 0));
  if (!entry) return;
  const nowMs = Math.trunc(input?.nowMs || Date.now());
  entry.lastActivityAtMs = nowMs;
  if (input?.markFirstByte && entry.firstByteAtMs == null) {
    entry.firstByteAtMs = nowMs;
  }
  if (input?.stage) {
    entry.stage = input.stage;
  }
}

export function finalizeProxyActiveRuntime(traceId: number, input?: {
  nowMs?: number;
  stage?: Extract<ProxyActiveRuntimeStage, 'completed' | 'failed' | 'aborted' | 'orphaned'>;
}): void {
  const entry = activeRuntimeEntries.get(Math.trunc(traceId || 0));
  if (!entry) return;
  const nowMs = Math.trunc(input?.nowMs || Date.now());
  entry.lastActivityAtMs = nowMs;
  entry.finalizedAtMs = nowMs;
  entry.stage = input?.stage || 'completed';
}

export function getProxyActiveRuntimeSnapshots(): ProxyActiveRuntimeEntry[] {
  return [...activeRuntimeEntries.values()].map((entry) => ({ ...entry }));
}

export function evictStaleProxyActiveRuntimes(input: {
  staleBeforeMs: number;
}): number {
  const staleBeforeMs = Math.trunc(Number(input.staleBeforeMs) || 0);
  if (!Number.isFinite(staleBeforeMs) || staleBeforeMs <= 0) return 0;
  let evicted = 0;
  for (const [traceId, entry] of activeRuntimeEntries.entries()) {
    if (entry.finalizedAtMs != null) {
      activeRuntimeEntries.delete(traceId);
      evicted += 1;
      continue;
    }
    if (entry.lastActivityAtMs > staleBeforeMs) continue;
    entry.stage = 'orphaned';
    entry.finalizedAtMs = Date.now();
    activeRuntimeEntries.delete(traceId);
    evicted += 1;
  }
  return evicted;
}

export function resetProxyActiveRuntimeRegistry(): void {
  activeRuntimeEntries.clear();
}
