import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getPreferredAccountToken } from './accountTokenService.js';
import {
  requiresManagedAccountTokens,
  supportsDirectAccountRoutingConnection,
} from './accountExtraConfig.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { buildOauthProviderHeaders } from './oauth/service.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from './siteProxy.js';
import { resolveSiteApiBaseUrl } from './siteApiEndpointService.js';
import { dispatchRuntimeRequest } from './runtimeDispatch.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpointRuntime.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../proxy-core/orchestration/endpointFlow.js';
import { summarizeUpstreamError } from '../proxy-core/orchestration/upstreamRequest.js';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';
import { collectResponsesFinalPayloadFromSseText, looksLikeResponsesSseText } from '../routes/proxy/responsesSseFinal.js';
import {
  createStreamTransformContext,
  normalizeUpstreamFinalResponse,
  normalizeUpstreamStreamEvent,
  type ParsedSseEvent,
  pullSseEventsWithDone,
} from '../transformers/shared/chatFormatsCore.js';

const ACCOUNT_PROBE_TIMEOUT_MS = 15_000;

type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

export type AccountProbeChatResult = {
  success: boolean;
  statusText: string;
  replyText?: string;
  errorMessage?: string;
  latencyMs: number | null;
  model: string;
};

class AccountProbeServiceError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'AccountProbeServiceError';
    this.statusCode = statusCode;
  }
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildProbeBody(modelName: string): Record<string, unknown> {
  return {
    model: modelName,
    messages: [
      {
        role: 'user',
        content: 'hi',
      },
    ],
    max_tokens: 64,
    stream: true,
  };
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveRemainingTimeoutMs(deadlineAtMs: number, timeoutLabel: string): number {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(timeoutLabel);
  }
  return remainingMs;
}

function resolveDirectCredential(account: typeof schema.accounts.$inferSelect): string {
  const oauth = getOauthInfoFromAccount(account);
  return asTrimmedString(oauth ? account.accessToken : account.apiToken);
}

async function resolveProbeCredential(account: typeof schema.accounts.$inferSelect): Promise<{
  tokenValue: string | null;
  errorMessage?: string;
}> {
  if (requiresManagedAccountTokens(account)) {
    const preferredToken = await getPreferredAccountToken(account.id);
    const tokenValue = asTrimmedString(preferredToken?.token);
    if (tokenValue) {
      return { tokenValue };
    }
  }

  if (supportsDirectAccountRoutingConnection(account)) {
    const directCredential = resolveDirectCredential(account);
    if (directCredential) {
      return { tokenValue: directCredential };
    }
  }

  if (requiresManagedAccountTokens(account)) {
    return {
      tokenValue: null,
      errorMessage: '该连接暂无可用账号令牌，请先同步或设置默认令牌',
    };
  }

  return {
    tokenValue: null,
    errorMessage: '该连接缺少可用凭据，请检查 API Key 或登录状态',
  };
}

function collectChatTextFromSse(rawText: string, modelName: string): string {
  const context = createStreamTransformContext(modelName);
  let replyText = '';

  const pulled = pullSseEventsWithDone(rawText);
  const events: ParsedSseEvent[] = [...pulled.events];
  if (pulled.rest.trim().length > 0) {
    const trailing = pullSseEventsWithDone(`${pulled.rest}\n\n`);
    if (trailing.events.length > 0 && trailing.rest.trim().length === 0) {
      events.push(...trailing.events);
    }
  }

  for (const event of events) {
    if (event.data === '[DONE]') continue;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }
    const normalized = normalizeUpstreamStreamEvent(payload, context, modelName);
    if (typeof normalized.contentDelta === 'string' && normalized.contentDelta.length > 0) {
      replyText += normalized.contentDelta;
    }
  }

  return replyText.trim();
}

function extractProbeReply(rawText: string, modelName: string): {
  replyText: string;
  resolvedModel: string;
} {
  if (looksLikeResponsesSseText(rawText)) {
    const collected = collectResponsesFinalPayloadFromSseText(rawText, modelName);
    const normalized = normalizeUpstreamFinalResponse(collected.payload, modelName);
    return {
      replyText: asTrimmedString(normalized.content),
      resolvedModel: normalized.model || modelName,
    };
  }

  const trimmed = asTrimmedString(rawText);
  if (trimmed.startsWith('data:') || trimmed.includes('\ndata:')) {
    return {
      replyText: collectChatTextFromSse(rawText, modelName),
      resolvedModel: modelName,
    };
  }

  let payload: unknown = rawText;
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = rawText;
  }

  const normalized = normalizeUpstreamFinalResponse(payload, modelName);
  return {
    replyText: asTrimmedString(normalized.content),
    resolvedModel: normalized.model || modelName,
  };
}

function normalizeFailureMessage(status: number, rawErrorText: string, fallbackMessage: string): string {
  const raw = asTrimmedString(rawErrorText);
  if (raw) {
    return summarizeUpstreamError(status, raw).replace(/^\[upstream:[^\]]+\]\s*/i, '').trim();
  }
  return asTrimmedString(fallbackMessage).replace(/^\[upstream:[^\]]+\]\s*/i, '').trim() || '测活失败';
}

async function loadAccountWithSite(accountId: number): Promise<AccountWithSiteRow> {
  const row = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!row) {
    throw new AccountProbeServiceError(404, '账号不存在');
  }

  return row;
}

