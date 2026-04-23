import { eq, inArray, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { sanitizeNonSecretSnapshot } from './nonSecretSnapshot.js';

function serializeSnapshot(snapshot: unknown): string | null {
  if (snapshot == null) return null;
  return JSON.stringify(sanitizeNonSecretSnapshot(snapshot));
}

export function parseRouteDecisionSnapshot(value: unknown): unknown | null {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function saveRouteDecisionSnapshot(routeId: number, snapshot: unknown): Promise<void> {
  const normalizedRouteId = Math.trunc(Number(routeId) || 0);
  if (normalizedRouteId <= 0) return;
  await db.update(schema.tokenRoutes)
    .set({
      decisionSnapshot: serializeSnapshot(snapshot),
      decisionRefreshedAt: new Date().toISOString(),
    })
    .where(eq(schema.tokenRoutes.id, normalizedRouteId))
    .run();
}

export async function saveRouteDecisionSnapshots(entries: Array<{ routeId: number; snapshot: unknown }>): Promise<void> {
  for (const entry of entries) {
    await saveRouteDecisionSnapshot(entry.routeId, entry.snapshot);
  }
}

export async function getRouteDecisionSnapshotEpochState(): Promise<{
  snapshotCount: number;
  latestRefreshedAt: string | null;
}> {
  const rows = await db.select({
    decisionRefreshedAt: schema.tokenRoutes.decisionRefreshedAt,
  })
    .from(schema.tokenRoutes)
    .where(isNotNull(schema.tokenRoutes.decisionSnapshot))
    .all();

  let latestRefreshedAt: string | null = null;
  for (const row of rows) {
    const value = String(row.decisionRefreshedAt || '').trim();
    if (!value) continue;
    if (!latestRefreshedAt || value > latestRefreshedAt) {
      latestRefreshedAt = value;
    }
  }

  return {
    snapshotCount: rows.length,
    latestRefreshedAt,
  };
}

export async function clearRouteDecisionSnapshot(routeId: number): Promise<void> {
  await clearRouteDecisionSnapshots([routeId]);
}

export async function clearRouteDecisionSnapshots(routeIds: number[]): Promise<void> {
  const normalizedRouteIds = Array.from(new Set(
    routeIds
      .map((routeId) => Math.trunc(routeId))
      .filter((routeId) => routeId > 0),
  ));
  if (normalizedRouteIds.length === 0) return;

  await db.update(schema.tokenRoutes)
    .set({
      decisionSnapshot: null,
      decisionRefreshedAt: null,
    })
    .where(inArray(schema.tokenRoutes.id, normalizedRouteIds))
    .run();
}

export async function clearAllRouteDecisionSnapshots(): Promise<void> {
  await db.update(schema.tokenRoutes)
    .set({
      decisionSnapshot: null,
      decisionRefreshedAt: null,
    })
    .run();
}

export const __routeDecisionSnapshotStoreTestUtils = {
  serializeSnapshot,
};
