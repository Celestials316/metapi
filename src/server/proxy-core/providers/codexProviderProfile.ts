import type { PreparedProviderRequest, PrepareProviderRequestInput, ProviderProfile, ProviderRuntimeDescriptor } from './types.js';
import { config } from '../../config.js';
import { buildCodexRuntimeHeaders, getInputHeader } from './headerUtils.js';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function prepareCodexRequest(input: PrepareProviderRequestInput & {
  pathOverride?: string;
  runtimeExecutorOverride?: ProviderRuntimeDescriptor['executor'];
  forceConfiguredUserAgent?: boolean;
  forceConfiguredBetaFeatures?: boolean;
  openAiBetaDefault?: string | null;
}): PreparedProviderRequest {
  const isCodexOauth = asTrimmedString(input.oauthProvider).toLowerCase() === 'codex';
  const websocketTransport = input.responsesWebsocketTransport === true;
  const configuredUserAgent = (
    isCodexOauth || input.forceConfiguredUserAgent === true
      ? asTrimmedString(config.codexHeaderDefaults.userAgent)
      : ''
  );
  const configuredBetaFeatures = (
    (isCodexOauth && websocketTransport) || input.forceConfiguredBetaFeatures === true
      ? asTrimmedString(config.codexHeaderDefaults.betaFeatures)
      : ''
  );
  const headers = buildCodexRuntimeHeaders({
    baseHeaders: input.baseHeaders,
    providerHeaders: input.providerHeaders,
    stream: input.stream,
    explicitSessionId: asTrimmedString(input.codexExplicitSessionId) || null,
    continuityKey: asTrimmedString(input.codexSessionCacheKey) || null,
    userAgentOverride: configuredUserAgent || null,
    codexBetaFeatures: getInputHeader(input.baseHeaders, 'x-codex-beta-features') || configuredBetaFeatures,
    codexTurnState: getInputHeader(input.baseHeaders, 'x-codex-turn-state'),
    codexTurnMetadata: getInputHeader(input.baseHeaders, 'x-codex-turn-metadata'),
    timingMetrics: getInputHeader(input.baseHeaders, 'x-responsesapi-include-timing-metrics'),
    openAiBeta: getInputHeader(input.baseHeaders, 'openai-beta')
      || input.openAiBetaDefault
      || (websocketTransport ? asTrimmedString(config.codexResponsesWebsocketBeta) : null),
  });

  return {
    path: input.pathOverride || '/responses',
    headers,
    body: input.body,
    runtime: {
      executor: input.runtimeExecutorOverride || 'codex',
      modelName: input.modelName,
      stream: input.stream,
      oauthProjectId: asTrimmedString(input.oauthProjectId) || null,
    },
  };
}

export function prepareCodexCompatibleOpenAiResponsesRequest(
  input: PrepareProviderRequestInput & {
    pathOverride: string;
  },
): PreparedProviderRequest {
  const prepared = prepareCodexRequest({
    ...input,
    runtimeExecutorOverride: 'default',
    forceConfiguredBetaFeatures: true,
    openAiBetaDefault: 'responses=experimental',
  });
  return {
    ...prepared,
    headers: {
      ...input.baseHeaders,
      ...prepared.headers,
    },
  };
}

export const codexProviderProfile: ProviderProfile = {
  id: 'codex',
  prepareRequest(input: PrepareProviderRequestInput): PreparedProviderRequest {
    return prepareCodexRequest(input);
  },
};
