import { describe, expect, it } from 'vitest';
import {
  normalizeAccountCheckinActionMode,
  resolveAccountCheckinPresentation,
} from './accountCheckinAction.js';

describe('accountCheckinAction helpers', () => {
  it('normalizes checkin action modes', () => {
    expect(normalizeAccountCheckinActionMode('auto')).toBe('auto');
    expect(normalizeAccountCheckinActionMode('manual_jump')).toBe('manual_jump');
    expect(normalizeAccountCheckinActionMode('unknown')).toBe('none');
    expect(normalizeAccountCheckinActionMode(undefined)).toBe('none');
  });

  it('resolves auto presentation for session-capable accounts', () => {
    expect(resolveAccountCheckinPresentation(
      { checkinEnabled: true, checkinActionMode: 'auto' },
      { canCheckin: true },
    )).toEqual({
      mode: 'auto',
      showButton: true,
      showToggle: true,
      statusLabel: '开启',
    });

    expect(resolveAccountCheckinPresentation(
      { checkinEnabled: false, checkinActionMode: 'auto' },
      { canCheckin: true },
    )).toEqual({
      mode: 'auto',
      showButton: true,
      showToggle: true,
      statusLabel: '关闭',
    });
  });

  it('resolves manual jump presentation without toggle', () => {
    expect(resolveAccountCheckinPresentation(
      { checkinEnabled: true, checkinActionMode: 'manual_jump' },
      { canCheckin: true },
    )).toEqual({
      mode: 'manual_jump',
      showButton: true,
      showToggle: false,
      statusLabel: '手动',
    });
  });

  it('hides checkin affordances for proxy-only accounts', () => {
    expect(resolveAccountCheckinPresentation(
      { checkinEnabled: true, checkinActionMode: 'auto' },
      { canCheckin: false },
    )).toEqual({
      mode: 'none',
      showButton: false,
      showToggle: false,
      statusLabel: '不支持',
    });
  });
});
