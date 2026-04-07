import { eq, inArray } from 'drizzle-orm';
import { db, runtimeDbDialect, schema } from '../db/index.js';

export type AccountDispatchPreferenceMode = 'default' | 'force' | 'prefer';

type StoredAccountDispatchPreferenceMode = Exclude<AccountDispatchPreferenceMode, 'default'>;

export type AccountDispatchPreferenceRecord = {
  accountId: number;
  mode: AccountDispatchPreferenceMode;
  updatedAt: string | null;
};

const VALID_ACCOUNT_DISPATCH_PREFERENCE_MODES = new Set<AccountDispatchPreferenceMode>([
  'default',
  'force',
  'prefer',
]);

let accountDispatchPreferenceCache: Map<number, AccountDispatchPreferenceRecord> | null = null;
let accountDispatchPreferenceLoadPromise: Promise<Map<number, AccountDispatchPreferenceRecord>> | null = null;

export function normalizeAccountDispatchPreferenceMode(value: unknown): AccountDispatchPreferenceMode {
  const normalized = String(value || '').trim().toLowerCase();
  if (VALID_ACCOUNT_DISPATCH_PREFERENCE_MODES.has(normalized as AccountDispatchPreferenceMode)) {
    return normalized as AccountDispatchPreferenceMode;
  }
  return 'default';
}

function toStoredMode(mode: AccountDispatchPreferenceMode): StoredAccountDispatchPreferenceMode | null {
  return mode === 'force' || mode === 'prefer' ? mode : null;
}

function buildPreferenceRecord(row: typeof schema.accountDispatchPreferences.$inferSelect): AccountDispatchPreferenceRecord {
  return {
    accountId: row.accountId,
    mode: normalizeAccountDispatchPreferenceMode(row.mode),
    updatedAt: row.updatedAt || null,
  };
}

async function loadAccountDispatchPreferenceCache(): Promise<Map<number, AccountDispatchPreferenceRecord>> {
  if (accountDispatchPreferenceCache) return accountDispatchPreferenceCache;
  if (accountDispatchPreferenceLoadPromise) return accountDispatchPreferenceLoadPromise;

  accountDispatchPreferenceLoadPromise = (async () => {
    const rows = await db.select().from(schema.accountDispatchPreferences).all();
    const next = new Map<number, AccountDispatchPreferenceRecord>();
    for (const row of rows) {
      next.set(row.accountId, buildPreferenceRecord(row));
    }
    accountDispatchPreferenceCache = next;
    accountDispatchPreferenceLoadPromise = null;
    return next;
  })().catch((error) => {
    accountDispatchPreferenceLoadPromise = null;
    throw error;
  });

  return accountDispatchPreferenceLoadPromise;
}

function setCachedAccountDispatchPreference(record: AccountDispatchPreferenceRecord | null): void {
  if (!accountDispatchPreferenceCache) {
    accountDispatchPreferenceCache = new Map<number, AccountDispatchPreferenceRecord>();
  }
  if (!record || record.mode === 'default') {
    if (record) {
      accountDispatchPreferenceCache.delete(record.accountId);
    }
    return;
  }
  accountDispatchPreferenceCache.set(record.accountId, record);
}

export function resetAccountDispatchPreferenceCache(): void {
  accountDispatchPreferenceCache = null;
  accountDispatchPreferenceLoadPromise = null;
}

export async function getAccountDispatchPreference(accountId: number): Promise<AccountDispatchPreferenceRecord> {
  const normalizedAccountId = Math.trunc(accountId || 0);
  if (normalizedAccountId <= 0) {
    return { accountId: normalizedAccountId, mode: 'default', updatedAt: null };
  }
  const cache = await loadAccountDispatchPreferenceCache();
  return cache.get(normalizedAccountId) ?? {
    accountId: normalizedAccountId,
    mode: 'default',
    updatedAt: null,
  };
}

export async function listAccountDispatchPreferences(accountIds?: number[]): Promise<Map<number, AccountDispatchPreferenceRecord>> {
  const cache = await loadAccountDispatchPreferenceCache();
  if (!Array.isArray(accountIds) || accountIds.length <= 0) {
    return new Map(cache);
  }

  const normalizedAccountIds = Array.from(new Set(
    accountIds
      .filter((accountId): accountId is number => Number.isFinite(accountId) && accountId > 0)
      .map((accountId) => Math.trunc(accountId)),
  ));

  const selected = new Map<number, AccountDispatchPreferenceRecord>();
  for (const accountId of normalizedAccountIds) {
    selected.set(accountId, cache.get(accountId) ?? {
      accountId,
      mode: 'default',
      updatedAt: null,
    });
  }
  return selected;
}

export async function setAccountDispatchPreferenceMode(
  accountId: number,
  mode: AccountDispatchPreferenceMode,
): Promise<AccountDispatchPreferenceRecord> {
  const normalizedAccountId = Math.trunc(accountId || 0);
  if (normalizedAccountId <= 0) {
    throw new Error('Invalid accountId');
  }
  const normalizedMode = normalizeAccountDispatchPreferenceMode(mode);
  const storedMode = toStoredMode(normalizedMode);

  if (!storedMode) {
    await db.delete(schema.accountDispatchPreferences)
      .where(eq(schema.accountDispatchPreferences.accountId, normalizedAccountId))
      .run();
    const cleared = {
      accountId: normalizedAccountId,
      mode: 'default' as const,
      updatedAt: null,
    };
    setCachedAccountDispatchPreference(cleared);
    return cleared;
  }

  const updatedAt = new Date().toISOString();
  if (runtimeDbDialect === 'mysql') {
    const existing = await db.select()
      .from(schema.accountDispatchPreferences)
      .where(eq(schema.accountDispatchPreferences.accountId, normalizedAccountId))
      .get();
    if (existing) {
      await db.update(schema.accountDispatchPreferences)
        .set({ mode: storedMode, updatedAt })
        .where(eq(schema.accountDispatchPreferences.accountId, normalizedAccountId))
        .run();
    } else {
      await db.insert(schema.accountDispatchPreferences)
        .values({ accountId: normalizedAccountId, mode: storedMode, updatedAt })
        .run();
    }
  } else {
    await (db.insert(schema.accountDispatchPreferences)
      .values({ accountId: normalizedAccountId, mode: storedMode, updatedAt }) as any)
      .onConflictDoUpdate({
        target: schema.accountDispatchPreferences.accountId,
        set: {
          mode: storedMode,
          updatedAt,
        },
      })
      .run();
  }

  const stored = {
    accountId: normalizedAccountId,
    mode: storedMode,
    updatedAt,
  };
  setCachedAccountDispatchPreference(stored);
  return stored;
}

export async function removeAccountDispatchPreferences(accountIds: number[]): Promise<void> {
  const normalizedAccountIds = Array.from(new Set(
    accountIds
      .filter((accountId): accountId is number => Number.isFinite(accountId) && accountId > 0)
      .map((accountId) => Math.trunc(accountId)),
  ));
  if (normalizedAccountIds.length <= 0) return;

  await db.delete(schema.accountDispatchPreferences)
    .where(inArray(schema.accountDispatchPreferences.accountId, normalizedAccountIds))
    .run();

  if (accountDispatchPreferenceCache) {
    for (const accountId of normalizedAccountIds) {
      accountDispatchPreferenceCache.delete(accountId);
    }
  }
}
