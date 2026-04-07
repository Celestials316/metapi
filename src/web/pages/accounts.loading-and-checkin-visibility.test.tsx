import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';

const { apiMock, mobileState } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getSites: vi.fn(),
  },
  mobileState: { value: false },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('react-dom', () => ({
  createPortal: (node: unknown) => node,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => mobileState.value,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(node: ReactTestInstance): string {
  return (node.children || [])
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');
}

describe('Accounts loading and checkin visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileState.value = false;
    apiMock.getSites.mockResolvedValue([
      { id: 1, name: '52公益', platform: 'sub2api', status: 'active' },
      { id: 2, name: '冰佬', platform: 'sub2api', status: 'active' },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the shared loading animation before account loading finishes', async () => {
    apiMock.getAccounts.mockImplementation(() => new Promise(() => {}));

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });

      const loadingState = root.root.find((node) => node.props['data-testid'] === 'accounts-loading-state');
      expect(loadingState).toBeTruthy();
      expect(collectText(loadingState)).toContain('加载连接列表...');
      expect(loadingState.findAll((node) => typeof node.props.className === 'string' && node.props.className.includes('spinner')).length)
        .toBeGreaterThan(0);
    } finally {
      root?.unmount();
    }
  });

  it('keeps manual external-checkin buttons visible while retaining the manual status label', async () => {
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        siteId: 1,
        username: 'manual-user',
        accessToken: 'session-manual',
        status: 'active',
        checkinEnabled: true,
        checkinActionMode: 'manual_jump',
        capabilities: { canCheckin: true, canRefreshBalance: true, proxyOnly: false },
        site: { id: 1, name: '52公益', platform: 'sub2api', status: 'active', url: 'https://free.9e.nz' },
      },
      {
        id: 2,
        siteId: 2,
        username: 'auto-user',
        accessToken: 'session-auto',
        status: 'active',
        checkinEnabled: true,
        checkinActionMode: 'auto',
        capabilities: { canCheckin: true, canRefreshBalance: true, proxyOnly: false },
        site: { id: 2, name: '冰佬', platform: 'sub2api', status: 'active', url: 'https://ice.v.ua' },
      },
    ]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const manualRow = root.root.find((node) => node.props['data-testid'] === 'account-row-1');
      const autoRow = root.root.find((node) => node.props['data-testid'] === 'account-row-2');

      expect(collectText(manualRow)).toContain('手动');
      expect(manualRow.findAll((node) => node.type === 'button' && collectText(node).trim() === '签到')).toHaveLength(1);
      expect(autoRow.findAll((node) => node.type === 'button' && collectText(node).trim() === '签到')).toHaveLength(1);
    } finally {
      root?.unmount();
    }
  });
});
