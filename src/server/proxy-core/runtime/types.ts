import type WebSocket from 'ws';

export type CodexWebsocketRuntimeSendInput = {
  sessionId: string;
  trustedSession: boolean;
  requestUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type CodexWebsocketRuntimeResult = {
  events: Array<Record<string, unknown>>;
  reusedSession: boolean;
};

export type CodexWebsocketSession = {
  sessionId: string;
  socket: WebSocket | null;
  socketUrl: string | null;
  queue: Promise<unknown>;
  createdAtMs: number;
  lastActivityAtMs: number;
  lastTerminalAtMs: number | null;
  lastTerminalReason: string | null;
  lastCloseReason: string | null;
};

export type CodexWebsocketSessionSnapshot = {
  sessionId: string;
  socketUrl: string | null;
  hasOpenSocket: boolean;
  createdAtMs: number;
  lastActivityAtMs: number;
  lastTerminalAtMs: number | null;
  lastTerminalReason: string | null;
  lastCloseReason: string | null;
};

export type CodexWebsocketSessionStore = {
  getOrCreate(sessionId: string): CodexWebsocketSession;
  take(sessionId: string): CodexWebsocketSession | null;
  list(): CodexWebsocketSession[];
  touch(sessionId: string, nowMs?: number): void;
  markTerminal(sessionId: string, input?: { nowMs?: number; reason?: string | null; closeReason?: string | null }): void;
  snapshots(): CodexWebsocketSessionSnapshot[];
};
