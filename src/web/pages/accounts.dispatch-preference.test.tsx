import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';

const { apiMock, mobileState } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getSites: vi.fn(),
    updateAccount: vi.fn(),
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

function collectText(node: any): string {
  return (node.children || []).map((child: any) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function createAccount(
  dispatchPreferenceMode: 'default' | 'force' | 'prefer' = 'default',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 1,
    siteId: 1,
    username: 'alpha',
    accessToken: 'session-alpha',
    status: 'active',
    dispatchPreferenceMode,
    site: { id: 1, name: 'Site A', status: 'active', platform: 'new-api' },
    ...overrides,
  };
}

describe('Accounts dispatch preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileState.value = false;
    apiMock.getSites.mockResolvedValue([
      { id: 1, name: 'Site A', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccounts.mockResolvedValue([
      createAccount(),
    ]);
    apiMock.updateAccount.mockImplementation(async (id: number, payload: { dispatchPreferenceMode: 'default' | 'force' | 'prefer' }) => ({
      ...createAccount(payload.dispatchPreferenceMode),
      id,
      dispatchPreferenceMode: payload.dispatchPreferenceMode,
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('saves prefer mode from the desktop action and renders the badge', async () => {
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

      const openButton = root.root.find((node) => node.props['data-testid'] === 'account-dispatch-preference-1');
      await act(async () => {
        openButton.props.onClick();
      });
      await flushMicrotasks();

      expect(collectText(root.root)).toContain('指定调度');
      expect(collectText(root.root)).toContain('优先调用');

      const preferRadio = root.root.find((node) => (
        node.type === 'input'
        && node.props.type === 'radio'
        && node.props.value === 'prefer'
      ));
      await act(async () => {
        preferRadio.props.onChange();
      });
      await flushMicrotasks();

      const saveButton = root.root.find((node) => (
        node.type === 'button' && collectText(node).includes('保存设置')
      ));
      await act(async () => {
        await saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateAccount).toHaveBeenCalledWith(1, {
        dispatchPreferenceMode: 'prefer',
      });

      const preferBadges = root.root.findAll((node) => (
        typeof node.props?.className === 'string'
        && node.props.className.includes('badge-purple')
        && collectText(node).trim() === '优先'
      ));
      expect(preferBadges.length).toBeGreaterThan(0);
    } finally {
      root?.unmount();
    }
  });

  it('supports saving force mode from the mobile footer action', async () => {
    mobileState.value = true;

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

      const openButton = root.root.find((node) => node.props['data-testid'] === 'account-dispatch-preference-1');
      expect(collectText(openButton)).toContain('指定');

      await act(async () => {
        openButton.props.onClick();
      });
      await flushMicrotasks();

      const forceRadio = root.root.find((node) => (
        node.type === 'input'
        && node.props.type === 'radio'
        && node.props.value === 'force'
      ));
      await act(async () => {
        forceRadio.props.onChange();
      });
      await flushMicrotasks();

      const saveButton = root.root.find((node) => (
        node.type === 'button' && collectText(node).includes('保存设置')
      ));
      await act(async () => {
        await saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateAccount).toHaveBeenCalledWith(1, {
        dispatchPreferenceMode: 'force',
      });
    } finally {
      root?.unmount();
    }
  });

  it('shows active manual dispatch summary at the top and supports restoring default mode', async () => {
    apiMock.getAccounts.mockResolvedValue([
      createAccount('force'),
      createAccount('prefer', {
        id: 2,
        username: 'beta',
        accessToken: 'session-beta',
        site: { id: 2, name: 'Site B', status: 'active', platform: 'new-api' },
      }),
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

      const pageText = collectText(root.root);
      expect(pageText).toContain('手动调度生效中');
      expect(pageText).toContain('强指定');
      expect(pageText).toContain('优先调用');
      expect(pageText).toContain('Site A');
      expect(pageText).toContain('alpha');
      expect(pageText).toContain('Site B');
      expect(pageText).toContain('beta');
      expect(pageText).toContain('共享路由时会按强指定优先、最近修改优先生效');

      const restoreButtons = root.root.findAll((node) => (
        node.type === 'button' && collectText(node).includes('恢复默认调用')
      ));
      expect(restoreButtons.length).toBeGreaterThan(0);

      await act(async () => {
        await restoreButtons[0].props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateAccount).toHaveBeenCalledWith(1, {
        dispatchPreferenceMode: 'default',
      });
    } finally {
      root?.unmount();
    }
  });
});
