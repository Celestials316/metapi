import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import BatchAccountProbeModal from './accounts/BatchAccountProbeModal.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
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

      const modelInput = root.root.findByProps({ 'data-testid': 'batch-probe-model-input' });
      await act(async () => {
        modelInput.props.onChange({ target: { value: 'preferred-one' } });
      });

      const startButton = findButtonByText(root.root, '开始测活');
      await act(async () => {
        await startButton.props.onClick();
      });

      expect(apiMock.streamBatchAccountProbe).toHaveBeenCalledWith({
        accountIds: [1],
        preferredModel: 'preferred-one',
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
      expect(collectText(root.root)).not.toContain('preferred-one');
      expect(collectText(root.root)).toContain('fallback-model');
    } finally {
      root?.unmount();
    }
  });
});
