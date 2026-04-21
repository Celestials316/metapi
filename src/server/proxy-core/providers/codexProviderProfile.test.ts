import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { codexProviderProfile, prepareCodexCompatibleOpenAiResponsesRequest } from './codexProviderProfile.js';

const originalCodexHeaderDefaults = {
  userAgent: config.codexHeaderDefaults.userAgent,
  betaFeatures: config.codexHeaderDefaults.betaFeatures,
};

afterEach(() => {
  config.codexHeaderDefaults = { ...originalCodexHeaderDefaults };
});

describe('codexProviderProfile', () => {
  it('uses the official codex header template for native codex responses requests', () => {
    config.codexHeaderDefaults = {
      ...config.codexHeaderDefaults,
      userAgent: 'codex_cli_rs/9.9.9 (Test OS 1.0; x64) TestTerminal/1',
    };

    const prepared = codexProviderProfile.prepareRequest({
      endpoint: 'responses',
      modelName: 'gpt-5.4',
      stream: true,
      tokenValue: 'token',
      baseHeaders: {
        authorization: 'Bearer downstream-token',
        'user-agent': 'OpenAI/Python 2.31.0',
      },
      body: {
        model: 'gpt-5.4',
        input: 'hello',
        stream: true,
      },
    });

    expect(prepared.headers.Authorization).toBe('Bearer downstream-token');
    expect(prepared.headers['User-Agent']).toBe('codex_cli_rs/9.9.9 (Test OS 1.0; x64) TestTerminal/1');
    expect(prepared.headers.Originator).toBe('codex_cli_rs');
    expect(prepared.headers.Version).toBe('0.101.0');
    expect(prepared.headers['OpenAI-Beta']).toBe('responses=experimental');
  });

  it('keeps explicit downstream openai-beta values when preparing native codex requests', () => {
    const prepared = codexProviderProfile.prepareRequest({
      endpoint: 'responses',
      modelName: 'gpt-5.4',
      stream: false,
      tokenValue: 'token',
      baseHeaders: {
        authorization: 'Bearer downstream-token',
        'openai-beta': 'responses-2025-03-11',
      },
      body: {
        model: 'gpt-5.4',
        input: 'hello',
        stream: false,
      },
    });

    expect(prepared.headers['OpenAI-Beta']).toBe('responses-2025-03-11');
    expect(prepared.headers.Accept).toBe('application/json');
  });

  it('still forces codex-compatible openai responses requests onto the official codex template', () => {
    config.codexHeaderDefaults = {
      ...config.codexHeaderDefaults,
      userAgent: 'codex_cli_rs/8.8.8 (Compat OS 1.0; x64) TestTerminal/2',
    };

    const prepared = prepareCodexCompatibleOpenAiResponsesRequest({
      endpoint: 'responses',
      modelName: 'gpt-5.4',
      stream: true,
      tokenValue: 'token',
      pathOverride: '/v1/responses',
      baseHeaders: {
        authorization: 'Bearer downstream-token',
        'user-agent': 'OpenAI/Python 2.31.0',
      },
      body: {
        model: 'gpt-5.4',
        input: 'hello',
        stream: true,
      },
    });

    expect(prepared.headers['User-Agent']).toBe('codex_cli_rs/8.8.8 (Compat OS 1.0; x64) TestTerminal/2');
    expect(prepared.headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(prepared.headers.Originator).toBe('codex_cli_rs');
    expect(prepared.runtime.executor).toBe('default');
  });
});
