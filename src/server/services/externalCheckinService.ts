import { eq } from 'drizzle-orm';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { db, schema } from '../db/index.js';
import type { CheckinResult } from './platforms/base.js';
import { resolvePlatformUserId, resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { withAccountProxyOverride, withSiteProxyRequestInit } from './siteProxy.js';
import { stripTrailingSlashes } from './urlNormalization.js';

type AccountRow = typeof schema.accounts.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;

export type ExternalCheckinKind = 'token_bridge' | 'manual_oauth' | 'unsupported';
export type AccountCheckinActionMode = 'auto' | 'manual_jump' | 'none';

export type AccountExternalCheckinAction = {
  mode: AccountCheckinActionMode;
  kind: ExternalCheckinKind;
  entryUrl: string | null;
  url: string | null;
  message: string;
};

export type AccountExternalCheckinExecution = AccountExternalCheckinAction & {
  handled: true;
  result: CheckinResult;
};

type HttpTextResponse = {
  url: string;
  status: number;
  headers: Headers;
  text: string;
  cookieHeader: string;
};

type NormalizedExternalCheckinUrlResult = {
  valid: boolean;
  present: boolean;
  url: string | null;
};

const DYNAMIC_CHECKIN_QUERY_KEYS = new Set([
  'token',
  'user_id',
  'src_host',
  'src_url',
  'lang',
  'ui_mode',
]);

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

export const MANUAL_EXTERNAL_CHECKIN_MESSAGE = '站点需要跳转外部签到页手动完成签到';
export const UNSUPPORTED_EXTERNAL_CHECKIN_MESSAGE = 'Check-in is not supported by Sub2API';
const EXTERNAL_CHECKIN_SUCCESS_MESSAGE = '签到成功';
const EXTERNAL_CHECKIN_ALREADY_MESSAGE = '今日已签到';

function isSub2ApiPlatform(platform?: string | null): boolean {
  return String(platform || '').trim().toLowerCase() === 'sub2api';
}

function hasSessionToken(account: Pick<AccountRow, 'accessToken'>): boolean {
  return typeof account.accessToken === 'string' && account.accessToken.trim().length > 0;
}

function normalizeHeaders(headers?: unknown): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, String(value)]));
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
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

function stripBearerPrefix(value?: string | null): string {
  return String(value || '').trim().replace(/^bearer\s+/i, '').trim();
}

function normalizeExternalCheckinUrl(raw: string | null | undefined): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  for (const key of Array.from(parsed.searchParams.keys())) {
    if (DYNAMIC_CHECKIN_QUERY_KEYS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }

  const nextPathname = stripTrailingSlashes(parsed.pathname);
  parsed.pathname = nextPathname || '/';

  const normalized = parsed.toString().replace(/\/$/, '');
  return normalized || null;
}

export function normalizeOptionalExternalCheckinUrlInput(input: unknown): NormalizedExternalCheckinUrlResult {
  if (input === undefined) {
    return { valid: true, present: false, url: null };
  }
  if (input === null) {
    return { valid: true, present: true, url: null };
  }
  if (typeof input !== 'string') {
    return { valid: false, present: true, url: null };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: true, present: true, url: null };
  }
  const normalized = normalizeExternalCheckinUrl(trimmed);
  if (!normalized) {
    return { valid: false, present: true, url: null };
  }
  return { valid: true, present: true, url: normalized };
}

export function normalizeExternalCheckinKind(value: unknown): ExternalCheckinKind | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'token_bridge') return 'token_bridge';
  if (normalized === 'manual_oauth') return 'manual_oauth';
  if (normalized === 'unsupported') return 'unsupported';
  return null;
}

export function resolveStoredAccountCheckinActionMode(
  account: Pick<AccountRow, 'accessToken'>,
  site: Pick<SiteRow, 'platform' | 'externalCheckinUrl' | 'externalCheckinKind'>,
): AccountCheckinActionMode {
  if (!hasSessionToken(account)) return 'none';
  if (!isSub2ApiPlatform(site.platform)) return 'auto';

  const entryUrl = normalizeExternalCheckinUrl(site.externalCheckinUrl);
  const kind = normalizeExternalCheckinKind(site.externalCheckinKind);

  if (kind === 'manual_oauth' && entryUrl) return 'manual_jump';
  if (kind === 'token_bridge' && entryUrl) return 'auto';

  // 管理端手动录入了签到页，但还未完成一次运行时识别时，先暴露安全的跳转按钮。
  if (!kind && entryUrl) return 'manual_jump';

  return 'none';
}

