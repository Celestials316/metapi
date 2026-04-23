import { describe, expect, it } from 'vitest';
import { classifyProxyFailure } from './proxyFailureTaxonomy.js';

describe('proxyFailureTaxonomy', () => {
  it('classifies pending request overload as a dedicated retryable failure', () => {
    expect(
      classifyProxyFailure({
        status: 429,
        errorMessage: 'Too many pending requests, please retry later',
      }).className,
    ).toBe('pending_overload');

    expect(
      classifyProxyFailure({
        status: 503,
        errorMessage: 'pending overload',
      }).className,
    ).toBe('pending_overload');
  });

  it('keeps generic rate limit distinct from pending overload', () => {
    expect(
      classifyProxyFailure({
        status: 429,
        errorMessage: 'rate limit exceeded',
      }).className,
    ).toBe('rate_limit');
  });

  it('classifies upstream processing errors as a dedicated retryable failure bucket', () => {
    expect(
      classifyProxyFailure({
        status: 500,
        errorMessage: 'An error occurred while processing your request',
      }),
    ).toMatchObject({
      className: 'processing_error',
      retryable: true,
      title: '上游处理错误',
    });

    expect(
      classifyProxyFailure({
        status: 429,
        errorMessage: 'processing error',
      }).className,
    ).toBe('processing_error');
  });

  it('treats interrupted response streams as timeout failures', () => {
    expect(
      classifyProxyFailure({
        status: 502,
        errorMessage: 'stream closed before response.completed',
      }),
    ).toMatchObject({
      className: 'timeout',
      retryable: true,
    });
  });
});
