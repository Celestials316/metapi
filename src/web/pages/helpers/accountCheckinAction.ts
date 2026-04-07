export type AccountCheckinActionMode = 'auto' | 'manual_jump' | 'none';

type AccountCapabilitiesLike = {
  canCheckin?: boolean | null;
};

type AccountCheckinLike = {
  checkinEnabled?: boolean | null;
  checkinActionMode?: unknown;
};

export type AccountCheckinPresentation = {
  mode: AccountCheckinActionMode;
  showButton: boolean;
  showToggle: boolean;
  statusLabel: string;
};

export function normalizeAccountCheckinActionMode(value: unknown): AccountCheckinActionMode {
  if (value === 'auto' || value === 'manual_jump') return value;
  return 'none';
}

export function resolveAccountCheckinPresentation(
  account: AccountCheckinLike,
  capabilities?: AccountCapabilitiesLike | null,
): AccountCheckinPresentation {
  const sessionCapable = !!capabilities?.canCheckin;
  if (!sessionCapable) {
    return {
      mode: 'none',
      showButton: false,
      showToggle: false,
      statusLabel: '不支持',
    };
  }

  const mode = normalizeAccountCheckinActionMode(account?.checkinActionMode || 'auto');
  if (mode === 'manual_jump') {
    return {
      mode,
      showButton: true,
      showToggle: false,
      statusLabel: '手动',
    };
  }

  if (mode === 'none') {
    return {
      mode,
      showButton: false,
      showToggle: false,
      statusLabel: '不支持',
    };
  }

  return {
    mode: 'auto',
    showButton: true,
    showToggle: true,
    statusLabel: account?.checkinEnabled === false ? '关闭' : '开启',
  };
}
