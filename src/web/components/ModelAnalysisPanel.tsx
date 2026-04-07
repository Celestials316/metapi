import { useMemo, useState } from 'react';
import { VChart } from '@visactor/react-vchart';
import { InlineBrandIcon } from './BrandIcon.js';
import { formatCompactTokenMetric } from '../numberFormat.js';
import { useThemeLabelColor } from './useThemeLabelColor.js';
import { useIsMobile } from './useIsMobile.js';

type TabKey = 'spend' | 'trend' | 'calls' | 'rank';

interface SpendDistributionItem { model: string; spend: number; calls: number; }
interface SpendTrendItem { day: string; spend: number; }
interface CallsDistributionItem { model: string; calls: number; share: number; }
interface CallRankingItem { model: string; calls: number; successRate: number; avgLatencyMs: number; spend: number; tokens: number; }

interface ModelAnalysisData {
  totals?: { spend?: number; calls?: number; tokens?: number };
  spendDistribution?: SpendDistributionItem[];
  spendTrend?: SpendTrendItem[];
  callsDistribution?: CallsDistributionItem[];
  callRanking?: CallRankingItem[];
}

interface ModelAnalysisPanelProps {
  data?: ModelAnalysisData | null;
}

const tabs: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'spend', label: '消耗分布', icon: '💰' },
  { key: 'trend', label: '消耗趋势', icon: '📈' },
  { key: 'calls', label: '调用分布', icon: '🔄' },
  { key: 'rank', label: '排行榜', icon: '🏆' },
];

const pieColors = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

function toSafeNumber(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return value;
}

