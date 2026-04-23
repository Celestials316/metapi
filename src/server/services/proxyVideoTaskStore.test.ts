import { describe, expect, it } from 'vitest';
import { __proxyVideoTaskStoreTestUtils } from './proxyVideoTaskStore.js';

describe('proxyVideoTaskStore', () => {
  it('accepts parsed object input for JSON column helpers', () => {
    expect(__proxyVideoTaskStoreTestUtils.parseJsonColumn({
      status: 'done',
      id: 'video-1',
    })).toEqual({
      status: 'done',
      id: 'video-1',
    });
  });

  it('drops empty or masked credentials when trimming runtime video task credentials', () => {
    expect(__proxyVideoTaskStoreTestUtils.asTrimmedCredential('  sk-live-token  ')).toBe('sk-live-token');
    expect(__proxyVideoTaskStoreTestUtils.asTrimmedCredential('***')).toBeNull();
    expect(__proxyVideoTaskStoreTestUtils.asTrimmedCredential('  ')).toBeNull();
  });

  it('prefers oauth accessToken but apiToken for non-oauth direct credentials', () => {
    expect(__proxyVideoTaskStoreTestUtils.resolveDirectAccountCredential({
      accessToken: 'oauth-access-token',
      apiToken: 'legacy-api-token',
      extraConfig: JSON.stringify({ oauth: { provider: 'codex' } }),
      oauthProvider: 'codex',
    } as any)).toBe('oauth-access-token');

    expect(__proxyVideoTaskStoreTestUtils.resolveDirectAccountCredential({
      accessToken: '',
      apiToken: 'direct-api-token',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    } as any)).toBe('direct-api-token');
  });

  it('sanitizes secret-like fields before persisting task snapshots', () => {
    expect(__proxyVideoTaskStoreTestUtils.sanitizeSnapshot({
      id: 'video-1',
      status: 'processing',
      authorization: 'Bearer sk-secret',
      nested: {
        apiKey: 'sk-live-123',
        refreshToken: 'rt-secret',
      },
      output: [
        { url: 'https://example.com/video.mp4', sessionCookie: 'sid=secret' },
      ],
    })).toEqual({
      id: 'video-1',
      status: 'processing',
      authorization: '[redacted]',
      nested: {
        apiKey: '[redacted]',
        refreshToken: '[redacted]',
      },
      output: [
        { url: 'https://example.com/video.mp4', sessionCookie: '[redacted]' },
      ],
    });
  });
});
