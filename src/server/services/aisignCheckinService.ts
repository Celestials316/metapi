import { performance } from 'node:perf_hooks';
import type { RequestInit as UndiciRequestInit } from 'undici';
import type { CheckinResult } from './platforms/base.js';
import { withSiteProxyRequestInit } from './siteProxy.js';

export type AisignTierOption = {
  id: number;
  name: string;
  rewardMin: number | null;
  rewardMax: number | null;
  difficulty: number | null;
  targetSeconds: number | null;
};

export type AisignTierMetadata = {
  requiresTierSelection: boolean;
  defaultTierId: number | null;
  tierOptions: AisignTierOption[];
};

type HttpTextResponse = {
  url: string;
  status: number;
  headers: Headers;
  text: string;
  cookieHeader: string;
};

type AisignSession = {
  origin: string;
  sid: string;
  cookieHeader: string;
};

type AisignPowRuntime = {
  memory: WebAssembly.Memory;
  alloc: (size: number) => number;
  dealloc: (ptr: number, size: number) => void;
  hashWithNonce: (challengePtr: number, challengeLength: number, nonce: bigint, outPtr: number) => number;
};

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const AISIGN_REPORTED_HPS_DIVISOR = 16;
const AISIGN_REPORTED_HPS_MIN = 100;
const AISIGN_BENCH_DURATION_MS = 480;

const AISIGN_FALLBACK_TIERS: AisignTierOption[] = [
  { id: 1, name: '简单', rewardMin: 1, rewardMax: 5, difficulty: 19, targetSeconds: 1 },
  { id: 2, name: '进阶', rewardMin: 5, rewardMax: 10, difficulty: 25, targetSeconds: 60 },
  { id: 3, name: '挑战', rewardMin: 10, rewardMax: 15, difficulty: 26, targetSeconds: 120 },
  { id: 4, name: '极限', rewardMin: 15, rewardMax: 20, difficulty: 26, targetSeconds: 200 },
];

const wasmModuleCache = new Map<string, Promise<WebAssembly.Module>>();

function normalizeHeaders(headers?: unknown): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers
        .filter((entry): entry is [string, unknown] => Array.isArray(entry) && entry.length >= 2)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)]),
    );
  }
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function upsertCookie(cookieHeader: string, name: string, value: string): string {
  if (!cookieHeader) return `${name}=${value}`;
  const parts = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean);
  let replaced = false;
  const next = parts.map((part) => {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) return part;
    const key = part.slice(0, eqIndex).trim();
    if (key !== name) return part;
    replaced = true;
    return `${name}=${value}`;
  });
  if (!replaced) next.push(`${name}=${value}`);
  return next.join('; ');
}

function mergeSetCookiePairs(cookieHeader: string, setCookieHeaders: string[]): string {
  let merged = cookieHeader;
  for (const raw of setCookieHeaders) {
    if (!raw) continue;
    const firstPair = raw.split(';')[0]?.trim();
    if (!firstPair) continue;
    const eqIndex = firstPair.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = firstPair.slice(0, eqIndex).trim();
    const value = firstPair.slice(eqIndex + 1);
    merged = upsertCookie(merged, name, value);
  }
  return merged;
}

function collectSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers) || [];
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function parseCookieValue(cookieHeader: string, name: string): string {
  const parts = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim();
    if (key === name) return part.slice(eqIndex + 1).trim();
  }
  return '';
}

function normalizeFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function normalizePositiveInt(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.trunc(numeric);
}

function cloneFallbackTiers(): AisignTierOption[] {
  return AISIGN_FALLBACK_TIERS.map((tier) => ({ ...tier }));
}

function normalizeAisignTierOption(raw: unknown): AisignTierOption | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = normalizePositiveInt(record.id);
  if (!id) return null;
  return {
    id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : `档位 ${id}`,
    rewardMin: normalizeFiniteNumber(record.reward_min ?? record.rewardMin),
    rewardMax: normalizeFiniteNumber(record.reward_max ?? record.rewardMax),
    difficulty: normalizePositiveInt(record.difficulty),
    targetSeconds: normalizePositiveInt(record.target_seconds ?? record.targetSeconds),
  };
}

export function isAisignExternalCheckinUrl(input: string | null | undefined): boolean {
  const trimmed = String(input || '').trim();
  if (!trimmed) return false;
  try {
    return new URL(trimmed).hostname.trim().toLowerCase() === 'aisign.td.ee';
  } catch {
    return false;
  }
}

function getAisignOrigin(entryUrl: string): string {
  return new URL(entryUrl).origin;
}

