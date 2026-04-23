import type { FastifyInstance, FastifyRequest } from 'fastify';

type MultipartAwareFastify = FastifyInstance & {
  __metapiMultipartParserRegistered?: boolean;
};

export const DEFAULT_MULTIPART_FILE_PART_LIMIT_BYTES = 20 << 20;

export class MultipartFilePartTooLargeError extends Error {
  readonly fieldName: string;
  readonly maxBytes: number;
  readonly actualBytes: number;

  constructor(fieldName: string, maxBytes: number, actualBytes: number) {
    super(`multipart field "${fieldName}" is too large (max ${formatBinaryMiB(maxBytes)})`);
    this.name = 'MultipartFilePartTooLargeError';
    this.fieldName = fieldName;
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

function formatBinaryMiB(bytes: number): string {
  if (bytes > 0 && bytes % (1 << 20) === 0) {
    return `${bytes >> 20} MiB`;
  }
  return `${bytes} bytes`;
}

function getContentType(request: FastifyRequest): string {
  return typeof request.headers['content-type'] === 'string'
    ? request.headers['content-type']
    : '';
}

export function ensureMultipartBufferParser(app: FastifyInstance): void {
  const target = app as MultipartAwareFastify;
  if (target.__metapiMultipartParserRegistered) return;

  app.addContentTypeParser(/^multipart\/form-data(?:;.*)?$/i, { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  target.__metapiMultipartParserRegistered = true;
}

export function isMultipartRequest(request: FastifyRequest): boolean {
  return /^multipart\/form-data(?:;.*)?$/i.test(getContentType(request));
}

export async function parseMultipartFormData(request: FastifyRequest): Promise<FormData | null> {
  if (!isMultipartRequest(request)) return null;
  const contentType = getContentType(request);
  const body = request.body;
  if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) return null;

  const response = new Response(new Blob([Buffer.from(body)]), {
    headers: {
      'content-type': contentType,
    },
  });
  return response.formData();
}

function shouldValidateMultipartField(
  key: string,
  options?: {
    fieldNames?: string[];
    fieldPrefixes?: string[];
  },
): boolean {
  const fieldNames = options?.fieldNames || [];
  const fieldPrefixes = options?.fieldPrefixes || [];
  if (fieldNames.length === 0 && fieldPrefixes.length === 0) return true;
  if (fieldNames.includes(key)) return true;
  return fieldPrefixes.some((prefix) => key.startsWith(prefix));
}

export function isMultipartFilePartTooLargeError(error: unknown): error is MultipartFilePartTooLargeError {
  return error instanceof MultipartFilePartTooLargeError;
}

export function assertMultipartFilePartSizeLimit(
  formData: FormData | null,
  options?: {
    maxBytes?: number;
    fieldNames?: string[];
    fieldPrefixes?: string[];
  },
): void {
  if (!formData) return;
  const maxBytes = options?.maxBytes ?? DEFAULT_MULTIPART_FILE_PART_LIMIT_BYTES;
  for (const [key, value] of formData.entries()) {
    if (!shouldValidateMultipartField(key, options) || typeof value === 'string') {
      continue;
    }
    const fileLike = value as unknown as File & { size?: number };
    const size = typeof fileLike.size === 'number' && Number.isFinite(fileLike.size) ? fileLike.size : 0;
    if (size > maxBytes) {
      throw new MultipartFilePartTooLargeError(key, maxBytes, size);
    }
  }
}

export function cloneFormDataWithOverrides(
  formData: FormData,
  overrides: Record<string, string>,
): FormData {
  const next = new FormData();
  const applied = new Set<string>();

  for (const [key, value] of formData.entries()) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      next.append(key, overrides[key] ?? '');
      applied.add(key);
      continue;
    }

    if (typeof value === 'string') {
      next.append(key, value);
      continue;
    }

    const fileLike = value as unknown as File;
    next.append(key, value, fileLike.name || 'upload.bin');
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (applied.has(key)) continue;
    next.append(key, value);
  }

  return next;
}
