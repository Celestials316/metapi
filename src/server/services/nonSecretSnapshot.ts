const REDACTED_VALUE = '[redacted]';
const MAX_DEPTH = 8;
const SENSITIVE_KEY_PATTERN = /(authorization|api[_-]?key|token|secret|cookie|password|session)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1, seen));
  }

  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  const next: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      next[key] = REDACTED_VALUE;
      continue;
    }
    next[key] = sanitizeValue(entryValue, depth + 1, seen);
  }
  seen.delete(value);
  return next;
}

export function sanitizeNonSecretSnapshot(value: unknown): unknown {
  return sanitizeValue(value, 0, new WeakSet<object>());
}

export const __nonSecretSnapshotTestUtils = {
  REDACTED_VALUE,
  SENSITIVE_KEY_PATTERN,
};