function formatCurrency(value: number): string {
  const n = toSafeNumber(value);
  if (n >= 1000) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(6)}`;
}

function formatPercent(value: number): string {
  return `${toSafeNumber(value).toFixed(1)}%`;
}

function truncateModelLabel(model: string, maxLength: number): string {
  if (model.length <= maxLength) return model;
  return `${model.slice(0, maxLength)}...`;
}

function getLatencyVisual(avgLatencyMs: number) {
  const latMs = toSafeNumber(avgLatencyMs);
  const latSec = latMs / 1000;

  let color: string;
  let background: string;
  if (latSec <= 15) {
    const t = Math.min(latSec / 15, 1);
    const r = Math.round(34 + t * (245 - 34));
    const g = Math.round(197 + t * (158 - 197));
    const b = Math.round(94 + t * (11 - 94));
    color = `rgb(${r},${g},${b})`;
    background = `rgba(${r},${g},${b},0.08)`;
  } else if (latSec <= 60) {
    const t = Math.min((latSec - 15) / 45, 1);
    const r = Math.round(245 + t * (239 - 245));
    const g = Math.round(158 + t * (68 - 158));
    const b = Math.round(11 + t * (68 - 11));
    color = `rgb(${r},${g},${b})`;
    background = `rgba(${r},${g},${b},0.08)`;
  } else {
    color = '#ef4444';
    background = 'rgba(239,68,68,0.08)';
  }

  return {
    color,
    background,
    text: latMs >= 1000 ? `${(latMs / 1000).toFixed(latSec >= 60 ? 0 : 1)}s` : `${latMs}ms`,
  };
}

function getSuccessRateVisual(successRate: number) {
  const safeRate = toSafeNumber(successRate);
  if (safeRate >= 90) {
    return { color: '#16a34a', background: 'rgba(34,197,94,0.1)' };
  }
  if (safeRate >= 60) {
    return { color: '#d97706', background: 'rgba(245,158,11,0.1)' };
  }
  return { color: '#dc2626', background: 'rgba(239,68,68,0.1)' };
}

function EmptyBlock() {
  return (
    <div className="empty-state" style={{ padding: 28 }}>
      <div className="empty-state-title">暂无模型调用数据</div>
      <div className="empty-state-desc">等待代理流量进入后会自动生成统计图表</div>
    </div>
  );
}

export default function ModelAnalysisPanel({ data }: ModelAnalysisPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('spend');
  const labelColor = useThemeLabelColor();
  const isMobile = useIsMobile();

  const totals = {
    spend: toSafeNumber(data?.totals?.spend),
    calls: toSafeNumber(data?.totals?.calls),
    tokens: toSafeNumber(data?.totals?.tokens),
  };

  const spendDistribution = (data?.spendDistribution || []).slice(0, 10);
  const spendTrend = data?.spendTrend || [];
  const callsDistribution = (data?.callsDistribution || []).slice(0, 10);
  const callRanking = (data?.callRanking || []).slice(0, 10);

  const hasData = totals.calls > 0
    || spendDistribution.length > 0
    || spendTrend.some((item) => toSafeNumber(item.spend) > 0);

  const chartHeight = isMobile ? 260 : 300;
  const axisLabelMaxLength = isMobile ? 14 : 25;

  const spendBarSpec = useMemo(() => ({
    type: 'bar' as const,
    data: [{
      id: 'data',
      values: spendDistribution
        .map((d) => ({
          model: truncateModelLabel(d.model, axisLabelMaxLength),
          value: toSafeNumber(d.spend),
        }))
        .reverse(),
    }],
    xField: 'value', yField: 'model', direction: 'horizontal' as const,
    bar: { style: { cornerRadius: [0, 6, 6, 0], fill: { gradient: 'linear' as const, x0: 0, y0: 0, x1: 1, y1: 0, stops: [{ offset: 0, color: '#4f46e5' }, { offset: 1, color: '#818cf8' }] } } },
    label: { visible: !isMobile, position: 'right', formatter: '{value}', style: { fontSize: 11, fill: labelColor, stroke: 'transparent' } },
    axes: [{ orient: 'left', label: { style: { fontSize: isMobile ? 10 : 11, fill: labelColor } } }, { orient: 'bottom', visible: false }],
    animation: true, background: 'transparent',
  }), [axisLabelMaxLength, isMobile, spendDistribution, labelColor]);

  const trendSpec = useMemo(() => ({
    type: 'area' as const,
    data: [{ id: 'data', values: spendTrend.map(d => ({ day: d.day, spend: toSafeNumber(d.spend) })) }],
    xField: 'day', yField: 'spend',
    line: { style: { lineWidth: 2.5, curveType: 'monotone' as const, stroke: '#4f46e5' } },
    area: { style: { fill: { gradient: 'linear' as const, x0: 0, y0: 0, x1: 0, y1: 1, stops: [{ offset: 0, color: 'rgba(79,70,229,0.25)' }, { offset: 1, color: 'rgba(79,70,229,0.02)' }] }, curveType: 'monotone' as const } },
    point: { visible: true, style: { size: isMobile ? 5 : 7, fill: '#4f46e5', stroke: '#fff', lineWidth: 2 } },
    axes: [
      { orient: 'bottom' as const, label: { style: { fontSize: isMobile ? 10 : 11, fill: labelColor } } },
      { orient: 'left' as const, label: { style: { fontSize: isMobile ? 10 : 11, fill: labelColor } } },
    ],
    tooltip: { mark: { content: [{ key: () => '消耗', value: (datum: any) => formatCurrency(datum?.spend ?? 0) }] } },
    animation: true, background: 'transparent',
  }), [isMobile, spendTrend, labelColor]);

  const callsPieSpec = useMemo(() => ({
    type: 'pie' as const,
    data: [{ id: 'data', values: callsDistribution.map(d => ({ model: d.model, calls: toSafeNumber(d.calls) })) }],
    valueField: 'calls', categoryField: 'model',
    outerRadius: isMobile ? 0.72 : 0.8,
    innerRadius: isMobile ? 0.48 : 0.55,
    pie: { style: { cornerRadius: 4, padAngle: 0.02 } },
    label: { visible: !isMobile, position: 'outside', formatter: '{_percent_}%', style: { fill: labelColor } },
    legends: { visible: false },
    animation: true,
    color: pieColors,
    background: 'transparent',
  }), [callsDistribution, isMobile, labelColor]);

  if (!hasData) return <EmptyBlock />;

  return (
    <div className="model-analysis-panel">
      <div className="model-analysis-summary-grid">
        <div className="stat-summary-card stat-summary-purple">
          <div className="stat-summary-card-label">总消耗</div>
          <div className="stat-summary-card-value">{formatCurrency(totals.spend)}</div>
        </div>
        <div className="stat-summary-card stat-summary-blue">
          <div className="stat-summary-card-label">总调用</div>
          <div className="stat-summary-card-value">{Math.round(totals.calls).toLocaleString()}</div>
        </div>
        <div className="stat-summary-card stat-summary-green">
          <div className="stat-summary-card-label">总 Tokens</div>
          <div className="stat-summary-card-value">{formatCompactTokenMetric(totals.tokens)}</div>
        </div>
      </div>

      <div className="model-analysis-tabs">
        <div className="pill-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`pill-tab ${activeTab === tab.key ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'spend' && (
        <div className="model-analysis-tab-pane">
          <div className="model-analysis-chart" style={{ height: chartHeight }}>
            <VChart spec={spendBarSpec} />
          </div>
          <div className="model-analysis-legend">
            {spendDistribution.map((d) => (
              <div key={d.model} className="model-analysis-legend-item">
                <InlineBrandIcon model={d.model} size={13} />
                <span className="model-analysis-legend-model">{d.model}</span>
                <span className="model-analysis-legend-value">{formatCurrency(d.spend)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'trend' && (
        <div className="model-analysis-chart" style={{ height: chartHeight }}>
          <VChart spec={trendSpec} />
        </div>
      )}

      {activeTab === 'calls' && (
        <div className="model-analysis-tab-pane">
          <div className="model-analysis-chart" style={{ height: chartHeight }}>
            <VChart spec={callsPieSpec} />
          </div>
          <div className="model-analysis-legend">
            {callsDistribution.map((d, idx) => {
              return (
                <div key={d.model} className="model-analysis-legend-item">
                  <span
                    className="model-analysis-legend-dot"
                    style={{ background: pieColors[idx % pieColors.length] }}
                  />
                  <InlineBrandIcon model={d.model} size={13} />
                  <span className="model-analysis-legend-model">{d.model}</span>
                  <span className="model-analysis-legend-value">{d.calls}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'rank' && (
        isMobile ? (
          <div className="model-analysis-rank-list">
            {callRanking.map((item, index) => {
              const latencyVisual = getLatencyVisual(item.avgLatencyMs);
              const successVisual = getSuccessRateVisual(item.successRate);
              return (
                <div key={item.model} className="model-analysis-rank-card">
                  <div className="model-analysis-rank-card-header">
                    <span
                      className="model-analysis-rank-badge"
                      style={{
                        background: index < 3
                          ? ['linear-gradient(135deg,#fbbf24,#f59e0b)', 'linear-gradient(135deg,#94a3b8,#cbd5e1)', 'linear-gradient(135deg,#d97706,#fbbf24)'][index]
                          : 'var(--color-bg)',
                        color: index < 3 ? '#fff' : 'var(--color-text-muted)',
                      }}
                    >
                      {index + 1}
                    </span>
                    <span className="model-analysis-rank-model">
                      <InlineBrandIcon model={item.model} size={14} />
                      <code>{item.model}</code>
                    </span>
                  </div>

                  <div className="model-analysis-rank-metrics">
                    <div className="model-analysis-rank-metric">
                      <span className="model-analysis-rank-metric-label">调用</span>
                      <span className="model-analysis-rank-metric-value">{Math.round(item.calls).toLocaleString()}</span>
                    </div>
                    <div className="model-analysis-rank-metric">
                      <span className="model-analysis-rank-metric-label">消耗</span>
                      <span className="model-analysis-rank-metric-value">{formatCurrency(item.spend)}</span>
                    </div>
                    <div className="model-analysis-rank-metric">
                      <span className="model-analysis-rank-metric-label">成功率</span>
                      <span
                        className="model-analysis-rank-chip"
                        style={{ color: successVisual.color, background: successVisual.background }}
                      >
                        {formatPercent(item.successRate)}
                      </span>
                    </div>
                    <div className="model-analysis-rank-metric">
                      <span className="model-analysis-rank-metric-label">平均延迟</span>
                      <span
                        className="model-analysis-rank-chip"
                        style={{ color: latencyVisual.color, background: latencyVisual.background }}
                      >
                        {latencyVisual.text}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ overflow: 'hidden', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-md)' }}>
            <table className="data-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 36, textAlign: 'center' }}>#</th>
                  <th>模型</th>
                  <th style={{ textAlign: 'center' }}>调用</th>
                  <th style={{ textAlign: 'center' }}>成功率</th>
                  <th style={{ textAlign: 'center' }}>平均延迟</th>
                  <th style={{ textAlign: 'right' }}>消耗</th>
                </tr>
              </thead>
              <tbody>
                {callRanking.map((item, index) => {
                  const latencyVisual = getLatencyVisual(item.avgLatencyMs);
                  const successVisual = getSuccessRateVisual(item.successRate);

                  return (
                    <tr key={item.model}>
                      <td style={{ textAlign: 'center', padding: '8px 4px' }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 22,
                            height: 22,
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 700,
                            background: index < 3
                              ? ['linear-gradient(135deg,#fbbf24,#f59e0b)', 'linear-gradient(135deg,#94a3b8,#cbd5e1)', 'linear-gradient(135deg,#d97706,#fbbf24)'][index]
                              : 'var(--color-bg)',
                            color: index < 3 ? '#fff' : 'var(--color-text-muted)',
                          }}
                        >
                          {index + 1}
                        </span>
                      </td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <InlineBrandIcon model={item.model} size={14} />
                          <code style={{ fontSize: 12, fontWeight: 500 }}>{item.model}</code>
                        </span>
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 600, fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                        {Math.round(item.calls).toLocaleString()}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span
                          style={{
                            padding: '2px 8px',
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            background: successVisual.background,
                            color: successVisual.color,
                          }}
                        >
                          {formatPercent(item.successRate)}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span
                          style={{
                            fontVariantNumeric: 'tabular-nums',
                            fontSize: 12,
                            fontWeight: 600,
                            color: latencyVisual.color,
                            background: latencyVisual.background,
                            padding: '2px 8px',
                            borderRadius: 4,
                          }}
                        >
                          {latencyVisual.text}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500, fontSize: 13 }}>
                        {formatCurrency(item.spend)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
