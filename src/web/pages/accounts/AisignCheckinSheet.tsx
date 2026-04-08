import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { AisignTierOption } from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import { useAnimatedVisibility } from '../../components/useAnimatedVisibility.js';
import { useIsMobile } from '../../components/useIsMobile.js';

type AisignCheckinSheetProps = {
  open: boolean;
  accountLabel: string;
  siteLabel?: string | null;
  tierOptions: AisignTierOption[];
  selectedTierId: number | null;
  running?: boolean;
  onSelectTier: (tierId: number) => void;
  onConfirm: () => void;
  onClose: () => void;
};

function formatRewardRange(tier: AisignTierOption): string {
  const min = tier.rewardMin;
  const max = tier.rewardMax;
  if (min == null && max == null) return '奖励区间待同步';
  if (min != null && max != null) return `${min} ~ ${max}`;
  return `${min ?? max}`;
}

function formatSeconds(value: number | null): string {
  if (value == null || value <= 0) return '--';
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function buildTitle(accountLabel: string, siteLabel?: string | null): string {
  return siteLabel ? `签到难度 · ${siteLabel}` : `签到难度 · ${accountLabel}`;
}

export default function AisignCheckinSheet({
  open,
  accountLabel,
  siteLabel,
  tierOptions,
  selectedTierId,
  running = false,
  onSelectTier,
  onConfirm,
  onClose,
}: AisignCheckinSheetProps) {
  const isMobile = useIsMobile();
  const presence = useAnimatedVisibility(open, 220);
  const canUsePortal = typeof document !== 'undefined'
    && !!document.body
    && typeof document.body.appendChild === 'function'
    && typeof document.body.removeChild === 'function';

  useEffect(() => {
    if (!open || !isMobile || !canUsePortal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [canUsePortal, isMobile, open]);

  useEffect(() => {
    if (!open || !isMobile || !canUsePortal) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [canUsePortal, isMobile, onClose, open]);

  const title = buildTitle(accountLabel, siteLabel);
  const selectedTier = tierOptions.find((tier) => tier.id === selectedTierId) || null;
  const content = (
    <div className="aisign-checkin-layout">
      <div className="aisign-checkin-summary-card">
        <div className="aisign-checkin-summary-title">{accountLabel}</div>
        <div className="aisign-checkin-summary-text">
          {running
            ? `正在按「${selectedTier?.name || '已选难度'}」执行签到。关闭弹窗后后台继续。`
            : '选择签到档位后立即走后台自动签到，不再打开外部页面。'}
        </div>
      </div>

      {tierOptions.length > 0 ? (
        <div className="aisign-checkin-tier-grid">
          {tierOptions.map((tier) => {
            const selected = tier.id === selectedTierId;
            return (
              <button
                key={tier.id}
                type="button"
                className={`aisign-checkin-tier-card ${selected ? 'is-selected' : ''}`.trim()}
                onClick={() => onSelectTier(tier.id)}
                aria-pressed={selected}
                disabled={running}
                data-testid={`aisign-tier-option-${tier.id}`}
              >
                <div className="aisign-checkin-tier-head">
                  <span className="aisign-checkin-tier-name">{tier.name}</span>
                  <span className={`aisign-checkin-tier-badge ${selected ? 'is-selected' : ''}`.trim()}>
                    {selected ? '已选' : `#${tier.id}`}
                  </span>
                </div>
                <div className="aisign-checkin-tier-range">奖励 {formatRewardRange(tier)}</div>
                <div className="aisign-checkin-tier-meta">
                  <span>前缀 0 位数 {tier.difficulty ?? '--'}</span>
                  <span>目标 {formatSeconds(tier.targetSeconds)}</span>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="aisign-checkin-state-card">
          当前未拿到可用档位，请稍后再试。
        </div>
      )}

      <div className={`aisign-checkin-state-card ${running ? 'is-running' : ''}`.trim()}>
        {running ? <span className="spinner spinner-sm" /> : null}
        <div>
          <div className="aisign-checkin-state-title">{running ? '后台签到中' : '推荐默认档位：挑战'}</div>
          <div className="aisign-checkin-state-text">
            {running
              ? '请求已经发出，可以留在这里等完成，也可以直接关闭。'
              : '默认会优先选中「挑战」，更贴近原站点常用操作。'}
          </div>
        </div>
      </div>
    </div>
  );

  const footer = (
    <div className="aisign-checkin-actions">
      <button type="button" onClick={onClose} className="btn btn-ghost">
        {running ? '关闭（后台继续）' : '关闭'}
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={running || !selectedTierId || tierOptions.length <= 0}
        className="btn btn-primary"
        data-testid="aisign-checkin-confirm"
      >
        {running ? <><span className="spinner spinner-sm" />签到中...</> : '开始签到'}
      </button>
    </div>
  );

  if (!isMobile) {
    return (
      <CenteredModal
        open={open}
        onClose={onClose}
        title={title}
        maxWidth={480}
        bodyStyle={{ maxHeight: 'min(64vh, 520px)', overflowY: 'auto' }}
        footer={footer}
      >
        {content}
      </CenteredModal>
    );
  }

  if (!presence.shouldRender) return null;

  const sheet = (
    <div
      className={`aisign-checkin-sheet-backdrop ${presence.isVisible ? '' : 'is-closing'}`.trim()}
      onClick={onClose}
      data-testid="aisign-checkin-sheet"
    >
      <div
        className={`aisign-checkin-sheet-content ${presence.isVisible ? '' : 'is-closing'}`.trim()}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="aisign-checkin-sheet-handle" />
        <div className="aisign-checkin-sheet-header">
          <div>
            <div className="aisign-checkin-sheet-title">{title}</div>
            <div className="aisign-checkin-sheet-subtitle">紧凑半屏 · 四档一屏可选</div>
          </div>
          <button type="button" className="aisign-checkin-sheet-close" onClick={onClose} aria-label="关闭 aisign 签到弹窗">×</button>
        </div>
        <div className="aisign-checkin-sheet-body">
          {content}
        </div>
        <div className="aisign-checkin-sheet-footer">
          {footer}
        </div>
      </div>
    </div>
  );

  return canUsePortal ? createPortal(sheet, document.body) : sheet;
}
