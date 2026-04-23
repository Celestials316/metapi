import { describe, expect, it } from 'vitest';
import { __routeDecisionSnapshotStoreTestUtils, parseRouteDecisionSnapshot } from './routeDecisionSnapshotStore.js';

describe('routeDecisionSnapshotStore', () => {
  it('accepts parsed decision snapshot objects', () => {
    expect(parseRouteDecisionSnapshot({
      matched: true,
      candidates: [{ routeId: 1 }],
    })).toEqual({
      matched: true,
      candidates: [{ routeId: 1 }],
    });
  });

  it('sanitizes secret-like fields before serializing route decision snapshots', () => {
    expect(__routeDecisionSnapshotStoreTestUtils.serializeSnapshot({
      matched: true,
      candidates: [{ routeId: 1, tokenValue: 'sk-secret' }],
      debug: {
        authorization: 'Bearer token',
        nested: { api_key: 'sk-live-123' },
      },
    })).toBe(JSON.stringify({
      matched: true,
      candidates: [{ routeId: 1, tokenValue: '[redacted]' }],
      debug: {
        authorization: '[redacted]',
        nested: { api_key: '[redacted]' },
      },
    }));
  });
});
