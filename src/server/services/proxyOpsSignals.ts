import { mergeAccountExtraConfigWithRetry, parseExtraConfig } from './accountExtraConfig.js';
import type { ProxyFailureClass } from './proxyFailureTaxonomy.js';

export type ProxyOpsRecoverySignal = {
  channelId: number;
  modelName: string;
  source: 'cooldown' | 'active' | 'suppressed';
  status: 'supported' | 'unsupported' | 'inconclusive' | 'skipped' | 'failed';
  latencyMs: number | null;
  reason: string;
  recordedAt: string;
};

export type ProxyOpsProtectionSignal = {
  className: ProxyFailureClass;
  title: string;
  summary: string;
  status: number | null;
  recordedAt: string;
};

export type ProxyOpsModelProbeSummary = {
  lastProbeAt: string;
  scanned: number;
  supported: number;
  unsupported: number;
  inconclusive: number;
  skipped: number;
  updatedRows: number;
  status: 'success' | 'failed' | 'skipped';
  message: string;
};

export type ProxyOpsRefreshSignal = {
  lastRefreshAt: string;
  status: 'success' | 'failed';
  message: string;
};

export type ProxyOpsState = {
  recoverySignals?: ProxyOpsRecoverySignal[];
  protectionSignals?: ProxyOpsProtectionSignal[];
  modelProbe?: ProxyOpsModelProbeSummary | null;
  refresh?: ProxyOpsRefreshSignal | null;
};

