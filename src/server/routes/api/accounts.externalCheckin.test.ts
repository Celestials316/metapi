import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

const resolveAccountExternalCheckinActionMock = vi.fn();

vi.mock('../../services/externalCheckinService.js', () => ({
  resolveAccountExternalCheckinAction: (...args: unknown[]) => resolveAccountExternalCheckinActionMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts api external checkin mode', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-external-checkin-'));
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
    resolveAccountExternalCheckinActionMock.mockReset();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('returns per-account checkinActionMode while only probing sub2api session samples', async () => {
    resolveAccountExternalCheckinActionMock.mockResolvedValue({
      mode: 'manual_jump',
      kind: 'manual_oauth',
      entryUrl: 'https://sign.example.com/embed',
      url: 'https://sign.example.com/embed?token=abc',
      message: '站点需要跳转外部签到页手动完成签到',
    });

    const sub2Site = await db.insert(schema.sites).values({
      name: 'sub2-site',
      url: 'https://sub2.example.com',
      platform: 'sub2api',
    }).returning().get();
    const newApiSite = await db.insert(schema.sites).values({
      name: 'new-api-site',
      url: 'https://newapi.example.com',
      platform: 'new-api',
    }).returning().get();

    const sessionAccount = await db.insert(schema.accounts).values({
      siteId: sub2Site.id,
      username: 'sub2-session',
      accessToken: 'session-token',
      status: 'active',
    }).returning().get();
    const proxyOnlyAccount = await db.insert(schema.accounts).values({
      siteId: sub2Site.id,
      username: 'sub2-apikey',
      accessToken: '',
      status: 'active',
    }).returning().get();
    const normalAccount = await db.insert(schema.accounts).values({
      siteId: newApiSite.id,
      username: 'newapi-session',
      accessToken: 'session-token',
      status: 'active',
    }).returning().get();

    const response = await app.inject({
      method: 'GET',
      url: '/api/accounts',
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json() as Array<{ id: number; checkinActionMode?: string }>;
    expect(rows.find((row) => row.id === sessionAccount.id)?.checkinActionMode).toBe('manual_jump');
    expect(rows.find((row) => row.id === proxyOnlyAccount.id)?.checkinActionMode).toBe('none');
    expect(rows.find((row) => row.id === normalAccount.id)?.checkinActionMode).toBe('auto');
    expect(resolveAccountExternalCheckinActionMock).toHaveBeenCalledTimes(1);
  });
});
