import type { CodexWebsocketSession, CodexWebsocketSessionSnapshot, CodexWebsocketSessionStore } from './types.js';

export function createCodexWebsocketSessionStore(): CodexWebsocketSessionStore {
  const sessions = new Map<string, CodexWebsocketSession>();

  return {
    getOrCreate(sessionId) {
      const normalized = sessionId.trim();
      const existing = sessions.get(normalized);
      if (existing) return existing;

      const nowMs = Date.now();
      const created: CodexWebsocketSession = {
        sessionId: normalized,
        socket: null,
        socketUrl: null,
        queue: Promise.resolve(),
        createdAtMs: nowMs,
        lastActivityAtMs: nowMs,
        lastTerminalAtMs: null,
        lastTerminalReason: null,
        lastCloseReason: null,
      };
      sessions.set(normalized, created);
      return created;
    },
    take(sessionId) {
      const normalized = sessionId.trim();
      if (!normalized) return null;
      const existing = sessions.get(normalized) || null;
      if (existing) {
        sessions.delete(normalized);
      }
      return existing;
    },
    list() {
      return [...sessions.values()];
    },
    touch(sessionId, nowMs = Date.now()) {
      const normalized = sessionId.trim();
      if (!normalized) return;
      const session = sessions.get(normalized);
      if (!session) return;
      session.lastActivityAtMs = nowMs;
    },
    markTerminal(sessionId, input) {
      const normalized = sessionId.trim();
      if (!normalized) return;
      const session = sessions.get(normalized);
      if (!session) return;
      const nowMs = input?.nowMs ?? Date.now();
      session.lastActivityAtMs = nowMs;
      session.lastTerminalAtMs = nowMs;
      session.lastTerminalReason = typeof input?.reason === 'string' && input.reason.trim()
        ? input.reason.trim()
        : session.lastTerminalReason;
      session.lastCloseReason = typeof input?.closeReason === 'string' && input.closeReason.trim()
        ? input.closeReason.trim()
        : session.lastCloseReason;
    },
    snapshots(): CodexWebsocketSessionSnapshot[] {
      return [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        socketUrl: session.socketUrl,
        hasOpenSocket: !!session.socket,
        createdAtMs: session.createdAtMs,
        lastActivityAtMs: session.lastActivityAtMs,
        lastTerminalAtMs: session.lastTerminalAtMs,
        lastTerminalReason: session.lastTerminalReason,
        lastCloseReason: session.lastCloseReason,
      }));
    },
  };
}