function normalizeSub2ApiManagementBaseUrl(baseUrl: string): string {
  let normalized = stripTrailingSlashes(baseUrl || '');
  if (!normalized) return normalized;

  const suffixes = [
    '/models',
    '/antigravity',
    '/antigravity/v1beta',
    '/antigravity/v1',
    '/api/v1',
    '/v1beta',
    '/v1',
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (!normalized.toLowerCase().endsWith(suffix)) continue;
      const trimmed = stripTrailingSlashes(normalized.slice(0, -suffix.length));
      if (!trimmed || trimmed === normalized) continue;
      normalized = trimmed;
      changed = true;
      break;
    }
  }

  return normalized;
}

function resolveSiteOrigin(baseUrl: string): string {
  const managementBase = normalizeSub2ApiManagementBaseUrl(baseUrl);
  try {
    return new URL(managementBase).origin;
  } catch {
    return managementBase;
  }
}

function decodeJwtUserId(token: string): number | undefined {
  try {
    const parts = stripBearerPrefix(token).split('.');
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const idCandidate = payload.id ?? payload.user_id ?? payload.uid ?? payload.sub;
    const parsed = Number.parseInt(String(idCandidate ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function resolveExternalCheckinUserId(account: Pick<AccountRow, 'extraConfig' | 'username' | 'accessToken'>): number | undefined {
  return resolvePlatformUserId(account.extraConfig, account.username) || decodeJwtUserId(account.accessToken);
}

function buildExternalCheckinRuntimeUrl(entryUrl: string, site: Pick<SiteRow, 'url'>, account: Pick<AccountRow, 'accessToken' | 'extraConfig' | 'username'>): string {
  const parsed = new URL(entryUrl);
  const token = stripBearerPrefix(account.accessToken);
  const siteOrigin = resolveSiteOrigin(site.url);
  const siteBaseUrl = normalizeSub2ApiManagementBaseUrl(site.url);
  const userId = resolveExternalCheckinUserId(account);

  if (token) parsed.searchParams.set('token', token);
  if (siteOrigin) parsed.searchParams.set('src_host', siteOrigin);
  if (siteBaseUrl) parsed.searchParams.set('src_url', siteBaseUrl);
  if (userId) parsed.searchParams.set('user_id', String(userId));

  return parsed.toString();
}

function normalizeCandidateMenuUrl(input: unknown, siteUrl: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return normalizeExternalCheckinUrl(new URL(trimmed, normalizeSub2ApiManagementBaseUrl(siteUrl)).toString());
  } catch {
    return null;
  }
}

function unwrapSub2ApiEnvelope(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const body = payload as Record<string, unknown>;
  if (typeof body.code === 'number' && body.code === 0 && body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return body.data as Record<string, unknown>;
  }
  return body;
}

function parseMenuItems(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  }
  if (typeof raw === 'string') {
    const parsed = parseJsonSafe<unknown>(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      : [];
  }
  return [];
}

function matchesCheckinMenuHint(item: Record<string, unknown>): boolean {
  const fields = [
    item.title,
    item.name,
    item.label,
    item.text,
    item.url,
    item.href,
    item.link,
  ];
  const normalized = fields
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .join(' ');

  if (!normalized) return false;
  return normalized.includes('签到')
    || normalized.includes('checkin')
    || normalized.includes('check-in')
    || normalized.includes('sign in')
    || normalized.includes('signin')
    || normalized.includes('重置');
}

function resolveDiscoveredExternalCheckinUrl(site: Pick<SiteRow, 'url'>, settingsPayload: unknown): string | null {
  const settings = unwrapSub2ApiEnvelope(settingsPayload);
  const menuItems = parseMenuItems(settings.custom_menu_items ?? settings.customMenuItems);
  for (const item of menuItems) {
    if (!matchesCheckinMenuHint(item)) continue;
    const candidate = normalizeCandidateMenuUrl(item.url ?? item.href ?? item.link, site.url);
    if (candidate) return candidate;
  }
  return null;
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function normalizeHtmlText(value: string): string {
  return decodeHtmlEntities(stripHtmlTags(value)).replace(/\s+/g, ' ').trim();
}

function looksLikeEmbeddedManualOauthPrompt(html: string): boolean {
  const normalized = String(html || '').toLowerCase();
  const text = normalizeHtmlText(html);
  const hasPromptShell = normalized.includes('login-screen')
    || normalized.includes('login-card')
    || normalized.includes('login-button-disabled');
  const hasSigninBranding = text.includes('签到系统') || text.includes('签到中心');
  const hasManualPrompt = text.includes('欢迎登录')
    || text.includes('请点击右上角在新窗口打开')
    || text.includes('使用 Linux.do 登录');
  return hasSigninBranding && hasManualPrompt && hasPromptShell;
}

function isManualOauthPage(html: string): boolean {
  const normalized = String(html || '').toLowerCase();
  return normalized.includes('/auth/linuxdo/login')
    || normalized.includes('connect.linux.do')
    || normalized.includes('data-linuxdo-login')
    || (normalized.includes('linux.do') && (normalized.includes('oauth') || normalized.includes('登录') || normalized.includes('login')))
    || looksLikeEmbeddedManualOauthPrompt(html);
}

function extractFormByActionKeyword(html: string, actionKeyword: string): {
  action: string;
  method: string;
  body: URLSearchParams;
} | null {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) || [];
  for (const form of forms) {
    const actionMatch = form.match(/action\s*=\s*["']([^"']+)["']/i);
    const methodMatch = form.match(/method\s*=\s*["']([^"']+)["']/i);
    const action = String(actionMatch?.[1] || '').trim();
    if (!action.toLowerCase().includes(actionKeyword)) continue;

    const body = new URLSearchParams();
    for (const input of form.match(/<input\b[^>]*>/gi) || []) {
      const typeMatch = input.match(/type\s*=\s*["']([^"']+)["']/i);
      const nameMatch = input.match(/name\s*=\s*["']([^"']+)["']/i);
      const valueMatch = input.match(/value\s*=\s*["']([^"']*)["']/i);
      const type = String(typeMatch?.[1] || 'text').trim().toLowerCase();
      const name = String(nameMatch?.[1] || '').trim();
      if (!name) continue;
      if (type === 'submit' || type === 'button') continue;
      body.set(name, String(valueMatch?.[1] || ''));
    }

    return {
      action,
      method: String(methodMatch?.[1] || 'post').trim().toUpperCase() || 'POST',
      body,
    };
  }
  return null;
}

function looksLikeTokenBridgePage(html: string): boolean {
  if (extractFormByActionKeyword(html, 'checkin')) return true;

  const text = normalizeHtmlText(html);
  if (!text) return false;
  return text.includes('今日已签到')
    || text.includes('今天已签到')
    || text.includes('当前余额')
    || text.includes('账户ID')
    || text.includes('签到成功');
}

export function classifyExternalCheckinKindFromHtml(html: string): ExternalCheckinKind {
  if (isManualOauthPage(html)) return 'manual_oauth';
  if (looksLikeTokenBridgePage(html)) return 'token_bridge';
  return 'unsupported';
}

type ExternalCheckinSuccessSummary = {
  message: string;
  reward: string | null;
};

function parseExternalCheckinRewardAmount(text: string): string | null {
  const normalized = text.replace(/,/g, '');
  const patterns = [
    /签到成功[：:，,\s]*(?:获得|奖励)?\s*\+?\s*([0-9]+(?:\.\d+)?)/i,
    /余额\s*\+?\s*([0-9]+(?:\.\d+)?)/i,
    /获得\s*([0-9]+(?:\.\d+)?)\s*(?:刀|点|元|usd|usdt)?/i,
    /奖励\s*\+?\s*([0-9]+(?:\.\d+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const parsed = Number.parseFloat(match[1] || '');
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return parsed.toString();
  }
  return null;
}

export function extractExternalCheckinSuccessSummary(html: string): ExternalCheckinSuccessSummary | null {
  const candidates: string[] = [];
  const blockPattern = /<(div|p|span)[^>]*class=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(blockPattern)) {
    const className = String(match[2] || '').toLowerCase();
    const text = normalizeHtmlText(match[3] || '');
    if (!text) continue;
    const isSuccessBlock = (className.includes('notice') || className.includes('banner') || className.includes('alert') || className.includes('message'))
      && (className.includes('success') || /(?:^|\s)ok(?:\s|$)/.test(className) || className.includes('good'));
    if (!isSuccessBlock) continue;
    candidates.push(text);
  }

  const fullText = normalizeHtmlText(html);
  const inlineSuccessMatch = fullText.match(/签到成功[^。！!?\n]{0,80}/);
  if (inlineSuccessMatch?.[0]) {
    candidates.push(inlineSuccessMatch[0].trim());
  }

  for (const candidate of candidates) {
    if (!candidate.includes('签到成功')) continue;
    const reward = parseExternalCheckinRewardAmount(candidate);
    return {
      message: candidate,
      reward,
    };
  }

  return null;
}

function buildAction(
  mode: AccountCheckinActionMode,
  kind: ExternalCheckinKind,
  entryUrl: string | null,
  url: string | null,
  message: string,
): AccountExternalCheckinAction {
  return { mode, kind, entryUrl, url, message };
}

async function fetchJsonValue(url: string, options?: UndiciRequestInit): Promise<unknown> {
  const { fetch } = await import('undici');
  const requestOptions = await withSiteProxyRequestInit(url, options);
  const response = await fetch(url, requestOptions);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
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

  throw new Error('Too many redirects while loading external check-in page');
}

async function fetchSub2ApiPublicSettings(site: Pick<SiteRow, 'url'>): Promise<unknown> {
  const endpoint = `${normalizeSub2ApiManagementBaseUrl(site.url)}/api/v1/settings/public`;
  return fetchJsonValue(endpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': BROWSER_USER_AGENT,
    },
  });
}

async function persistSiteExternalCheckinMetadata(
  site: SiteRow,
  next: { entryUrl: string | null; kind: ExternalCheckinKind },
): Promise<void> {
  if (!(typeof site.id === 'number' && Number.isFinite(site.id) && site.id > 0)) return;

  const updates: Partial<typeof schema.sites.$inferInsert> = {};
  const normalizedStoredUrl = normalizeExternalCheckinUrl(site.externalCheckinUrl);
  const normalizedNextUrl = normalizeExternalCheckinUrl(next.entryUrl);
  const storedKind = normalizeExternalCheckinKind(site.externalCheckinKind) || 'unsupported';

  if (normalizedStoredUrl !== normalizedNextUrl) {
    updates.externalCheckinUrl = normalizedNextUrl;
  }
  if (storedKind !== next.kind) {
    updates.externalCheckinKind = next.kind;
  }
  if (Object.keys(updates).length <= 0) return;

  updates.updatedAt = new Date().toISOString();
  await db.update(schema.sites)
    .set(updates)
    .where(eq(schema.sites.id, site.id))
    .run();
}

async function resolveSub2ApiExternalDefinition(
  site: SiteRow,
  account: AccountRow,
): Promise<{ entryUrl: string | null; kind: ExternalCheckinKind }> {
  let entryUrl = normalizeExternalCheckinUrl(site.externalCheckinUrl);
  let kind = normalizeExternalCheckinKind(site.externalCheckinKind);

  if (!entryUrl || kind === 'unsupported' || !kind) {
    try {
      const settings = await fetchSub2ApiPublicSettings(site);
      const discoveredUrl = resolveDiscoveredExternalCheckinUrl(site, settings);
      if (discoveredUrl) entryUrl = discoveredUrl;
    } catch {
      // Ignore discovery errors and fall back to stored values.
    }
  }

  if (!entryUrl) {
    const resolved = { entryUrl: null, kind: 'unsupported' as const };
    await persistSiteExternalCheckinMetadata(site, resolved);
    return resolved;
  }

  if (!kind || kind === 'unsupported') {
    try {
      const probeUrl = buildExternalCheckinRuntimeUrl(entryUrl, site, account);
      const page = await fetchTextFollowingRedirects(probeUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: resolveSiteOrigin(site.url),
          'User-Agent': BROWSER_USER_AGENT,
        },
      });
      kind = classifyExternalCheckinKindFromHtml(page.text);
    } catch {
      kind = 'unsupported';
    }
  }

  const resolved = {
    entryUrl,
    kind: kind || 'unsupported',
  };
  await persistSiteExternalCheckinMetadata(site, resolved);
  return resolved;
}