async function fetchJsonByUrl(url: string, options?: UndiciRequestInit & { cookieHeader?: string }): Promise<{ data: Record<string, unknown>; cookieHeader: string }> {
  const { fetch } = await import('undici');
  const headers = normalizeHeaders(options?.headers);
  let cookieHeader = options?.cookieHeader || '';
  if (headers.Cookie || headers.cookie) {
    cookieHeader = cookieHeader || headers.Cookie || headers.cookie;
    delete headers.Cookie;
    delete headers.cookie;
  }

  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  const requestOptions = await withSiteProxyRequestInit(url, {
    ...options,
    headers,
  });
  const response = await fetch(url, requestOptions);
  cookieHeader = mergeSetCookiePairs(cookieHeader, collectSetCookieHeaders(response.headers));
  const text = await response.text();
  const data = parseJsonSafe<Record<string, unknown>>(text) || {};
  if (!response.ok) {
    const message = typeof data.error === 'string' && data.error.trim()
      ? data.error.trim()
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return { data, cookieHeader };
}

export async function fetchAisignPublicConfig(entryUrl: string): Promise<Record<string, unknown>> {
  const origin = getAisignOrigin(entryUrl);
  const { data } = await fetchJsonByUrl(`${origin}/api/config/public`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': BROWSER_USER_AGENT,
    },
  });
  return data;
}

export function resolveAisignTierOptions(configPayload: unknown): AisignTierOption[] {
  const record = configPayload && typeof configPayload === 'object' && !Array.isArray(configPayload)
    ? configPayload as Record<string, unknown>
    : {};
  const parsed = Array.isArray(record.tiers)
    ? record.tiers.map((item) => normalizeAisignTierOption(item)).filter((item): item is AisignTierOption => !!item)
    : [];
  return parsed.length > 0 ? parsed : cloneFallbackTiers();
}

export function resolveDefaultAisignTierId(tierOptions: AisignTierOption[]): number | null {
  const preferred = tierOptions.find((tier) => tier.name.includes('挑战'));
  if (preferred?.id) return preferred.id;
  if (tierOptions[2]?.id) return tierOptions[2].id;
  return tierOptions[0]?.id ?? null;
}

export async function resolveAisignTierMetadata(entryUrl: string): Promise<AisignTierMetadata> {
  try {
    const config = await fetchAisignPublicConfig(entryUrl);
    const tierOptions = resolveAisignTierOptions(config);
    return {
      requiresTierSelection: tierOptions.length > 0,
      defaultTierId: resolveDefaultAisignTierId(tierOptions),
      tierOptions,
    };
  } catch {
    const tierOptions = cloneFallbackTiers();
    return {
      requiresTierSelection: true,
      defaultTierId: resolveDefaultAisignTierId(tierOptions),
      tierOptions,
    };
  }
}

async function fetchTextFollowingRedirects(
  url: string,
  options?: UndiciRequestInit & { cookieHeader?: string },
  maxRedirects = 5,
): Promise<HttpTextResponse> {
  const { fetch } = await import('undici');
  let currentUrl = url;
  let currentMethod = String(options?.method || 'GET').toUpperCase();
  let currentBody = options?.body ?? undefined;
  let cookieHeader = options?.cookieHeader || '';
  const baseHeaders = normalizeHeaders(options?.headers);

  if (baseHeaders.Cookie || baseHeaders.cookie) {
    cookieHeader = cookieHeader || baseHeaders.Cookie || baseHeaders.cookie;
    delete baseHeaders.Cookie;
    delete baseHeaders.cookie;
  }

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const requestHeaders = { ...baseHeaders };
    if (cookieHeader) {
      requestHeaders.Cookie = cookieHeader;
    }
    const requestOptions = await withSiteProxyRequestInit(currentUrl, {
      ...options,
      redirect: 'manual',
      method: currentMethod,
      body: currentBody,
      headers: requestHeaders,
    });
    const response = await fetch(currentUrl, requestOptions);
    cookieHeader = mergeSetCookiePairs(cookieHeader, collectSetCookieHeaders(response.headers));

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        const text = await response.text();
        return {
          url: currentUrl,
          status: response.status,
          headers: response.headers,
          text,
          cookieHeader,
        };
      }
      currentUrl = new URL(location, currentUrl).toString();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      continue;
    }

    const text = await response.text();
    return {
      url: currentUrl,
      status: response.status,
      headers: response.headers,
      text,
      cookieHeader,
    };
  }

  throw new Error('Too many redirects while opening aisign bridge session');
}

export async function openAisignBridgeSession(runtimeUrl: string): Promise<AisignSession> {
  const page = await fetchTextFollowingRedirects(runtimeUrl, {
    method: 'GET',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': BROWSER_USER_AGENT,
    },
  });

  const finalUrl = new URL(page.url);
  const sid = finalUrl.searchParams.get('sid') || parseCookieValue(page.cookieHeader, 'sid');
  if (!sid) {
    throw new Error('aisign sid missing after bridge bootstrap');
  }

  return {
    origin: finalUrl.origin,
    sid,
    cookieHeader: page.cookieHeader,
  };
}

