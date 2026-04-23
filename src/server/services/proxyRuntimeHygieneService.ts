import { and, eq, isNull, lt } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { finalizeProxyDebugTrace } from './proxyDebugTraceStore.js';
import { proxyChannelCoordinator } from './proxyChannelCoordinator.js';
import { clearCodexSessionResponseId } from '../proxy-core/runtime/codexSessionResponseStore.js';
import { sharedCodexWebsocketRuntime } from '../proxy-core/runtime/codexWebsocketRuntime.js';
import { evictStaleProxyActiveRuntimes } from './proxyActiveRuntimeRegistry.js';

const DEFAULT_RUNTIME_HYGIENE_INTERVAL_MS = 60_000;
const DEFAULT_RUNTIME_RECONCILE_STALE_MS = 10 * 60_000;
const DEFAULT_RUNTIME_RECONCILE_BATCH = 100;

let runtimeHygieneTimer: ReturnType<typeof setInterval> | null = null;
let runtimeHygieneSweepInFlight: Promise<number> | null = null;

function shouldUnrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>) {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function getRuntimeHygieneIntervalMs(): number {
  return Math.max(15_000, Math.trunc((config as any).proxyRuntimeHygieneIntervalMs || DEFAULT_RUNTIME_HYGIENE_INTERVAL_MS));
}

function getRuntimeReconcileStaleMs(): number {
  return Math.max(60_000, Math.trunc((config as any).proxyRuntimeReconcileStaleMs || DEFAULT_RUNTIME_RECONCILE_STALE_MS));
}

function getRuntimeReconcileBatch(): number {
  return Math.max(1, Math.min(500, Math.trunc((config as any).proxyRuntimeReconcileBatch || DEFAULT_RUNTIME_RECONCILE_BATCH)));
}

async function loadStaleIncompleteDebugTraces(nowMs = Date.now()) {
  const cutoffIso = formatUtcSqlDateTime(new Date(nowMs - getRuntimeReconcileStaleMs()));
  return await db.select({
    id: schema.proxyDebugTraces.id,
    sessionId: schema.proxyDebugTraces.sessionId,
    traceHint: schema.proxyDebugTraces.traceHint,
    stickySessionKey: schema.proxyDebugTraces.stickySessionKey,
    selectedChannelId: schema.proxyDebugTraces.selectedChannelId,
    updatedAt: schema.proxyDebugTraces.updatedAt,
    createdAt: schema.proxyDebugTraces.createdAt,
  }).from(schema.proxyDebugTraces)
    .where(and(
      isNull(schema.proxyDebugTraces.finalStatus),
      lt(schema.proxyDebugTraces.updatedAt, cutoffIso),
    ))
    .limit(getRuntimeReconcileBatch())
    .all();
}

async function orphanTraceAndCleanup(trace: {
  id: number;
  sessionId: string | null;
  traceHint: string | null;
  stickySessionKey: string | null;
  selectedChannelId: number | null;
}, options?: { reason?: 'startup_reconciled_orphan' | 'runtime_scavenged_orphan' }) {
  const reason = options?.reason || 'runtime_scavenged_orphan';
  await finalizeProxyDebugTrace(trace.id, {
    finalStatus: 'orphaned',
    finalHttpStatus: 499,
    finalUpstreamPath: null,
    finalResponseBody: {
      error: {
        message: 'runtime reconciliation marked stale active trace as orphaned',
        type: 'runtime_reconciliation',
        reason,
      },
      metapiRuntimeReason: reason,
    },
  });

  if (trace.stickySessionKey) {
    proxyChannelCoordinator.clearStickyChannel(trace.stickySessionKey, trace.selectedChannelId ?? undefined);
  }
  if (typeof trace.selectedChannelId === 'number' && trace.selectedChannelId > 0) {
    proxyChannelCoordinator.clearStickyChannelsByChannelIds([trace.selectedChannelId]);
  }

  const candidateSessionKeys = [trace.sessionId, trace.traceHint]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  for (const sessionKey of candidateSessionKeys) {
    clearCodexSessionResponseId(sessionKey);
  }
}

export async function runProxyRuntimeHygieneSweep(
  nowMs = Date.now(),
  options?: { reason?: 'startup_reconciled_orphan' | 'runtime_scavenged_orphan' },
): Promise<number> {
  const staleTraces = await loadStaleIncompleteDebugTraces(nowMs);
  const orphanReason = options?.reason || 'runtime_scavenged_orphan';
  for (const trace of staleTraces) {
    await orphanTraceAndCleanup(trace, { reason: orphanReason });
  }
  const staleBeforeMs = nowMs - getRuntimeReconcileStaleMs();
  const evictedSessions = await sharedCodexWebsocketRuntime.evictStaleSessions({
    staleBeforeMs,
    closeReason: 'proxy-runtime-hygiene',
  });
  const evictedActiveRuntimes = evictStaleProxyActiveRuntimes({
    staleBeforeMs,
  });
  return staleTraces.length + evictedSessions + evictedActiveRuntimes;
}

export async function runStartupProxyRuntimeReconciliation(): Promise<number> {
  return await runProxyRuntimeHygieneSweep(Date.now(), {
    reason: 'startup_reconciled_orphan',
  });
}

export function startProxyRuntimeHygieneScheduler(intervalMs = getRuntimeHygieneIntervalMs()): void {
  stopProxyRuntimeHygieneScheduler();
  runtimeHygieneTimer = setInterval(() => {
    if (runtimeHygieneSweepInFlight) return;
    runtimeHygieneSweepInFlight = runProxyRuntimeHygieneSweep()
      .catch((error) => {
        console.warn('[proxy-runtime-hygiene] sweep failed', error);
        return 0;
      })
      .finally(() => {
        runtimeHygieneSweepInFlight = null;
      });
  }, Math.max(15_000, Math.trunc(intervalMs || getRuntimeHygieneIntervalMs())));
  shouldUnrefTimer(runtimeHygieneTimer);
}

export function stopProxyRuntimeHygieneScheduler(): void {
  if (!runtimeHygieneTimer) return;
  clearInterval(runtimeHygieneTimer);
  runtimeHygieneTimer = null;
}