async function resolveAccountExternalCheckinActionInternal(
  account: AccountRow,
  site: SiteRow,
): Promise<AccountExternalCheckinAction> {
  if (!isSub2ApiPlatform(site.platform) || !hasSessionToken(account)) {
    return buildAction('none', 'unsupported', null, null, UNSUPPORTED_EXTERNAL_CHECKIN_MESSAGE);
  }

  const definition = await resolveSub2ApiExternalDefinition(site, account);
  if (!definition.entryUrl || definition.kind === 'unsupported') {
    return buildAction('none', 'unsupported', definition.entryUrl, null, UNSUPPORTED_EXTERNAL_CHECKIN_MESSAGE);
  }

  const runtimeUrl = buildExternalCheckinRuntimeUrl(definition.entryUrl, site, account);
  if (definition.kind === 'manual_oauth') {
    return buildAction('manual_jump', definition.kind, definition.entryUrl, runtimeUrl, MANUAL_EXTERNAL_CHECKIN_MESSAGE);
  }

  return buildAction('auto', definition.kind, definition.entryUrl, null, EXTERNAL_CHECKIN_SUCCESS_MESSAGE);
}

export async function resolveAccountExternalCheckinAction(
  account: AccountRow,
  site: SiteRow,
): Promise<AccountExternalCheckinAction> {
  return withAccountProxyOverride(
    resolveProxyUrlFromExtraConfig(account.extraConfig),
    () => resolveAccountExternalCheckinActionInternal(account, site),
  );
}

