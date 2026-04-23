import {
  ensureAccountDispatchRuntimeStateLoaded,
  flushAccountDispatchRuntimePersistence,
  resetAccountDispatchRuntimeMemory,
} from './accountDispatchRuntimeMemory.js';
import {
  ensureProxyChannelCoordinatorStateLoaded,
  flushProxyChannelCoordinatorStatePersistence,
  resetProxyChannelCoordinatorState,
} from './proxyChannelCoordinator.js';
import {
  ensureUpstreamEndpointRuntimeStateLoaded,
  flushUpstreamEndpointRuntimePersistence,
  resetUpstreamEndpointRuntimeState,
} from './upstreamEndpointRuntimeMemory.js';
import {
  flushSiteRuntimeHealthPersistence,
  resetSiteRuntimeHealthState,
} from './tokenRouter.js';

export async function flushAllRuntimeStatePersistence(): Promise<void> {
  await Promise.all([
    flushAccountDispatchRuntimePersistence(),
    flushProxyChannelCoordinatorStatePersistence(),
    flushUpstreamEndpointRuntimePersistence(),
    flushSiteRuntimeHealthPersistence(),
  ]);
}

export function resetAllRuntimeStateCaches(): void {
  resetAccountDispatchRuntimeMemory();
  resetProxyChannelCoordinatorState();
  resetUpstreamEndpointRuntimeState();
  resetSiteRuntimeHealthState();
}

export async function warmRuntimeStateCachesForImport(input: {
  siteIds?: number[];
  nowMs?: number;
} = {}): Promise<void> {
  const nowMs = input.nowMs ?? Date.now();
  await Promise.all([
    ensureAccountDispatchRuntimeStateLoaded(nowMs),
    ensureProxyChannelCoordinatorStateLoaded(nowMs),
  ]);

  const siteIds = Array.from(new Set(
    (input.siteIds ?? [])
      .filter((siteId): siteId is number => Number.isFinite(siteId) && siteId > 0)
      .map((siteId) => Math.trunc(siteId)),
  ));

  await Promise.all(siteIds.map((siteId) => ensureUpstreamEndpointRuntimeStateLoaded(siteId, nowMs)));
}
