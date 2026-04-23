import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from 'node:zlib';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  Response,
  fetch,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from 'undici';

export type ProxyRuntimeRequest = {
  endpoint: 'chat' | 'messages' | 'responses';
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  runtime?: {
    executor: 'default' | 'codex' | 'gemini-cli' | 'antigravity' | 'claude';
    modelName?: string;
    requestedModel?: string;
    protocol?: string;
    stream?: boolean;
    oauthProjectId?: string | null;
    action?: 'generateContent' | 'streamGenerateContent' | 'countTokens';
  };
};

export type RuntimeDispatchInput = {
  siteUrl: string;
  request: ProxyRuntimeRequest;
  targetUrl?: string;
  signal?: AbortSignal;
  buildInit: (requestUrl: string, request: ProxyRuntimeRequest) => Promise<UndiciRequestInit> | UndiciRequestInit;
};

export type RuntimeResponse = UndiciResponse;

export type RuntimeExecutor = {
  dispatch(input: RuntimeDispatchInput): Promise<RuntimeResponse>;
};

export const DEFAULT_UPSTREAM_RESPONSE_BODY_LIMIT_BYTES = 2 << 20;
const UPSTREAM_RESPONSE_TOO_LARGE_MESSAGE = 'Upstream response too large';

export type RuntimeResponseReadOptions = {
  maxBytes?: number;
};

export class RuntimeResponseBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number, message = UPSTREAM_RESPONSE_TOO_LARGE_MESSAGE) {
    super(message);
    this.name = 'RuntimeResponseBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export function isRuntimeResponseBodyTooLargeError(error: unknown): error is RuntimeResponseBodyTooLargeError {
  return error instanceof RuntimeResponseBodyTooLargeError
    || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'RuntimeResponseBodyTooLargeError');
}

export function describeRuntimeResponseReadError(error: unknown, fallback = 'unknown error'): string {
  if (isRuntimeResponseBodyTooLargeError(error)) {
    return error.message || UPSTREAM_RESPONSE_TOO_LARGE_MESSAGE;
  }
  return fallback;
}

export function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function withRequestBody(
  request: ProxyRuntimeRequest,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): ProxyRuntimeRequest {
  return {
    ...request,
    headers: headers ? { ...headers } : { ...request.headers },
    body,
  };
}

function buildUpstreamUrl(siteUrl: string, path: string): string {
  const normalizedBase = siteUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export async function performFetch(
  input: RuntimeDispatchInput,
  request: ProxyRuntimeRequest,
  requestUrl = input.targetUrl || buildUpstreamUrl(input.siteUrl, request.path),
): Promise<RuntimeResponse> {
  const init = await input.buildInit(requestUrl, request);
  const combinedSignal = input.signal && init.signal
    ? AbortSignal.any([input.signal, init.signal as AbortSignal])
    : (input.signal ?? init.signal);
  return fetch(requestUrl, {
    ...init,
    signal: combinedSignal,
  });
}

function hasZstdContentEncoding(contentEncoding: string | null): boolean {
  return getContentEncodings(contentEncoding).some((encoding) => encoding === 'zstd');
}

function getContentEncodings(contentEncoding: string | null): string[] {
  if (!contentEncoding) return [];
  return contentEncoding
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);
}

function getOutermostContentEncoding(contentEncoding: string | null): string | null {
  const encodings = getContentEncodings(contentEncoding);
  return encodings.length > 0 ? encodings[encodings.length - 1] : null;
}

function looksLikeZstdFrame(buffer: Buffer): boolean {
  return buffer.length >= 4
    && buffer[0] === 0x28
    && buffer[1] === 0xb5
    && buffer[2] === 0x2f
    && buffer[3] === 0xfd;
}

function decodeRuntimeResponseBuffer(buffer: Buffer, contentEncoding: string | null): Buffer {
  if (!contentEncoding) return buffer;

  let decoded = buffer;
  const encodings = getContentEncodings(contentEncoding).reverse();

  for (const encoding of encodings) {
    if (encoding === 'zstd') {
      decoded = zstdDecompressSync(decoded);
      continue;
    }
    if (encoding === 'br') {
      decoded = brotliDecompressSync(decoded);
      continue;
    }
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      decoded = gunzipSync(decoded);
      continue;
    }
    if (encoding === 'deflate') {
      decoded = inflateSync(decoded);
      continue;
    }
  }

  return decoded;
}

function decodeRuntimeResponseStream(
  stream: Readable,
  contentEncoding: string | null,
): Readable {
  if (!contentEncoding) return stream;

  let decoded = stream;
  const encodings = getContentEncodings(contentEncoding).reverse();

  for (const encoding of encodings) {
    if (encoding === 'zstd') {
      decoded = decoded.pipe(createZstdDecompress()) as Readable;
      continue;
    }
    if (encoding === 'br') {
      decoded = decoded.pipe(createBrotliDecompress()) as Readable;
      continue;
    }
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      decoded = decoded.pipe(createGunzip()) as Readable;
      continue;
    }
    if (encoding === 'deflate') {
      decoded = decoded.pipe(createInflate()) as Readable;
      continue;
    }
  }

  return decoded;
}

