import { describe, expect, it } from 'vitest';

import {
  OAUTH_REFRESH_LEASE_TTL_MS,
  OAUTH_REFRESH_POST_LEASE_GRACE_MS,
  OAUTH_REFRESH_WAIT_POLL_MS,
  OAUTH_REFRESH_WAIT_TIMEOUT_MS,
} from './refreshGovernance.js';

describe('oauth refresh governance constants', () => {
  it('allows remote wait timeout to outlive a valid refresh lease', () => {
    expect(OAUTH_REFRESH_WAIT_TIMEOUT_MS).toBeGreaterThan(OAUTH_REFRESH_LEASE_TTL_MS);
  });

  it('keeps a post-lease settle window for late remote success persistence', () => {
    expect(OAUTH_REFRESH_POST_LEASE_GRACE_MS).toBeGreaterThanOrEqual(OAUTH_REFRESH_WAIT_POLL_MS);
  });

  it('keeps wait polling cadence below the overall wait timeout', () => {
    expect(OAUTH_REFRESH_WAIT_POLL_MS).toBeGreaterThan(0);
    expect(OAUTH_REFRESH_WAIT_POLL_MS).toBeLessThan(OAUTH_REFRESH_WAIT_TIMEOUT_MS);
  });
});