const MAX_RECOVERY_SIGNALS = 12;
const MAX_PROTECTION_SIGNALS = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeIso(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeRecoverySignal(raw: unknown): ProxyOpsRecoverySignal | null {
  if (!isRecord(raw)) return null;
  const channelId = Number(raw.channelId);
  const modelName = String(raw.modelName || '').trim();
  const source = raw.source === 'cooldown'
    ? 'cooldown'
    : raw.source === 'active'
      ? 'active'
      : raw.source === 'suppressed'
        ? 'suppressed'
        : null;
  const status = ['supported', 'unsupported', 'inconclusive', 'skipped', 'failed'].includes(String(raw.status || ''))
    ? String(raw.status) as ProxyOpsRecoverySignal['status']
    : null;
  const recordedAt = normalizeIso(raw.recordedAt);
  if (!Number.isFinite(channelId) || channelId <= 0 || !modelName || !source || !status || !recordedAt) {
    return null;
  }
  return {
    channelId: Math.trunc(channelId),
    modelName,
    source,
    status,
    latencyMs: Number.isFinite(Number(raw.latencyMs)) ? Number(raw.latencyMs) : null,
    reason: String(raw.reason || '').trim(),
    recordedAt,
  };
}

function normalizeProtectionSignal(raw: unknown): ProxyOpsProtectionSignal | null {
  if (!isRecord(raw)) return null;
  const className = String(raw.className || '').trim() as ProxyFailureClass;
  const title = String(raw.title || '').trim();
  const recordedAt = normalizeIso(raw.recordedAt);
  if (!className || !title || !recordedAt) return null;
  return {
    className,
    title,
    summary: String(raw.summary || '').trim(),
    status: Number.isFinite(Number(raw.status)) ? Number(raw.status) : null,
    recordedAt,
  };
}

function normalizeModelProbeSummary(raw: unknown): ProxyOpsModelProbeSummary | null {
  if (!isRecord(raw)) return null;
  const lastProbeAt = normalizeIso(raw.lastProbeAt);
  const status = ['success', 'failed', 'skipped'].includes(String(raw.status || ''))
    ? String(raw.status) as ProxyOpsModelProbeSummary['status']
    : null;
  if (!lastProbeAt || !status) return null;
  return {
    lastProbeAt,
    scanned: Math.max(0, Math.trunc(Number(raw.scanned) || 0)),
    supported: Math.max(0, Math.trunc(Number(raw.supported) || 0)),
    unsupported: Math.max(0, Math.trunc(Number(raw.unsupported) || 0)),
    inconclusive: Math.max(0, Math.trunc(Number(raw.inconclusive) || 0)),
    skipped: Math.max(0, Math.trunc(Number(raw.skipped) || 0)),
    updatedRows: Math.max(0, Math.trunc(Number(raw.updatedRows) || 0)),
    status,
    message: String(raw.message || '').trim(),
  };
}

function normalizeRefreshSignal(raw: unknown): ProxyOpsRefreshSignal | null {
  if (!isRecord(raw)) return null;
  const lastRefreshAt = normalizeIso(raw.lastRefreshAt);
  const status = raw.status === 'success' ? 'success' : raw.status === 'failed' ? 'failed' : null;
  if (!lastRefreshAt || !status) return null;
  return {
    lastRefreshAt,
    status,
    message: String(raw.message || '').trim(),
  };
}

export function getProxyOpsState(extraConfig?: string | Record<string, unknown> | null): ProxyOpsState {
  const parsed = parseExtraConfig(extraConfig);
  const rawProxyOps = isRecord(parsed.proxyOps) ? parsed.proxyOps : {};
  const rawRecoverySignals = Array.isArray(rawProxyOps.recoverySignals) ? rawProxyOps.recoverySignals : [];
  const rawProtectionSignals = Array.isArray(rawProxyOps.protectionSignals) ? rawProxyOps.protectionSignals : [];
  return {
    recoverySignals: rawRecoverySignals.map(normalizeRecoverySignal).filter((item): item is ProxyOpsRecoverySignal => !!item),
    protectionSignals: rawProtectionSignals.map(normalizeProtectionSignal).filter((item): item is ProxyOpsProtectionSignal => !!item),
    modelProbe: normalizeModelProbeSummary(rawProxyOps.modelProbe),
    refresh: normalizeRefreshSignal(rawProxyOps.refresh),
  };
}

async function mutateProxyOpsState<T>(
  accountId: number,
  mutate: (current: ProxyOpsState) => T,
  buildNextState: (current: ProxyOpsState, mutation: T) => ProxyOpsState,
): Promise<void> {
  await mergeAccountExtraConfigWithRetry(accountId, async (currentExtraConfig) => {
    const current = getProxyOpsState(currentExtraConfig);
    const mutation = mutate(current);
    return {
      patch: {
        proxyOps: buildNextState(current, mutation),
      },
      result: mutation,
    };
  });
}

export async function recordProxyOpsRecoverySignal(accountId: number, signal: Omit<ProxyOpsRecoverySignal, 'recordedAt'> & { recordedAt?: string }): Promise<void> {
  const nextSignal: ProxyOpsRecoverySignal = {
    ...signal,
    recordedAt: normalizeIso(signal.recordedAt) || new Date().toISOString(),
  };
  await mutateProxyOpsState(accountId, (current) => {
    const dedupeKey = `${nextSignal.channelId}:${nextSignal.modelName.toLowerCase()}`;
    return [nextSignal, ...(current.recoverySignals || []).filter((item) => `${item.channelId}:${item.modelName.toLowerCase()}` !== dedupeKey)]
      .slice(0, MAX_RECOVERY_SIGNALS);
  }, (current, nextSignals) => ({
    ...current,
    recoverySignals: nextSignals,
  }));
}

export async function recordProxyOpsProtectionSignal(accountId: number, signal: Omit<ProxyOpsProtectionSignal, 'recordedAt'> & { recordedAt?: string }): Promise<void> {
  const nextSignal: ProxyOpsProtectionSignal = {
    ...signal,
    recordedAt: normalizeIso(signal.recordedAt) || new Date().toISOString(),
  };
  await mutateProxyOpsState(accountId, (current) => [nextSignal, ...(current.protectionSignals || []).slice(0, MAX_PROTECTION_SIGNALS - 1)], (current, nextSignals) => ({
    ...current,
    protectionSignals: nextSignals,
  }));
}

export async function recordProxyOpsModelProbeSummary(accountId: number, summary: ProxyOpsModelProbeSummary): Promise<void> {
  await mutateProxyOpsState(accountId, () => ({
    ...summary,
    lastProbeAt: normalizeIso(summary.lastProbeAt) || new Date().toISOString(),
  }), (current, nextModelProbe) => ({
    ...current,
    modelProbe: nextModelProbe,
  }));
}

export async function recordProxyOpsRefreshSignal(accountId: number, signal: ProxyOpsRefreshSignal): Promise<void> {
  await mutateProxyOpsState(accountId, () => ({
    ...signal,
    lastRefreshAt: normalizeIso(signal.lastRefreshAt) || new Date().toISOString(),
  }), (current, nextRefresh) => ({
    ...current,
    refresh: nextRefresh,
  }));
}
