import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AccountProbeModal from './accounts/AccountProbeModal.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccountModels: vi.fn(),
    probeAccountChat: vi.fn(),
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

describe('AccountProbeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAccountModels.mockResolvedValue({
      siteName: 'Site A',
      models: [
        { name: 'gpt-4.1', disabled: false, latencyMs: 321 },
        { name: 'gpt-4.1-mini', disabled: false, latencyMs: null },
      ],
    });
    apiMock.probeAccountChat.mockResolvedValue({
      success: true,
      statusText: '服务正常',
      replyText: '你好，我在线。',
      latencyMs: 188,
      model: 'gpt-4.1',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads account models and renders the normalized probe reply', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <AccountProbeModal
            open
            account={{ id: 1, username: 'alpha', site: { name: 'Site A' } }}
            onClose={() => {}}
          />,
        );
      });
      await flushMicrotasks();

      expect(apiMock.getAccountModels).toHaveBeenCalledWith(1);

      const startButton = findButtonByText(root.root, '开始测活');
      await act(async () => {
        startButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.probeAccountChat).toHaveBeenCalledWith(1, { model: 'gpt-4.1' });
      expect(collectText(root.root)).toContain('服务正常');
      expect(collectText(root.root)).toContain('你好，我在线。');
    } finally {
      root?.unmount();
    }
  });

  it('uses a half-screen mobile sheet style in shared css', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/accounts/AccountProbeModal.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toContain('account-probe-sheet-content');
    expect(css).toMatch(/\.account-probe-sheet-content\s*\{[\s\S]*max-height:\s*52vh/);
  });
});
