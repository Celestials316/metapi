import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');

describe('accounts dispatch preference route', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let proxyChannelCoordinator: typeof import('../../services/proxyChannelCoordinator.js').proxyChannelCoordinator;
  let resetProxyChannelCoordinatorState: typeof import('../../services/proxyChannelCoordinator.js').resetProxyChannelCoordinatorState;
  let recordAccountDispatchSelectionBlocked: typeof import('../../services/accountDispatchRuntimeMemory.js').recordAccountDispatchSelectionBlocked;
  let getAccountDispatchRuntimeSnapshot: typeof import('../../services/accountDispatchRuntimeMemory.js').getAccountDispatchRuntimeSnapshot;
  let ensureAccountDispatchRuntimeStateLoaded: typeof import('../../services/accountDispatchRuntimeMemory.js').ensureAccountDispatchRuntimeStateLoaded;
  let resetAccountDispatchRuntimeMemory: typeof import('../../services/accountDispatchRuntimeMemory.js').resetAccountDispatchRuntimeMemory;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-dispatch-preference-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    const proxyChannelCoordinatorModule = await import('../../services/proxyChannelCoordinator.js');
    const runtimeMemoryModule = await import('../../services/accountDispatchRuntimeMemory.js');
    db = dbModule.db;
    schema = dbModule.schema;
    proxyChannelCoordinator = proxyChannelCoordinatorModule.proxyChannelCoordinator;
    resetProxyChannelCoordinatorState = proxyChannelCoordinatorModule.resetProxyChannelCoordinatorState;
    recordAccountDispatchSelectionBlocked = runtimeMemoryModule.recordAccountDispatchSelectionBlocked;
    getAccountDispatchRuntimeSnapshot = runtimeMemoryModule.getAccountDispatchRuntimeSnapshot;
    ensureAccountDispatchRuntimeStateLoaded = runtimeMemoryModule.ensureAccountDispatchRuntimeStateLoaded;
    resetAccountDispatchRuntimeMemory = runtimeMemoryModule.resetAccountDispatchRuntimeMemory;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accountDispatchPreferences).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.oauthRouteUnitMembers).run();
    await db.delete(schema.oauthRouteUnits).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    resetProxyChannelCoordinatorState();
    resetAccountDispatchRuntimeMemory();
  });

  afterAll(async () => {
    if (app) await app.close();
    delete process.env.DATA_DIR;
  });

  async function createAccount() {
    const site = await db.insert(schema.sites).values({
      name: 'Dispatch Site',
      url: 'https://dispatch-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    return await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'dispatch-user',
      accessToken: 'dispatch-access',
      apiToken: 'dispatch-api',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
  }

  async function createSessionAccount(username: string, siteId?: number) {
    const resolvedSiteId = siteId ?? (await db.insert(schema.sites).values({
      name: `${username}-site`,
      url: `https://${username}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get()).id;

    return await db.insert(schema.accounts).values({
      siteId: resolvedSiteId,
      username,
      accessToken: `${username}-session`,
      apiToken: `${username}-api`,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();
  }

  it('returns default dispatch mode for accounts without explicit preference', async () => {
    await createAccount();

    const response = await app.inject({
      method: 'GET',
      url: '/api/accounts',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        username: 'dispatch-user',
        dispatchPreferenceMode: 'default',
      }),
    ]));
  });

  it('updates account dispatch preference via account update route', async () => {
    const account = await createAccount();

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}`,
      payload: {
        dispatchPreferenceMode: 'prefer',
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toEqual(expect.objectContaining({
      id: account.id,
      dispatchPreferenceMode: 'prefer',
    }));

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/accounts',
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: account.id,
        dispatchPreferenceMode: 'prefer',
      }),
    ]));

    const clearResponse = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}`,
      payload: {
        dispatchPreferenceMode: 'default',
      },
    });
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toEqual(expect.objectContaining({
      id: account.id,
      dispatchPreferenceMode: 'default',
    }));
  });

  it('clears sticky bindings and runtime memory for direct route channels when dispatch preference changes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Sticky Site',
      url: 'https://sticky.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const targetAccount = await createSessionAccount('preferred-user', site.id);
    const fallbackAccount = await createSessionAccount('fallback-user', site.id);
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const targetChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: targetAccount.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    const fallbackChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: fallbackAccount.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const stickyKeyA = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'sticky-a',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 1,
    });
    const stickyKeyB = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'sticky-b',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 1,
    });
    proxyChannelCoordinator.bindStickyChannel(stickyKeyA, targetChannel.id, targetAccount);
    proxyChannelCoordinator.bindStickyChannel(stickyKeyB, fallbackChannel.id, fallbackAccount);
    const nowMs = Date.now();
    recordAccountDispatchSelectionBlocked(route.id, 'gpt-5.4', targetAccount.id, nowMs);

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${targetAccount.id}`,
      payload: {
        dispatchPreferenceMode: 'force',
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(proxyChannelCoordinator.getStickyChannelId(stickyKeyA)).toBeNull();
    expect(proxyChannelCoordinator.getStickyChannelId(stickyKeyB)).toBeNull();
    expect(getAccountDispatchRuntimeSnapshot(route.id, 'gpt-5.4', targetAccount.id, nowMs + 1).status).toBe('healthy');

    resetAccountDispatchRuntimeMemory();
    await ensureAccountDispatchRuntimeStateLoaded();
    expect(getAccountDispatchRuntimeSnapshot(route.id, 'gpt-5.4', targetAccount.id, nowMs + 1).status).toBe('healthy');
  });

  it('clears sticky bindings for oauth route-unit channels when a member account preference changes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Route Unit Site',
      url: 'https://route-unit.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const representative = await createSessionAccount('rep-user', site.id);
    const member = await createSessionAccount('member-user', site.id);
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'codex-unit',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values({
      unitId: routeUnit.id,
      accountId: member.id,
      sortOrder: 1,
    }).run();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const groupedChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: representative.id,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    const stickyKey = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'route-unit-sticky',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 1,
    });
    proxyChannelCoordinator.bindStickyChannel(stickyKey, groupedChannel.id, representative);

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${member.id}`,
      payload: {
        dispatchPreferenceMode: 'prefer',
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(proxyChannelCoordinator.getStickyChannelId(stickyKey)).toBeNull();
  });
});
