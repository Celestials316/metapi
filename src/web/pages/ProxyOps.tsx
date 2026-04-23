import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ProxyOpsAccountSnapshot, type ProxyOpsSnapshot } from '../api.js';
import { useToast } from '../components/Toast.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';

const pageStyle: React.CSSProperties = {
  display: 'grid',
  gap: 16,
};
const heroStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  padding: 18,
  border: '1px solid var(--color-border-light)',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--color-bg-card)',
};
const gridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
};
const metricCardStyle: React.CSSProperties = {
  padding: 14,
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-border-light)',
  background: 'var(--color-bg-card)',
  display: 'grid',
  gap: 6,
};
const sectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  padding: 16,
  border: '1px solid var(--color-border-light)',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--color-bg-card)',
};
const accountCardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  padding: 16,
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-border-light)',
  background: 'color-mix(in srgb, var(--color-bg-card) 92%, var(--color-bg) 8%)',
};
const badgeBaseStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 700,
};
const actionButtonStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-card)',
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
  fontWeight: 600,
};

function statusBadgeStyle(kind: 'good' | 'warn' | 'bad' | 'muted'): React.CSSProperties {
  if (kind === 'good') {
    return {
      ...badgeBaseStyle,
      color: 'var(--color-success)',
      background: 'color-mix(in srgb, var(--color-success) 14%, transparent)',
      border: '1px solid color-mix(in srgb, var(--color-success) 30%, transparent)',
    };
  }
  if (kind === 'warn') {
    return {
      ...badgeBaseStyle,
      color: 'var(--color-warning)',
      background: 'color-mix(in srgb, var(--color-warning) 14%, transparent)',
      border: '1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)',
    };
  }
  if (kind === 'bad') {
    return {
      ...badgeBaseStyle,
      color: 'var(--color-danger)',
      background: 'color-mix(in srgb, var(--color-danger) 14%, transparent)',
      border: '1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)',
    };
  }
  return {
    ...badgeBaseStyle,
    color: 'var(--color-text-secondary)',
    background: 'color-mix(in srgb, var(--color-text-secondary) 10%, transparent)',
    border: '1px solid var(--color-border-light)',
  };
}

function scoreKind(score: number): 'good' | 'warn' | 'bad' {
  if (score >= 85) return 'good';
  if (score >= 60) return 'warn';
  return 'bad';
}

function formatWhen(value?: string | null) {
  if (!value) return '-';
  return formatDateTimeLocal(value) || value;
}

function formatPercent(value: number) {
  return `${Number.isFinite(value) ? value.toFixed(value >= 100 || Number.isInteger(value) ? 0 : 1) : '0'}%`;
}

function padDateTimeSegment(value: number) {
  return String(value).padStart(2, '0');
}

function formatDateTimeInputValue(value: Date) {
  return `${value.getFullYear()}-${padDateTimeSegment(value.getMonth() + 1)}-${padDateTimeSegment(value.getDate())}T${padDateTimeSegment(value.getHours())}:${padDateTimeSegment(value.getMinutes())}`;
}

function buildProxyLogsTarget(params: Record<string, string>) {
  const search = new URLSearchParams(params);
  return `/logs?${search.toString()}`;
}

function buildProxyOpsWindowBounds(generatedAt?: string | null) {
  const parsed = generatedAt ? new Date(generatedAt) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    const fallbackEnd = new Date();
    return {
      from: formatDateTimeInputValue(new Date(fallbackEnd.getTime() - 24 * 60 * 60 * 1000)),
      to: formatDateTimeInputValue(fallbackEnd),
    };
  }
  return {
    from: formatDateTimeInputValue(new Date(parsed.getTime() - 24 * 60 * 60 * 1000)),
    to: formatDateTimeInputValue(parsed),
  };
}

function topFailureLabel(snapshot: ProxyOpsAccountSnapshot): string {
  if (snapshot.failureBuckets.length <= 0) return '无';
  return snapshot.failureBuckets.slice(0, 2).map((item) => `${item.title} × ${item.count}`).join(' · ');
}

