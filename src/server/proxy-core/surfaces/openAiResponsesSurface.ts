import { TextDecoder } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { reportProxyAllFailed } from '../../services/alertService.js';
import { hasProxyUsagePayload, mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import {
  extractResponsesTerminalResponseId,
  hasOrphanToolOutputFollowUp,
  isResponsesPreviousResponseNotFoundError,
  shouldInferResponsesPreviousResponseId,
  stripResponsesPreviousResponseId,
  withResponsesPreviousResponseId,
} from '../../transformers/openai/responses/continuation.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from '../../services/upstreamEndpointRuntime.js';
import {
  ensureUpstreamEndpointRuntimeStateLoaded,
  getUpstreamEndpointRuntimeStateSnapshot,
  recordUpstreamEndpointFailure,
  recordUpstreamEndpointSuccess,
} from '../../services/upstreamEndpointRuntimeMemory.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from '../../routes/proxy/downstreamPolicy.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../orchestration/endpointFlow.js';
import { detectProxyFailure } from '../../routes/proxy/proxyFailureJudge.js';
import { getProxyAuthContext, getProxyResourceOwner } from '../../middleware/auth.js';
import { normalizeInputFileBlock } from '../../transformers/shared/inputFile.js';
import {
  ProxyInputFileResolutionError,
  resolveResponsesBodyInputFiles,
} from '../../services/proxyInputFileResolver.js';
import {
  buildOauthProviderHeaders,
} from '../../services/oauth/service.js';
import { getOauthInfoFromAccount } from '../../services/oauth/oauthAccount.js';
import {
  collectResponsesFinalPayloadFromSse,
  collectResponsesFinalPayloadFromSseText,
  createSingleChunkStreamReader,
  looksLikeResponsesSseText,
} from '../../routes/proxy/responsesSseFinal.js';
import {
  createGeminiCliStreamReader,
  unwrapGeminiCliPayload,
} from '../../routes/proxy/geminiCliCompat.js';
import { isCodexResponsesSurface } from '../cliProfiles/codexProfile.js';
import { getObservedResponseMeta } from '../firstByteTimeout.js';
import { getRuntimeResponseReader, readRuntimeResponseText } from '../executors/types.js';
import { runCodexHttpSessionTask } from '../runtime/codexHttpSessionQueue.js';
import {
  buildCodexSessionResponseStoreKey,
  clearCodexSessionResponseId,
  ensureCodexSessionResponseStoreLoaded,
  getCodexSessionResponseId,
  setCodexSessionResponseId,
} from '../runtime/codexSessionResponseStore.js';
import {
  summarizeConversationFileInputsInOpenAiBody,
  summarizeConversationFileInputsInResponsesBody,
} from '../capabilities/conversationFileCapabilities.js';
import {
  sanitizeCompactResponsesRequestBody,
  shouldFallbackCompactResponsesToResponses,
} from '../capabilities/responsesCompact.js';
import { detectDownstreamClientContext } from '../downstreamClientContext.js';
import { buildContentContinuitySeed } from '../providers/headerUtils.js';
import {
  clearChannelAffinityBinding,
  recordChannelAffinitySuccess,
  resolveChannelAffinityRequest,
} from '../../services/channelAffinity.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import { shouldAbortSameSiteEndpointFallback } from '../../services/proxyRetryPolicy.js';
import { describeErrorWithCauses } from '../../services/errorMessageService.js';
import {
  acquireSurfaceChannelLease,
  bindSurfaceStickyChannel,
  buildSurfaceChannelBusyMessage,
  buildSurfaceStickySessionKey,
  clearSurfaceStickyChannel,
  createSurfaceFailureToolkit,
  createSurfaceDispatchRequest,
  getSurfaceStickyPreferredChannelId,
  recordSurfaceSuccess,
  selectSurfaceChannelForAttempt,
  trySurfaceOauthRefreshRecovery,
} from './sharedSurface.js';
import {
  buildSurfaceProxyDebugResponseHeaders,
  captureSurfaceProxyDebugSuccessResponseBody,
  parseSurfaceProxyDebugTextPayload,
  reserveSurfaceProxyDebugAttemptBase,
  safeFinalizeSurfaceProxyDebugTrace,
  safeInsertSurfaceProxyDebugAttempt,
  safeUpdateSurfaceProxyDebugAttempt,
  safeUpdateSurfaceProxyDebugCandidates,
  safeUpdateSurfaceProxyDebugSelection,
  startSurfaceProxyDebugTrace,
} from '../../services/proxyDebugTraceRuntime.js';
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import {
  buildForcedChannelUnavailableMessage,
  canRetryChannelSelection,
  getTesterForcedChannelId,
} from '../channelSelection.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function getResponsesHeaderValueByKeys(headers: Record<string, unknown>, keys: string[]): string {
  for (const targetKey of keys) {
    const normalizedTargetKey = targetKey.trim().toLowerCase();
    for (const [rawKey, rawValue] of Object.entries(headers)) {
      const normalizedKey = rawKey.trim().toLowerCase();
      if (normalizedKey !== normalizedTargetKey) continue;
      if (typeof rawValue === 'string') {
        const trimmed = rawValue.trim();
        if (trimmed) return trimmed;
      }
      if (Array.isArray(rawValue)) {
        const match = rawValue.find((value) => typeof value === 'string' && value.trim().length > 0);
        if (typeof match === 'string') {
          return match.trim();
        }
      }
    }
  }
  return '';
}

function getResponsesSessionHeaderValue(headers: Record<string, unknown>): string {
  return getResponsesHeaderValueByKeys(headers, [
    'session_id',
    'session-id',
    'conversation_id',
    'conversation-id',
  ]);
}

function isNativeResponsesUpstreamPath(path: string): boolean {
  return /\/responses(?:\/compact)?$/i.test(path.trim());
}

function syncTrustedResponsesSessionResponseId(
  sessionStoreKey: string,
  upstreamPath: string,
  payload: unknown,
): void {
  if (!sessionStoreKey) return;
  if (!isNativeResponsesUpstreamPath(upstreamPath)) {
    clearCodexSessionResponseId(sessionStoreKey);
    return;
  }

  const responseId = extractResponsesTerminalResponseId(payload);
  if (responseId) {
    setCodexSessionResponseId(sessionStoreKey, responseId);
    return;
  }

  clearCodexSessionResponseId(sessionStoreKey);
}

