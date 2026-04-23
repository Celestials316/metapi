export type ProxyFailureClass =
  | 'challenge_cloudflare'
  | 'challenge_turnstile'
  | 'challenge_shield'
  | 'pending_overload'
  | 'processing_error'
  | 'rate_limit'
  | 'quota_exceeded'
  | 'auth_invalid'
  | 'auth_expired'
  | 'timeout'
  | 'network'
  | 'model_unsupported'
  | 'request_shape'
  | 'upstream_5xx'
  | 'unknown';

export type ProxyFailureClassification = {
  className: ProxyFailureClass;
  title: string;
  retryable: boolean;
  challenge: boolean;
  summary: string;
};

function normalizeMessage(raw: unknown): string {
  return String(raw || '').trim();
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

const CHALLENGE_CLOUDFLARE_PATTERNS = [
  /cloudflare/i,
  /cf[-_ ]ray/i,
  /attention required/i,
  /cf-mitigated/i,
  /cdn-cgi\/challenge/i,
  /please enable javascript/i,
];

const CHALLENGE_TURNSTILE_PATTERNS = [
  /turnstile/i,
  /captcha/i,
  /verify you are human/i,
  /security check/i,
  /challenge page/i,
];

const CHALLENGE_SHIELD_PATTERNS = [
  /shield/i,
  /blocked by waf/i,
  /request was blocked/i,
  /access denied/i,
  /forbidden by policy/i,
  /unexpected token\s*</i,
  /<html/i,
];

const PENDING_OVERLOAD_PATTERNS = [
  /too many pending requests/i,
  /pending requests?.*retry later/i,
  /pending overload/i,
  /pending request overload/i,
];

const PROCESSING_ERROR_PATTERNS = [
  /an error occurred while processing your request/i,
  /processing error/i,
  /failed to process your request/i,
];

const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /too many requests/i,
  /retry later/i,
  /request limit/i,
  /请求过于频繁/,
  /触发限流/,
];

const QUOTA_PATTERNS = [
  /quota exceeded/i,
  /insufficient quota/i,
  /credit balance/i,
  /额度已用尽/,
  /余额不足/,
  /配额不足/,
];

const AUTH_INVALID_PATTERNS = [
  /invalid (api key|access token|token)/i,
  /unauthorized/i,
  /authentication failed/i,
  /未授权/,
  /无效密钥/,
  /无效令牌/,
];

const AUTH_EXPIRED_PATTERNS = [
  /token expired/i,
  /expired token/i,
  /session expired/i,
  /login expired/i,
  /登录过期/,
  /令牌过期/,
  /会话过期/,
];

const TIMEOUT_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /etimedout/i,
  /deadline exceeded/i,
  /stream closed before response\.completed/i,
  /response\.incomplete/i,
  /读取超时/,
  /请求超时/,
];

const NETWORK_PATTERNS = [
  /socket hang up/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /network error/i,
  /connection reset/i,
  /connection refused/i,
  /upstream connect error/i,
];

const MODEL_UNSUPPORTED_PATTERNS = [
  /unsupported model/i,
  /model .* does not exist/i,
  /model .* not found/i,
  /does\s+not\s+support(?:\s+the)?\s+model/i,
  /no\s+such\s+model/i,
  /invalid\s+model/i,
  /当前\s*api\s*不支持所选模型/i,
  /不支持所选模型/i,
  /不支持.*模型/i,
  /模型.*(不存在|不可用|不支持)/i,
];

const REQUEST_SHAPE_PATTERNS = [
  /invalid request body/i,
  /invalid_request_error/i,
  /unprocessable/i,
  /invalid input/i,
  /schema validation/i,
  /missing required/i,
  /required parameter/i,
  /unknown parameter/i,
  /unrecognized (field|key|parameter)/i,
  /malformed/i,
  /invalid json/i,
  /cannot parse/i,
  /unsupported media type/i,
  /timeout must/i,
  /invalid timeout/i,
  /参数错误/,
  /请求体错误/,
];

