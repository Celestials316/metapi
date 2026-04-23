import { beforeEach, describe, expect, it } from 'vitest';

import {
  getProxyActiveRuntimeSnapshots,
  resetProxyActiveRuntimeRegistry,
} from '../../../services/proxyActiveRuntimeRegistry.js';
import { createChatProxyStreamSession } from './proxyStream.js';

describe('createChatProxyStreamSession', () => {
  beforeEach(() => {
    resetProxyActiveRuntimeRegistry();
  });

  it('registers and completes active runtime on clean EOF', async () => {
    const lines: string[] = [];
    let ended = false;
    const chunk = [
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
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

    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/chat/completions',
      runtimeTraceId: 101,
      downstreamPath: '/v1/chat/completions',
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: (chunkText) => {
        lines.push(chunkText);
      },
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({ status: 'completed', errorMessage: null });
    expect(ended).toBe(true);
    expect(lines.join('')).toContain('data: [DONE]');
    expect(getProxyActiveRuntimeSnapshots()).toEqual([
      expect.objectContaining({
        traceId: 101,
        downstreamPath: '/v1/chat/completions',
        stage: 'completed',
        firstByteAtMs: expect.any(Number),
        finalizedAtMs: expect.any(Number),
      }),
    ]);
  });

  it('marks active runtime failed when upstream emits failure payload', async () => {
    const lines: string[] = [];
    let ended = false;
    const chunk = [
      'event: response.failed',
      'data: {"type":"response.failed","error":{"message":"boom"}}',
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

    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      runtimeTraceId: 102,
      downstreamPath: '/v1/chat/completions',
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: (chunkText) => {
        lines.push(chunkText);
      },
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({ status: 'failed', errorMessage: 'boom' });
    expect(ended).toBe(true);
    expect(getProxyActiveRuntimeSnapshots()).toEqual([
      expect.objectContaining({
        traceId: 102,
        stage: 'failed',
        finalizedAtMs: expect.any(Number),
      }),
    ]);
  });
});