async function requestAisignJson(
  session: AisignSession,
  path: string,
  options?: {
    method?: 'GET' | 'POST';
    query?: Record<string, string | number | null | undefined>;
    body?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const url = new URL(path, session.origin);
  for (const [key, value] of Object.entries(options?.query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const { data, cookieHeader } = await fetchJsonByUrl(url.toString(), {
    method: options?.method || 'GET',
    cookieHeader: session.cookieHeader,
    body: options?.body ? JSON.stringify(options.body) : undefined,
    headers: {
      Accept: 'application/json',
      'User-Agent': BROWSER_USER_AGENT,
      'X-Embed-Session': session.sid,
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  session.cookieHeader = cookieHeader;
  return data;
}

function isAisignAlreadySignedMessage(message?: string | null): boolean {
  const text = String(message || '').trim();
  if (!text) return false;
  return text.includes('今日已签到') || text.includes('今天已签到') || text.toLowerCase().includes('already');
}

function formatRewardValue(value: unknown): string | null {
  const numeric = normalizeFiniteNumber(value);
  if (numeric == null) return null;
  const normalized = Math.round(numeric * 1_000_000) / 1_000_000;
  return normalized.toString();
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

async function getPowModule(origin: string): Promise<WebAssembly.Module> {
  if (!wasmModuleCache.has(origin)) {
    wasmModuleCache.set(origin, (async () => {
      const { fetch } = await import('undici');
      const url = `${origin}/wasm/pow.wasm`;
      const requestOptions = await withSiteProxyRequestInit(url, {
        method: 'GET',
        headers: {
          Accept: '*/*',
          'User-Agent': BROWSER_USER_AGENT,
        },
      });
      const response = await fetch(url, requestOptions);
      if (!response.ok) {
        throw new Error(`Failed to load aisign pow wasm: HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      return WebAssembly.compile(bytes);
    })());
  }
  return wasmModuleCache.get(origin)!;
}

async function createPowRuntime(origin: string): Promise<AisignPowRuntime> {
  const module = await getPowModule(origin);
  const instance = await WebAssembly.instantiate(module, {});
  const memory = instance.exports.memory;
  const alloc = instance.exports.alloc;
  const dealloc = instance.exports.dealloc;
  const hashWithNonce = instance.exports.hash_with_nonce;

  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error('aisign pow wasm memory export missing');
  }
  if (typeof alloc !== 'function' || typeof dealloc !== 'function' || typeof hashWithNonce !== 'function') {
    throw new Error('aisign pow wasm exports missing');
  }

  return {
    memory,
    alloc: alloc as AisignPowRuntime['alloc'],
    dealloc: dealloc as AisignPowRuntime['dealloc'],
    hashWithNonce: hashWithNonce as AisignPowRuntime['hashWithNonce'],
  };
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function benchmarkPowHashesPerSecond(runtime: AisignPowRuntime, durationMs = AISIGN_BENCH_DURATION_MS): Promise<number> {
  const encoder = new TextEncoder();
  const challengeBytes = encoder.encode('bench');
  const challengePtr = runtime.alloc(challengeBytes.length);
  const outPtr = runtime.alloc(32);
  try {
    new Uint8Array(runtime.memory.buffer).set(challengeBytes, challengePtr);
    let nonce = 0n;
    const startedAt = performance.now();
    let lastYield = startedAt;

    while ((performance.now() - startedAt) < durationMs) {
      runtime.hashWithNonce(challengePtr, challengeBytes.length, nonce, outPtr);
      nonce += 1n;
      const now = performance.now();
      if (now - lastYield >= 16) {
        lastYield = now;
        await yieldToEventLoop();
      }
    }

    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs <= 0) return 0;
    return Math.max(0, Math.round((Number(nonce) / elapsedMs) * 1000));
  } finally {
    runtime.dealloc(challengePtr, challengeBytes.length);
    runtime.dealloc(outPtr, 32);
  }
}

function resolveReportedHps(measuredHps: number | null, fallbackPowHps: number | null): number {
  const base = measuredHps && measuredHps > 0
    ? measuredHps
    : (fallbackPowHps && fallbackPowHps > 0 ? fallbackPowHps : 0);
  if (!base) return 0;
  return Math.max(AISIGN_REPORTED_HPS_MIN, Math.round(base / AISIGN_REPORTED_HPS_DIVISOR));
}

async function solvePow(runtime: AisignPowRuntime, challenge: string, difficulty: number): Promise<{ nonce: number; hash: string; leading: number }> {
  const encoder = new TextEncoder();
  const challengeBytes = encoder.encode(challenge);
  const challengePtr = runtime.alloc(challengeBytes.length);
  const outPtr = runtime.alloc(32);
  try {
    new Uint8Array(runtime.memory.buffer).set(challengeBytes, challengePtr);
    let nonce = 0n;
    let lastYield = performance.now();

    while (true) {
      const leading = runtime.hashWithNonce(challengePtr, challengeBytes.length, nonce, outPtr);
      if (leading >= difficulty) {
        const hashBytes = new Uint8Array(runtime.memory.buffer).slice(outPtr, outPtr + 32);
        return {
          nonce: Number(nonce),
          hash: bytesToHex(hashBytes),
          leading,
        };
      }

      nonce += 1n;
      const now = performance.now();
      if (now - lastYield >= 16) {
        lastYield = now;
        await yieldToEventLoop();
      }
    }
  } finally {
    runtime.dealloc(challengePtr, challengeBytes.length);
    runtime.dealloc(outPtr, 32);
  }
}

function resolveRequestedTierId(tierOverride: number | null | undefined, tierOptions: AisignTierOption[]): number | null {
  const requestedTierId = normalizePositiveInt(tierOverride);
  if (requestedTierId && tierOptions.some((tier) => tier.id === requestedTierId)) {
    return requestedTierId;
  }
  return resolveDefaultAisignTierId(tierOptions);
}

function buildSubmitSuccessResult(payload: Record<string, unknown>): CheckinResult {
  const reward = formatRewardValue(payload.rewardFinal ?? payload.reward_final ?? payload.reward);
  const notes = typeof payload.notes === 'string' && payload.notes.trim()
    ? payload.notes.trim()
    : (typeof payload.message === 'string' ? payload.message.trim() : '');

  if (isAisignAlreadySignedMessage(notes)) {
    return { success: true, message: '今日已签到', reward: reward || undefined };
  }

  return {
    success: true,
    message: reward ? `签到成功，奖励 +${reward}` : '签到成功',
    reward: reward || undefined,
  };
}

export async function executeAisignCheckin(options: {
  entryUrl: string;
  runtimeUrl: string;
  tier?: number | null;
}): Promise<CheckinResult> {
  const session = await openAisignBridgeSession(options.runtimeUrl);
  const mePayload = await requestAisignJson(session, '/api/me');
  if (mePayload.signedInToday && !mePayload.isTest) {
    return { success: true, message: '今日已签到' };
  }

  let publicConfig: Record<string, unknown>;
  try {
    publicConfig = await requestAisignJson(session, '/api/config/public');
  } catch {
    publicConfig = await fetchAisignPublicConfig(options.entryUrl).catch(() => ({}));
  }

  let tierOptions = resolveAisignTierOptions(publicConfig);
  let selectedTierId = resolveRequestedTierId(options.tier, tierOptions);
  if (!selectedTierId) {
    throw new Error('aisign tier unavailable');
  }

  const powRuntime = await createPowRuntime(session.origin);
  const measuredHps = await benchmarkPowHashesPerSecond(powRuntime).catch(() => 0);
  const fallbackPowHps = normalizePositiveInt(publicConfig.powHps);
  const reportedHps = resolveReportedHps(measuredHps, fallbackPowHps);

  if (reportedHps > 0) {
    try {
      const personalConfig = await requestAisignJson(session, '/api/config/personal', {
        query: { hps: reportedHps },
      });
      tierOptions = resolveAisignTierOptions(personalConfig);
      selectedTierId = resolveRequestedTierId(options.tier, tierOptions);
      if (!selectedTierId) {
        throw new Error('aisign personal tier unavailable');
      }
    } catch {
      // 个人配置失败时，回退到公开配置的默认档位。
    }
  }

  let challengePayload: Record<string, unknown>;
  try {
    challengePayload = await requestAisignJson(session, '/api/pow/challenge', {
      query: {
        tier: selectedTierId,
        hps: reportedHps || undefined,
      },
    });
  } catch (error: any) {
    if (isAisignAlreadySignedMessage(error?.message)) {
      return { success: true, message: '今日已签到' };
    }
    throw error;
  }

  const challengeId = normalizePositiveInt(
    challengePayload.challengeId ?? challengePayload.challenge_id ?? challengePayload.id,
  );
  const difficulty = normalizePositiveInt(challengePayload.difficulty);
  const challenge = typeof challengePayload.challenge === 'string'
    ? challengePayload.challenge.trim()
    : '';

  if (!challengeId || !difficulty || !challenge) {
    throw new Error('aisign challenge payload invalid');
  }

  const powResult = await solvePow(powRuntime, challenge, difficulty);
  if (!Number.isFinite(powResult.nonce) || powResult.nonce < 0) {
    throw new Error('aisign pow solve failed');
  }

  const submitPayload = await requestAisignJson(session, '/api/pow/submit', {
    method: 'POST',
    body: {
      challengeId,
      nonce: powResult.nonce,
      tier: selectedTierId,
    },
  });

  return buildSubmitSuccessResult(submitPayload);
}
