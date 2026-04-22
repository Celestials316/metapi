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
});
