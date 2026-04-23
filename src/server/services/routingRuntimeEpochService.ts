import { createHash } from 'node:crypto';
import { getChannelAffinityEpochState } from './channelAffinity.js';
import { getResponsesContinuityEpochState } from './responsesContinuityStore.js';
import { getRouteDecisionSnapshotEpochState } from './routeDecisionSnapshotStore.js';
import { getTokenRouterEpochState } from './tokenRouter.js';

export type RoutingRuntimeEpochSnapshot = {
  digest: string;
  generatedAt: string;
  tokenRouter: ReturnType<typeof getTokenRouterEpochState>;
  channelAffinity: ReturnType<typeof getChannelAffinityEpochState>;
  responsesContinuity: ReturnType<typeof getResponsesContinuityEpochState>;
  routeDecisionSnapshots: Awaited<ReturnType<typeof getRouteDecisionSnapshotEpochState>>;
};

function buildDigestPayload(input: Omit<RoutingRuntimeEpochSnapshot, 'digest' | 'generatedAt'>): string {
  return JSON.stringify({
    tokenRouter: input.tokenRouter,
    channelAffinity: input.channelAffinity,
    responsesContinuity: input.responsesContinuity,
    routeDecisionSnapshots: input.routeDecisionSnapshots,
  });
}

export async function getRoutingRuntimeEpochSnapshot(nowMs = Date.now()): Promise<RoutingRuntimeEpochSnapshot> {
  const tokenRouter = getTokenRouterEpochState();
  const channelAffinity = getChannelAffinityEpochState(nowMs);
  const responsesContinuity = getResponsesContinuityEpochState(nowMs);
  const routeDecisionSnapshots = await getRouteDecisionSnapshotEpochState();
  const payload = {
    tokenRouter,
    channelAffinity,
    responsesContinuity,
    routeDecisionSnapshots,
  };
  return {
    digest: createHash('sha256').update(buildDigestPayload(payload)).digest('hex'),
    generatedAt: new Date(nowMs).toISOString(),
    ...payload,
  };
}
