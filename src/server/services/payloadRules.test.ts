import { describe, expect, it } from 'vitest';
import {
  applyPayloadHeaderRules,
  createEmptyPayloadRulesConfig,
  mapPayloadStatusCode,
  normalizePayloadRulesConfig,
} from './payloadRules.js';

describe('payloadRules override hub extensions', () => {
  it('normalizes header override, header filter, and status mapping rules', () => {
    const rules = normalizePayloadRulesConfig({
      'header-override': [
        {
          models: [{ name: 'gpt-*', protocol: 'codex' }],
          endpoints: ['responses'],
          headers: {
            'X-Test-Header': 'applied',
            '': 'ignored',
          },
        },
      ],
      'header-filter': [
        {
          models: [{ name: 'gpt-*', protocol: 'codex' }],
          headers: ['Authorization'],
        },
      ],
      'status-code-map': [
        {
          models: [{ name: 'gpt-*', protocol: 'codex' }],
          endpoints: ['responses'],
          from: [529, '530', 99],
          to: 503,
        },
      ],
    });

    expect(rules.headerOverride).toEqual([
      {
        models: [{ name: 'gpt-*', protocol: 'codex' }],
        endpoints: ['responses'],
        headers: { 'X-Test-Header': 'applied' },
      },
    ]);
    expect(rules.headerFilter).toEqual([
      {
        models: [{ name: 'gpt-*', protocol: 'codex' }],
        headers: ['Authorization'],
      },
    ]);
    expect(rules.statusCodeMap).toEqual([
      {
        models: [{ name: 'gpt-*', protocol: 'codex' }],
        endpoints: ['responses'],
        from: [529, 530],
        to: 503,
      },
    ]);
  });

  it('applies header overrides and filters case-insensitively after model and endpoint matching', () => {
    const rules = normalizePayloadRulesConfig({
      headerOverride: [
        {
          models: [{ name: 'gpt-5.4', protocol: 'codex' }],
          endpoints: ['responses'],
          headers: {
            'User-Agent': 'ops-hotfix/1.0',
            'X-Ops-Route': 'codex-hotfix',
          },
        },
      ],
      headerFilter: [
        {
          models: [{ name: 'gpt-5.4', protocol: 'codex' }],
          endpoints: ['responses'],
          headers: ['authorization'],
        },
      ],
    });

    const headers = applyPayloadHeaderRules({
      rules,
      headers: {
        authorization: 'Bearer keep-me-out',
        'user-agent': 'client/1.0',
        accept: 'application/json',
      },
      modelName: 'gpt-5.4',
      requestedModel: 'gpt-5.4',
      protocol: 'codex',
      endpoint: 'responses',
    });

    expect(headers).toEqual({
      'User-Agent': 'ops-hotfix/1.0',
      accept: 'application/json',
      'X-Ops-Route': 'codex-hotfix',
    });
  });

  it('maps configured failure status codes by model, protocol, and endpoint', () => {
    const rules = normalizePayloadRulesConfig({
      statusCodeMap: [
        {
          models: [{ name: 'gpt-*', protocol: 'codex' }],
          endpoints: ['responses'],
          from: [529, 530],
          to: 503,
        },
      ],
    });

    expect(mapPayloadStatusCode({
      rules,
      status: 529,
      modelName: 'gpt-5.4',
      requestedModel: 'gpt-5.4',
      protocol: 'codex',
      endpoint: 'responses',
    })).toBe(503);

    expect(mapPayloadStatusCode({
      rules,
      status: 529,
      modelName: 'gpt-5.4',
      requestedModel: 'gpt-5.4',
      protocol: 'codex',
      endpoint: 'chat',
    })).toBe(529);
  });

  it('keeps empty config backward compatible', () => {
    expect(createEmptyPayloadRulesConfig()).toEqual({
      default: [],
      defaultRaw: [],
      override: [],
      overrideRaw: [],
      filter: [],
      headerOverride: [],
      headerFilter: [],
      statusCodeMap: [],
    });
  });
});
