import { beforeEach, describe, expect, it } from 'vitest';

import {
  getProxyActiveRuntimeSnapshots,
  resetProxyActiveRuntimeRegistry,
} from '../../../services/proxyActiveRuntimeRegistry.js';
import { createResponsesProxyStreamSession } from './proxyStream.js';

describe('createResponsesProxyStreamSession', () => {
  beforeEach(() => {
    resetProxyActiveRuntimeRegistry();
  });

  it('serializes non-SSE fallback payloads into canonical responses SSE closeout events', () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const payload = {
      id: 'resp_fallback_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-5.2',
      output_text: 'hello from responses upstream',
      output: [
        {
          id: 'msg_fallback_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from responses upstream' }],
        },
      ],
      usage: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5.2',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = session.consumeUpstreamFinalPayload(
      payload,
      JSON.stringify(payload),
      {
        end() {
          ended = true;
        },
      },
    );

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);

    const output = lines.join('');
    expect(output).toContain('event: response.created');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('"type":"response.completed"');
    expect(output).toContain('"output_text":"hello from responses upstream"');
    expect(output).toContain('data: [DONE]');
  });

  it('preserves the canonical [DONE] terminator after an explicit response.completed SSE event', async () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const chunk = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_stream_1","model":"gpt-5","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);
    const output = lines.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('data: [DONE]');
  });

  it('treats downgraded chat-completions finish_reason terminals as completed when native responses terminals are absent', async () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const chunk = [
      'data: {"id":"chatcmpl_fallback_1","model":"gpt-5","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_fallback_1","model":"gpt-5","choices":[{"delta":{"content":"hello from fallback"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_fallback_1","model":"gpt-5","choices":[{"delta":{},"finish_reason":"stop"}]}',
      '',
    ].join('\n');

    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);
    const output = lines.join('');
    expect(output).toContain('event: response.output_text.delta');
    expect(output).toContain('event: response.completed');
    expect(output).not.toContain('event: response.failed');
    expect(output).toContain('data: [DONE]');
  });

  it('preserves response.incomplete SSE terminals instead of coercing them to response.failed', async () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const chunk = [
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"id":"resp_incomplete_1","model":"gpt-5","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);
    const output = lines.join('');
    expect(output).toContain('event: response.incomplete');
    expect(output).toContain('"status":"incomplete"');
    expect(output).toContain('"incomplete_details":{"reason":"max_output_tokens"}');
    expect(output).not.toContain('event: response.failed');
    expect(output).toContain('data: [DONE]');
  });

  it('preserves non-SSE incomplete fallback payloads as response.incomplete', () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const payload = {
      id: 'resp_incomplete_fallback_1',
      object: 'response',
      status: 'incomplete',
      incomplete_details: {
        reason: 'max_output_tokens',
      },
      model: 'gpt-5.2',
      output_text: 'partial answer',
      output: [
        {
          id: 'msg_incomplete_1',
          type: 'message',
          role: 'assistant',
          status: 'incomplete',
          content: [{ type: 'output_text', text: 'partial answer' }],
        },
      ],
      usage: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5.2',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = session.consumeUpstreamFinalPayload(
      payload,
      JSON.stringify(payload),
      {
        end() {
          ended = true;
        },
      },
    );

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);

    const output = lines.join('');
    expect(output).toContain('event: response.incomplete');
    expect(output).toContain('"status":"incomplete"');
    expect(output).toContain('"output_text":"partial answer"');
    expect(output).not.toContain('event: response.completed');
    expect(output).toContain('data: [DONE]');
  });

  it('tracks active runtime through streaming activity and idle timeout failure', async () => {
    const lines: string[] = [];
    let ended = false;

    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { done: false, value: new Uint8Array() };
        }
        this.reads += 1;
        return {
          done: false,
          value: new TextEncoder().encode([
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"hello"}',
            '',
          ].join('\n')),
        };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      runtimeTraceId: 201,
      downstreamPath: '/v1/responses',
      idleTimeoutMs: 5,
      getUsage: () => ({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: null,
      }),
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({
      status: 'failed',
      errorMessage: 'stream idle timeout',
    });
    expect(ended).toBe(true);
    expect(lines.join('')).toContain('stream idle timeout');
    expect(getProxyActiveRuntimeSnapshots()).toEqual([
      expect.objectContaining({
        traceId: 201,
        downstreamPath: '/v1/responses',
        stage: 'failed',
        firstByteAtMs: expect.any(Number),
        finalizedAtMs: expect.any(Number),
      }),
    ]);
  });

  it('tracks active runtime to completed on clean streamed EOF', async () => {
    const lines: string[] = [];
    let ended = false;
    const chunk = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_stream_2","model":"gpt-5","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      runtimeTraceId: 202,
      downstreamPath: '/v1/responses',
      getUsage: () => ({
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: null,
      }),
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({ status: 'completed', errorMessage: null });
    expect(ended).toBe(true);
    expect(lines.join('')).toContain('event: response.completed');
    expect(getProxyActiveRuntimeSnapshots()).toEqual([
      expect.objectContaining({
        traceId: 202,
        stage: 'completed',
        firstByteAtMs: expect.any(Number),
        finalizedAtMs: expect.any(Number),
      }),
    ]);
  });
});
