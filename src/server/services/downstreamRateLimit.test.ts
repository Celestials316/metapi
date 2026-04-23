import { describe, expect, it } from 'vitest';
import {
  evaluateDownstreamRateLimit,
  normalizeDownstreamRateLimitConfig,
  recordDownstreamRateLimitRequest,
  recordDownstreamRateLimitSuccess,
  resetDownstreamRateLimitStore,
} from './downstreamRateLimit.js';

describe('downstreamRateLimit', () => {
  it('normalizes global and group dual-threshold config', () => {
    const config = normalizeDownstreamRateLimitConfig({
      enabled: true,
      windowMinutes: 5,
      totalCount: 20,
      successCount: 10,
      group: {
        vip: [50, 30],
        invalid: [-1, 0],
      },
    });

    expect(config).toEqual({
      enabled: true,
      windowMinutes: 5,
      totalCount: 20,
      successCount: 10,
      group: {
        vip: [50, 30],
      },
    });
  });

  it('blocks requests after the total-count threshold is exhausted within the window', () => {
    resetDownstreamRateLimitStore();
    const config = normalizeDownstreamRateLimitConfig({
      enabled: true,
      windowMinutes: 1,
      totalCount: 2,
      successCount: 9,
    });

    expect(evaluateDownstreamRateLimit({ config, keyId: 101, groupName: null, nowMs: 0 }).allowed).toBe(true);
    recordDownstreamRateLimitRequest({ config, keyId: 101, groupName: null, nowMs: 0 });
    recordDownstreamRateLimitRequest({ config, keyId: 101, groupName: null, nowMs: 500 });

    const blocked = evaluateDownstreamRateLimit({ config, keyId: 101, groupName: null, nowMs: 800 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('total');
    expect(blocked.message).toContain('including failed attempts');
  });

  it('uses group overrides and only counts successful requests toward the success threshold', () => {
    resetDownstreamRateLimitStore();
    const config = normalizeDownstreamRateLimitConfig({
      enabled: true,
      windowMinutes: 1,
      totalCount: 10,
      successCount: 3,
      group: {
        vip: [10, 1],
      },
    });

    recordDownstreamRateLimitRequest({ config, keyId: 202, groupName: 'vip', nowMs: 0 });
    expect(evaluateDownstreamRateLimit({ config, keyId: 202, groupName: 'vip', nowMs: 100 }).allowed).toBe(true);

    recordDownstreamRateLimitSuccess({ config, keyId: 202, groupName: 'vip', nowMs: 200 });
    const blocked = evaluateDownstreamRateLimit({ config, keyId: 202, groupName: 'vip', nowMs: 300 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('success');

    const standardGroup = evaluateDownstreamRateLimit({ config, keyId: 203, groupName: 'standard', nowMs: 300 });
    expect(standardGroup.allowed).toBe(true);
  });
});
