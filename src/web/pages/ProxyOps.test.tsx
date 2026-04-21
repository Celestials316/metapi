import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import ProxyOps from './ProxyOps.js';

const { apiMock, navigateMock, toastSuccessMock, toastErrorMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    getProxyOps: vi.fn(),
    triggerProxyOpsRecoverySweep: vi.fn(),
    checkModels: vi.fn(),
  },
  navigateMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastMock: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/Toast.js', () => ({
  useToast: () => toastMock,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('./helpers/checkinLogTime.js', () => ({
  formatDateTimeLocal: (value: string) => value,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function findButtonByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).includes(text)
  ));
}

function formatDateTimeInputValue(value: Date) {
  const pad = (segment: number) => String(segment).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function expectLogsTarget(target: string, expected: Record<string, string>) {
  const url = new URL(target, 'https://local.test');
  for (const [key, value] of Object.entries(expected)) {
    expect(url.searchParams.get(key)).toBe(value);
  }
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ProxyOps page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getProxyOps.mockResolvedValue({
      generatedAt: '2026-04-21T12:00:00.000Z',
      overview: {
        totalAccounts: 1,
        degradedAccounts: 1,
        challengeAffectedAccounts: 1,
        coveredFailures24h: 1,
        totalRequests24h: 12,
        successRequests24h: 9,
        successRate24h: 75,
      },
      failureBuckets24h: [
        {
          className: 'challenge_shield',
          title: 'Cloudflare / Turnstile 挑战',
          count: 2,
        },
      ],
      accounts: [
        {
          accountId: 7,
          username: 'ops-user',
          siteId: 3,
          siteName: 'Codex Site',
          siteUrl: 'https://codex.example.com',
          accountStatus: 'active',
          channelHealth: {
            total: 2,
            cooling: 1,
            degraded: 1,
          },
          proxy24h: {
            total: 12,
            success: 9,
            failed: 1,
            retried: 2,
            successRate: 75,
          },
          failureBuckets: [
            {
              className: 'challenge_shield',
              title: 'Cloudflare / Turnstile 挑战',
              count: 2,
            },
          ],
          latestFailure: {
            className: 'challenge_shield',
            title: 'Cloudflare / Turnstile 挑战',
            summary: '403 blocked by upstream WAF',
            recordedAt: '2026-04-21T11:59:00.000Z',
            httpStatus: 403,
          },
          modelProbe: null,
          refresh: {
            lastRefreshAt: '2026-04-21T11:58:00.000Z',
            status: 'failed',
            message: 'refresh cooldown active',
          },
          recoverySignals: [],
          protectionSignals: [
            {
              className: 'challenge_shield',
              title: 'Cloudflare / Turnstile 挑战',
              summary: '403 blocked by upstream WAF',
              status: 403,
              recordedAt: '2026-04-21T11:59:00.000Z',
            },
          ],
          opsScore: 58,
        },
      ],
    });
    apiMock.triggerProxyOpsRecoverySweep.mockResolvedValue({ success: true, triggeredAt: '2026-04-21T12:00:00.000Z' });
    apiMock.checkModels.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows protection details after expand and deep-links failureClass when opening logs', async () => {
    let root: ReactTestRenderer | undefined;
    const expectedFrom = formatDateTimeInputValue(new Date('2026-04-20T12:00:00.000Z'));
    const expectedTo = formatDateTimeInputValue(new Date('2026-04-21T12:00:00.000Z'));
    try {
      await act(async () => {
        root = create(<ProxyOps />);
      });
      await flushMicrotasks();

      const coveredFailuresCard = root!.root.find((node) => node.props['data-testid'] === 'proxy-ops-overview-card-coveredFailures24h');
      await act(async () => {
        coveredFailuresCard.props.onClick();
      });
      expectLogsTarget(String(navigateMock.mock.lastCall?.[0] || ''), {
        status: 'failed',
        failureClass: 'covered_failure',
        from: expectedFrom,
        to: expectedTo,
      });

      const failureBucketButton = root!.root.find((node) => node.props['data-testid'] === 'proxy-ops-failure-bucket-challenge_shield');
      await act(async () => {
        failureBucketButton.props.onClick();
      });
      expectLogsTarget(String(navigateMock.mock.lastCall?.[0] || ''), {
        status: 'failed',
        failureClass: 'challenge_shield',
        from: expectedFrom,
        to: expectedTo,
      });

      const expandButton = findButtonByText(root!.root, '展开详情');
      await act(async () => {
        expandButton.props.onClick();
      });

      expect(collectText(root!.root)).toContain('保护/挑战信号');
      expect(collectText(root!.root)).toContain('Cloudflare / Turnstile 挑战');

      const logsButton = findButtonByText(root!.root, '看失败日志');
      await act(async () => {
        logsButton.props.onClick();
      });

      expectLogsTarget(String(navigateMock.mock.lastCall?.[0] || ''), {
        status: 'failed',
        accountId: '7',
        failureClass: 'challenge_shield',
        from: expectedFrom,
        to: expectedTo,
      });
    } finally {
      if (root) {
        root.unmount();
      }
    }
  });
});