function syncTrustedResponsesSessionResponseIdFromSseText(
  sessionStoreKey: string,
  upstreamPath: string,
  rawText: string,
  modelName: string,
): void {
  if (!sessionStoreKey) return;
  if (!isNativeResponsesUpstreamPath(upstreamPath)) {
    clearCodexSessionResponseId(sessionStoreKey);
    return;
  }

  try {
    syncTrustedResponsesSessionResponseId(
      sessionStoreKey,
      upstreamPath,
      collectResponsesFinalPayloadFromSseText(rawText, modelName).payload,
    );
  } catch {
    clearCodexSessionResponseId(sessionStoreKey);
  }
}

function moveEndpointToTail(
  candidates: UpstreamEndpoint[],
  targetEndpoint: UpstreamEndpoint,
): UpstreamEndpoint[] {
  if (!candidates.includes(targetEndpoint)) return candidates;
  return [
    ...candidates.filter((endpoint) => endpoint !== targetEndpoint),
    targetEndpoint,
  ];
}

function isResponsesWebsocketTransportRequest(headers: Record<string, unknown>): boolean {
  return Object.entries(headers)
    .some(([rawKey, rawValue]) => rawKey.trim().toLowerCase() === 'x-metapi-responses-websocket-transport'
      && String(rawValue).trim() === '1');
}

function getResponsesWebsocketModeHeaderValue(headers: Record<string, unknown>): string {
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== 'x-metapi-responses-websocket-mode') continue;
    return String(rawValue || '').trim().toLowerCase();
  }
  return '';
}

function normalizeIncludeList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function hasExplicitInclude(body: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'include');
}

function hasResponsesReasoningRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const relevantKeys = ['effort', 'budget_tokens', 'budgetTokens', 'max_tokens', 'maxTokens', 'summary'];
  return relevantKeys.some((key) => {
    const entry = value[key];
    if (typeof entry === 'string') return entry.trim().length > 0;
    return entry !== undefined && entry !== null;
  });
}

function carriesResponsesReasoningContinuity(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => carriesResponsesReasoningContinuity(item));
  }
  if (!isRecord(value)) return false;

  const type = typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
  if (type === 'reasoning') {
    if (typeof value.encrypted_content === 'string' && value.encrypted_content.trim()) {
      return true;
    }
    if (Array.isArray(value.summary) && value.summary.length > 0) {
      return true;
    }
  }

  if (typeof value.reasoning_signature === 'string' && value.reasoning_signature.trim()) {
    return true;
  }

  return carriesResponsesReasoningContinuity(value.input)
    || carriesResponsesReasoningContinuity(value.content);
}

function wantsNativeResponsesReasoning(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const include = normalizeIncludeList(body.include);
  if (include.some((item) => item.toLowerCase() === 'reasoning.encrypted_content')) {
    return true;
  }
  if (carriesResponsesReasoningContinuity(body.input)) {
    return true;
  }
  if (hasExplicitInclude(body)) {
    return false;
  }
  return hasResponsesReasoningRequest(body.reasoning);
}

function carriesResponsesFileUrlInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => carriesResponsesFileUrlInput(item));
  }
  if (!isRecord(value)) return false;

  const normalizedFile = normalizeInputFileBlock(value);
  if (normalizedFile?.fileUrl) return true;

  return Object.values(value).some((entry) => carriesResponsesFileUrlInput(entry));
}

function finalizeRetryAsUpstreamFailure(status: number, message: string) {
  return {
    action: 'respond' as const,
    status,
    payload: {
      error: {
        message,
        type: 'upstream_error' as const,
      },
    },
  };
}

function finalizeRetryAsExecutionFailure(message: string) {
  return {
    action: 'respond' as const,
    status: 502,
    payload: {
      error: {
        message: `Upstream error: ${message}`,
        type: 'upstream_error' as const,
      },
    },
  };
}

function shouldRefreshOauthResponsesRequest(input: {
  oauthProvider?: string;
  status: number;
  response: { headers: { get(name: string): string | null } };
  rawErrText: string;
}): boolean {
  if (input.status === 401) return true;
  if (input.status !== 403 || input.oauthProvider !== 'codex') return false;
  const authenticate = input.response.headers.get('www-authenticate') || '';
  const combined = `${authenticate}\n${input.rawErrText || ''}`;
  return /\b(invalid_token|expired_token|expired|invalid|unauthorized|account mismatch|authentication)\b/i.test(combined);
}

type UsageSummary = ReturnType<typeof parseProxyUsage>;

