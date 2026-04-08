import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getSites: vi.fn(),
    getCheckinAction: vi.fn(),
    triggerCheckin: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('react-dom', () => ({
  createPortal: (node: unknown) => node,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
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

describe('Accounts aisign checkin sheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      { id: 7, name: 'Aisign Site', platform: 'sub2api', status: 'active' },
    ]);
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 11,
        siteId: 7,
        username: 'aisign-user',
        accessToken: 'session-token',
        checkinEnabled: true,
        checkinActionMode: 'auto',
        capabilities: {
          canCheckin: true,
          canRefreshBalance: true,
          proxyOnly: false,
        },
        status: 'active',
        site: { id: 7, name: 'Aisign Site', status: 'active', platform: 'sub2api' },
      },
    ]);
    apiMock.getCheckinAction.mockResolvedValue({
      success: true,
      mode: 'auto',
      kind: 'aisign',
      url: null,
      message: '签到成功',
      requiresTierSelection: true,
      defaultTierId: 3,
      tierOptions: [
        { id: 1, name: '简单', rewardMin: 1, rewardMax: 5, targetSeconds: 1, difficulty: 19 },
        { id: 2, name: '进阶', rewardMin: 5, rewardMax: 10, targetSeconds: 60, difficulty: 25 },
        { id: 3, name: '挑战', rewardMin: 10, rewardMax: 15, targetSeconds: 120, difficulty: 26 },
        { id: 4, name: '极限', rewardMin: 15, rewardMax: 20, targetSeconds: 200, difficulty: 26 },
      ],
    });
    apiMock.triggerCheckin.mockResolvedValue({
      success: true,
      status: 'success',
      message: '签到成功',
      reward: '12',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens the aisign mobile sheet and submits the default challenge tier', async () => {
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

      const signButton = findButtonByText(root.root, '签到');
      await act(async () => {
        signButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getCheckinAction).toHaveBeenCalledWith(11);

      const sheet = root.root.find((node) => node.props['data-testid'] === 'aisign-checkin-sheet');
      expect(sheet).toBeTruthy();

      const defaultTier = root.root.find((node) => node.props['data-testid'] === 'aisign-tier-option-3');
      expect(defaultTier.props['aria-pressed']).toBe(true);

      const confirmButton = root.root.find((node) => node.props['data-testid'] === 'aisign-checkin-confirm');
      await act(async () => {
        confirmButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.triggerCheckin).toHaveBeenCalledWith(11, { tier: 3 });
    } finally {
      root?.unmount();
    }
  });

  it('uses a compact mobile half-sheet style for aisign selection', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/accounts/AisignCheckinSheet.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toContain('aisign-checkin-sheet-content');
    expect(css).toMatch(/\.aisign-checkin-sheet-content\s*\{[\s\S]*max-height:\s*min\(64vh,\s*520px\)/);
  });
});
