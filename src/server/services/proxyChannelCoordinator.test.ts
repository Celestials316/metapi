import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import {
  ensureProxyChannelCoordinatorStateLoaded,
  flushProxyChannelCoordinatorStatePersistence,
  proxyChannelCoordinator,
  resetProxyChannelCoordinatorState,
} from './proxyChannelCoordinator.js';

describe('proxyChannelCoordinator', () => {
  let dataDir = '';
  const originalStickyEnabled = config.proxyStickySessionEnabled;
  const originalStickyTtlMs = config.proxyStickySessionTtlMs;
  const originalConcurrencyLimit = config.proxySessionChannelConcurrencyLimit;
  const originalQueueWaitMs = config.proxySessionChannelQueueWaitMs;
  const originalLeaseTtlMs = config.proxySessionChannelLeaseTtlMs;
  const originalLeaseKeepaliveMs = config.proxySessionChannelLeaseKeepaliveMs;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sticky-continuity-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
  });

  beforeEach(() => {
    vi.useFakeTimers();
    config.proxyStickySessionEnabled = true;
    config.proxyStickySessionTtlMs = 31_000;
    config.proxySessionChannelConcurrencyLimit = 1;
    config.proxySessionChannelQueueWaitMs = 200;
    config.proxySessionChannelLeaseTtlMs = 100;
    config.proxySessionChannelLeaseKeepaliveMs = 30;
    resetProxyChannelCoordinatorState();
  });

  afterEach(() => {
    config.proxyStickySessionEnabled = originalStickyEnabled;
    config.proxyStickySessionTtlMs = originalStickyTtlMs;
    config.proxySessionChannelConcurrencyLimit = originalConcurrencyLimit;
    config.proxySessionChannelQueueWaitMs = originalQueueWaitMs;
    config.proxySessionChannelLeaseTtlMs = originalLeaseTtlMs;
    config.proxySessionChannelLeaseKeepaliveMs = originalLeaseKeepaliveMs;
    resetProxyChannelCoordinatorState();
    vi.useRealTimers();
  });

  afterAll(() => {
    resetProxyChannelCoordinatorState();
    delete process.env.DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('includes the continuity key when building sticky session bindings', () => {
    const keyA = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-123',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
      continuityKey: 'resp-1',
    } as never);
    const keyB = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-123',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
      continuityKey: 'resp-2',
    } as never);

    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain('turn-123');
    expect(keyA).toContain('resp-1');
    expect(keyB).toContain('resp-2');
  });

  it('allows content-derived synthetic session ids to participate in sticky bindings', () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'content-seed:responses:sha256:abc123',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
      continuityKey: 'responses:sha256:abc123',
    } as never);

    expect(key).toContain('content-seed:responses:sha256:abc123');
    expect(key).toContain('responses:sha256:abc123');
  });

  it('stores sticky bindings for session-scoped channels and expires them by ttl', async () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-123',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    proxyChannelCoordinator.bindStickyChannel(key, 42, JSON.stringify({ credentialMode: 'session' }));
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(42);

    await vi.advanceTimersByTimeAsync(31_100);
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBeNull();
  });

  it('persists sticky bindings across a reset and reload while they remain fresh', async () => {
    await ensureProxyChannelCoordinatorStateLoaded();
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-persist',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    proxyChannelCoordinator.bindStickyChannel(key, 84, JSON.stringify({ credentialMode: 'session' }));
    await flushProxyChannelCoordinatorStatePersistence();

    resetProxyChannelCoordinatorState();
    await ensureProxyChannelCoordinatorStateLoaded();

    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(84);
  });

  it('does not store sticky bindings for apikey-only channels', () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-456',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    proxyChannelCoordinator.bindStickyChannel(key, 42, JSON.stringify({ credentialMode: 'apikey' }));
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBeNull();
  });

  it('treats structured oauth providers as session-scoped even when extraConfig omits oauth.provider', () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-oauth-structured',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    proxyChannelCoordinator.bindStickyChannel(key, 42, {
      oauthProvider: 'codex',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(42);
  });

  it('clears sticky bindings by channel ids in bulk', () => {
    const keyA = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-a',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });
    const keyB = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-b',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });
    const keyC = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-c',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    proxyChannelCoordinator.bindStickyChannel(keyA, 42, JSON.stringify({ credentialMode: 'session' }));
    proxyChannelCoordinator.bindStickyChannel(keyB, 43, JSON.stringify({ credentialMode: 'session' }));
    proxyChannelCoordinator.bindStickyChannel(keyC, 99, JSON.stringify({ credentialMode: 'session' }));

    proxyChannelCoordinator.clearStickyChannelsByChannelIds([42, 43]);

    expect(proxyChannelCoordinator.getStickyChannelId(keyA)).toBeNull();
    expect(proxyChannelCoordinator.getStickyChannelId(keyB)).toBeNull();
    expect(proxyChannelCoordinator.getStickyChannelId(keyC)).toBe(99);
  });

  it('queues requests behind the active lease and grants the next waiter after release', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    let secondSettled = false;
    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).then((result) => {
      secondSettled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(secondSettled).toBe(false);

    first.lease.release();
    await vi.advanceTimersByTimeAsync(0);

    const second = await secondPromise;
    expect(second.status).toBe('acquired');
    if (second.status === 'acquired') {
      second.lease.release();
    }
  });

  it('times out queued requests when no slot becomes available', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(secondPromise).resolves.toEqual({
      status: 'timeout',
      waitMs: 200,
    });

    first.lease.release();
  });

  it('keeps active leases alive until they are explicitly released', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    let secondSettled = false;
    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).then((result) => {
      secondSettled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(180);
    expect(first.lease.isActive()).toBe(true);
    expect(secondSettled).toBe(false);

    first.lease.release();
    await vi.advanceTimersByTimeAsync(0);

    const second = await secondPromise;
    expect(second.status).toBe('acquired');
    if (second.status === 'acquired') {
      second.lease.release();
    }
  });

  it('exposes the set of currently active leased channels', async () => {
    const lease = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 23,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(lease.status).toBe('acquired');
    if (lease.status !== 'acquired') return;

    expect(proxyChannelCoordinator.getActiveChannelIds()).toEqual([23]);

    lease.lease.release();
    expect(proxyChannelCoordinator.getActiveChannelIds()).toEqual([]);
  });

  it('reports active and waiting load for a guarded session channel', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 31,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 31,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(proxyChannelCoordinator.getChannelLoadSnapshot({
      channelId: 31,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    })).toEqual({
      channelId: 31,
      sessionScoped: true,
      concurrencyLimit: 1,
      activeLeaseCount: 1,
      waitingCount: 1,
      loadRatio: 2,
      saturated: true,
    });

    first.lease.release();
    await vi.advanceTimersByTimeAsync(0);

    const second = await secondPromise;
    expect(second.status).toBe('acquired');
    if (second.status === 'acquired') {
      second.lease.release();
    }
  });

  it('treats structured oauth providers as session-scoped in load snapshots', () => {
    expect(proxyChannelCoordinator.getChannelLoadSnapshot({
      channelId: 41,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
      accountOauthProvider: 'codex',
    })).toEqual({
      channelId: 41,
      sessionScoped: true,
      concurrencyLimit: 1,
      activeLeaseCount: 0,
      waitingCount: 0,
      loadRatio: 0,
      saturated: false,
    });
  });
});