export function warmAccountExternalCheckinMetadata(
  account: AccountRow,
  site: SiteRow,
): void {
  if (!hasSessionToken(account) || !isSub2ApiPlatform(site.platform)) return;
  void resolveAccountExternalCheckinAction(account, site).catch(() => undefined);
}

export async function resolveAccountExternalCheckinActionById(
  accountId: number,
): Promise<AccountExternalCheckinAction | null> {
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!row) return null;
  return resolveAccountExternalCheckinAction(row.accounts, row.sites);
}

function buildHtmlHeaders(referer: string): Record<string, string> {
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: referer,
    'User-Agent': BROWSER_USER_AGENT,
  };
}

function extractHtmlErrorMessage(html: string): string | null {
  const alertPatterns = [
    /<(?:div|p|span)[^>]*class=["'][^"']*(?:alert|error|message)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|p|span)>/i,
    /<(?:div|p|span)[^>]*role=["']alert["'][^>]*>([\s\S]*?)<\/(?:div|p|span)>/i,
  ];
  for (const pattern of alertPatterns) {
    const match = html.match(pattern);
    const text = normalizeHtmlText(match?.[1] || '');
    if (text) return text;
  }
  return null;
}

async function executeTokenBridgeCheckin(
  account: AccountRow,
  site: SiteRow,
  entryUrl: string,
): Promise<AccountExternalCheckinExecution | null> {
  const runtimeUrl = buildExternalCheckinRuntimeUrl(entryUrl, site, account);
  const initialPage = await fetchTextFollowingRedirects(runtimeUrl, {
    method: 'GET',
    headers: buildHtmlHeaders(resolveSiteOrigin(site.url)),
  });

  const initialKind = classifyExternalCheckinKindFromHtml(initialPage.text);
  if (initialKind !== 'token_bridge') {
    await persistSiteExternalCheckinMetadata(site, { entryUrl, kind: initialKind });
    if (initialKind === 'manual_oauth') {
      const action = buildAction('manual_jump', initialKind, entryUrl, runtimeUrl, MANUAL_EXTERNAL_CHECKIN_MESSAGE);
      return {
        ...action,
        handled: true,
        result: { success: false, message: MANUAL_EXTERNAL_CHECKIN_MESSAGE },
      };
    }
    return null;
  }

  const initialText = normalizeHtmlText(initialPage.text);
  const initialSuccessSummary = extractExternalCheckinSuccessSummary(initialPage.text);
  if (initialText.includes(EXTERNAL_CHECKIN_ALREADY_MESSAGE) || initialText.includes('今天已签到')) {
    const message = initialSuccessSummary?.message
      ? `${EXTERNAL_CHECKIN_ALREADY_MESSAGE}（${initialSuccessSummary.message}）`
      : EXTERNAL_CHECKIN_ALREADY_MESSAGE;
    const action = buildAction('auto', 'token_bridge', entryUrl, null, EXTERNAL_CHECKIN_ALREADY_MESSAGE);
    return {
      ...action,
      handled: true,
      result: {
        success: true,
        message,
        reward: initialSuccessSummary?.reward || undefined,
      },
    };
  }

  const form = extractFormByActionKeyword(initialPage.text, 'checkin');
  if (!form) {
    const failureMessage = extractHtmlErrorMessage(initialPage.text) || '外部签到页未返回可用签到表单';
    const action = buildAction('auto', 'token_bridge', entryUrl, null, failureMessage);
    return {
      ...action,
      handled: true,
      result: { success: false, message: failureMessage },
    };
  }

  const actionUrl = new URL(form.action, initialPage.url).toString();
  const submitResult = await fetchTextFollowingRedirects(actionUrl, {
    method: form.method || 'POST',
    body: form.body.toString(),
    cookieHeader: initialPage.cookieHeader,
    headers: {
      ...buildHtmlHeaders(initialPage.url),
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: new URL(initialPage.url).origin,
    },
  });

  const finalText = normalizeHtmlText(submitResult.text);
  const successSummary = extractExternalCheckinSuccessSummary(submitResult.text);
  if (
    finalText.includes(EXTERNAL_CHECKIN_ALREADY_MESSAGE)
    || finalText.includes('今天已签到')
    || finalText.includes(EXTERNAL_CHECKIN_SUCCESS_MESSAGE)
    || looksLikeTokenBridgePage(submitResult.text)
  ) {
    const message = successSummary?.message
      || (finalText.includes(EXTERNAL_CHECKIN_ALREADY_MESSAGE) || finalText.includes('今天已签到')
        ? EXTERNAL_CHECKIN_ALREADY_MESSAGE
        : EXTERNAL_CHECKIN_SUCCESS_MESSAGE);
    const action = buildAction('auto', 'token_bridge', entryUrl, null, message);
    return {
      ...action,
      handled: true,
      result: {
        success: true,
        message,
        reward: successSummary?.reward || undefined,
      },
    };
  }

  const failureMessage = extractHtmlErrorMessage(submitResult.text)
    || (submitResult.status >= 400 ? `HTTP ${submitResult.status}` : '外部签到失败');
  const action = buildAction('auto', 'token_bridge', entryUrl, null, failureMessage);
  return {
    ...action,
    handled: true,
    result: { success: false, message: failureMessage },
  };
}

export async function performAccountExternalCheckin(
  account: AccountRow,
  site: SiteRow,
): Promise<AccountExternalCheckinExecution | null> {
  if (!isSub2ApiPlatform(site.platform) || !hasSessionToken(account)) {
    return null;
  }

  return withAccountProxyOverride(
    resolveProxyUrlFromExtraConfig(account.extraConfig),
    async () => {
      const action = await resolveAccountExternalCheckinActionInternal(account, site);
      if (action.mode === 'none' || !action.entryUrl) {
        return null;
      }
      if (action.mode === 'manual_jump') {
        return {
          ...action,
          handled: true,
          result: { success: false, message: MANUAL_EXTERNAL_CHECKIN_MESSAGE },
        };
      }
      return executeTokenBridgeCheckin(account, site, action.entryUrl);
    },
  );
}
