import { beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeChannelAffinityConfig,
  recordChannelAffinitySuccess,
  resetChannelAffinityState,
  resolveChannelAffinityRequest,
} from './channelAffinity.js';

describe('channelAffinity', () => {
  beforeEach(() => {
    resetChannelAffinityState();
  });

  it('extracts a body-path affinity key, hashes it, and isolates bindings by group/model/rule', () => {
    const affinity = normalizeChannelAffinityConfig({
      enabled: true,
      switchOnSuccess: true,
      defaultTtlSeconds: 3600,
      maxEntries: 100,
      rules: [
        {
          name: 'responses-prompt-cache',
          modelRegex: ['^gpt-5'],
          pathRegex: ['^/v1/responses$'],
          keySources: [{ type: 'body_path', path: 'prompt_cache_key' }],
          includeGroup: true,
          includeModel: true,
          includeRule: true,
        },
      ],
    });

    const first = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      headers: {},
      body: { prompt_cache_key: 'pc-hit-001' },
      downstreamGroup: 'team-a',
      downstreamApiKeyId: 7,
    });

    expect(first).toMatchObject({
      ruleName: 'responses-prompt-cache',
      preferredChannelId: null,
      skipRetryOnFailure: false,
      selectedGroup: 'team-a',
    });
    expect(first?.cacheKey).toContain('group:team-a');
    expect(first?.cacheKey).toContain('model:gpt-5.4');
    expect(first?.cacheKey).toContain('rule:responses-prompt-cache');
    expect(first?.cacheKey).not.toContain('pc-hit-001');

    recordChannelAffinitySuccess({
      config: affinity,
      resolution: first,
      selectedChannelId: 11,
    });

    const second = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      headers: {},
      body: { prompt_cache_key: 'pc-hit-001' },
      downstreamGroup: 'team-a',
      downstreamApiKeyId: 7,
    });
    const otherGroup = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      headers: {},
      body: { prompt_cache_key: 'pc-hit-001' },
      downstreamGroup: 'team-b',
      downstreamApiKeyId: 8,
    });
    const otherModel = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-4.1',
      downstreamPath: '/v1/responses',
      headers: {},
      body: { prompt_cache_key: 'pc-hit-001' },
      downstreamGroup: 'team-a',
      downstreamApiKeyId: 7,
    });

    expect(second?.preferredChannelId).toBe(11);
    expect(otherGroup?.preferredChannelId).toBeNull();
    expect(otherModel).toBeNull();
  });

  it('updates the binding to the successful failover channel when switch-on-success is enabled', () => {
    const affinity = normalizeChannelAffinityConfig({
      enabled: true,
      switchOnSuccess: true,
      rules: [
        {
          name: 'responses-prompt-cache',
          modelRegex: ['^gpt-5'],
          pathRegex: ['^/v1/responses$'],
          keySources: [{ type: 'body_path', path: 'prompt_cache_key' }],
          skipRetryOnFailure: true,
        },
      ],
    });

    const initial = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      headers: {},
      body: { prompt_cache_key: 'pc-switch-success' },
      downstreamGroup: 'global',
    });
    recordChannelAffinitySuccess({ config: affinity, resolution: initial, selectedChannelId: 11 });

    const cached = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      headers: {},
      body: { prompt_cache_key: 'pc-switch-success' },
      downstreamGroup: 'global',
    });
    expect(cached?.preferredChannelId).toBe(11);
    expect(cached?.skipRetryOnFailure).toBe(true);

    recordChannelAffinitySuccess({ config: affinity, resolution: cached, selectedChannelId: 12 });

    const updated = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      headers: {},
      body: { prompt_cache_key: 'pc-switch-success' },
      downstreamGroup: 'global',
    });
    expect(updated?.preferredChannelId).toBe(12);
  });

  it('keeps the original binding after failover success when switch-on-success is disabled', () => {
    const affinity = normalizeChannelAffinityConfig({
      enabled: true,
      switchOnSuccess: false,
      rules: [
        {
          name: 'responses-prompt-cache',
          modelRegex: ['^gpt-5'],
          pathRegex: ['^/v1/responses$'],
          keySources: [{ type: 'header', key: 'x-affinity-key' }],
        },
      ],
    });

    const initial = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      headers: { 'x-affinity-key': 'header-affinity-1' },
      body: {},
      downstreamGroup: 'global',
    });
    recordChannelAffinitySuccess({ config: affinity, resolution: initial, selectedChannelId: 21 });

    const cached = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      headers: { 'x-affinity-key': 'header-affinity-1' },
      body: {},
      downstreamGroup: 'global',
    });
    expect(cached?.preferredChannelId).toBe(21);

    recordChannelAffinitySuccess({ config: affinity, resolution: cached, selectedChannelId: 22 });

    const afterFailover = resolveChannelAffinityRequest({
      config: affinity,
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      headers: { 'x-affinity-key': 'header-affinity-1' },
      body: {},
      downstreamGroup: 'global',
    });
    expect(afterFailover?.preferredChannelId).toBe(21);
  });
});
