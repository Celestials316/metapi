import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeChannelAffinityConfig,
  recordChannelAffinitySuccess,
  resetChannelAffinityState,
  resolveChannelAffinityRequest,
} from './channelAffinity.js';
import {
  resetResponsesContinuityStore,
  setStoredSessionResponseId,
  setStoredStickyChannelBinding,
} from './responsesContinuityStore.js';
import {
  recordAccountDispatchFailure,
  resetAccountDispatchRuntimeMemory,
} from './accountDispatchRuntimeMemory.js';
import {
  clearProxyOpsRuntimeState,
  getProxyOpsRuntimeStateSnapshot,
} from './proxyOpsRuntimeStateService.js';

describe('proxyOpsRuntimeStateService', () => {
  beforeEach(() => {
    resetChannelAffinityState();
    resetResponsesContinuityStore();
    resetAccountDispatchRuntimeMemory();
  });

  afterEach(() => {
    resetChannelAffinityState();
    resetResponsesContinuityStore();
    resetAccountDispatchRuntimeMemory();
  });

  it('returns affinity, continuity, and suppression snapshots for minimal ops inspection', async () => {
    const nowMs = Date.now();
    const affinity = normalizeChannelAffinityConfig({
      enabled: true,
      rules: [{
        name: 'responses-prompt-cache',
        pathRegex: ['^/v1/responses$'],
        keySources: [{ type: 'body_path', path: 'prompt_cache_key' }],
      }],
    });
    const resolution = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      headers: {},
      body: { prompt_cache_key: 'raw-affinity-value' },
      downstreamGroup: 'global',
    });
    recordChannelAffinitySuccess({ config: affinity, resolution, selectedChannelId: 11 });

    setStoredSessionResponseId('sess:1', 'resp-1', nowMs);
    setStoredStickyChannelBinding({ key: 'sticky:1', channelId: 22, expiresAtMs: nowMs + 50_000, nowMs });
    recordAccountDispatchFailure({ routeId: 7, modelName: 'gpt-5.4', accountId: 33, kind: 'hard', reason: 'auth_invalid', nowMs });

    const snapshot = await getProxyOpsRuntimeStateSnapshot({ nowMs: nowMs + 1_000 });

    expect(snapshot.channelAffinity.total).toBe(1);
    expect(snapshot.channelAffinity.entries[0]).toMatchObject({ channelId: 11 });
    expect(snapshot.channelAffinity.entries[0].cacheKey).toContain('channel-affinity:v1');
    expect(snapshot.channelAffinity.entries[0].cacheKey).not.toContain('raw-affinity-value');
    expect(snapshot.continuity.sessionAnchors).toEqual([
      expect.objectContaining({ handle: expect.any(String), responseIdHash: expect.any(String) }),
    ]);
    expect(snapshot.continuity.stickyBindings).toEqual([
      expect.objectContaining({ handle: expect.any(String), channelId: 22 }),
    ]);
    expect(snapshot.suppression.total).toBe(1);
    expect(snapshot.suppression.entries[0]).toMatchObject({
      accountId: 33,
      suppressionReason: 'auth_invalid',
    });
    expect(JSON.stringify(snapshot)).not.toContain('resp-1');
    expect(JSON.stringify(snapshot)).not.toContain('sess:1');
    expect(JSON.stringify(snapshot)).not.toContain('7:gpt-5.4:33');
  });

  it('clears requested affinity, continuity, and suppression state entries', async () => {
    const nowMs = Date.now();
    const affinity = normalizeChannelAffinityConfig({
      enabled: true,
      rules: [{
        name: 'responses-prompt-cache',
        pathRegex: ['^/v1/responses$'],
        keySources: [{ type: 'body_path', path: 'prompt_cache_key' }],
      }],
    });
    const resolution = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      headers: {},
      body: { prompt_cache_key: 'clear-me' },
      downstreamGroup: 'global',
    });
    recordChannelAffinitySuccess({ config: affinity, resolution, selectedChannelId: 11 });
    setStoredSessionResponseId('sess:clear', 'resp-clear', nowMs);
    setStoredStickyChannelBinding({ key: 'sticky:clear', channelId: 22, expiresAtMs: nowMs + 50_000, nowMs });
    recordAccountDispatchFailure({ routeId: 7, modelName: 'gpt-5.4', accountId: 44, kind: 'hard', reason: 'auth_invalid', nowMs });

    const before = await getProxyOpsRuntimeStateSnapshot({ nowMs: nowMs + 1_000 });
    const cleared = await clearProxyOpsRuntimeState({
      affinity: { cacheKeys: [before.channelAffinity.entries[0].cacheKey] },
      continuity: {
        sessionAnchorHandles: [before.continuity.sessionAnchors[0].handle],
        stickyHandles: [before.continuity.stickyBindings[0].handle],
      },
      suppression: { accountIds: [44] },
    });

    expect(cleared.cleared).toEqual({
      channelAffinity: 1,
      sessionAnchors: 1,
      stickyBindings: 1,
      suppression: 1,
    });

    const after = await getProxyOpsRuntimeStateSnapshot({ nowMs: nowMs + 1_000 });
    expect(after.channelAffinity.total).toBe(0);
    expect(after.continuity.sessionAnchors).toHaveLength(0);
    expect(after.continuity.stickyBindings).toHaveLength(0);
    expect(after.suppression.total).toBe(0);
  });
});