function buildFailureLogsTarget(snapshot: ProxyOpsAccountSnapshot, generatedAt?: string | null): string {
  const window = buildProxyOpsWindowBounds(generatedAt);
  const params: Record<string, string> = {
    status: 'failed',
    accountId: String(snapshot.accountId),
    from: window.from,
    to: window.to,
  };
  const failureClass = snapshot.latestFailure?.className || snapshot.failureBuckets[0]?.className || '';
  if (failureClass) {
    params.failureClass = failureClass;
  }
  return buildProxyLogsTarget(params);
}

function buildOverviewLogsTarget(snapshot: ProxyOpsSnapshot | null, key: 'successRate24h' | 'degradedAccounts' | 'challengeAffectedAccounts' | 'coveredFailures24h'): string | null {
  if (!snapshot) return null;
  const window = buildProxyOpsWindowBounds(snapshot.generatedAt);
  if (key === 'successRate24h') {
    return buildProxyLogsTarget({ from: window.from, to: window.to });
  }
  if (key === 'degradedAccounts') {
    return buildProxyLogsTarget({ status: 'failed', from: window.from, to: window.to });
  }
  if (key === 'coveredFailures24h') {
    return buildProxyLogsTarget({ status: 'failed', failureClass: 'covered_failure', from: window.from, to: window.to });
  }
  const challengeBucket = snapshot.failureBuckets24h.find((bucket) => bucket.className.startsWith('challenge_'));
  return challengeBucket
    ? buildProxyLogsTarget({ status: 'failed', failureClass: challengeBucket.className, from: window.from, to: window.to })
    : null;
}

