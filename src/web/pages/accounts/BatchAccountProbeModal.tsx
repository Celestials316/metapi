import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  api,
  type BatchAccountProbeDoneSummary,
  type BatchAccountProbeResultItem,
} from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import { useAnimatedVisibility } from '../../components/useAnimatedVisibility.js';
import { useIsMobile } from '../../components/useIsMobile.js';

type ProbeScope = 'segment' | 'all';
type BatchProbeCandidate = {
  id: number;
  username?: string | null;
  status?: string | null;
  site?: { name?: string | null } | null;
};
type BatchProbeModelOption = {
  name: string;
  count: number;
};

type BatchAccountProbeModalProps = {
  open: boolean;
  activeSegment: 'session' | 'apikey' | 'tokens';
  segmentAccounts: BatchProbeCandidate[];
  allAccounts: BatchProbeCandidate[];
  onClose: () => void;
};

type ProbePhase = 'config' | 'running' | 'done';
type ProbeSummary = {
  success: number;
  failed: number;
  skipped: number;
  pending: number;
};

function resolveScopeLabel(scope: ProbeScope, activeSegment: BatchAccountProbeModalProps['activeSegment']): string {
  if (scope === 'all') return '全部分段';
  return activeSegment === 'apikey' ? '当前分段 · API Key 管理' : '当前分段 · 账号管理';
}

function resolveStatusLabel(status: BatchAccountProbeResultItem['status']): string {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'skipped_disabled') return '未启用';
  return '无模型';
}

function resolveStatusClass(status: BatchAccountProbeResultItem['status']): string {
  if (status === 'success') return 'is-success';
  if (status === 'failed') return 'is-error';
  return 'is-muted';
}

function buildInitialSummary(): ProbeSummary {
  return {
    success: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
  };
}

function formatLatency(latencyMs: number | null | undefined): string {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs <= 0) return '';
  return `${Math.round(latencyMs)}ms`;
}