export async function probeAccountChat(input: {
  accountId: number;
  modelName: string;
  timeoutMs?: number;
}): Promise<AccountProbeChatResult> {
  const accountId = Number.parseInt(String(input.accountId), 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new AccountProbeServiceError(400, '账号 ID 无效');
  }

  const modelName = asTrimmedString(input.modelName);
  if (!modelName) {
    throw new AccountProbeServiceError(400, '模型名称不能为空');
  }

  const timeoutMs = Math.max(1, input.timeoutMs ?? ACCOUNT_PROBE_TIMEOUT_MS);
  const row = await loadAccountWithSite(accountId);
  const account = row.accounts;
  const site = row.sites;

  const credential = await resolveProbeCredential(account);
  if (!credential.tokenValue) {
    return {
      success: false,
      statusText: '测活失败',
      errorMessage: credential.errorMessage || '该连接缺少可用凭据',
      latencyMs: null,
      model: modelName,
    };
  }

  const tokenValue = credential.tokenValue;
  const startedAt = Date.now();
  const deadlineAtMs = startedAt + timeoutMs;

  try {
    const endpointCandidates = await withTimeout(
      () => resolveUpstreamEndpointCandidates(
        {
          site,
          account,
        },
        modelName,
        'openai',
        modelName,
      ),
      resolveRemainingTimeoutMs(
        deadlineAtMs,
        `account probe candidate resolution timeout (${Math.round(timeoutMs / 1000)}s)`,
      ),
      `account probe candidate resolution timeout (${Math.round(timeoutMs / 1000)}s)`,
    );

    if (endpointCandidates.length <= 0) {
      return {
        success: false,
        statusText: '测活失败',
        errorMessage: '未找到可用的上游接口',
        latencyMs: Date.now() - startedAt,
        model: modelName,
      };
    }

    const oauth = getOauthInfoFromAccount(account);
    const providerHeaders = buildOauthProviderHeaders({
      account,
      downstreamHeaders: {},
    });
    const resolvedSiteApiBaseUrl = await resolveSiteApiBaseUrl(site);
    if (!resolvedSiteApiBaseUrl) {
      return {
        success: false,
        statusText: '测活失败',
        errorMessage: '当前站点的 API 请求地址均不可用',
        latencyMs: Date.now() - startedAt,
        model: modelName,
      };
    }
    const openaiBody = buildProbeBody(modelName);
    const channelProxyUrl = resolveChannelProxyUrl(site, account.extraConfig);
    const abortController = new AbortController();
    const remainingExecutionTimeoutMs = resolveRemainingTimeoutMs(
      deadlineAtMs,
      `account probe timeout (${Math.round(timeoutMs / 1000)}s)`,
    );
    const abortTimer = setTimeout(() => {
      abortController.abort(new Error(`account probe timeout (${Math.round(timeoutMs / 1000)}s)`));
    }, remainingExecutionTimeoutMs);
    abortTimer.unref?.();

    const buildRequest = (endpoint: UpstreamEndpoint): BuiltEndpointRequest => {
      const request = buildUpstreamEndpointRequest({
        endpoint,
        modelName,
        stream: true,
        tokenValue,
        oauthProvider: oauth?.provider,
        oauthProjectId: oauth?.projectId,
        sitePlatform: site.platform,
        siteUrl: resolvedSiteApiBaseUrl,
        openaiBody,
        downstreamFormat: 'openai',
        downstreamHeaders: {},
        providerHeaders,
      });

      return {
        endpoint,
        path: request.path,
        headers: request.headers,
        body: request.body as Record<string, unknown>,
        runtime: request.runtime,
      };
    };

    const dispatchRequest = async (
      request: BuiltEndpointRequest,
      targetUrl: string,
    ) => (
      dispatchRuntimeRequest({
        siteUrl: resolvedSiteApiBaseUrl,
        targetUrl,
        request,
        buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(
          site,
          {
            method: 'POST',
            headers: requestForFetch.headers,
            body: JSON.stringify(requestForFetch.body),
            signal: abortController.signal,
          },
          channelProxyUrl,
        ),
      })
    );

    let result: Awaited<ReturnType<typeof executeEndpointFlow>>;
    try {
      result = await executeEndpointFlow({
        siteUrl: resolvedSiteApiBaseUrl,
        proxyUrl: channelProxyUrl,
        endpointCandidates,
        buildRequest,
        dispatchRequest,
      });
    } finally {
      clearTimeout(abortTimer);
    }

    const latencyMs = Date.now() - startedAt;

    if (!result.ok) {
      return {
        success: false,
        statusText: '测活失败',
        errorMessage: normalizeFailureMessage(
          result.status || 0,
          asTrimmedString(result.rawErrText),
          result.errText,
        ),
        latencyMs,
        model: modelName,
      };
    }

    const rawText = await readRuntimeResponseText(result.upstream);
    const extracted = extractProbeReply(rawText, modelName);

    if (!extracted.replyText) {
      return {
        success: false,
        statusText: '测活失败',
        errorMessage: '上游已响应，但未返回任何可展示文本',
        latencyMs,
        model: extracted.resolvedModel || modelName,
      };
    }

    return {
      success: true,
      statusText: '服务正常',
      replyText: extracted.replyText,
      latencyMs,
      model: extracted.resolvedModel || modelName,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return {
      success: false,
      statusText: '测活失败',
      errorMessage: error instanceof Error ? error.message : '测活失败',
      latencyMs,
      model: modelName,
    };
  }
}

export function isAccountProbeServiceError(error: unknown): error is AccountProbeServiceError {
  return error instanceof AccountProbeServiceError;
}
