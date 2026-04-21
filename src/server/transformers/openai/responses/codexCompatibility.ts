function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function shouldApplyCodexResponsesCompatibility(input: {
  sitePlatform?: string;
  downstreamClientKind?: string;
}): boolean {
  return (
    asTrimmedString(input.sitePlatform).toLowerCase() === 'codex'
    || asTrimmedString(input.downstreamClientKind).toLowerCase() === 'codex'
  );
}

function ensureCodexResponsesInstructions(
  body: Record<string, unknown>,
  shouldApply: boolean,
): Record<string, unknown> {
  if (!shouldApply) return body;
  if (typeof body.instructions === 'string') return body;
  return {
    ...body,
    instructions: '',
  };
}

function ensureCodexResponsesStoreFalse(
  body: Record<string, unknown>,
  shouldApply: boolean,
): Record<string, unknown> {
  if (!shouldApply) return body;
  return {
    ...body,
    store: false,
  };
}

function stripCodexUnsupportedResponsesFields(
  body: Record<string, unknown>,
  shouldApply: boolean,
): Record<string, unknown> {
  if (!shouldApply) return body;
  const next = { ...body };
  delete next.max_output_tokens;
  delete next.max_completion_tokens;
  delete next.max_tokens;
  delete next.metadata;
  delete next.user;
  delete next.service_tier;
  delete next.prompt_cache_retention;
  return next;
}

function convertCodexSystemRoleToDeveloper(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (!isRecord(item)) return item;
    if (asTrimmedString(item.type).toLowerCase() !== 'message') return item;
    if (asTrimmedString(item.role).toLowerCase() !== 'system') return item;
    return {
      ...item,
      role: 'developer',
    };
  });
}

function applyCodexResponsesCompatibility(
  body: Record<string, unknown>,
  shouldApply: boolean,
): Record<string, unknown> {
  if (!shouldApply) return body;

  const next: Record<string, unknown> = {
    ...body,
    input: convertCodexSystemRoleToDeveloper(body.input),
  };

  if (typeof next.instructions !== 'string') {
    next.instructions = '';
  }

  return next;
}

export function normalizeCodexResponsesBodyForProxy(
  body: Record<string, unknown>,
  input: {
    sitePlatform?: string;
    downstreamClientKind?: string;
  },
): Record<string, unknown> {
  const shouldApply = shouldApplyCodexResponsesCompatibility(input);
  if (!shouldApply) return body;
  return ensureCodexResponsesStoreFalse(
    stripCodexUnsupportedResponsesFields(
      ensureCodexResponsesInstructions(
        applyCodexResponsesCompatibility(body, shouldApply),
        shouldApply,
      ),
      shouldApply,
    ),
    shouldApply,
  );
}