function buildBatchProbeModelOptions(results: unknown[]): BatchProbeModelOption[] {
  const counts = new Map<string, number>();

  for (const result of results) {
    const models = Array.isArray((result as any)?.models) ? (result as any).models : [];
    for (const item of models) {
      const modelName = typeof item?.name === 'string' ? item.name.trim() : '';
      if (!modelName || item?.disabled) continue;
      counts.set(modelName, (counts.get(modelName) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function summarizeResult(summary: ProbeSummary, result: BatchAccountProbeResultItem): ProbeSummary {
  const next = {
    ...summary,
    pending: Math.max(0, summary.pending - 1),
  };
  if (result.status === 'success') next.success += 1;
  else if (result.status === 'failed') next.failed += 1;
  else next.skipped += 1;
  return next;
}

export default function BatchAccountProbeModal({
  open,
  activeSegment,
  segmentAccounts,
  allAccounts,
  onClose,
}: BatchAccountProbeModalProps) {
  const isMobile = useIsMobile();
  const presence = useAnimatedVisibility(open, 220);
  const canUsePortal = typeof document !== 'undefined'
    && !!document.body
    && typeof document.body.appendChild === 'function'
    && typeof document.body.removeChild === 'function';
  const abortControllerRef = useRef<AbortController | null>(null);
  const modelRequestSeqRef = useRef(0);
  const [scope, setScope] = useState<ProbeScope>('segment');
  const [preferredModel, setPreferredModel] = useState('');
  const [modelOptions, setModelOptions] = useState<BatchProbeModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelLoadError, setModelLoadError] = useState('');
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [concurrency, setConcurrency] = useState<3 | 4 | 5>(4);
  const [phase, setPhase] = useState<ProbePhase>('config');
  const [running, setRunning] = useState(false);
  const [aborted, setAborted] = useState(false);
  const [items, setItems] = useState<BatchAccountProbeResultItem[]>([]);
  const [summary, setSummary] = useState<ProbeSummary>(buildInitialSummary);
  const [streamError, setStreamError] = useState('');
  const [doneSummary, setDoneSummary] = useState<BatchAccountProbeDoneSummary | null>(null);

  const targetAccounts = useMemo(() => (
    scope === 'all' ? allAccounts : segmentAccounts
  ), [allAccounts, scope, segmentAccounts]);
  const targetAccountIds = useMemo(() => Array.from(new Set(
    targetAccounts
      .map((account) => Number.parseInt(String(account.id), 10))
      .filter((accountId) => Number.isFinite(accountId) && accountId > 0),
  )), [targetAccounts]);

  useEffect(() => {
    if (open) return;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    modelRequestSeqRef.current += 1;
    setScope('segment');
    setPreferredModel('');
    setModelOptions([]);
    setLoadingModels(false);
    setModelLoadError('');
    setIncludeDisabled(false);
    setConcurrency(4);
    setPhase('config');
    setRunning(false);
    setAborted(false);
    setItems([]);
    setSummary(buildInitialSummary());
    setStreamError('');
    setDoneSummary(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const requestId = ++modelRequestSeqRef.current;
    setLoadingModels(true);
    setModelLoadError('');
    setModelOptions([]);

    if (targetAccountIds.length <= 0) {
      setPreferredModel('');
      setLoadingModels(false);
      return;
    }

    void Promise.allSettled(targetAccountIds.map((accountId) => api.getAccountModels(accountId)))
      .then((results) => {
        if (modelRequestSeqRef.current !== requestId) return;

        const fulfilled = results
          .filter((result): result is PromiseFulfilledResult<unknown> => result.status === 'fulfilled')
          .map((result) => result.value);
        const options = buildBatchProbeModelOptions(fulfilled);

        setModelOptions(options);
        setPreferredModel((current) => (
          options.some((item) => item.name === current)
            ? current
            : (options[0]?.name || '')
        ));

        if (options.length === 0 && fulfilled.length === 0) {
          const firstRejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          setModelLoadError(firstRejected?.reason?.message || '加载模型列表失败');
          return;
        }

        setModelLoadError('');
      })
      .catch((error: any) => {
        if (modelRequestSeqRef.current !== requestId) return;
        setModelOptions([]);
        setPreferredModel('');
        setModelLoadError(error?.message || '加载模型列表失败');
      })
      .finally(() => {
        if (modelRequestSeqRef.current !== requestId) return;
        setLoadingModels(false);
      });
  }, [open, targetAccountIds]);

  useEffect(() => {
    if (!isMobile || !open || !canUsePortal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [canUsePortal, isMobile, open]);

  useEffect(() => {
    if (!isMobile || !open || !canUsePortal) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [canUsePortal, isMobile, onClose, open]);

  const handleStop = () => {
    setAborted(true);
    setRunning(false);
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  };

  const handleStart = async () => {
    if (running) return;
    const normalizedModel = preferredModel.trim();
    if (!normalizedModel || targetAccountIds.length <= 0) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setPhase('running');
    setRunning(true);
    setAborted(false);
    setItems([]);
    setSummary(buildInitialSummary());
    setStreamError('');
    setDoneSummary(null);

    try {
      await api.streamBatchAccountProbe({
        accountIds: targetAccountIds,
        preferredModel: normalizedModel,
        includeDisabled,
        concurrency,
      }, {
        signal: controller.signal,
        onStart: (payload) => {
          setSummary({
            success: 0,
            failed: 0,
            skipped: 0,
            pending: payload.scheduledAccounts,
          });
        },
        onResult: (payload) => {
          setItems((current) => [payload, ...current]);
          setSummary((current) => summarizeResult(current, payload));
        },
        onDone: (payload) => {
          setDoneSummary(payload);
          if (payload.errorMessage) setStreamError(payload.errorMessage);
          setRunning(false);
          setPhase('done');
          setSummary((current) => ({
            ...current,
            pending: Math.max(0, payload.scheduledAccounts - payload.completedAccounts),
          }));
        },
      });
    } catch (error: any) {
      if (controller.signal.aborted) {
        setAborted(true);
        setPhase('done');
        setRunning(false);
      } else {
        setStreamError(error?.message || '批量测活连接中断');
        setPhase('done');
        setRunning(false);
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  const configContent = (
    <div className="batch-account-probe-layout" data-testid="batch-account-probe-modal">
      <div className="batch-account-probe-summary-card">
        <div className="batch-account-probe-summary-title">全部测活</div>
        <div className="batch-account-probe-summary-text">
          真实发送一条 <strong>hi</strong>，返回一个显示一个，适合快速判断当前连接整体可用性。
        </div>
      </div>

      <div className="batch-account-probe-field-group">
        <div className="batch-account-probe-field-label">测活范围</div>
        <div className="batch-account-probe-choice-row">
          <button
            type="button"
            className={`batch-account-probe-choice ${scope === 'segment' ? 'is-active' : ''}`.trim()}
            onClick={() => setScope('segment')}
          >
            当前分段
          </button>
          <button
            type="button"
            className={`batch-account-probe-choice ${scope === 'all' ? 'is-active' : ''}`.trim()}
            onClick={() => setScope('all')}
          >
            全部分段
          </button>
        </div>
        <div className="batch-account-probe-hint-text">
          {resolveScopeLabel(scope, activeSegment)} · 共 {targetAccountIds.length} 条连接
        </div>
      </div>

      <div className="batch-account-probe-field-group">
        <div className="batch-account-probe-field-label">默认测活模型</div>
        {loadingModels ? (
          <div className="batch-account-probe-model-state" data-testid="batch-probe-model-loading">加载模型列表...</div>
        ) : modelLoadError ? (
          <div className="batch-account-probe-model-state is-error" data-testid="batch-probe-model-error">{modelLoadError}</div>
        ) : modelOptions.length === 0 ? (
          <div className="batch-account-probe-model-state" data-testid="batch-probe-model-empty">当前范围没有可选模型，请先同步模型。</div>
        ) : (
          <select
            value={preferredModel}
            onChange={(event) => setPreferredModel(event.target.value)}
            className="batch-account-probe-select"
            data-testid="batch-probe-model-select"
          >
            {modelOptions.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        <div className="batch-account-probe-hint-text">
          {modelOptions.length > 0
            ? `已汇总 ${modelOptions.length} 个可用模型，没有该模型时会自动回退到该连接第一个可用且未禁用模型。`
            : '没有该模型时，自动回退到该连接第一个可用且未禁用模型。'}
        </div>
      </div>

      <div className="batch-account-probe-config-grid">
        <div className="batch-account-probe-field-group">
          <div className="batch-account-probe-field-label">并发数</div>
          <div className="batch-account-probe-choice-row compact">
            {[3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                className={`batch-account-probe-choice compact ${concurrency === value ? 'is-active' : ''}`.trim()}
                onClick={() => setConcurrency(value as 3 | 4 | 5)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="batch-account-probe-field-group">
          <div className="batch-account-probe-field-label">未启用连接</div>
          <label className="batch-account-probe-toggle">
            <input
              type="checkbox"
              checked={includeDisabled}
              onChange={(event) => setIncludeDisabled(event.target.checked)}
            />
            <span>显示未启用（不发请求）</span>
          </label>
        </div>
      </div>
    </div>
  );

  const resultContent = (
    <div className="batch-account-probe-layout" data-testid="batch-account-probe-results">
      <div className="batch-account-probe-result-header">
        <div>
          <div className="batch-account-probe-summary-title">测活结果</div>
          <div className="batch-account-probe-summary-text">
            {running
              ? '正在实时返回测活结果'
              : (aborted ? '已停止，本次已返回的结果已保留' : '本次测活已结束')}
          </div>
        </div>
        <div className="batch-account-probe-progress-text">
          {summary.success + summary.failed + summary.skipped}/{doneSummary?.scheduledAccounts ?? (summary.success + summary.failed + summary.skipped + summary.pending)}
        </div>
      </div>

      <div className="batch-account-probe-stat-grid">
        <div className="batch-account-probe-stat-card"><span>成功</span><strong>{summary.success}</strong></div>
        <div className="batch-account-probe-stat-card"><span>失败</span><strong>{summary.failed}</strong></div>
        <div className="batch-account-probe-stat-card"><span>跳过</span><strong>{summary.skipped}</strong></div>
        <div className="batch-account-probe-stat-card"><span>等待</span><strong>{summary.pending}</strong></div>
      </div>

      {streamError ? (
        <div className="batch-account-probe-banner is-error">{streamError}</div>
      ) : null}
      {aborted ? (
        <div className="batch-account-probe-banner is-muted">已手动停止，已返回结果仍保留。</div>
      ) : null}

      <div className="batch-account-probe-result-list">
        {items.length > 0 ? items.map((item) => (
          <div
            key={`${item.accountId}-${item.status}-${item.model || 'none'}-${item.message}`}
            className={`batch-account-probe-result-row ${resolveStatusClass(item.status)}`.trim()}
          >
            <div className="batch-account-probe-result-line">
              <div className="batch-account-probe-result-title">{item.accountName}</div>
              <div className="batch-account-probe-result-meta">
                {item.siteName ? <span>{item.siteName}</span> : null}
                {formatLatency(item.latencyMs) ? <span>{formatLatency(item.latencyMs)}</span> : null}
                <span className={`batch-account-probe-status-pill ${resolveStatusClass(item.status)}`.trim()}>{resolveStatusLabel(item.status)}</span>
              </div>
            </div>
            {item.model ? (
              <div className="batch-account-probe-result-subline">
                {item.model}{item.usedFallbackModel ? ' · 已回退' : ''}
              </div>
            ) : null}
            <div className="batch-account-probe-result-message">{item.message}</div>
          </div>
        )) : (
          <div className="batch-account-probe-empty">还没有结果返回。</div>
        )}
      </div>
    </div>
  );

  const footer = phase === 'config' ? (
    <div className="batch-account-probe-actions">
      <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={loadingModels || !preferredModel.trim() || targetAccountIds.length <= 0}
        onClick={handleStart}
      >
        开始测活
      </button>
    </div>
  ) : (
    <div className="batch-account-probe-actions">
      <button type="button" className="btn btn-ghost" onClick={onClose}>关闭</button>
      {running ? (
        <button type="button" className="btn btn-primary" onClick={handleStop}>停止</button>
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => {
          setPhase('config');
          setItems([]);
          setSummary(buildInitialSummary());
          setStreamError('');
          setDoneSummary(null);
          setAborted(false);
        }}>重新测活</button>
      )}
    </div>
  );

  const modalTitle = phase === 'config' ? '全部测活' : '测活结果';
  const content = phase === 'config' ? configContent : resultContent;

  if (!isMobile) {
    return (
      <CenteredModal
        open={open}
        onClose={onClose}
        title={modalTitle}
        maxWidth={640}
        bodyStyle={{ maxHeight: 'min(78vh, 760px)', overflowY: 'auto' }}
        footer={footer}
      >
        {content}
      </CenteredModal>
    );
  }

  if (!presence.shouldRender) return null;

  const sheet = (
    <div
      className={`batch-account-probe-sheet-backdrop ${presence.isVisible ? '' : 'is-closing'}`.trim()}
      onClick={onClose}
      data-testid="batch-account-probe-sheet"
    >
      <div
        className={`batch-account-probe-sheet-content ${presence.isVisible ? '' : 'is-closing'}`.trim()}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={modalTitle}
      >
        <div className="batch-account-probe-sheet-handle" />
        <div className="batch-account-probe-sheet-header">
          <div>
            <div className="batch-account-probe-sheet-title">{modalTitle}</div>
            <div className="batch-account-probe-sheet-subtitle">{phase === 'config' ? '批量真实测活' : '实时更新结果'}</div>
          </div>
          <button type="button" className="batch-account-probe-sheet-close" onClick={onClose} aria-label="关闭批量测活弹窗">×</button>
        </div>
        <div className="batch-account-probe-sheet-body">{content}</div>
        <div className="batch-account-probe-sheet-footer">{footer}</div>
      </div>
    </div>
  );

  return canUsePortal ? createPortal(sheet, document.body) : sheet;
}
