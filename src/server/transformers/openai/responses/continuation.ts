function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const RESPONSES_TOOL_OUTPUT_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
]);

const RESPONSES_TOOL_CALL_CONTEXT_TYPES = new Set([
  'tool_call',
  'function_call',
  'custom_tool_call',
]);

const RESPONSES_ITEM_REFERENCE_TYPE = 'item_reference';

const RESPONSES_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'incomplete',
]);

function collectResponsesErrorFragments(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (!isRecord(value)) return [];

  const fragments = [
    value.type,
    value.code,
    value.message,
    value.reason,
  ]
    .map((entry) => asTrimmedString(entry))
    .filter(Boolean);

  if (isRecord(value.error)) {
    fragments.push(...collectResponsesErrorFragments(value.error));
  }

  if (isRecord(value.response)) {
    fragments.push(...collectResponsesErrorFragments(value.response));
  }

  if (isRecord(value.incomplete_details)) {
    fragments.push(...collectResponsesErrorFragments(value.incomplete_details));
  }

  return fragments;
}

export type ResponsesContinuationSignals = {
  hasToolOutput: boolean;
  hasToolOutputMissingCallId: boolean;
  hasToolCallContext: boolean;
  hasItemReference: boolean;
  hasItemReferenceForAllToolCallIds: boolean;
  toolOutputCallIds: string[];
};

export function analyzeResponsesContinuationSignals(input: unknown): ResponsesContinuationSignals {
  const signals: ResponsesContinuationSignals = {
    hasToolOutput: false,
    hasToolOutputMissingCallId: false,
    hasToolCallContext: false,
    hasItemReference: false,
    hasItemReferenceForAllToolCallIds: false,
    toolOutputCallIds: [],
  };
  if (!Array.isArray(input)) return signals;

  const toolOutputCallIds = new Set<string>();
  const itemReferenceIds = new Set<string>();

  for (const item of input) {
    if (!isRecord(item)) continue;

    const type = asTrimmedString(item.type).toLowerCase();
    if (!type) continue;

    if (RESPONSES_TOOL_CALL_CONTEXT_TYPES.has(type)) {
      if (asTrimmedString(item.call_id).length > 0) {
        signals.hasToolCallContext = true;
      }
      continue;
    }

    if (type === RESPONSES_ITEM_REFERENCE_TYPE) {
      signals.hasItemReference = true;
      const itemReferenceId = asTrimmedString(item.id);
      if (itemReferenceId) {
        itemReferenceIds.add(itemReferenceId);
      }
      continue;
    }

    if (!RESPONSES_TOOL_OUTPUT_TYPES.has(type)) continue;

    signals.hasToolOutput = true;
    const callId = asTrimmedString(item.call_id ?? item.id);
    if (!callId) {
      signals.hasToolOutputMissingCallId = true;
      continue;
    }
    toolOutputCallIds.add(callId);
  }

  signals.toolOutputCallIds = [...toolOutputCallIds];
  if (toolOutputCallIds.size === 0 || itemReferenceIds.size === 0) {
    return signals;
  }

  signals.hasItemReferenceForAllToolCallIds = [...toolOutputCallIds]
    .every((callId) => itemReferenceIds.has(callId));
  return signals;
}

function hasResponsesToolOutput(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  return analyzeResponsesContinuationSignals(input).hasToolOutput;
}

export function hasOrphanToolOutputFollowUp(
  body: Record<string, unknown> | null | undefined,
): boolean {
  if (!body) return false;
  if (asTrimmedString(body.previous_response_id)) return false;

  const signals = analyzeResponsesContinuationSignals(body.input);
  if (!signals.hasToolOutput) return false;
  if (signals.hasToolCallContext) return false;
  if (signals.hasItemReferenceForAllToolCallIds) return false;
  return true;
}

export function shouldInferResponsesPreviousResponseId(
  body: Record<string, unknown> | null | undefined,
  candidatePreviousResponseId: unknown,
): candidatePreviousResponseId is string {
  if (!body) return false;
  if (asTrimmedString(body.previous_response_id)) return false;
  const candidate = asTrimmedString(candidatePreviousResponseId);
  if (!candidate) return false;
  return hasResponsesToolOutput(body.input);
}

export function withResponsesPreviousResponseId(
  body: Record<string, unknown>,
  previousResponseId: string,
): Record<string, unknown> {
  return {
    ...body,
    previous_response_id: previousResponseId.trim(),
  };
}

export function stripResponsesPreviousResponseId(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; removed: boolean } {
  if (!Object.prototype.hasOwnProperty.call(body, 'previous_response_id')) {
    return { body, removed: false };
  }
  const next = { ...body };
  delete next.previous_response_id;
  return { body: next, removed: true };
}

export function isResponsesPreviousResponseNotFoundError(input: {
  rawErrText?: string | null;
  payload?: unknown;
}): boolean {
  const fragments = [
    ...collectResponsesErrorFragments(input.payload),
  ];
  const rawErrText = asTrimmedString(input.rawErrText);
  if (rawErrText) fragments.push(rawErrText);
  const combined = fragments.join(' ').toLowerCase();
  if (!combined) return false;
  return (
    combined.includes('previous_response_not_found')
    || /previous[\s_-]*response(?:[\s_-]*(?:id|identifier))?[\s_-]*not[\s_-]*found/i.test(combined)
    || /previous[\s_-]*response[\s_-]*id\s+is\s+only\s+supported\s+on\s+responses\s+websocket\s+v2/i.test(combined)
  );
}

export function extractResponsesTerminalResponseId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const type = asTrimmedString(payload.type).toLowerCase();
  if (
    type === 'response.completed'
    || type === 'response.failed'
    || type === 'response.incomplete'
  ) {
    if (isRecord(payload.response)) {
      const responseId = asTrimmedString(payload.response.id);
      return responseId || null;
    }
    return null;
  }

  const object = asTrimmedString(payload.object).toLowerCase();
  const status = asTrimmedString(payload.status).toLowerCase();
  if (
    (object === 'response' && RESPONSES_TERMINAL_STATUSES.has(status))
    || RESPONSES_TERMINAL_STATUSES.has(status)
  ) {
    const responseId = asTrimmedString(payload.id);
    return responseId || null;
  }

  if (isRecord(payload.response)) {
    const nestedStatus = asTrimmedString(payload.response.status).toLowerCase();
    if (RESPONSES_TERMINAL_STATUSES.has(nestedStatus)) {
      const responseId = asTrimmedString(payload.response.id);
      return responseId || null;
    }
  }

  return null;
}
