import { describe, expect, it } from 'vitest';
import { normalizeCodexResponsesBodyForProxy } from './codexCompatibility.js';

describe('normalizeCodexResponsesBodyForProxy', () => {
  it('normalizes codex responses bodies before proxying upstream', () => {
    const body = normalizeCodexResponsesBodyForProxy({
      input: [
        {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: 'be precise' }],
        },
      ],
      max_output_tokens: 512,
      max_completion_tokens: 256,
      max_tokens: 128,
      metadata: { trace: 'drop-me' },
      user: 'drop-me',
      service_tier: 'auto',
      temperature: 0.3,
      store: true,
    }, { sitePlatform: 'codex' });

    expect(body).toEqual({
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'be precise' }],
        },
      ],
      instructions: '',
      store: false,
      temperature: 0.3,
    });
  });

  it('keeps supported continuity fields while stripping codex-incompatible wrappers', () => {
    const body = normalizeCodexResponsesBodyForProxy({
      previous_response_id: 'resp_prev_1',
      include: ['reasoning.encrypted_content', 'mcp_approval_request.details'],
      parallel_tool_calls: false,
      prompt_cache_retention: { scope: 'workspace' },
      metadata: { trace: 'drop-me' },
      user: 'drop-me',
      service_tier: 'auto',
      input: 'hello',
    }, { sitePlatform: 'codex' });

    expect(body).toEqual({
      previous_response_id: 'resp_prev_1',
      include: ['reasoning.encrypted_content', 'mcp_approval_request.details'],
      parallel_tool_calls: false,
      instructions: '',
      store: false,
      input: 'hello',
    });
  });

  it('leaves non-codex bodies untouched', () => {
    const source = {
      input: 'hello',
      max_output_tokens: 512,
    };

    const body = normalizeCodexResponsesBodyForProxy(source, { sitePlatform: 'openai' });

    expect(body).toBe(source);
  });

  it('normalizes openai-site responses bodies for downstream codex clients', () => {
    const body = normalizeCodexResponsesBodyForProxy({
      input: [
        {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: 'be precise' }],
        },
      ],
      max_output_tokens: 256,
      store: true,
    }, {
      sitePlatform: 'openai',
      downstreamClientKind: 'codex',
    });

    expect(body).toEqual({
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'be precise' }],
        },
      ],
      instructions: '',
      store: false,
    });
  });
});