export function classifyProxyFailure(input: {
  status?: number | null;
  errorMessage?: unknown;
}): ProxyFailureClassification {
  const status = Number.isFinite(input.status as number) ? Number(input.status) : 0;
  const rawMessage = normalizeMessage(input.errorMessage);
  const message = rawMessage.toLowerCase();

  if (includesAny(message, CHALLENGE_CLOUDFLARE_PATTERNS)) {
    return {
      className: 'challenge_cloudflare',
      title: 'Cloudflare / 挑战页',
      retryable: true,
      challenge: true,
      summary: rawMessage || 'Cloudflare challenge',
    };
  }
  if (includesAny(message, CHALLENGE_TURNSTILE_PATTERNS)) {
    return {
      className: 'challenge_turnstile',
      title: 'Turnstile / 人机验证',
      retryable: true,
      challenge: true,
      summary: rawMessage || 'Turnstile challenge',
    };
  }
  if ((status === 403 || status === 503 || status === 400) && includesAny(message, CHALLENGE_SHIELD_PATTERNS)) {
    return {
      className: 'challenge_shield',
      title: 'WAF / Shield 拦截',
      retryable: true,
      challenge: true,
      summary: rawMessage || 'Shield challenge',
    };
  }
  if (includesAny(message, PENDING_OVERLOAD_PATTERNS)) {
    return {
      className: 'pending_overload',
      title: 'Pending 请求过载',
      retryable: true,
      challenge: false,
      summary: rawMessage || 'pending overload',
    };
  }
  if (includesAny(message, PROCESSING_ERROR_PATTERNS)) {
    return {
      className: 'processing_error',
      title: '上游处理错误',
      retryable: true,
      challenge: false,
      summary: rawMessage || 'processing error',
    };
  }
  if (status === 429 || includesAny(message, RATE_LIMIT_PATTERNS)) {
    return {
      className: 'rate_limit',
      title: '限流',
      retryable: true,
      challenge: false,
      summary: rawMessage || 'rate limited',
    };
  }
  if (includesAny(message, QUOTA_PATTERNS)) {
    return {
      className: 'quota_exceeded',
      title: '额度不足',
      retryable: false,
      challenge: false,
      summary: rawMessage || 'quota exceeded',
    };
  }
  if (status === 401 && includesAny(message, AUTH_EXPIRED_PATTERNS)) {
    return {
      className: 'auth_expired',
      title: '凭证过期',
      retryable: true,
      challenge: false,
      summary: rawMessage || 'token expired',
    };
  }
  if (status === 401 || status === 403 || includesAny(message, AUTH_INVALID_PATTERNS)) {
    return {
      className: 'auth_invalid',
      title: '鉴权失败',
      retryable: true,
      challenge: false,
      summary: rawMessage || 'authentication failed',
    };
  }
  if ((status === 400 || status === 404 || status === 422) && includesAny(message, REQUEST_SHAPE_PATTERNS)) {
    return {
      className: 'request_shape',
      title: '请求格式错误',
      retryable: false,
      challenge: false,
      summary: rawMessage || 'request validation failed',
    };
  }
  if (includesAny(message, TIMEOUT_PATTERNS)) {
    return {
      className: 'timeout',
      title: '超时',
      retryable: true,
      challenge: false,
      summary: rawMessage || 'timeout',
    };
  }
  if (includesAny(message, NETWORK_PATTERNS)) {
    return {
      className: 'network',
      title: '网络异常',
      retryable: true,
      challenge: false,
      summary: rawMessage || 'network error',
    };
  }
  if (status >= 500) {
    return {
      className: 'upstream_5xx',
      title: '上游 5xx',
      retryable: true,
      challenge: false,
      summary: rawMessage || `upstream ${status}`,
    };
  }
  if (includesAny(message, MODEL_UNSUPPORTED_PATTERNS)) {
    return {
      className: 'model_unsupported',
      title: '模型不支持',
      retryable: true,
      challenge: false,
      summary: rawMessage || 'model unsupported',
    };
  }
  return {
    className: 'unknown',
    title: '未分类失败',
    retryable: status >= 500 || status === 429,
    challenge: false,
    summary: rawMessage || (status ? `http ${status}` : 'unknown failure'),
  };
}
