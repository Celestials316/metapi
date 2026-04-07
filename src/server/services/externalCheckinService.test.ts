import { describe, expect, it } from 'vitest';
import {
  normalizeExternalCheckinKind,
  normalizeOptionalExternalCheckinUrlInput,
} from './externalCheckinService.js';

describe('externalCheckinService', () => {
  it('normalizes supported external checkin kinds', () => {
    expect(normalizeExternalCheckinKind('token_bridge')).toBe('token_bridge');
    expect(normalizeExternalCheckinKind(' manual_oauth ')).toBe('manual_oauth');
    expect(normalizeExternalCheckinKind('unsupported')).toBe('unsupported');
    expect(normalizeExternalCheckinKind('unknown')).toBeNull();
  });

  it('strips runtime-only query params from external checkin urls', () => {
    expect(normalizeOptionalExternalCheckinUrlInput(
      'https://sign.example.com/embed/?token=abc&user_id=11&src_host=https%3A%2F%2Fdemo.example.com&src_url=https%3A%2F%2Fdemo.example.com&lang=zh-CN&ui_mode=dark&foo=bar',
    )).toEqual({
      valid: true,
      present: true,
      url: 'https://sign.example.com/embed?foo=bar',
    });
  });

  it('rejects invalid protocols', () => {
    expect(normalizeOptionalExternalCheckinUrlInput('ftp://sign.example.com')).toEqual({
      valid: false,
      present: true,
      url: null,
    });
  });
});
