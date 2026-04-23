import { getProxyActiveRuntimeSnapshots } from './proxyActiveRuntimeRegistry.js';
import { sharedCodexWebsocketRuntime } from '../proxy-core/runtime/codexWebsocketRuntime.js';
import type { ProxyDebugRuntimeDiagnostics } from './proxyDebugTraceStore.js';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildProxyDebugRuntimeDiagnostics(input: {
  traceId: number;
  trace: {
    sessionId?: string | null;
    traceHint?: string | null;
    downstreamPath?: string | null;
  };
}): ProxyDebugRuntimeDiagnostics {
  const activeRuntime = getProxyActiveRuntimeSnapshots()
    .find((item) => item.traceId === input.traceId) || null;

  const candidateSessionIds = [
    asTrimmedString(input.trace.sessionId),
    asTrimmedString(input.trace.traceHint),
  ].filter((value, index, array) => value && array.indexOf(value) === index);

  const websocketSnapshots = sharedCodexWebsocketRuntime.listSessionSnapshots();
  const websocketRuntime = websocketSnapshots.find((snapshot) => {
    if (candidateSessionIds.includes(asTrimmedString(snapshot.sessionId))) return true;
    return false;
  }) || null;

  return {
    activeRuntime: activeRuntime
      ? {
        traceId: activeRuntime.traceId,
        downstreamPath: activeRuntime.downstreamPath,
        acceptedAtMs: activeRuntime.acceptedAtMs,
        firstByteAtMs: activeRuntime.firstByteAtMs,
        lastActivityAtMs: activeRuntime.lastActivityAtMs,
        finalizedAtMs: activeRuntime.finalizedAtMs,
        stage: activeRuntime.stage,
      }
      : null,
    websocketRuntime: websocketRuntime
      ? {
        sessionId: websocketRuntime.sessionId,
        socketUrl: websocketRuntime.socketUrl,
        hasOpenSocket: websocketRuntime.hasOpenSocket,
        createdAtMs: websocketRuntime.createdAtMs,
        lastActivityAtMs: websocketRuntime.lastActivityAtMs,
        lastTerminalAtMs: websocketRuntime.lastTerminalAtMs,
        lastTerminalReason: websocketRuntime.lastTerminalReason,
        lastCloseReason: websocketRuntime.lastCloseReason,
      }
      : null,
  };
}