export default function ProxyOps() {
  const toast = useToast();
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<ProxyOpsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getProxyOps({ limit: 100 });
      setSnapshot(data);
      if (expandedId && !data.accounts.some((item) => item.accountId === expandedId)) {
        setExpandedId(null);
      }
    } catch (error: any) {
      toast.error(error?.message || '加载 Proxy Ops 失败');
    } finally {
      setLoading(false);
    }
  }, [expandedId, toast]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const runRecoverySweep = useCallback(async () => {
    setBusy('recovery');
    try {
      await api.triggerProxyOpsRecoverySweep();
      toast.success('已触发恢复扫一轮，正在刷新概览');
      await loadSnapshot();
    } catch (error: any) {
      toast.error(error?.message || '触发恢复扫一轮失败');
    } finally {
      setBusy(null);
    }
  }, [loadSnapshot, toast]);

  const probeAccount = useCallback(async (accountId: number) => {
    setBusy(`probe:${accountId}`);
    try {
      await api.checkModels(accountId);
      toast.success(`已提交账号 #${accountId} 模型探测`);
      setTimeout(() => {
        void loadSnapshot();
      }, 1200);
    } catch (error: any) {
      toast.error(error?.message || `账号 #${accountId} 模型探测失败`);
    } finally {
      setBusy(null);
    }
  }, [loadSnapshot, toast]);

  const overviewCards = useMemo(() => {
    const overview = snapshot?.overview;
    if (!overview) return [];
    return [
      {
        key: 'successRate24h' as const,
        label: '24h 成功率',
        value: formatPercent(overview.successRate24h),
        hint: `${overview.successRequests24h}/${overview.totalRequests24h}`,
        target: buildOverviewLogsTarget(snapshot, 'successRate24h'),
      },
      {
        key: 'degradedAccounts' as const,
        label: '异常账号',
        value: String(overview.degradedAccounts),
        hint: `总账号 ${overview.totalAccounts}`,
        target: buildOverviewLogsTarget(snapshot, 'degradedAccounts'),
      },
      {
        key: 'challengeAffectedAccounts' as const,
        label: '挑战影响账号',
        value: String(overview.challengeAffectedAccounts),
        hint: 'Cloudflare / Turnstile / WAF',
        target: buildOverviewLogsTarget(snapshot, 'challengeAffectedAccounts'),
      },
      {
        key: 'coveredFailures24h' as const,
        label: 'Covered failure',
        value: String(overview.coveredFailures24h),
        hint: '最终成功但中途有失败',
        target: buildOverviewLogsTarget(snapshot, 'coveredFailures24h'),
      },
    ];
  }, [snapshot]);

  return (
    <div style={pageStyle}>
      <div style={heroStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <h1 style={{ margin: 0, fontSize: 24 }}>Proxy Ops</h1>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
              看恢复探测、挑战/WAF、covered failure、模型探测与账号稳态分数。
            </div>
            <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>
              最近生成：{snapshot ? formatWhen(snapshot.generatedAt) : '-'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'start' }}>
            <button type="button" style={actionButtonStyle} onClick={() => void loadSnapshot()} disabled={loading || !!busy}>
              {loading ? '刷新中…' : '刷新概览'}
            </button>
            <button type="button" style={actionButtonStyle} onClick={() => void runRecoverySweep()} disabled={busy === 'recovery'}>
              {busy === 'recovery' ? '执行中…' : '恢复扫一轮'}
            </button>
          </div>
        </div>
        <div style={gridStyle}>
          {overviewCards.map((card) => (
            <button
              key={card.key}
              type="button"
              style={{
                ...metricCardStyle,
                textAlign: 'left',
                cursor: card.target ? 'pointer' : 'default',
              }}
              disabled={!card.target}
              data-testid={`proxy-ops-overview-card-${card.key}`}
              onClick={() => {
                if (card.target) navigate(card.target);
              }}
            >
              <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{card.label}</div>
              <div style={{ fontSize: 28, fontWeight: 800 }}>{card.value}</div>
              <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{card.hint}</div>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {(snapshot?.failureBuckets24h || []).slice(0, 8).map((bucket) => (
            <button
              key={bucket.className}
              type="button"
              style={{
                ...statusBadgeStyle(bucket.className.startsWith('challenge_') ? 'bad' : bucket.count >= 3 ? 'warn' : 'muted'),
                cursor: 'pointer',
              }}
              data-testid={`proxy-ops-failure-bucket-${bucket.className}`}
              onClick={() => navigate(buildProxyLogsTarget({
                status: 'failed',
                failureClass: bucket.className,
                ...buildProxyOpsWindowBounds(snapshot?.generatedAt),
              }))}
            >
              {bucket.title} × {bucket.count}
            </button>
          ))}
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>账号稳态看板</div>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>按风险分数排序，越靠前越需要优先处理。</div>
          </div>
        </div>

        {loading && !snapshot ? (
          <div style={{ color: 'var(--color-text-secondary)' }}>加载中…</div>
        ) : snapshot?.accounts.length ? snapshot.accounts.map((account) => {
          const expanded = expandedId === account.accountId;
          const badgeKind = scoreKind(account.opsScore);
          return (
            <div key={account.accountId} style={accountCardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={statusBadgeStyle(badgeKind)}>稳态分 {account.opsScore}</span>
                    {account.channelHealth.degraded > 0 ? <span style={statusBadgeStyle('warn')}>降级通道 {account.channelHealth.degraded}</span> : <span style={statusBadgeStyle('good')}>通道正常</span>}
                    {account.failureBuckets.some((item) => item.className.startsWith('challenge_')) ? <span style={statusBadgeStyle('bad')}>存在挑战/WAF</span> : null}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>
                    {account.username || `账号 #${account.accountId}`}
                  </div>
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
                    {account.siteName || '未命名站点'} · #{account.accountId}
                    {account.siteUrl ? ` · ${account.siteUrl}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'start' }}>
                  <button type="button" style={actionButtonStyle} onClick={() => setExpandedId(expanded ? null : account.accountId)}>
                    {expanded ? '收起详情' : '展开详情'}
                  </button>
                  <button type="button" style={actionButtonStyle} disabled={busy === `probe:${account.accountId}`} onClick={() => void probeAccount(account.accountId)}>
                    {busy === `probe:${account.accountId}` ? '探测中…' : '探测模型'}
                  </button>
                  <button
                    type="button"
                    style={actionButtonStyle}
                    onClick={() => navigate(buildFailureLogsTarget(account, snapshot?.generatedAt))}
                  >
                    看失败日志
                  </button>
                </div>
              </div>

              <div style={gridStyle}>
                <div style={metricCardStyle}>
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>24h 请求</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{account.proxy24h.total}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>成功率 {formatPercent(account.proxy24h.successRate)}</div>
                </div>
                <div style={metricCardStyle}>
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>covered failure</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{account.proxy24h.retried}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>最终成功但中途失败</div>
                </div>
                <div style={metricCardStyle}>
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>异常分布</div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{topFailureLabel(account)}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>最新失败 {account.latestFailure ? formatWhen(account.latestFailure.recordedAt) : '无'}</div>
                </div>
                <div style={metricCardStyle}>
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>模型探测</div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{account.modelProbe ? `${account.modelProbe.status} · ${account.modelProbe.supported}/${account.modelProbe.scanned}` : '暂无'}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>最近 {formatWhen(account.modelProbe?.lastProbeAt)}</div>
                </div>
              </div>

              {expanded ? (
                <div style={{ display: 'grid', gap: 12 }}>
                  {account.latestFailure ? (
                    <div style={metricCardStyle}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>最近失败</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <span style={statusBadgeStyle(account.latestFailure.className.startsWith('challenge_') ? 'bad' : 'warn')}>
                          {account.latestFailure.title}
                        </span>
                        {account.latestFailure.httpStatus ? <span style={statusBadgeStyle('muted')}>HTTP {account.latestFailure.httpStatus}</span> : null}
                        <span style={statusBadgeStyle('muted')}>{formatWhen(account.latestFailure.recordedAt)}</span>
                      </div>
                      <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>{account.latestFailure.summary || '-'}</div>
                    </div>
                  ) : null}

                  <div style={gridStyle}>
                    <div style={metricCardStyle}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>实时负载</div>
                      <div style={{ fontSize: 16, fontWeight: 700 }}>
                        活跃 {account.liveLoad.activeLeaseCount} · 等待 {account.liveLoad.waitingCount}
                      </div>
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>
                        session 通道 {account.liveLoad.sessionScopedChannels} · 饱和通道 {account.liveLoad.saturatedChannels}
                      </div>
                    </div>

                    <div style={metricCardStyle}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>抑制原因</div>
                      {account.dispatchSuppression.total > 0 ? (
                        <>
                          <div style={{ fontSize: 16, fontWeight: 700 }}>
                            {account.dispatchSuppression.reasons.map((item) => `${item.reason} × ${item.count}`).join(' · ')}
                          </div>
                          {(account.dispatchSuppression.entries || []).slice(0, 4).map((entry) => (
                            <div key={`${entry.routeId}:${entry.modelName}:${entry.updatedAt}`} style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                              {entry.modelName} · {entry.status}
                              <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>
                                route #{entry.routeId} · {entry.suppressionReason || 'none'} · {formatWhen(entry.updatedAt)}
                              </div>
                            </div>
                          ))}
                        </>
                      ) : <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>暂无抑制</div>}
                    </div>

                    <div style={metricCardStyle}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>恢复信号</div>
                      {(account.recoverySignals || []).length > 0 ? account.recoverySignals.slice(0, 4).map((signal) => (
                        <div key={`${signal.channelId}:${signal.modelName}`} style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                          #{signal.channelId} · {signal.modelName} · {signal.status}
                          <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{formatWhen(signal.recordedAt)} · {signal.reason || '-'}</div>
                        </div>
                      )) : <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>暂无恢复信号</div>}
                    </div>

                    <div style={metricCardStyle}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>保护/挑战信号</div>
                      {(account.protectionSignals || []).length > 0 ? account.protectionSignals.slice(0, 4).map((signal, index) => (
                        <div key={`${signal.className}-${index}`} style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                          {signal.title}
                          <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{formatWhen(signal.recordedAt)} · {signal.summary || '-'}</div>
                        </div>
                      )) : <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>暂无保护信号</div>}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        }) : (
          <div style={{ color: 'var(--color-text-secondary)' }}>暂无数据</div>
        )}
      </div>
    </div>
  );
}
