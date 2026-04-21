import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  type AccountDispatchPreferenceMode,
  type AccountDispatchPreferenceRecord,
  setAccountDispatchPreferenceMode,
} from './accountDispatchPreferenceService.js';
import {
  clearAccountDispatchRuntimeStatesForAccount,
  flushAccountDispatchRuntimePersistence,
} from './accountDispatchRuntimeMemory.js';
import { proxyChannelCoordinator } from './proxyChannelCoordinator.js';

async function listAffectedRouteIdsForAccount(accountId: number): Promise<number[]> {
  const normalizedAccountId = Math.trunc(accountId || 0);
  if (normalizedAccountId <= 0) return [];

  const directRouteRows = await db.select({
    routeId: schema.routeChannels.routeId,
  })
    .from(schema.routeChannels)
    .where(eq(schema.routeChannels.accountId, normalizedAccountId))
    .all();

  const routeIds = new Set<number>(
    directRouteRows
      .map((row) => Math.trunc(row.routeId || 0))
      .filter((routeId) => routeId > 0),
  );

  const routeUnitRows = await db.select({
    unitId: schema.oauthRouteUnitMembers.unitId,
  })
    .from(schema.oauthRouteUnitMembers)
    .where(eq(schema.oauthRouteUnitMembers.accountId, normalizedAccountId))
    .all();

  const routeUnitIds: number[] = Array.from(new Set(
    routeUnitRows
      .map((row) => Math.trunc(row.unitId || 0))
      .filter((unitId) => unitId > 0),
  ));

  if (routeUnitIds.length > 0) {
    const routeUnitChannelRows = await db.select({
      routeId: schema.routeChannels.routeId,
    })
      .from(schema.routeChannels)
      .where(inArray(schema.routeChannels.oauthRouteUnitId, routeUnitIds))
      .all();
    for (const row of routeUnitChannelRows) {
      const routeId = Math.trunc(row.routeId || 0);
      if (routeId > 0) routeIds.add(routeId);
    }
  }

  return [...routeIds];
}

async function listChannelIdsForRoutes(routeIds: number[]): Promise<number[]> {
  const normalizedRouteIds: number[] = Array.from(new Set(
    routeIds
      .filter((routeId): routeId is number => Number.isFinite(routeId) && routeId > 0)
      .map((routeId) => Math.trunc(routeId)),
  ));
  if (normalizedRouteIds.length <= 0) return [];

  const rows = await db.select({
    channelId: schema.routeChannels.id,
  })
    .from(schema.routeChannels)
    .where(inArray(schema.routeChannels.routeId, normalizedRouteIds))
    .all();

  return Array.from(new Set(
    rows
      .map((row) => Math.trunc(row.channelId || 0))
      .filter((channelId) => channelId > 0),
  ));
}

export async function updateAccountDispatchPreferenceMode(
  accountId: number,
  mode: AccountDispatchPreferenceMode,
): Promise<AccountDispatchPreferenceRecord> {
  const normalizedAccountId = Math.trunc(accountId || 0);
  if (normalizedAccountId <= 0) {
    throw new Error('Invalid accountId');
  }

  const affectedRouteIds = await listAffectedRouteIdsForAccount(normalizedAccountId);
  const affectedChannelIds = await listChannelIdsForRoutes(affectedRouteIds);

  const record = await setAccountDispatchPreferenceMode(normalizedAccountId, mode);

  if (affectedChannelIds.length > 0) {
    proxyChannelCoordinator.clearStickyChannelsByChannelIds(affectedChannelIds);
  }
  await clearAccountDispatchRuntimeStatesForAccount(normalizedAccountId);
  await flushAccountDispatchRuntimePersistence();

  return record;
}
