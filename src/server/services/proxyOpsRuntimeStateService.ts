import { createHash } from 'node:crypto';

import {
  listChannelAffinityBindings,
  clearChannelAffinityBinding,
  clearChannelAffinityBindingsByChannelIds,
} from './channelAffinity.js';
import {
  listStoredSessionResponseAnchors,
  listStoredStickyChannelBindings,
  clearStoredSessionResponseId,
  clearStoredStickyChannelBinding,
  clearStoredStickyChannelsByChannelIds,
} from './responsesContinuityStore.js';
import {
  listAccountDispatchRuntimeSnapshots,
  clearAccountDispatchRuntimeStatesForAccount,
} from './accountDispatchRuntimeMemory.js';

type RedactedSessionAnchorSnapshot = {
  handle: string;
  responseIdHash: string;
  updatedAtMs: number;
};

type RedactedStickyBindingSnapshot = {
  handle: string;
  channelId: number;
  expiresAtMs: number;
  updatedAtMs: number;
};

type RedactedSuppressionSnapshot = Omit<ReturnType<typeof listAccountDispatchRuntimeSnapshots>[number], 'key'>;

function buildRuntimeStateHandle(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function redactSessionAnchors(nowMs: number): RedactedSessionAnchorSnapshot[] {
  return listStoredSessionResponseAnchors(nowMs).map((entry) => ({
    handle: buildRuntimeStateHandle(entry.key),
    responseIdHash: buildRuntimeStateHandle(entry.responseId),
    updatedAtMs: entry.updatedAtMs,
  }));
}

function redactStickyBindings(nowMs: number): RedactedStickyBindingSnapshot[] {
  return listStoredStickyChannelBindings(nowMs).map((entry) => ({
    handle: buildRuntimeStateHandle(entry.key),
    channelId: entry.channelId,
    expiresAtMs: entry.expiresAtMs,
    updatedAtMs: entry.updatedAtMs,
  }));
}

function redactSuppressionEntries(nowMs: number): RedactedSuppressionSnapshot[] {
  return listAccountDispatchRuntimeSnapshots({ nowMs }).map(({ key: _key, ...rest }) => rest);
}

function resolveSessionAnchorKeys(inputKeys: string[], inputHandles: string[]): string[] {
  const resolved = new Set<string>();
  for (const rawKey of inputKeys) {
    const key = String(rawKey || '').trim();
    if (key) resolved.add(key);
  }
  if (inputHandles.length <= 0) return [...resolved];
  for (const entry of listStoredSessionResponseAnchors()) {
    if (inputHandles.includes(buildRuntimeStateHandle(entry.key))) {
      resolved.add(entry.key);
    }
  }
  return [...resolved];
}

function resolveStickyKeys(inputKeys: string[], inputHandles: string[]): string[] {
  const resolved = new Set<string>();
  for (const rawKey of inputKeys) {
    const key = String(rawKey || '').trim();
    if (key) resolved.add(key);
  }
  if (inputHandles.length <= 0) return [...resolved];
  for (const entry of listStoredStickyChannelBindings()) {
    if (inputHandles.includes(buildRuntimeStateHandle(entry.key))) {
      resolved.add(entry.key);
    }
  }
  return [...resolved];
}

export type ProxyOpsRuntimeStateSnapshot = {
  generatedAt: string;
  channelAffinity: {
    total: number;
    entries: ReturnType<typeof listChannelAffinityBindings>;
  };
  continuity: {
    sessionAnchors: RedactedSessionAnchorSnapshot[];
    stickyBindings: RedactedStickyBindingSnapshot[];
  };
  suppression: {
    total: number;
    entries: RedactedSuppressionSnapshot[];
  };
};

export type ClearProxyOpsRuntimeStateInput = {
  affinity?: {
    cacheKeys?: string[];
    channelIds?: number[];
  };
  continuity?: {
    sessionAnchorKeys?: string[];
    sessionAnchorHandles?: string[];
    stickyKeys?: string[];
    stickyHandles?: string[];
    stickyChannelIds?: number[];
  };
  suppression?: {
    accountIds?: number[];
  };
};

export async function getProxyOpsRuntimeStateSnapshot(input: { nowMs?: number } = {}): Promise<ProxyOpsRuntimeStateSnapshot> {
  const nowMs = input.nowMs ?? Date.now();
  const channelAffinityEntries = listChannelAffinityBindings(nowMs);
  const sessionAnchors = redactSessionAnchors(nowMs);
  const stickyBindings = redactStickyBindings(nowMs);
  const suppressionEntries = redactSuppressionEntries(nowMs);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    channelAffinity: {
      total: channelAffinityEntries.length,
      entries: channelAffinityEntries,
    },
    continuity: {
      sessionAnchors,
      stickyBindings,
    },
    suppression: {
      total: suppressionEntries.length,
      entries: suppressionEntries,
    },
  };
}

