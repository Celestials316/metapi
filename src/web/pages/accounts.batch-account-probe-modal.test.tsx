import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import BatchAccountProbeModal from './accounts/BatchAccountProbeModal.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccountModels: vi.fn(),
    streamBatchAccountProbe: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('react-dom', () => ({
  createPortal: (node: unknown) => node,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => false,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(node: any): string {
  return (node.children || []).map((child: any) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function findButtonByText(root: any, text: string) {
  return root.find((node: any) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).includes(text)
  ));
}

describe('BatchAccountProbeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAccountModels.mockImplementation((accountId: number) => {
      if (accountId === 1) {
        return Promise.resolve({
          siteName: 'Site A',
          models: [
            { name: 'gpt-4.1', disabled: false },
            { name: 'gpt-4.1-mini', disabled: false },
          ],
        });
      }

      return Promise.resolve({
        siteName: 'Site B',
        models: [
          { name: 'gpt-4.1-mini', disabled: false },
          { name: 'gemini-2.5-flash', disabled: false },
        ],
      });
    });
    apiMock.streamBatchAccountProbe.mockImplementation(async (payload: any, handlers: any) => {
      handlers.onStart?.({
        totalAccounts: payload.accountIds.length,
        scheduledAccounts: payload.accountIds.length,
        hiddenDisabledAccounts: 0,
        concurrency: payload.concurrency,
      });
      handlers.onResult?.({
        accountId: 1,
        accountName: 'alpha',
        siteName: 'Site A',
        status: 'success',
        latencyMs: 135,
        model: 'fallback-model',
        usedFallbackModel: true,
        message: 'hello from upstream',
      });
      handlers.onDone?.({
        totalAccounts: payload.accountIds.length,
        scheduledAccounts: payload.accountIds.length,
        hiddenDisabledAccounts: 0,
        completedAccounts: payload.accountIds.length,
        success: 1,
        failed: 0,
        skipped: 0,
        durationMs: 20,
      });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts batch probing from the config step and renders streamed results without repeating the preferred model', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <BatchAccountProbeModal
            open
            activeSegment="session"
            segmentAccounts={[
              { id: 1, username: 'alpha', status: 'active', site: { name: 'Site A' } },
            ]}
            allAccounts={[
              { id: 1, username: 'alpha', status: 'active', site: { name: 'Site A' } },
              { id: 2, username: 'beta', status: 'active', site: { name: 'Site B' } },
            ]}
            onClose={() => {}}
          />,
        );
      });
      await flushMicrotasks();

      expect(apiMock.getAccountModels).toHaveBeenCalledWith(1);

      const modelSelect = root.root.findByProps({ 'data-testid': 'batch-probe-model-select' });
      await act(async () => {
        modelSelect.props.onChange({ target: { value: 'gpt-4.1-mini' } });
      });

      const startButton = findButtonByText(root.root, '开始测活');
      await act(async () => {
        await startButton.props.onClick();
      });

      expect(apiMock.streamBatchAccountProbe).toHaveBeenCalledWith({
        accountIds: [1],
        preferredModel: 'gpt-4.1-mini',
        includeDisabled: false,
        concurrency: 4,
      }, expect.objectContaining({
        onStart: expect.any(Function),
        onResult: expect.any(Function),
        onDone: expect.any(Function),
        signal: expect.any(Object),
      }));
      expect(collectText(root.root)).toContain('测活结果');
      expect(collectText(root.root)).toContain('alpha');
      expect(collectText(root.root)).toContain('hello from upstream');
      expect(collectText(root.root)).not.toContain('默认测活模型');
      expect(collectText(root.root)).toContain('fallback-model');
    } finally {
      root?.unmount();
    }
  });

  it('reloads aggregated model options when switching to all scope', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <BatchAccountProbeModal
            open
            activeSegment="session"
            segmentAccounts={[
              { id: 1, username: 'alpha', status: 'active', site: { name: 'Site A' } },
            ]}
            allAccounts={[
              { id: 1, username: 'alpha', status: 'active', site: { name: 'Site A' } },
              { id: 2, username: 'beta', status: 'active', site: { name: 'Site B' } },
            ]}
            onClose={() => {}}
          />,
        );
      });
      await flushMicrotasks();

      const scopeButton = findButtonByText(root.root, '全部分段');
      await act(async () => {
        scopeButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getAccountModels).toHaveBeenCalledWith(1);
      expect(apiMock.getAccountModels).toHaveBeenCalledWith(2);

      const modelSelect = root.root.findByProps({ 'data-testid': 'batch-probe-model-select' });
      const optionValues = modelSelect.props.children.map((child: any) => child.props.value);

      expect(optionValues).toContain('gemini-2.5-flash');
      expect(optionValues[0]).toBe('gpt-4.1-mini');
    } finally {
      root?.unmount();
    }
  });

  it('opens a compact filtered stats view when tapping the success summary card after probing', async () => {
    apiMock.streamBatchAccountProbe.mockImplementationOnce(async (payload: any, handlers: any) => {
      handlers.onStart?.({
        totalAccounts: payload.accountIds.length,
        scheduledAccounts: payload.accountIds.length,
        hiddenDisabledAccounts: 0,
        concurrency: payload.concurrency,
      });
      handlers.onResult?.({
        accountId: 1,
        accountName: 'alpha',
        siteName: 'Site A',
        status: 'success',
        latencyMs: 135,
        model: 'gpt-4.1-mini',
        usedFallbackModel: false,
        message: 'alpha ok',
      });
      handlers.onResult?.({
        accountId: 2,
        accountName: 'beta',
        siteName: 'Site B',
        status: 'failed',
        latencyMs: 420,
        model: 'gpt-4.1-mini',
        usedFallbackModel: false,
        message: 'beta failed',
      });
      handlers.onResult?.({
        accountId: 3,
        accountName: 'gamma',
        siteName: 'Site C',
        status: 'skipped_disabled',
        latencyMs: null,
        model: null,
        usedFallbackModel: false,
        message: '连接已禁用，未发起测活',
      });
      handlers.onDone?.({
        totalAccounts: payload.accountIds.length,
        scheduledAccounts: payload.accountIds.length,
        hiddenDisabledAccounts: 0,
        completedAccounts: payload.accountIds.length,
        success: 1,
        failed: 1,
        skipped: 1,
        durationMs: 20,
      });
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <BatchAccountProbeModal
            open
            activeSegment="session"
            segmentAccounts={[
              { id: 1, username: 'alpha', status: 'active', site: { name: 'Site A' } },
              { id: 2, username: 'beta', status: 'active', site: { name: 'Site B' } },
              { id: 3, username: 'gamma', status: 'inactive', site: { name: 'Site C' } },
            ]}
            allAccounts={[
              { id: 1, username: 'alpha', status: 'active', site: { name: 'Site A' } },
              { id: 2, username: 'beta', status: 'active', site: { name: 'Site B' } },
              { id: 3, username: 'gamma', status: 'inactive', site: { name: 'Site C' } },
            ]}
            onClose={() => {}}
          />,
        );
      });
      await flushMicrotasks();

      const startButton = findButtonByText(root.root, '开始测活');
      await act(async () => {
        await startButton.props.onClick();
      });

      const successCard = root.root.findByProps({ 'data-testid': 'batch-probe-stat-success' });
      await act(async () => {
        successCard.props.onClick();
      });

      expect(collectText(root.root)).toContain('结果统计');
      expect(collectText(root.root)).toContain('只看成功');
      expect(collectText(root.root)).toContain('alpha');
      expect(collectText(root.root)).not.toContain('beta');
      expect(collectText(root.root)).not.toContain('gamma');
    } finally {
      root?.unmount();
    }
  });
});
