const GENERIC_PARENT_ERROR_PATTERNS: RegExp[] = [
  /^fetch failed$/i,
  /^network\s+(?:error|failure)$/i,
  /^unknown error$/i,
];

function normalizeMessage(input: unknown): string {
  return typeof input === 'string' ? input.trim() : '';
}

function isGenericParentErrorMessage(message: string): boolean {
  return GENERIC_PARENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function extractNestedErrorMessages(error: unknown): string[] {
  if (typeof error === 'string') {
    const direct = normalizeMessage(error);
    return direct ? [direct] : [];
  }

  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current: any = error;

  while (current && !visited.has(current)) {
    visited.add(current);
    const message = normalizeMessage(current?.message);
    if (message && !messages.includes(message)) {
      messages.push(message);
    }
    current = current?.cause;
  }

  return messages;
}

export function describeErrorWithCauses(error: unknown, fallback = 'unknown error'): string {
  const messages = extractNestedErrorMessages(error);
  if (messages.length === 0) {
    return normalizeMessage(fallback) || 'unknown error';
  }

  const primary = messages[0] || normalizeMessage(fallback) || 'unknown error';
  const detail = messages.find((message, index) => index > 0 && !isGenericParentErrorMessage(message))
    || messages[1]
    || '';

  if (!detail || detail === primary) {
    return primary;
  }

  if (primary.includes(detail)) {
    return primary;
  }

  return `${primary}: ${detail}`;
}
