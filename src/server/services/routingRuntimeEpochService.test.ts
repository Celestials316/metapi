import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type DbModule = typeof import('../db/index.js');
type EpochModule = typeof import('./routingRuntimeEpochService.js');
type RouteDecisionStoreModule = typeof import('./routeDecisionSnapshotStore.js');
type ResponsesContinuityModule = typeof import('./responsesContinuityStore.js');
type ChannelAffinityModule = typeof import('./channelAffinity.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('routingRuntimeEpochService', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let getRoutingRuntimeEpochSnapshot: EpochModule['getRoutingRuntimeEpochSnapshot'];
  let saveRouteDecisionSnapshot: RouteDecisionStoreModule['saveRouteDecisionSnapshot'];
  let setStoredSessionResponseId: ResponsesContinuityModule['setStoredSessionResponseId'];
  let setStoredStickyChannelBinding: ResponsesContinuityModule['setStoredStickyChannelBinding'];
  let resetResponsesContinuityStore: ResponsesContinuityModule['resetResponsesContinuityStore'];
  let resolveChannelAffinityRequest: ChannelAffinityModule['resolveChannelAffinityRequest'];
  let recordChannelAffinitySuccess: ChannelAffinityModule['recordChannelAffinitySuccess'];
  let resetChannelAffinityState: ChannelAffinityModule['resetChannelAffinityState'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-routing-runtime-epoch-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const epochModule = await import('./routingRuntimeEpochService.js');
    const routeDecisionStoreModule = await import('./routeDecisionSnapshotStore.js');
    const responsesContinuityModule = await import('./responsesContinuityStore.js');
    const channelAffinityModule = await import('./channelAffinity.js');
    const tokenRouterModule = await import('./tokenRouter.js');

    db = dbModule.db;
    schema = dbModule.schema;
    getRoutingRuntimeEpochSnapshot = epochModule.getRoutingRuntimeEpochSnapshot;
    saveRouteDecisionSnapshot = routeDecisionStoreModule.saveRouteDecisionSnapshot;
    setStoredSessionResponseId = responsesContinuityModule.setStoredSessionResponseId;
    setStoredStickyChannelBinding = responsesContinuityModule.setStoredStickyChannelBinding;
    resetResponsesContinuityStore = responsesContinuityModule.resetResponsesContinuityStore;
    resolveChannelAffinityRequest = channelAffinityModule.resolveChannelAffinityRequest;
    recordChannelAffinitySuccess = channelAffinityModule.recordChannelAffinitySuccess;
    resetChannelAffinityState = channelAffinityModule.resetChannelAffinityState;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    resetResponsesContinuityStore();
    resetChannelAffinityState();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
  });

  afterAll(() => {
    resetResponsesContinuityStore();
    resetChannelAffinityState();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    delete process.env.DATA_DIR;
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('returns a stable digest for the same runtime state', async () => {
    const first = await getRoutingRuntimeEpochSnapshot();
    const second = await getRoutingRuntimeEpochSnapshot();

    expect(second.digest).toBe(first.digest);
    expect(second.tokenRouter).toEqual(first.tokenRouter);
    expect(second.channelAffinity).toEqual(first.channelAffinity);
    expect(second.responsesContinuity).toEqual(first.responsesContinuity);
    expect(second.routeDecisionSnapshots).toEqual(first.routeDecisionSnapshots);
  });

  it('changes the digest when routing runtime layers change', async () => {
    const before = await getRoutingRuntimeEpochSnapshot();

    const site = await db.insert(schema.sites).values({
      name: 'epoch-site',
      url: 'https://epoch-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'epoch-user',
      accessToken: '',
      apiToken: 'sk-epoch',
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      name: 'epoch-route',
      modelPattern: 'gpt-4o-mini',
      responseMode: 'proxy',
      routeMode: 'simple',
      enabled: true,
      priority: 10,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      weight: 10,
      enabled: true,
    }).returning().get();

    await saveRouteDecisionSnapshot(route.id, {
      matched: true,
      selectedChannelId: channel.id,
    });

    setStoredSessionResponseId('session:epoch', 'resp_epoch');
    setStoredStickyChannelBinding({
      key: 'sticky:epoch',
      channelId: channel.id,
      expiresAtMs: Date.now() + 60_000,
    });

    const resolution = resolveChannelAffinityRequest({
      config: {
        enabled: true,
        switchOnSuccess: true,
        maxEntries: 10,
        defaultTtlSeconds: 60,
        rules: [{
          name: 'session',
          modelRegex: ['^gpt-4o-mini$'],
          pathRegex: ['^/v1/responses$'],
          keySources: [{ type: 'header', key: 'x-session-id' }],
          valueRegex: null,
          ttlSeconds: 60,
          skipRetryOnFailure: false,
          includeGroup: true,
          includeModel: true,
          includeRule: true,
        }],
      },
      requestedModel: 'gpt-4o-mini',
      downstreamPath: '/v1/responses',
      headers: { 'x-session-id': 'epoch-session' },
      downstreamGroup: 'global',
    });

    expect(resolution).not.toBeNull();
    recordChannelAffinitySuccess({
      config: {
        enabled: true,
        switchOnSuccess: true,
        maxEntries: 10,
        defaultTtlSeconds: 60,
        rules: [{
          name: 'session',
          modelRegex: ['^gpt-4o-mini$'],
          pathRegex: ['^/v1/responses$'],
          keySources: [{ type: 'header', key: 'x-session-id' }],
          valueRegex: null,
          ttlSeconds: 60,
          skipRetryOnFailure: false,
          includeGroup: true,
          includeModel: true,
          includeRule: true,
        }],
      },
      resolution,
      selectedChannelId: channel.id,
    });

    invalidateTokenRouterCache();

    const after = await getRoutingRuntimeEpochSnapshot();

    expect(after.digest).not.toBe(before.digest);
    expect(after.routeDecisionSnapshots.snapshotCount).toBe(1);
    expect(after.responsesContinuity.sessionAnchorCount).toBe(1);
    expect(after.responsesContinuity.stickyBindingCount).toBe(1);
    expect(after.channelAffinity.bindingCount).toBe(1);
    expect(after.tokenRouter.runtimeEpochVersion).toBeGreaterThan(before.tokenRouter.runtimeEpochVersion);
  });
});
