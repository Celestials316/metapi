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

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-dispatch-preference-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accountDispatchPreferences).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
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
});
