import { classifyProxyFailure, type ProxyFailureClass } from './proxyFailureTaxonomy.js';

export const RETRYABLE_TIMEOUT_PATTERNS: RegExp[] = [
  /(request timed out|connection timed out|read timeout|first byte timeout|\btimed out\b)/i,
];

const RETRYABLE_CHANNEL_COMPATIBILITY_PATTERNS: RegExp[] = [
  /unsupported\s+legacy\s+protocol/i,
  /please\s+use\s+\/v1\/responses/i,
  /please\s+use\s+\/v1\/messages/i,
  /please\s+use\s+\/v1\/chat\/completions/i,
  /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i,
  /unsupported\s+endpoint/i,
  /unsupported\s+path/i,
  /unknown\s+endpoint/i,
  /unrecognized\s+request\s+url/i,
  /no\s+route\s+matched/i,
];

const RETRYABLE_STATUS_FALLBACK = new Set([401, 403, 408, 409, 425, 429]);
const RETRYABLE_FAILURE_CLASSES = new Set<ProxyFailureClass>([
  'challenge_cloudflare',
  'challenge_turnstile',
  'challenge_shield',
  'pending_overload',
  'rate_limit',
  'quota_exceeded',
  'auth_invalid',
  'auth_expired',
  'timeout',
  'network',
  'model_unsupported',
  'upstream_5xx',
]);
const SAME_SITE_ABORT_CLASSES = new Set<ProxyFailureClass>([
  'challenge_cloudflare',
  'challenge_turnstile',
  'challenge_shield',
  'rate_limit',
  'quota_exceeded',
  'auth_invalid',
  'auth_expired',
  'timeout',
  'network',
  'model_unsupported',
  'request_shape',
  'upstream_5xx',
]);

function shouldRetryUnknownFailure(status: number): boolean {
  return status >= 500 || RETRYABLE_STATUS_FALLBACK.has(status);
}

function matchesAnyPattern(patterns: RegExp[], rawMessage?: string | null): boolean {
  const text = (rawMessage || '').trim();
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

export function shouldRetryProxyRequest(status: number, upstreamErrorText?: string | null): boolean {
  if (matchesAnyPattern(RETRYABLE_CHANNEL_COMPATIBILITY_PATTERNS, upstreamErrorText)) return true;
  const failure = classifyProxyFailure({
    status,
    errorMessage: upstreamErrorText,
  });
  if (failure.className === 'request_shape') return false;
  if (failure.className === 'unknown') return shouldRetryUnknownFailure(status);
  return RETRYABLE_FAILURE_CLASSES.has(failure.className);
}

export function shouldAbortSameSiteEndpointFallback(status: number, upstreamErrorText?: string | null): boolean {
  if (matchesAnyPattern(RETRYABLE_CHANNEL_COMPATIBILITY_PATTERNS, upstreamErrorText)) return false;
  const failure = classifyProxyFailure({
    status,
    errorMessage: upstreamErrorText,
  });
  if (failure.className === 'unknown') {
    return status >= 500 || status === 408 || status === 429;
  }
  return SAME_SITE_ABORT_CLASSES.has(failure.className);
}