export async function clearProxyOpsRuntimeState(input: ClearProxyOpsRuntimeStateInput = {}): Promise<{
  clearedAt: string;
  cleared: {
    channelAffinity: number;
    sessionAnchors: number;
    stickyBindings: number;
    suppression: number;
  };
}> {
  let clearedChannelAffinity = 0;
  let clearedSessionAnchors = 0;
  let clearedStickyBindings = 0;
  let clearedSuppression = 0;

  const affinityCacheKeys = Array.isArray(input.affinity?.cacheKeys) ? input.affinity?.cacheKeys : [];
  for (const rawKey of affinityCacheKeys) {
    const cacheKey = String(rawKey || '').trim();
    if (!cacheKey) continue;
    const before = listChannelAffinityBindings().length;
    clearChannelAffinityBinding(cacheKey);
    const after = listChannelAffinityBindings().length;
    if (after < before) clearedChannelAffinity += 1;
  }
  clearedChannelAffinity += clearChannelAffinityBindingsByChannelIds(Array.isArray(input.affinity?.channelIds) ? input.affinity!.channelIds! : []);

  const sessionAnchorKeys = resolveSessionAnchorKeys(
    Array.isArray(input.continuity?.sessionAnchorKeys) ? input.continuity?.sessionAnchorKeys : [],
    Array.isArray(input.continuity?.sessionAnchorHandles) ? input.continuity?.sessionAnchorHandles.map((value) => String(value || '').trim()).filter(Boolean) : [],
  );
  for (const rawKey of sessionAnchorKeys) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    const before = listStoredSessionResponseAnchors().length;
    clearStoredSessionResponseId(key);
    const after = listStoredSessionResponseAnchors().length;
    if (after < before) clearedSessionAnchors += 1;
  }

  const stickyKeys = resolveStickyKeys(
    Array.isArray(input.continuity?.stickyKeys) ? input.continuity?.stickyKeys : [],
    Array.isArray(input.continuity?.stickyHandles) ? input.continuity?.stickyHandles.map((value) => String(value || '').trim()).filter(Boolean) : [],
  );
  for (const rawKey of stickyKeys) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    const before = listStoredStickyChannelBindings().length;
    clearStoredStickyChannelBinding(key);
    const after = listStoredStickyChannelBindings().length;
    if (after < before) clearedStickyBindings += 1;
  }

  const stickyChannelIds = Array.isArray(input.continuity?.stickyChannelIds) ? input.continuity?.stickyChannelIds : [];
  if (stickyChannelIds.length > 0) {
    const before = listStoredStickyChannelBindings().length;
    clearStoredStickyChannelsByChannelIds(stickyChannelIds);
    const after = listStoredStickyChannelBindings().length;
    clearedStickyBindings += Math.max(0, before - after);
  }

  const accountIds = Array.isArray(input.suppression?.accountIds) ? input.suppression?.accountIds : [];
  for (const rawAccountId of accountIds) {
    const accountId = Math.trunc(Number(rawAccountId) || 0);
    if (accountId <= 0) continue;
    const before = listAccountDispatchRuntimeSnapshots({ accountId }).length;
    await clearAccountDispatchRuntimeStatesForAccount(accountId);
    const after = listAccountDispatchRuntimeSnapshots({ accountId }).length;
    if (after < before) clearedSuppression += before - after;
  }

  return {
    clearedAt: new Date().toISOString(),
    cleared: {
      channelAffinity: clearedChannelAffinity,
      sessionAnchors: clearedSessionAnchors,
      stickyBindings: clearedStickyBindings,
      suppression: clearedSuppression,
    },
  };
}
