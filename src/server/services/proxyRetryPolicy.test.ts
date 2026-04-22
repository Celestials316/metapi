import { describe, expect, it } from 'vitest';
import { shouldAbortSameSiteEndpointFallback, shouldRetryProxyRequest } from './proxyRetryPolicy.js';

describe('proxyRetryPolicy', () => {
  it('retries on taxonomy-recognized retryable failures', () => {
    expect(shouldRetryProxyRequest(429, 'rate limit exceeded')).toBe(true);
    expect(shouldRetryProxyRequest(429, 'Too many pending requests, please retry later')).toBe(true);
    expect(shouldRetryProxyRequest(503, 'service unavailable')).toBe(true);
    expect(shouldRetryProxyRequest(403, '<html><title>Attention Required</title> cf-ray=abc')).toBe(true);
    expect(shouldRetryProxyRequest(402, '{"error":{"message":"insufficient quota"}}')).toBe(true);
    expect(shouldRetryProxyRequest(401, '{"error":{"message":"token expired"}}')).toBe(true);
    expect(shouldRetryProxyRequest(400, 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.')).toBe(true);
  });

  it('does not retry request-shape failures that will fail on every channel', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"invalid request body"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(422, '{"error":{"message":"unknown parameter: temperature"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"timeout must be <= 60"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"not found"}}'),
    ).toBe(false);
  });

  it('retries on model unsupported failures recognized by taxonomy', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":"当前 API 不支持所选模型 claude-sonnet-4-5-20250929","type":"error"}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"unsupported model: claude-3"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"The model `gpt-4.1` does not exist"}}'),
    ).toBe(true);
  });

  it('aborts same-site endpoint fallback for taxonomy classes that are site-wide or request-wide', () => {
    expect(
      shouldAbortSameSiteEndpointFallback(429, '{"error":{"message":"rate limit exceeded"}}'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(429, '{"error":{"message":"Too many pending requests, please retry later"}}'),
    ).toBe(false);
    expect(
      shouldAbortSameSiteEndpointFallback(503, '{"error":{"message":"pending overload"}}'),
    ).toBe(false);
    expect(
      shouldAbortSameSiteEndpointFallback(402, '{"error":{"message":"insufficient quota"}}'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(401, '{"error":{"message":"invalid access token"}}'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(400, '{"error":{"message":"invalid request body"}}'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(400, '{"error":{"message":"unsupported model: claude-3"}}'),
    ).toBe(true);
  });

  it('keeps endpoint-compatibility errors eligible for same-site endpoint fallback', () => {
    expect(
      shouldRetryProxyRequest(400, 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(400, 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.'),
    ).toBe(false);
  });

  it('keeps generic 4xx unknown failures from entering useless retries or same-site aborts', () => {
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"not found"}}'),
    ).toBe(false);
    expect(
      shouldAbortSameSiteEndpointFallback(404, '{"error":{"message":"not found"}}'),
    ).toBe(false);
  });
});