export async function handleOpenAiResponsesSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  downstreamPath: '/v1/responses' | '/v1/responses/compact',
) {
    const requestHeaders = request.headers as Record<string, unknown>;
    const body = request.body as Record<string, unknown>;
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: requestHeaders,
      body,
    });
    const defaultEncryptedReasoningInclude = isCodexResponsesSurface(
      requestHeaders,
    );
    const parsedRequestEnvelope = openAiResponsesTransformer.transformRequest(body, {
      defaultEncryptedReasoningInclude,
    });
    if (parsedRequestEnvelope.error) {
      return reply.code(parsedRequestEnvelope.error.statusCode).send(parsedRequestEnvelope.error.payload);
    }
    const requestEnvelope = parsedRequestEnvelope.value!;
    const requestedModel = requestEnvelope.model;
    const isStream = requestEnvelope.stream;
    const isCompactRequest = downstreamPath === '/v1/responses/compact';
    if (isCompactRequest && isStream) {
      return reply.code(400).send({
        error: {
          message: 'stream is not supported on /v1/responses/compact',
          type: 'invalid_request_error',
        },
      });
    }
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    await ensureCodexSessionResponseStoreLoaded();
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const forcedChannelId = getTesterForcedChannelId({
      headers: request.headers as Record<string, unknown>,
      clientIp: request.ip,
    });
    const authContext = getProxyAuthContext(request);
    const downstreamApiKeyId = authContext?.keyId ?? null;
    const maxRetries = getProxyMaxChannelRetries();
    const failureToolkit = createSurfaceFailureToolkit({
      warningScope: 'responses',
      downstreamPath,
      maxRetries,
      clientContext,
      downstreamApiKeyId,
    });
    const channelAffinity = resolveChannelAffinityRequest({
      config: config.channelAffinity,
      requestedModel,
      downstreamPath,
      headers: requestHeaders,
      body: requestEnvelope.parsed.normalizedBody,
      clientContext,
      downstreamGroup: authContext?.source === 'managed' ? authContext.keyName : null,
      downstreamApiKeyId,
    });
    const downstreamSessionId = (
      clientContext.sessionId
      || getResponsesSessionHeaderValue(requestHeaders)
    ).trim();
    const explicitPreviousResponseId = String(
      body.previous_response_id
      || requestEnvelope.parsed.normalizedBody.previous_response_id
      || '',
    ).trim();
    const contentContinuitySeed = (!downstreamSessionId && !explicitPreviousResponseId)
      ? buildContentContinuitySeed({
        requestedModel,
        downstreamPath,
        body: requestEnvelope.parsed.normalizedBody,
      })
      : null;
    const continuitySessionId = downstreamSessionId || (contentContinuitySeed ? `content-seed:${contentContinuitySeed}` : '');
    const rememberedPreviousResponseId = continuitySessionId
      ? getCodexSessionResponseId(continuitySessionId)
      : null;
    const stickyContinuityKey = explicitPreviousResponseId || rememberedPreviousResponseId || contentContinuitySeed || null;
    const stickySessionKey = buildSurfaceStickySessionKey({
      clientContext,
      sessionId: continuitySessionId || null,
      continuityKey: stickyContinuityKey,
      requestedModel,
      downstreamPath,
      downstreamApiKeyId,
    });
    const debugTrace = await startSurfaceProxyDebugTrace({
      downstreamPath,
      clientKind: clientContext.clientKind,
      sessionId: clientContext.sessionId || null,
      traceHint: clientContext.traceHint || null,
      requestedModel,
      downstreamApiKeyId,
      requestHeaders,
      requestBody: request.body,
    });
    const finalizeDebugFailure = async (status: number, payload: unknown, upstreamPath: string | null = null) => {
      await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
        finalStatus: 'failed',
        finalHttpStatus: status,
        finalUpstreamPath: upstreamPath,
        finalResponseHeaders: {
          'content-type': 'application/json',
        },
        finalResponseBody: payload,
      });
    };
    const finalizeDebugSuccess = async (status: number, upstreamPath: string | null, responseHeaders: unknown, responseBody: unknown) => {
      await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
        finalStatus: 'success',
        finalHttpStatus: status,
        finalUpstreamPath: upstreamPath,
        finalResponseHeaders: responseHeaders as Record<string, unknown> | null,
        finalResponseBody: responseBody,
      });
    };
    const excludeChannelIds: number[] = [];
    let retryCount = 0;

    while (retryCount <= maxRetries) {
      const stickyPreferredChannelId = retryCount === 0
        ? getSurfaceStickyPreferredChannelId(stickySessionKey)
        : null;
      const affinityPreferredChannelId = retryCount === 0 && !stickyPreferredChannelId
        ? (channelAffinity?.preferredChannelId ?? null)
        : null;
      const selected = await selectSurfaceChannelForAttempt({
        requestedModel,
        downstreamPolicy,
        excludeChannelIds,
        retryCount,
        stickySessionKey,
        forcedChannelId,
        affinityPreferredChannelId,
      });

      if (!selected) {
        const noChannelMessage = buildForcedChannelUnavailableMessage(forcedChannelId);
        await reportProxyAllFailed({
          model: requestedModel,
          reason: forcedChannelId ? noChannelMessage : 'No available channels after retries',
        });
        const payload = {
          error: { message: noChannelMessage, type: 'server_error' as const },
        };
        await finalizeDebugFailure(503, payload, null);
        return reply.code(503).send({
          error: { message: noChannelMessage, type: 'server_error' },
        });
      }

      const affinityRetryLocked = Boolean(
        retryCount === 0
        && affinityPreferredChannelId
        && channelAffinity?.skipRetryOnFailure
        && selected.channel.id === affinityPreferredChannelId,
      );
      const canRetryCurrentSelection = () => canRetryChannelSelection(
        retryCount,
        forcedChannelId,
        affinityRetryLocked,
      );
      const recordChannelAffinityIfSuccessful = () => recordChannelAffinitySuccess({
        config: config.channelAffinity,
        resolution: channelAffinity,
        selectedChannelId: selected.channel.id,
      });
      if (
        retryCount === 0
        && affinityPreferredChannelId
        && selected.channel.id !== affinityPreferredChannelId
        && !stickyPreferredChannelId
      ) {
        clearChannelAffinityBinding(channelAffinity?.cacheKey, affinityPreferredChannelId);
      }

      excludeChannelIds.push(selected.channel.id);
      await safeUpdateSurfaceProxyDebugSelection(debugTrace, {
        stickySessionKey,
        stickyHitChannelId: (
          stickyPreferredChannelId && stickyPreferredChannelId === selected.channel.id
            ? stickyPreferredChannelId
            : null
        ),
        selectedChannelId: selected.channel.id,
        selectedRouteId: selected.channel.routeId ?? null,
        selectedAccountId: selected.account.id,
        selectedSiteId: selected.site.id,
        selectedSitePlatform: selected.site.platform,
      });

      const modelName = selected.actualModel || requestedModel;
      const oauth = getOauthInfoFromAccount(selected.account);
      const isCodexSite = String(selected.site.platform || '').trim().toLowerCase() === 'codex';
      const isCodexClient = clientContext.clientKind === 'codex';
      const isCodexCompatibleRequest = isCodexSite || isCodexClient;
      const trustedResponsesSessionStoreKey = continuitySessionId
        ? buildCodexSessionResponseStoreKey({
          sessionId: continuitySessionId,
          siteId: selected.site.id,
          accountId: selected.account.id,
          channelId: selected.channel.id,
        })
        : null;
      const owner = getProxyResourceOwner(request);

      let normalizedResponsesBody: Record<string, unknown> = {
        ...requestEnvelope.parsed.normalizedBody,
        model: modelName,
        stream: isStream,
      };
      if (body.generate === false) {
        normalizedResponsesBody.generate = false;
      }
      if (owner) {
        try {
          normalizedResponsesBody = await resolveResponsesBodyInputFiles(normalizedResponsesBody, owner);
        } catch (error) {
          if (error instanceof ProxyInputFileResolutionError) {
            return reply.code(error.statusCode).send(error.payload);
          }
          throw error;
        }
      }
      const openAiBody = openAiResponsesTransformer.inbound.toOpenAiBody(
        normalizedResponsesBody,
        modelName,
        isStream,
        { defaultEncryptedReasoningInclude },
      );
      const conversationFileSummary = summarizeConversationFileInputsInOpenAiBody(openAiBody);
      const hasNonImageFileInput = conversationFileSummary.hasDocument;
      const prefersNativeResponsesReasoning = wantsNativeResponsesReasoning(normalizedResponsesBody);
      const responsesConversationFileSummary = summarizeConversationFileInputsInResponsesBody(normalizedResponsesBody);
      const requiresNativeResponsesFileUrl = responsesConversationFileSummary.hasRemoteDocumentUrl
        || carriesResponsesFileUrlInput(normalizedResponsesBody.input);
      const websocketTransportRequest = isResponsesWebsocketTransportRequest(requestHeaders);
      const websocketIncrementalTransportRequest = websocketTransportRequest
        && getResponsesWebsocketModeHeaderValue(requestHeaders) === 'incremental';
      const websocketNonIncrementalReplayRequest = websocketTransportRequest
        && !websocketIncrementalTransportRequest;
      const allowSurfaceContinuationInference = !websocketNonIncrementalReplayRequest;
      const hasOrphanToolOutputContinuation = allowSurfaceContinuationInference
        && hasOrphanToolOutputFollowUp(normalizedResponsesBody);
      const trustedNativeResponsesResponseId = allowSurfaceContinuationInference
        && trustedResponsesSessionStoreKey
        ? getCodexSessionResponseId(trustedResponsesSessionStoreKey)
        : null;
      const hasTrustedNativeResponsesAnchor = !!trustedNativeResponsesResponseId;
      const wantsContinuationAwareResponses = hasOrphanToolOutputContinuation || hasTrustedNativeResponsesAnchor;
      let endpointCandidates: UpstreamEndpoint[] = isCompactRequest
        ? ['responses']
        : await resolveUpstreamEndpointCandidates(
          {
            site: selected.site,
            account: selected.account,
          },
          modelName,
          'responses',
          requestedModel,
          {
            hasNonImageFileInput,
            conversationFileSummary,
            wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
            wantsContinuationAwareResponses,
          },
        );
      if (endpointCandidates.length === 0) {
        endpointCandidates.push('responses', 'chat', 'messages');
      }
      if (hasOrphanToolOutputContinuation && !hasTrustedNativeResponsesAnchor) {
        endpointCandidates = moveEndpointToTail(endpointCandidates, 'responses');
      }
      const endpointRuntimeContext = {
        siteId: selected.site.id,
        modelName,
        downstreamFormat: 'responses' as const,
        requestedModelHint: requestedModel,
        requestCapabilities: {
          hasNonImageFileInput,
          conversationFileSummary,
          wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
          wantsContinuationAwareResponses,
        },
      };
      await safeUpdateSurfaceProxyDebugCandidates(debugTrace, {
        endpointCandidates,
        endpointRuntimeState: getUpstreamEndpointRuntimeStateSnapshot(endpointRuntimeContext),
        decisionSummary: {
          retryCount,
          downstreamFormat: 'responses',
          stickySessionKey,
          stickyPreferredChannelId,
          oauthProvider: oauth?.provider || null,
          isCodexSite,
          requiresNativeResponsesFileUrl,
          isCompactRequest,
          hasOrphanToolOutputFollowUp: hasOrphanToolOutputContinuation,
          hasTrustedNativeResponsesAnchor,
          wantsContinuationAwareResponses,
          websocketTransportRequest,
          websocketIncrementalTransportRequest,
          websocketNonIncrementalReplayRequest,
          allowSurfaceContinuationInference,
        },
      });
      const buildProviderHeaders = () => (
        buildOauthProviderHeaders({
          account: selected.account,
          downstreamHeaders: requestHeaders,
        })
      );
      const executeEndpointResultForSiteApiBaseUrl = async (siteApiBaseUrl: string) => {
        const forceCodexUpstreamStream = isCodexCompatibleRequest && !isCompactRequest;
        const buildEndpointRequest = (endpoint: 'chat' | 'messages' | 'responses') => {
          const upstreamStream = isStream || (forceCodexUpstreamStream && endpoint === 'responses');
          const responsesOriginalBody = (
            endpoint === 'responses'
            && trustedResponsesSessionStoreKey
            && hasTrustedNativeResponsesAnchor
            && shouldInferResponsesPreviousResponseId(
              normalizedResponsesBody,
              trustedNativeResponsesResponseId,
            )
          )
            ? withResponsesPreviousResponseId(
              normalizedResponsesBody,
              trustedNativeResponsesResponseId!,
            )
            : normalizedResponsesBody;
          const endpointRequest = buildUpstreamEndpointRequest({
            endpoint,
            modelName,
            stream: upstreamStream,
            tokenValue: selected.tokenValue,
            oauthProvider: oauth?.provider,
            oauthProjectId: oauth?.projectId,
            sitePlatform: selected.site.platform,
            siteUrl: siteApiBaseUrl,
            openaiBody: openAiBody,
            downstreamFormat: 'responses',
            responsesOriginalBody,
            downstreamHeaders: requestHeaders,
            downstreamClientKind: clientContext.clientKind,
            providerHeaders: buildProviderHeaders(),
            codexSessionCacheKey: downstreamSessionId ? (trustedResponsesSessionStoreKey || undefined) : undefined,
            codexExplicitSessionId: downstreamSessionId || undefined,
          });
          const upstreamPath = (
            isCompactRequest && endpoint === 'responses'
              ? `${endpointRequest.path}/compact`
              : endpointRequest.path
          );
          const requestBody = (
            isCompactRequest && endpoint === 'responses'
              ? sanitizeCompactResponsesRequestBody(endpointRequest.body as Record<string, unknown>)
              : endpointRequest.body as Record<string, unknown>
          );
          return {
            endpoint,
            path: upstreamPath,
            headers: endpointRequest.headers,
            body: requestBody,
            runtime: endpointRequest.runtime,
          };
        };
        const baseDispatchRequest = createSurfaceDispatchRequest({
          site: selected.site,
          siteUrl: siteApiBaseUrl,
          accountExtraConfig: selected.account.extraConfig,
        });
        const dispatchRequest = (
          endpointRequest: BuiltEndpointRequest,
          targetUrl?: string,
        ) => {
          if (!isCodexCompatibleRequest || !endpointRequest.path.startsWith('/responses')) {
            return baseDispatchRequest(endpointRequest, targetUrl);
          }
          const sessionId = getResponsesSessionHeaderValue(endpointRequest.headers);
          if (!downstreamSessionId) {
            return baseDispatchRequest(endpointRequest, targetUrl);
          }
          return runCodexHttpSessionTask(
            trustedResponsesSessionStoreKey || sessionId,
            () => baseDispatchRequest(endpointRequest, targetUrl),
          );
        };
        const endpointStrategy = openAiResponsesTransformer.compatibility.createEndpointStrategy({
          isStream: isStream || forceCodexUpstreamStream,
          requiresNativeResponsesFileUrl,
          dispatchRequest,
        });
        const tryRecover = async (ctx: Parameters<NonNullable<typeof endpointStrategy.tryRecover>>[0]) => {
          if (oauth && shouldRefreshOauthResponsesRequest({
            oauthProvider: oauth.provider,
            status: ctx.response.status,
            response: ctx.response,
            rawErrText: ctx.rawErrText || '',
          })) {
          const recovered = await trySurfaceOauthRefreshRecovery({
            ctx,
            selected,
            siteUrl: siteApiBaseUrl,
            buildRequest: (endpoint) => buildEndpointRequest(endpoint),
            dispatchRequest,
            onRecoveredSuccess: ({ failedRequest, failedResponse, failedRawErrText }) => failureToolkit.log({
              selected,
              modelRequested: requestedModel,
              status: 'retried',
              httpStatus: failedResponse.status,
              latencyMs: Date.now() - startTime,
              errorMessage: failedRawErrText || 'unknown error',
              retryCount,
              upstreamPath: failedRequest.path,
            }),
          });
            if (recovered?.upstream?.ok) {
              return recovered;
            }
          }
          if (
            ctx.request.endpoint === 'responses'
            && isResponsesPreviousResponseNotFoundError({
              rawErrText: ctx.rawErrText,
            })
          ) {
            if (trustedResponsesSessionStoreKey) {
              clearCodexSessionResponseId(trustedResponsesSessionStoreKey);
            }
            const previousResponseRecovery = stripResponsesPreviousResponseId(ctx.request.body);
            if (previousResponseRecovery.removed) {
              const recoveredRequest = {
                ...ctx.request,
                body: previousResponseRecovery.body,
              };
              const recoveredResponse = await dispatchRequest(recoveredRequest, ctx.targetUrl);
              if (recoveredResponse.ok) {
                return {
                  upstream: recoveredResponse,
                  upstreamPath: recoveredRequest.path,
                  request: recoveredRequest,
                  targetUrl: ctx.targetUrl,
                };
              }
              ctx.request = recoveredRequest;
              ctx.response = recoveredResponse;
              ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
            }
          }
          if (
            isCompactRequest
            && config.responsesCompactFallbackToResponsesEnabled
            && ctx.request.endpoint === 'responses'
            && ctx.request.path.endsWith('/responses/compact')
            && shouldFallbackCompactResponsesToResponses({
              status: ctx.response.status,
              rawErrText: ctx.rawErrText,
            })
          ) {
            const recoveredRequest = {
              ...ctx.request,
              path: ctx.request.path.replace(/\/compact$/, ''),
            };
            const recoveredResponse = await dispatchRequest(recoveredRequest);
            if (recoveredResponse.ok) {
              return {
                upstream: recoveredResponse,
                upstreamPath: recoveredRequest.path,
                request: recoveredRequest,
              };
            }
            ctx.request = recoveredRequest;
            ctx.response = recoveredResponse;
            ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
          }
          return endpointStrategy.tryRecover(ctx);
        };

        const debugAttemptBase = reserveSurfaceProxyDebugAttemptBase(debugTrace, endpointCandidates.length);
        return executeEndpointFlow({
          siteUrl: siteApiBaseUrl,
          disableCrossProtocolFallback: isCompactRequest || config.disableCrossProtocolFallback,
          firstByteTimeoutMs: Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000)),
          endpointCandidates,
          buildRequest: (endpoint) => buildEndpointRequest(endpoint),
          dispatchRequest,
          tryRecover,
          shouldAbortRemainingEndpoints: (ctx) => shouldAbortSameSiteEndpointFallback(
            ctx.response.status,
            ctx.rawErrText || ctx.errText,
          ),
          onAttemptFailure: async (ctx) => {
            const memoryWrite = isCompactRequest
              ? null
              : (await ensureUpstreamEndpointRuntimeStateLoaded(endpointRuntimeContext.siteId), recordUpstreamEndpointFailure({
                ...endpointRuntimeContext,
                endpoint: ctx.request.endpoint,
                status: ctx.response.status,
                errorText: ctx.rawErrText,
              }));
            await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
              attemptIndex: debugAttemptBase + ctx.endpointIndex,
              endpoint: ctx.request.endpoint,
              requestPath: ctx.request.path,
              targetUrl: ctx.targetUrl,
              runtimeExecutor: ctx.request.runtime?.executor || 'default',
              requestHeaders: ctx.request.headers,
              requestBody: ctx.request.body,
              responseStatus: ctx.response.status,
              responseHeaders: buildSurfaceProxyDebugResponseHeaders(ctx.response),
              responseBody: parseSurfaceProxyDebugTextPayload(ctx.rawErrText),
              rawErrorText: ctx.rawErrText,
              recoverApplied: ctx.recoverApplied === true,
              downgradeDecision: false,
              downgradeReason: null,
              memoryWrite,
            });
          },
          onAttemptSuccess: async (ctx) => {
            const memoryWrite = isCompactRequest
              ? null
              : (await ensureUpstreamEndpointRuntimeStateLoaded(endpointRuntimeContext.siteId), recordUpstreamEndpointSuccess({
                ...endpointRuntimeContext,
                endpoint: ctx.request.endpoint,
              }));
            const responseBody = await captureSurfaceProxyDebugSuccessResponseBody(debugTrace, ctx);
            await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
              attemptIndex: debugAttemptBase + ctx.endpointIndex,
              endpoint: ctx.request.endpoint,
              requestPath: ctx.request.path,
              targetUrl: ctx.targetUrl,
              runtimeExecutor: ctx.request.runtime?.executor || 'default',
              requestHeaders: ctx.request.headers,
              requestBody: ctx.request.body,
              responseStatus: ctx.response.status,
              responseHeaders: buildSurfaceProxyDebugResponseHeaders(ctx.response),
              responseBody,
              rawErrorText: null,
              recoverApplied: ctx.recoverApplied === true,
              downgradeDecision: false,
              downgradeReason: null,
              memoryWrite,
            });
          },
          shouldDowngrade: endpointStrategy.shouldDowngrade,
          onDowngrade: async (ctx) => {
            await safeUpdateSurfaceProxyDebugAttempt(debugTrace, debugAttemptBase + ctx.endpointIndex, {
              downgradeDecision: true,
              downgradeReason: ctx.errText,
              rawErrorText: ctx.rawErrText,
            });
            return failureToolkit.log({
              selected,
              modelRequested: requestedModel,
              status: 'failed',
              httpStatus: ctx.response.status,
              latencyMs: Date.now() - startTime,
              errorMessage: ctx.errText,
              retryCount,
            });
          },
        });
      };

      const startTime = Date.now();
      const leaseResult = await acquireSurfaceChannelLease({
        stickySessionKey: downstreamSessionId ? stickySessionKey : null,
        selected,
      });
      if (leaseResult.status === 'timeout') {
        clearSurfaceStickyChannel({
          stickySessionKey,
          selected,
        });
      const busyMessage = buildSurfaceChannelBusyMessage(leaseResult.waitMs);
      await failureToolkit.log({
        selected,
        modelRequested: requestedModel,
        status: 'failed',
        httpStatus: 503,
        latencyMs: leaseResult.waitMs,
        errorMessage: busyMessage,
        retryCount,
      });
      if (retryCount < maxRetries && canRetryCurrentSelection()) {
        retryCount += 1;
        continue;
      }
        await finalizeDebugFailure(503, {
          error: {
            message: busyMessage,
            type: 'server_error',
          },
        });
        return reply.code(503).send({
          error: {
            message: busyMessage,
            type: 'server_error',
          },
        });
      }
      const channelLease = leaseResult.lease;

      try {
        const endpointResult = await runWithSiteApiEndpointPool(selected.site, async (target) => {
          const result = await executeEndpointResultForSiteApiBaseUrl(target.baseUrl);
          if (!result.ok) {
            const upstreamFailure = new SiteApiEndpointRequestError(result.errText || 'unknown error', {
              status: result.status || 502,
              rawErrText: result.rawErrText || result.errText || 'unknown error',
            }) as SiteApiEndpointRequestError & { siteApiEndpointUpstreamFailure?: boolean };
            upstreamFailure.siteApiEndpointUpstreamFailure = true;
            throw upstreamFailure;
          }
          return result;
        });

        const upstream = endpointResult.upstream;
        const successfulUpstreamPath = endpointResult.upstreamPath;
        const firstByteLatencyMs = getObservedResponseMeta(upstream)?.firstByteLatencyMs ?? null;
        const syncTrustedResponsesAnchorForSuccess = (payload: unknown) => {
          if (!trustedResponsesSessionStoreKey) return;
          syncTrustedResponsesSessionResponseId(
            trustedResponsesSessionStoreKey,
            successfulUpstreamPath,
            payload,
          );
        };
        const syncTrustedResponsesAnchorForSseText = (rawText: string) => {
          if (!trustedResponsesSessionStoreKey) return;
          syncTrustedResponsesSessionResponseIdFromSseText(
            trustedResponsesSessionStoreKey,
            successfulUpstreamPath,
            rawText,
            modelName,
          );
        };
        const finalizeStreamSuccess = async (
          parsedUsage: UsageSummary,
          latency: number,
          streamDebugBody: unknown,
          upstreamUsagePresent: boolean,
        ) => {
          try {
            await recordSurfaceSuccess({
              selected,
              requestedModel,
              modelName,
              parsedUsage,
              upstreamUsagePresent,
              upstreamHeaders: upstream.headers,
              requestStartedAtMs: startTime,
              isStream: true,
              firstByteLatencyMs,
              latencyMs: latency,
              retryCount,
              upstreamPath: successfulUpstreamPath,
              logSuccess: failureToolkit.log,
              recordDownstreamCost: (estimatedCost) => {
                recordDownstreamCostUsage(request, estimatedCost);
              },
              bestEffortMetrics: {
                errorLabel: '[responses] post-stream bookkeeping failed:',
              },
            });
          } catch (error) {
            console.error('[responses] post-stream success logging failed:', error);
          }
          await finalizeDebugSuccess(
            200,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            streamDebugBody,
          );
        };

        if (isStream) {
          const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
          const startSseResponse = () => {
            reply.hijack();
            reply.raw.statusCode = 200;
            reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Accel-Buffering', 'no');
          };

          let parsedUsage: UsageSummary = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            promptTokensIncludeCache: null,
          };
          let upstreamUsagePresent = false;
          const writeLines = (lines: string[]) => {
            for (const line of lines) reply.raw.write(line);
          };
          const streamSession = openAiResponsesTransformer.proxyStream.createSession({
            modelName,
            successfulUpstreamPath,
            getUsage: () => parsedUsage,
            onParsedPayload: (payload) => {
              if (payload && typeof payload === 'object') {
                upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(payload);
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(payload));
              }
            },
            writeLines,
            writeRaw: (chunk) => {
              reply.raw.write(chunk);
            },
          });
          if (!upstreamContentType.includes('text/event-stream')) {
            const rawText = await readRuntimeResponseText(upstream);
            if (looksLikeResponsesSseText(rawText)) {
              startSseResponse();
              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(rawText),
                reply.raw,
              );
              const latency = Date.now() - startTime;
	              if (streamResult.status === 'failed') {
	                clearSurfaceStickyChannel({
	                  stickySessionKey,
	                  selected,
	                });
              await failureToolkit.recordStreamFailure({
	                  selected,
	                  requestedModel,
                  modelName,
                  errorMessage: streamResult.errorMessage,
                  latencyMs: latency,
                  retryCount,
                  promptTokens: parsedUsage.promptTokens,
                  completionTokens: parsedUsage.completionTokens,
                  totalTokens: parsedUsage.totalTokens,
                  upstreamPath: successfulUpstreamPath,
                });
	              await finalizeDebugFailure(502, {
                  error: {
                    message: streamResult.errorMessage,
                    type: 'stream_error',
                  },
                }, successfulUpstreamPath);
                return;
	              }

	              syncTrustedResponsesAnchorForSseText(rawText);
	              await finalizeStreamSuccess(
                  parsedUsage,
                  latency,
                  debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
                  upstreamUsagePresent,
                );
	              recordChannelAffinityIfSuccessful();
              bindSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
	              return;
	            }
            let upstreamData: unknown = rawText;
            try {
              upstreamData = JSON.parse(rawText);
            } catch {
              upstreamData = rawText;
            }
            if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
              upstreamData = unwrapGeminiCliPayload(upstreamData);
            }

            parsedUsage = parseProxyUsage(upstreamData);
            upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(upstreamData);
            const latency = Date.now() - startTime;
            const failure = detectProxyFailure({ rawText, usage: parsedUsage });
	            if (failure) {
	              clearSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
	              const failureOutcome = await failureToolkit.handleDetectedFailure({
	                selected,
	                requestedModel,
	                modelName,
                failure,
                latencyMs: latency,
                retryCount,
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
                upstreamPath: successfulUpstreamPath,
	              });
	              const terminalFailureOutcome = failureOutcome.action === 'retry'
	                ? (canRetryCurrentSelection()
	                  ? null
	                  : finalizeRetryAsUpstreamFailure(failure.status, failure.reason))
	                : failureOutcome;
	              if (!terminalFailureOutcome) {
	                retryCount += 1;
	                continue;
	              }
	              await finalizeDebugFailure(
	                terminalFailureOutcome.status,
	                terminalFailureOutcome.payload,
	                successfulUpstreamPath,
	              );
	              return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
            }

            startSseResponse();
            const streamResult = streamSession.consumeUpstreamFinalPayload(upstreamData, rawText, reply.raw);
	            if (streamResult.status === 'failed') {
	              clearSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
              await failureToolkit.recordStreamFailure({
	                selected,
	                requestedModel,
                modelName,
                errorMessage: streamResult.errorMessage,
                latencyMs: latency,
                retryCount,
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
                upstreamPath: successfulUpstreamPath,
                runtimeFailureStatus: 502,
              });
              await finalizeDebugFailure(502, {
                error: {
                  message: streamResult.errorMessage,
                  type: 'stream_error',
                },
              }, successfulUpstreamPath);
              return;
	            }

	            syncTrustedResponsesAnchorForSuccess(upstreamData);
	            await finalizeStreamSuccess(
                parsedUsage,
                latency,
                debugTrace?.options.captureStreamChunks ? rawText : upstreamData,
                upstreamUsagePresent,
              );
	            recordChannelAffinityIfSuccessful();
              bindSurfaceStickyChannel({
	              stickySessionKey,
	              selected,
	            });
	            return;
	          }

          startSseResponse();

          let replayReader: ReturnType<typeof createSingleChunkStreamReader> | null = null;
          if (websocketTransportRequest) {
            const rawText = await readRuntimeResponseText(upstream);
            if (looksLikeResponsesSseText(rawText)) {
              try {
                const collectedPayload = collectResponsesFinalPayloadFromSseText(rawText, modelName).payload;
                upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(collectedPayload);
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(collectedPayload));
                const createdPayload = {
                  ...collectedPayload,
                  status: 'in_progress',
                  output: [],
                  output_text: '',
                };
                const terminalEventType = String(collectedPayload.status || '').trim().toLowerCase() === 'incomplete'
                  ? 'response.incomplete'
                  : 'response.completed';
                writeLines([
                  `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: createdPayload })}\n\n`,
                  `event: ${terminalEventType}\ndata: ${JSON.stringify({ type: terminalEventType, response: collectedPayload })}\n\n`,
                  'data: [DONE]\n\n',
                ]);
                syncTrustedResponsesAnchorForSuccess(collectedPayload);
                reply.raw.end();
                const latency = Date.now() - startTime;
                await finalizeStreamSuccess(
                  parsedUsage,
                  latency,
                  debugTrace?.options.captureStreamChunks ? rawText : collectedPayload,
                  upstreamUsagePresent,
                );
                recordChannelAffinityIfSuccessful();
              bindSurfaceStickyChannel({
                  stickySessionKey,
                  selected,
                });
                return;
              } catch {
                // Fall through to the generic stream session for response.failed/error terminals.
              }

              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(rawText),
                reply.raw,
              );
              const latency = Date.now() - startTime;
              if (streamResult.status === 'failed') {
                await failureToolkit.recordStreamFailure({
                  selected,
                  requestedModel,
                  modelName,
                  errorMessage: streamResult.errorMessage,
                  latencyMs: latency,
                  retryCount,
                  promptTokens: parsedUsage.promptTokens,
                  completionTokens: parsedUsage.completionTokens,
                  totalTokens: parsedUsage.totalTokens,
                  upstreamPath: successfulUpstreamPath,
                  runtimeFailureStatus: 502,
                });
                await finalizeDebugFailure(502, {
                  error: {
                    message: streamResult.errorMessage,
                    type: 'stream_error',
                  },
                }, successfulUpstreamPath);
                return;
              }

              syncTrustedResponsesAnchorForSseText(rawText);
              await finalizeStreamSuccess(
                parsedUsage,
                latency,
                debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
                upstreamUsagePresent,
              );
              return;
            }

            replayReader = createSingleChunkStreamReader(rawText);
          }

          const upstreamReader = replayReader ?? getRuntimeResponseReader(upstream);
          const baseReader = String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli' && upstreamReader
            ? createGeminiCliStreamReader(upstreamReader)
            : upstreamReader;
          let rawText = '';
          const decoder = new TextDecoder();
          const reader = baseReader
            ? {
              async read() {
                const result = await baseReader.read();
                if (result.value) {
                  rawText += decoder.decode(result.value, { stream: true });
                }
                return result;
              },
              async cancel(reason?: unknown) {
                return baseReader.cancel(reason);
              },
              releaseLock() {
                return baseReader.releaseLock();
              },
            }
            : baseReader;
          const streamResult = await streamSession.run(reader, reply.raw);
          rawText += decoder.decode();

          const latency = Date.now() - startTime;
	          if (streamResult.status === 'failed') {
	            clearSurfaceStickyChannel({
	              stickySessionKey,
	              selected,
	            });
	            await failureToolkit.recordStreamFailure({
	              selected,
	              requestedModel,
              modelName,
              errorMessage: streamResult.errorMessage,
              latencyMs: latency,
              retryCount,
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
              upstreamPath: successfulUpstreamPath,
              runtimeFailureStatus: 502,
            });
            await finalizeDebugFailure(502, {
              error: {
                message: streamResult.errorMessage,
                type: 'stream_error',
              },
            }, successfulUpstreamPath);
            return;
          }

          // Once SSE has been hijacked and bytes may already be on the wire, we
          // must not attempt to convert stream failures into a fresh HTTP error
          // response or retry on another channel. Responses stream failures are
	          // handled in-band by the proxy stream session.

	          syncTrustedResponsesAnchorForSseText(rawText);
	          await finalizeStreamSuccess(
              parsedUsage,
              latency,
              debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
              upstreamUsagePresent,
            );
	          recordChannelAffinityIfSuccessful();
              bindSurfaceStickyChannel({
	            stickySessionKey,
	            selected,
	          });
	          return;
	        }

        const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
        let rawText = '';
        let upstreamData: unknown;
        if (
          upstreamContentType.includes('text/event-stream')
          && (
            successfulUpstreamPath.endsWith('/responses')
            || successfulUpstreamPath.endsWith('/responses/compact')
          )
        ) {
          const collected = await collectResponsesFinalPayloadFromSse(upstream, modelName);
          rawText = collected.rawText;
          upstreamData = collected.payload;
        } else {
          rawText = await readRuntimeResponseText(upstream);
          if (looksLikeResponsesSseText(rawText)) {
            upstreamData = collectResponsesFinalPayloadFromSseText(rawText, modelName).payload;
          } else {
            upstreamData = rawText;
            try {
              upstreamData = JSON.parse(rawText);
            } catch {
              upstreamData = rawText;
            }
          }
        }
        if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
          upstreamData = unwrapGeminiCliPayload(upstreamData);
        }
        const latency = Date.now() - startTime;
        const parsedUsage = parseProxyUsage(upstreamData);
        const upstreamUsagePresent = hasProxyUsagePayload(upstreamData);
        const failure = detectProxyFailure({ rawText, usage: parsedUsage });
	        if (failure) {
	          clearSurfaceStickyChannel({
	            stickySessionKey,
	            selected,
	          });
	          const failureOutcome = await failureToolkit.handleDetectedFailure({
	            selected,
	            requestedModel,
	            modelName,
            failure,
            latencyMs: latency,
            retryCount,
            promptTokens: parsedUsage.promptTokens,
            completionTokens: parsedUsage.completionTokens,
            totalTokens: parsedUsage.totalTokens,
            upstreamPath: successfulUpstreamPath,
	          });
	          const terminalFailureOutcome = failureOutcome.action === 'retry'
	            ? (canRetryCurrentSelection()
	              ? null
	              : finalizeRetryAsUpstreamFailure(failure.status, failure.reason))
	            : failureOutcome;
	          if (!terminalFailureOutcome) {
	            retryCount += 1;
	            continue;
	          }
	          await finalizeDebugFailure(
	            terminalFailureOutcome.status,
	            terminalFailureOutcome.payload,
	            successfulUpstreamPath,
	          );
	          return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
        }
        const normalized = openAiResponsesTransformer.transformFinalResponse(
          upstreamData,
          modelName,
          rawText,
        );
        const downstreamData = openAiResponsesTransformer.outbound.serializeFinal({
          upstreamPayload: upstreamData,
          normalized,
          usage: parsedUsage,
          serializationMode: isCompactRequest ? 'compact' : 'response',
        });
        syncTrustedResponsesAnchorForSuccess(upstreamData);
        try {
          await recordSurfaceSuccess({
            selected,
            requestedModel,
            modelName,
            parsedUsage,
            upstreamUsagePresent,
            upstreamHeaders: upstream.headers,
            requestStartedAtMs: startTime,
            isStream: false,
            firstByteLatencyMs,
            latencyMs: latency,
            retryCount,
            upstreamPath: successfulUpstreamPath,
            logSuccess: failureToolkit.log,
            recordDownstreamCost: (estimatedCost) => {
              recordDownstreamCostUsage(request, estimatedCost);
            },
            bestEffortMetrics: {
              errorLabel: '[responses] post-response bookkeeping failed:',
            },
          });
	        } catch (error) {
	          console.error('[responses] post-response success logging failed:', error);
	        }
	        await finalizeDebugSuccess(
            upstream.status,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            downstreamData,
          );
	        recordChannelAffinityIfSuccessful();
              bindSurfaceStickyChannel({
	          stickySessionKey,
	          selected,
	        });
	        return reply.send(downstreamData);
	      } catch (err: any) {
	        clearSurfaceStickyChannel({
	          stickySessionKey,
	          selected,
	        });
          const endpointFailureStatus = typeof err?.status === 'number' ? err.status : null;
          const isSiteApiEndpointFailure = (
            err instanceof SiteApiEndpointRequestError
            || err?.name === 'SiteApiEndpointRequestError'
            || err?.siteApiEndpointUpstreamFailure === true
            || (endpointFailureStatus !== null && endpointFailureStatus >= 500)
          );
          const surfacedErrorMessage = describeErrorWithCauses(err, 'unknown error');
          if (isSiteApiEndpointFailure) {
            const failureOutcome = await failureToolkit.handleUpstreamFailure({
              selected,
              requestedModel,
              modelName,
              status: endpointFailureStatus || 502,
              errText: surfacedErrorMessage,
              rawErrText: err?.rawErrText || surfacedErrorMessage,
              isStream,
              latencyMs: Date.now() - startTime,
              retryCount,
            });
            const terminalFailureOutcome = failureOutcome.action === 'retry'
              ? (canRetryCurrentSelection()
                ? null
                : finalizeRetryAsUpstreamFailure(endpointFailureStatus || 502, surfacedErrorMessage))
              : failureOutcome;
            if (!terminalFailureOutcome) {
              retryCount += 1;
              continue;
            }
            await finalizeDebugFailure(
              terminalFailureOutcome.status,
              terminalFailureOutcome.payload,
              null,
            );
            return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
          }
	        const failureOutcome = await failureToolkit.handleExecutionError({
	          selected,
	          requestedModel,
            modelName,
            errorMessage: describeErrorWithCauses(err, 'network failure'),
            error: err,
            isStream,
            latencyMs: Date.now() - startTime,
            retryCount,
          });
          const terminalFailureOutcome = failureOutcome.action === 'retry'
            ? (canRetryCurrentSelection()
              ? null
              : finalizeRetryAsExecutionFailure(describeErrorWithCauses(err, 'network failure')))
            : failureOutcome;
          if (!terminalFailureOutcome) {
            retryCount += 1;
            continue;
	        }
		        await finalizeDebugFailure(
	            terminalFailureOutcome.status,
	            terminalFailureOutcome.payload,
	            null,
	          );
		        return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
	      } finally {
	        channelLease.release();
	      }
	    }
}
