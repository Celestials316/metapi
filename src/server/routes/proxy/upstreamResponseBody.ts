import type { Response as UndiciResponse } from 'undici';
import { describeRuntimeResponseReadError, readRuntimeResponseText } from '../../proxy-core/executors/types.js';
import { SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';

export async function readProxyUpstreamResponseText(response: UndiciResponse): Promise<string> {
  return readRuntimeResponseText(response as Parameters<typeof readRuntimeResponseText>[0]);
}

export async function readSiteApiEndpointResponseText(
  response: UndiciResponse,
  options?: {
    firstByteLatencyMs?: number | null;
  },
): Promise<string> {
  try {
    return await readProxyUpstreamResponseText(response);
  } catch (error) {
    const message = describeRuntimeResponseReadError(error);
    throw new SiteApiEndpointRequestError(message, {
      status: response.ok ? 502 : response.status,
      rawErrText: message || null,
      firstByteLatencyMs: options?.firstByteLatencyMs ?? null,
      cause: error,
    });
  }
}

export function describeUpstreamResponseReadError(error: unknown, fallback = 'unknown error'): string {
  return describeRuntimeResponseReadError(error, fallback);
}
