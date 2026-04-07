import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Dashboard from './Dashboard.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getDashboard: vi.fn(),
    getSiteDistribution: vi.fn(),
    getSiteTrend: vi.fn(),
    getSites: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
}));

vi.mock('../components/ModelAnalysisPanel.js', () => ({
  default: () => <div className="model-analysis-panel-stub">model-analysis</div>,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Dashboard mobile panels', () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getDashboard.mockResolvedValue({
      totalBalance: 0,
      totalUsed: 0,
      todaySpend: 0,
      todayReward: 0,
      activeAccounts: 0,
      totalAccounts: 0,
      todayCheckin: { success: 0, total: 0 },
      proxy24h: { success: 12, total: 16, totalTokens: 0 },
      performance: { windowSeconds: 60, requestsPerMinute: 0, tokensPerMinute: 0 },
      modelAnalysis: null,
      siteAvailability: [],
    });
    apiMock.getSiteDistribution.mockResolvedValue({ distribution: [] });
    apiMock.getSiteTrend.mockResolvedValue({ trend: [] });
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'A very long demo site name for mobile cards',
        url: 'https://example.com/v1/really/long/mobile/path/that/should/still/break/correctly',
        status: 'active',
      },
    ]);
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getElementById: vi.fn(() => null),
    } as unknown as Document;
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    vi.clearAllMocks();
  });

  it('separates site title and action rows for mobile cards', async () => {
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/']}>
            <ToastProvider>
              <Dashboard />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(root.root.find((node) => node.props.className === 'dashboard-site-info-header')).toBeTruthy();
      expect(root.root.find((node) => (
        typeof node.props.className === 'string'
        && node.props.className.includes('dashboard-site-info-bulk-speed')
      ))).toBeTruthy();
      expect(root.root.find((node) => node.props.className === 'dashboard-site-info-card-header')).toBeTruthy();
      expect(root.root.find((node) => node.props.className === 'dashboard-site-info-card-actions')).toBeTruthy();
      expect(root.root.find((node) => node.props.className === 'dashboard-site-info-url')).toBeTruthy();
    } finally {
      root?.unmount();
    }
  });
});
