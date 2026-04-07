import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type AccountProbeChatResponse } from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import { useAnimatedVisibility } from '../../components/useAnimatedVisibility.js';
import { useIsMobile } from '../../components/useIsMobile.js';

type AccountProbeModalProps = {
  open: boolean;
  account: {
    id: number;
    username?: string | null;
    site?: { name?: string | null } | null;
  } | null;
  onClose: () => void;
};

type AccountModelOption = {
  name: string;
  disabled?: boolean;
  latencyMs?: number | null;
};

function resolveAccountName(account: AccountProbeModalProps['account']): string {
  const username = typeof account?.username === 'string' ? account.username.trim() : '';
  return username || '连接';
}

function formatLatency(latencyMs: number | null | undefined): string {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs <= 0) return '';
  return `${Math.round(latencyMs)}ms`;
}

export default function AccountProbeModal({
  open,
  account,
  onClose,
}: AccountProbeModalProps) {
  const isMobile = useIsMobile();
  const presence = useAnimatedVisibility(open, 220);
  const canUsePortal = typeof document !== 'undefined'
    && !!document.body
    && typeof document.body.appendChild === 'function'
    && typeof document.body.removeChild === 'function';
  const requestSeqRef = useRef(0);
  const resultCardRef = useRef<HTMLDivElement | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [models, setModels] = useState<AccountModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [loadError, setLoadError] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<AccountProbeChatResponse | null>(null);

  useEffect(() => {
    if (!open || !account) return;

    const requestId = ++requestSeqRef.current;
    setLoadingModels(true);
    setLoadError('');
    setProbeResult(null);
    setProbing(false);
    setModels([]);
    setSelectedModel('');

    void api.getAccountModels(account.id)
      .then((result) => {
        if (requestSeqRef.current !== requestId) return;
        const nextModels: AccountModelOption[] = Array.isArray(result?.models)
          ? result.models.filter((item: any) => typeof item?.name === 'string' && item.name.trim().length > 0)
          : [];
        setModels(nextModels);
        const firstEnabled = nextModels.find((item) => !item.disabled)?.name || nextModels[0]?.name || '';
        setSelectedModel(firstEnabled);
      })
      .catch((error: any) => {
        if (requestSeqRef.current !== requestId) return;
        setLoadError(error?.message || '加载模型列表失败');
      })
      .finally(() => {
        if (requestSeqRef.current !== requestId) return;
        setLoadingModels(false);
      });
  }, [account, open]);

  useEffect(() => {
    if (open) return;
    requestSeqRef.current += 1;
    setLoadingModels(false);
    setProbeResult(null);
    setProbing(false);
    setLoadError('');
  }, [open]);

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

  useEffect(() => {
    if (!probeResult) return;
    const resultNode = resultCardRef.current;
    if (!resultNode || typeof resultNode.scrollIntoView !== 'function') return;

    const timer = setTimeout(() => {
      resultNode.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }, 32);

    return () => {
      clearTimeout(timer);
    };
  }, [probeResult]);

  const currentModelMeta = useMemo(
    () => models.find((item) => item.name === selectedModel) || null,
    [models, selectedModel],
  );

  const handleStart = async () => {
    if (!account || !selectedModel || probing) return;
    setProbing(true);
    setProbeResult(null);
    try {
      const result = await api.probeAccountChat(account.id, { model: selectedModel });
      setProbeResult(result);
    } catch (error: any) {
      setProbeResult({
        success: false,
        statusText: '测活失败',
        errorMessage: error?.message || '测活失败',
        latencyMs: null,
        model: selectedModel,
      });
    } finally {
      setProbing(false);
    }
  };

  const modalTitle = account?.site?.name
    ? `连接测活 · ${account.site.name}`
    : '连接测活';

  const content = (
    <div className="account-probe-layout" data-testid="account-probe-modal">
      <div className="account-probe-summary">
        <div className="account-probe-summary-title">{resolveAccountName(account)}</div>
        <div className="account-probe-summary-text">
          选择一个模型，发送一条 <strong>hi</strong> 做真实测活。
        </div>
      </div>

      <div className="account-probe-field">
        <div className="account-probe-field-label">测活模型</div>
        {loadingModels ? (
          <div className="account-probe-state-card">
            <span className="spinner spinner-sm" />
            <span>加载模型列表...</span>
          </div>
        ) : loadError ? (
          <div className="account-probe-result-card is-error">
            <span className="account-probe-status-pill is-error">加载失败</span>
            <div className="account-probe-result-text">{loadError}</div>
          </div>
        ) : models.length === 0 ? (
          <div className="account-probe-result-card is-muted">
            <span className="account-probe-status-pill is-muted">暂无模型</span>
            <div className="account-probe-result-text">当前连接还没有可选模型，请先在「模型」里同步或补录模型。</div>
          </div>
        ) : (
          <>
            <select
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              className="account-probe-select"
              disabled={probing}
              data-testid="account-probe-model-select"
            >
              {models.map((item) => (
                <option key={item.name} value={item.name} disabled={item.disabled}>
                  {item.name}{item.disabled ? '（已禁用）' : ''}
                </option>
              ))}
            </select>
            <div className="account-probe-hint">
              {currentModelMeta?.disabled
                ? '该模型当前处于禁用状态，建议先启用后再测活。'
                : (formatLatency(currentModelMeta?.latencyMs) ? `最近探测延迟：${formatLatency(currentModelMeta?.latencyMs)}` : '将发送固定消息 hi，校验是否能正常返回内容。')}
            </div>
          </>
        )}
      </div>

      {probing ? (
        <div className="account-probe-state-card is-running">
          <span className="spinner" />
          <div>
            <div className="account-probe-state-title">正在测活...</div>
            <div className="account-probe-state-text">正在等待模型返回具体内容</div>
          </div>
        </div>
      ) : null}

      {probeResult ? (
        <div
          ref={resultCardRef}
          className={`account-probe-result-card ${probeResult.success ? 'is-success' : 'is-error'}`.trim()}
        >
          <div className="account-probe-result-head">
            <span className={`account-probe-status-pill ${probeResult.success ? 'is-success' : 'is-error'}`.trim()}>
              {probeResult.statusText}
            </span>
            {probeResult.latencyMs != null ? (
              <span className="account-probe-meta">{Math.round(probeResult.latencyMs)}ms</span>
            ) : null}
          </div>
          <div className="account-probe-result-text">
            {probeResult.success ? '返回内容' : '失败原因'}
          </div>
          <div className="account-probe-reply">
            {probeResult.success ? probeResult.replyText : probeResult.errorMessage}
          </div>
        </div>
      ) : null}
    </div>
  );

  const footer = (
    <div className="account-probe-actions">
      <button type="button" onClick={onClose} className="btn btn-ghost">关闭</button>
      <button
        type="button"
        onClick={() => void handleStart()}
        disabled={loadingModels || probing || !selectedModel || !!currentModelMeta?.disabled}
        className="btn btn-primary"
        data-testid="account-probe-start"
      >
        {probing ? <><span className="spinner spinner-sm" />测活中...</> : '开始测活'}
      </button>
    </div>
  );

  if (!isMobile) {
    return (
      <CenteredModal
        open={open}
        onClose={onClose}
        title={modalTitle}
        maxWidth={560}
        bodyStyle={{ maxHeight: 'min(72vh, 640px)', overflowY: 'auto' }}
        footer={footer}
      >
        {content}
      </CenteredModal>
    );
  }

  if (!presence.shouldRender) return null;

  const sheet = (
    <div
      className={`account-probe-sheet-backdrop ${presence.isVisible ? '' : 'is-closing'}`.trim()}
      onClick={onClose}
      data-testid="account-probe-sheet"
    >
      <div
        className={`account-probe-sheet-content ${presence.isVisible ? '' : 'is-closing'}`.trim()}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={modalTitle}
      >
        <div className="account-probe-sheet-handle" />
        <div className="account-probe-sheet-header">
          <div>
            <div className="account-probe-sheet-title">{modalTitle}</div>
            <div className="account-probe-sheet-subtitle">真实发送 hi，查看模型直接回复</div>
          </div>
          <button type="button" className="account-probe-sheet-close" onClick={onClose} aria-label="关闭测活弹窗">×</button>
        </div>
        <div className="account-probe-sheet-body">
          {content}
        </div>
        <div className="account-probe-sheet-footer">
          {footer}
        </div>
      </div>
    </div>
  );

  return canUsePortal ? createPortal(sheet, document.body) : sheet;
}
