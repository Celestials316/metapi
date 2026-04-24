import { beforeEach, describe, expect, it } from 'vitest';
import {
  getSuppressedClientSurfaceChannelIds,
  isClientSurfaceSuppressed,
  maybeSuppressClientSurfaceFromFailure,
  resetClientSurfaceSuppressions,
  suppressClientSurface,
} from './clientSurfaceSuppression.js';

describe('clientSurfaceSuppression', () => {
  beforeEach(() => {
    resetClientSurfaceSuppressions();
  });

  it('suppresses only the matching channel endpoint client kind and model until TTL expires', () => {
    suppressClientSurface({
      channelId: 2871,
      endpoint: 'responses',
      clientKind: 'generic',
      model: 'gpt-5.4',
      reason: 'upstream_blocked_generic_responses',
      ttlMs: 30 * 60 * 1000,
      nowMs: 1_000,
    });

    expect(isClientSurfaceSuppressed({
      channelId: 2871,
      endpoint: 'responses',
      clientKind: 'generic',
      model: 'gpt-5.4',
      nowMs: 1_000 + 10_000,
    })).toBe(true);
    expect(isClientSurfaceSuppressed({
      channelId: 2871,
      endpoint: 'responses',
      clientKind: 'codex',
      model: 'gpt-5.4',
      nowMs: 1_000 + 10_000,
    })).toBe(false);
    expect(isClientSurfaceSuppressed({
      channelId: 2871,
      endpoint: 'responses',
      clientKind: 'generic',
      model: 'gpt-5.5',
      nowMs: 1_000 + 10_000,
    })).toBe(false);
    expect(isClientSurfaceSuppressed({
      channelId: 2871,
      endpoint: 'responses',
      clientKind: 'generic',
      model: 'gpt-5.4',
      nowMs: 1_000 + 30 * 60 * 1000 + 1,
    })).toBe(false);
  });

  it('lists currently suppressed channels for a surface and prunes expired entries', () => {
    suppressClientSurface({
      channelId: 2871,
      endpoint: 'responses',
      clientKind: 'generic',
      model: 'gpt-5.4',
      reason: 'upstream_blocked_generic_responses',
      ttlMs: 30 * 60 * 1000,
      nowMs: 1_000,
    });
    suppressClientSurface({
      channelId: 2872,
      endpoint: 'responses',
      clientKind: 'generic',
      model: 'gpt-5.4',
      reason: 'upstream_blocked_generic_responses',
      ttlMs: 1_000,
      nowMs: 1_000,
    });

    expect(getSuppressedClientSurfaceChannelIds({
      endpoint: 'responses',
      clientKind: 'generic',
      model: 'gpt-5.4',
      nowMs: 2_001,
    })).toEqual([2871]);
  });

  it('only learns huainova-style new-api generic responses blocked failures', () => {
    const learned = maybeSuppressClientSurfaceFromFailure({
      channelId: 2871,
      endpoint: 'responses',
      clientKind: 'generic',
      model: 'gpt-5.4',
      sitePlatform: 'new-api',
      status: 403,
      errorText: 'Upstream returned HTTP 403: Your request was blocked.',
      nowMs: 1_000,
    });

    expect(learned).toBe(true);
    expect(getSuppressedClientSurfaceChannelIds({
      endpoint: 'responses',
      clientKind: 'generic',
      model: 'gpt-5.4',
      nowMs: 1_001,
    })).toEqual([2871]);

    expect(maybeSuppressClientSurfaceFromFailure({
      channelId: 2871,
      endpoint: 'responses',
      clientKind: 'codex',
      model: 'gpt-5.4',
      sitePlatform: 'new-api',
      status: 403,
      errorText: 'Upstream returned HTTP 403: Your request was blocked.',
      nowMs: 1_001,
    })).toBe(false);
    expect(maybeSuppressClientSurfaceFromFailure({
      channelId: 2871,
      endpoint: 'responses',
      clientKind: 'generic',
      model: 'gpt-5.4',
      sitePlatform: 'new-api',
      status: 401,
      errorText: 'invalid token',
      nowMs: 1_001,
    })).toBe(false);
  });
});
