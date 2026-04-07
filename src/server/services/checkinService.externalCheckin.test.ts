import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  checkin: vi.fn(),
  login: vi.fn(),
};

const performAccountExternalCheckinMock = vi.fn();
const notifyMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const refreshBalanceMock = vi.fn();
const decryptPasswordMock = vi.fn();
const selectAllMock = vi.fn();
const insertValuesMock = vi.fn();
const updateSetMock = vi.fn();

const MANUAL_EXTERNAL_CHECKIN_MESSAGE = '站点需要跳转外部签到页手动完成签到';

vi.mock('../db/index.js', () => {
  const selectChain = {
    all: () => selectAllMock(),
    where: () => selectChain,
    innerJoin: () => selectChain,
    from: () => selectChain,
  };

  const insertChain = {
    run: () => ({}),
    values: (...args: unknown[]) => {
      insertValuesMock(...args);
      return insertChain;
    },
  };

  const updateWhereChain = {
    run: () => ({}),
  };

  const updateSetChain = {
    where: () => updateWhereChain,
  };

  return {
    db: {
      select: () => selectChain,
      insert: () => insertChain,
      update: () => ({
        set: (updates: Record<string, unknown>) => {
          updateSetMock(updates);
          return updateSetChain;
        },
      }),
    },
    schema: {
      accounts: { id: 'id', siteId: 'siteId', checkinEnabled: 'checkinEnabled', status: 'status' },
      sites: { id: 'id' },
      checkinLogs: {},
      events: {},
    },
  };
});

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => adapterMock,
}));

vi.mock('./externalCheckinService.js', () => ({
  MANUAL_EXTERNAL_CHECKIN_MESSAGE,
  performAccountExternalCheckin: (...args: unknown[]) => performAccountExternalCheckinMock(...args),
}));

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => notifyMock(...args),
}));

vi.mock('./alertService.js', () => ({
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('./balanceService.js', () => ({
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

vi.mock('./accountCredentialService.js', () => ({
  decryptAccountPassword: (...args: unknown[]) => decryptPasswordMock(...args),
}));

describe('checkinService external checkin integration', () => {
  beforeEach(() => {
    adapterMock.checkin.mockReset();
    adapterMock.login.mockReset();
    performAccountExternalCheckinMock.mockReset();
    notifyMock.mockReset();
    reportTokenExpiredMock.mockReset();
    refreshBalanceMock.mockReset();
    decryptPasswordMock.mockReset();
    selectAllMock.mockReset();
    insertValuesMock.mockReset();
    updateSetMock.mockReset();
  });

  it('treats manual external checkin as skipped without falling back to adapter checkin', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 21,
          username: 'sub2-user',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 21,
          name: 'sub2-site',
          url: 'https://sub2.example.com',
          platform: 'sub2api',
        },
      },
    ]);

    performAccountExternalCheckinMock.mockResolvedValue({
      handled: true,
      mode: 'manual_jump',
      kind: 'manual_oauth',
      entryUrl: 'https://sign.example.com/embed',
      url: 'https://sign.example.com/embed?token=abc',
      message: MANUAL_EXTERNAL_CHECKIN_MESSAGE,
      result: {
        success: false,
        message: MANUAL_EXTERNAL_CHECKIN_MESSAGE,
      },
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(21);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    expect(result.skipped).toBe(true);
    expect(adapterMock.checkin).not.toHaveBeenCalled();
    expect(refreshBalanceMock).not.toHaveBeenCalled();
    expect(insertValuesMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      status: 'skipped',
      message: MANUAL_EXTERNAL_CHECKIN_MESSAGE,
    }));
  });

  it('records automatic token-bridge external checkin as success', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 22,
          username: 'sub2-user',
          accessToken: 'token',
          status: 'active',
          balance: 10,
          extraConfig: null,
        },
        sites: {
          id: 22,
          name: 'sub2-site',
          url: 'https://sub2.example.com',
          platform: 'sub2api',
        },
      },
    ]);

    performAccountExternalCheckinMock.mockResolvedValue({
      handled: true,
      mode: 'auto',
      kind: 'token_bridge',
      entryUrl: 'https://sign.example.com/embed',
      url: null,
      message: '签到成功',
      result: {
        success: true,
        message: '签到成功',
      },
    });
    refreshBalanceMock.mockResolvedValue({ balance: 11, used: 0, quota: 11 });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(22);

    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    expect(adapterMock.checkin).not.toHaveBeenCalled();
    expect(refreshBalanceMock).toHaveBeenCalledWith(22);
    expect(insertValuesMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      status: 'success',
      message: '签到成功',
    }));
  });
});
