import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import ModelAnalysisPanel from './ModelAnalysisPanel.js';

vi.mock('@visactor/react-vchart', () => ({
  VChart: () => <div>mock-chart</div>,
}));

vi.mock('./BrandIcon.js', () => ({
  InlineBrandIcon: () => <span>brand-icon</span>,
}));

vi.mock('./useIsMobile.js', () => ({
  useIsMobile: () => true,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

describe('ModelAnalysisPanel mobile layout', () => {
  const originalDocument = globalThis.document;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const originalMutationObserver = globalThis.MutationObserver;

  beforeEach(() => {
    globalThis.document = {
      documentElement: {},
    } as unknown as Document;
    globalThis.getComputedStyle = vi.fn(() => ({
      getPropertyValue: () => '#9ca3af',
    })) as unknown as typeof getComputedStyle;
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof MutationObserver;
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalGetComputedStyle;
    globalThis.MutationObserver = originalMutationObserver;
  });

  it('uses dedicated mobile containers for summary, tabs, and legends', () => {
    let root!: WebTestRenderer;

    act(() => {
      root = create(
        <ModelAnalysisPanel
          data={{
            totals: {
              spend: 12.345,
              calls: 42,
              tokens: 123_456,
            },
            spendDistribution: [
              { model: 'openai/gpt-4.1-mini-with-a-very-long-name', spend: 8.12, calls: 20 },
              { model: 'claude/sonnet', spend: 4.22, calls: 22 },
            ],
            spendTrend: [{ day: '04-07', spend: 12.345 }],
          }}
        />,
      );
    });

    expect(root.root.find((node) => node.props.className === 'model-analysis-summary-grid')).toBeTruthy();
    expect(root.root.find((node) => node.props.className === 'model-analysis-tabs')).toBeTruthy();
    expect(root.root.findAll((node) => node.props.className === 'model-analysis-legend-item')).toHaveLength(2);

    root.unmount();
  });

  it('renders ranking as stacked cards instead of a wide table on mobile', async () => {
    let root!: WebTestRenderer;

    await act(async () => {
      root = create(
        <ModelAnalysisPanel
          data={{
            totals: {
              spend: 24.68,
              calls: 88,
              tokens: 654_321,
            },
            spendDistribution: [{ model: 'gpt-4.1', spend: 10, calls: 30 }],
            spendTrend: [{ day: '04-07', spend: 24.68 }],
            callRanking: [
              { model: 'openai/gpt-4.1', calls: 50, successRate: 98.5, avgLatencyMs: 680, spend: 16.2, tokens: 200_000 },
              { model: 'anthropic/claude-sonnet-4', calls: 38, successRate: 84.1, avgLatencyMs: 1880, spend: 8.48, tokens: 160_000 },
            ],
          }}
        />,
      );
    });

    const rankButton = root.root.find((node) => (
      node.type === 'button'
      && typeof node.props.className === 'string'
      && node.props.className.includes('pill-tab')
      && collectText(node).includes('排行榜')
    ));

    await act(async () => {
      rankButton.props.onClick();
    });

    expect(root.root.findAll((node) => node.type === 'table')).toHaveLength(0);
    expect(root.root.findAll((node) => node.props.className === 'model-analysis-rank-card')).toHaveLength(2);
    expect(collectText(root.root)).toContain('平均延迟');
    expect(collectText(root.root)).toContain('成功率');

    root.unmount();
  });
});