export async function readRuntimeResponseText(
  response: RuntimeResponse,
  options: RuntimeResponseReadOptions = {},
): Promise<string> {
  const reader = getRuntimeResponseReader(response);
  if (!reader) {
    if (typeof response.text === 'function') {
      try {
        return await response.text();
      } catch {
        return '';
      }
    }
    return '';
  }

  const maxBytes = Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) > 0
    ? Math.trunc(Number(options.maxBytes))
    : DEFAULT_UPSTREAM_RESPONSE_BODY_LIMIT_BYTES;
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const nextChunk = await reader.read();
      if (nextChunk.done) break;
      const chunk = Buffer.from(nextChunk.value || []);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel(UPSTREAM_RESPONSE_TOO_LARGE_MESSAGE).catch(() => undefined);
        throw new RuntimeResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function asNodeReadableStream(
  stream: globalThis.ReadableStream<Uint8Array>,
): NodeReadableStream<any> {
  return stream as unknown as NodeReadableStream<any>;
}

function asWebReadableStream(
  stream: NodeReadableStream<any>,
): globalThis.ReadableStream<Uint8Array> {
  return stream as unknown as globalThis.ReadableStream<Uint8Array>;
}

function prependReadableStreamChunks(
  initialChunks: Uint8Array[],
  sourceReader: ReadableStreamDefaultReader<Uint8Array>,
): globalThis.ReadableStream<Uint8Array> {
  const pendingChunks = [...initialChunks];
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const nextPendingChunk = pendingChunks.shift();
      if (nextPendingChunk) {
        controller.enqueue(nextPendingChunk);
        return;
      }

      const nextChunk = await sourceReader.read();
      if (nextChunk.done) {
        controller.close();
        return;
      }

      controller.enqueue(nextChunk.value);
    },
    cancel(reason) {
      return sourceReader.cancel(reason);
    },
  });
}

async function resolveRuntimeResponseReader(
  sourceReader: ReadableStreamDefaultReader<Uint8Array>,
  contentEncoding: string | null,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const initialChunks: Uint8Array[] = [];
  let probeBuffer = Buffer.alloc(0);

  while (probeBuffer.length < 4) {
    const nextChunk = await sourceReader.read();
    if (nextChunk.done) {
      break;
    }
    if (!nextChunk.value || nextChunk.value.byteLength === 0) {
      continue;
    }

    initialChunks.push(nextChunk.value);
    probeBuffer = Buffer.concat([probeBuffer, Buffer.from(nextChunk.value)]);
  }

  if (initialChunks.length === 0) {
    return sourceReader;
  }

  const reconstructedBody = prependReadableStreamChunks(initialChunks, sourceReader);
  const outermostEncoding = getOutermostContentEncoding(contentEncoding);
  if (outermostEncoding === 'zstd' && !looksLikeZstdFrame(probeBuffer)) {
    return reconstructedBody.getReader();
  }

  const decoded = decodeRuntimeResponseStream(
    Readable.fromWeb(asNodeReadableStream(reconstructedBody)),
    contentEncoding,
  );
  return asWebReadableStream(Readable.toWeb(decoded)).getReader();
}

export function getRuntimeResponseReader(
  response: RuntimeResponse,
): ReadableStreamDefaultReader<Uint8Array> | undefined {
  const body = response.body as globalThis.ReadableStream<Uint8Array> | null | undefined;
  if (!body) return undefined;

  const contentEncoding = typeof response.headers?.get === 'function'
    ? response.headers.get('content-encoding')
    : null;
  if (!hasZstdContentEncoding(contentEncoding)) {
    return body.getReader();
  }

  const sourceReader = body.getReader();
  let resolvedReaderPromise: Promise<ReadableStreamDefaultReader<Uint8Array>> | null = null;
  const ensureResolvedReader = () => {
    if (!resolvedReaderPromise) {
      resolvedReaderPromise = resolveRuntimeResponseReader(sourceReader, contentEncoding);
    }
    return resolvedReaderPromise;
  };

  // Keep the public API synchronous while delaying the zstd probe until the first read.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const reader = await ensureResolvedReader();
      const nextChunk = await reader.read();
      if (nextChunk.done) {
        controller.close();
        return;
      }

      controller.enqueue(nextChunk.value);
    },
    async cancel(reason) {
      if (!resolvedReaderPromise) {
        await sourceReader.cancel(reason);
        return;
      }

      const reader = await resolvedReaderPromise.catch(() => sourceReader);
      await reader.cancel(reason);
    },
  }).getReader();
}

export async function materializeErrorResponse(
  response: RuntimeResponse,
  options: RuntimeResponseReadOptions = {},
): Promise<RuntimeResponse> {
  if (response.ok) return response;
  let text = '';
  let bodyReadTooLarge = false;
  try {
    text = await readRuntimeResponseText(response, options);
  } catch (error) {
    text = describeRuntimeResponseReadError(error, '');
    bodyReadTooLarge = isRuntimeResponseBodyTooLargeError(error);
  }
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  if (bodyReadTooLarge) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }
  return new Response(text, {
    status: response.status,
    headers,
  });
}
