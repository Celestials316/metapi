import { afterEach, describe, expect, it } from 'vitest';

import { config } from './config.js';
import { normalizeChannelAffinityConfig } from './services/channelAffinity.js';
import { applyRuntimeSettings } from './runtimeSettingsHydration.js';

const originalConfig = structuredClone(config);

afterEach(() => {
  Object.assign(config, structuredClone(originalConfig));
});

describe('applyRuntimeSettings', () => {
  it('hydrates persisted runtime settings that should survive restarts', () => {
    config.disableCrossProtocolFallback = false;
    config.responsesCompactFallbackToResponsesEnabled = false;
    config.webhookEnabled = true;
    config.barkEnabled = true;
    config.serverChanEnabled = true;
    config.globalAllowedModels = [];

    applyRuntimeSettings(new Map([
      ['disable_cross_protocol_fallback', JSON.stringify(true)],
      ['responses_compact_fallback_to_responses_enabled', JSON.stringify(true)],
      ['token_router_pending_overload_cooldown_sec', JSON.stringify(75)],
      ['token_router_timeout_cooldown_sec', JSON.stringify(180)],
      ['webhook_enabled', JSON.stringify(false)],
      ['bark_enabled', JSON.stringify(false)],
      ['serverchan_enabled', JSON.stringify(false)],
      ['global_allowed_models', JSON.stringify(['gpt-5.4', ' claude-3.7-sonnet '])],
    ]));

    expect(config.disableCrossProtocolFallback).toBe(true);
    expect(config.responsesCompactFallbackToResponsesEnabled).toBe(true);
    expect(config.tokenRouterPendingOverloadCooldownSec).toBe(75);
    expect(config.tokenRouterTimeoutCooldownSec).toBe(180);
    expect(config.webhookEnabled).toBe(false);
    expect(config.barkEnabled).toBe(false);
    expect(config.serverChanEnabled).toBe(false);
    expect(config.globalAllowedModels).toEqual(['gpt-5.4', 'claude-3.7-sonnet']);
  });

  it('normalizes smtpPort to a positive integer during hydration', () => {
    config.smtpPort = 587;

    applyRuntimeSettings(new Map([
      ['smtp_port', JSON.stringify(587.9)],
    ]));

    expect(config.smtpPort).toBe(587);
  });

  it('hydrates channel affinity config during restart recovery', () => {
    config.channelAffinity = normalizeChannelAffinityConfig({ enabled: false, rules: [] });

    applyRuntimeSettings(new Map([
      ['channel_affinity', JSON.stringify({
        enabled: true,
        rules: [{
          name: 'responses-prompt-cache',
          pathRegex: ['^/v1/responses$'],
          keySources: [{ type: 'body_path', path: 'prompt_cache_key' }],
          ttlSeconds: 1800,
          skipRetryOnFailure: true,
        }],
      })],
    ]));

    expect(config.channelAffinity.enabled).toBe(true);
    expect(config.channelAffinity.rules).toHaveLength(1);
    expect(config.channelAffinity.rules[0]).toMatchObject({
      name: 'responses-prompt-cache',
      ttlSeconds: 1800,
      skipRetryOnFailure: true,
    });
  });

  it('normalizes and validates pending-overload cooldown during hydration', () => {
    config.tokenRouterPendingOverloadCooldownSec = 30;
    config.tokenRouterTimeoutCooldownSec = 90;

    applyRuntimeSettings(new Map([
      ['token_router_pending_overload_cooldown_sec', JSON.stringify(12.9)],
    ]));
    expect(config.tokenRouterPendingOverloadCooldownSec).toBe(12);

    applyRuntimeSettings(new Map([
      ['token_router_pending_overload_cooldown_sec', JSON.stringify(0)],
    ]));
    expect(config.tokenRouterPendingOverloadCooldownSec).toBe(12);

    applyRuntimeSettings(new Map([
      ['token_router_timeout_cooldown_sec', JSON.stringify(180.9)],
    ]));
    expect(config.tokenRouterTimeoutCooldownSec).toBe(180);

    applyRuntimeSettings(new Map([
      ['token_router_timeout_cooldown_sec', JSON.stringify(0)],
    ]));
    expect(config.tokenRouterTimeoutCooldownSec).toBe(180);
  });
});
