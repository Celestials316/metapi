import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountModels: vi.fn(),
    getSites: vi.fn(),
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

describe('Accounts batch account probe entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      { id: 1, name: 'Site A', platform: 'new-api', status: 'active' },
      { id: 2, name: 'Site B', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        siteId: 1,
        username: 'alpha',
        accessToken: 'session-alpha',
        status: 'active',
        site: { id: 1, name: 'Site A', status: 'active', platform: 'new-api' },
      },
      {
        id: 2,
        siteId: 2,
        username: 'beta',
        accessToken: '',
        apiToken: 'sk-beta',
        status: 'active',
        extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
        site: { id: 2, name: 'Site B', status: 'active', platform: 'new-api' },
      },
    ]);
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the batch probe entry on session and apikey segments and opens the modal', async () => {
    let sessionRoot!: WebTestRenderer;
    let apikeyRoot!: WebTestRenderer;
    try {
      await act(async () => {
        sessionRoot = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const sessionButton = findButtonByText(sessionRoot.root, '全部测活');
      await act(async () => {
        sessionButton.props.onClick();
      });
      await flushMicrotasks();

      expect(collectText(sessionRoot.root)).toContain('默认测活模型');
      expect(apiMock.getAccountModels).toHaveBeenCalledWith(1);

      await act(async () => {
        apikeyRoot = create(
          <MemoryRouter initialEntries={['/accounts?segment=apikey']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(collectText(apikeyRoot.root)).toContain('全部测活');
    } finally {
      sessionRoot?.unmount();
      apikeyRoot?.unmount();
    }
  });

  it('does not show the batch probe entry on the tokens segment', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(collectText(root.root)).not.toContain('全部测活');
    } finally {
      root?.unmount();
    }
  });
});
