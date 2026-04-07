import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type PreferenceServiceModule = typeof import('./accountDispatchPreferenceService.js');

describe('accountDispatchPreferenceService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let setAccountDispatchPreferenceMode: PreferenceServiceModule['setAccountDispatchPreferenceMode'];
  let getAccountDispatchPreference: PreferenceServiceModule['getAccountDispatchPreference'];
  let listAccountDispatchPreferences: PreferenceServiceModule['listAccountDispatchPreferences'];
  let resetAccountDispatchPreferenceCache: PreferenceServiceModule['resetAccountDispatchPreferenceCache'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-dispatch-preference-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./accountDispatchPreferenceService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    setAccountDispatchPreferenceMode = serviceModule.setAccountDispatchPreferenceMode;
    getAccountDispatchPreference = serviceModule.getAccountDispatchPreference;
    listAccountDispatchPreferences = serviceModule.listAccountDispatchPreferences;
    resetAccountDispatchPreferenceCache = serviceModule.resetAccountDispatchPreferenceCache;
  });

  beforeEach(async () => {
    await db.delete(schema.accountDispatchPreferences).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    resetAccountDispatchPreferenceCache();
  });

  afterAll(() => {
    resetAccountDispatchPreferenceCache();
    delete process.env.DATA_DIR;
  });

  async function createAccount(username: string) {
    const site = await db.insert(schema.sites).values({
      name: `${username}-site`,
      url: `https://${username}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    return await db.insert(schema.accounts).values({
      siteId: site.id,
      username,
      accessToken: `${username}-access`,
      apiToken: `${username}-api`,
      status: 'active',
    }).returning().get();
  }

  it('returns default mode when no preference row exists', async () => {
    const account = await createAccount('alpha');

    await expect(getAccountDispatchPreference(account.id)).resolves.toEqual({
      accountId: account.id,
      mode: 'default',
      updatedAt: null,
    });
  });

  it('stores and reloads force/prefer preferences', async () => {
    const accountA = await createAccount('force-user');
    const accountB = await createAccount('prefer-user');

    const force = await setAccountDispatchPreferenceMode(accountA.id, 'force');
    const prefer = await setAccountDispatchPreferenceMode(accountB.id, 'prefer');

    expect(force.mode).toBe('force');
    expect(prefer.mode).toBe('prefer');
    expect(force.updatedAt).toBeTruthy();
    expect(prefer.updatedAt).toBeTruthy();

    resetAccountDispatchPreferenceCache();

    const reloaded = await listAccountDispatchPreferences([accountA.id, accountB.id]);
    expect(reloaded.get(accountA.id)).toEqual(expect.objectContaining({
      accountId: accountA.id,
      mode: 'force',
    }));
    expect(reloaded.get(accountB.id)).toEqual(expect.objectContaining({
      accountId: accountB.id,
      mode: 'prefer',
    }));
  });

  it('clears persisted preference when switched back to default', async () => {
    const account = await createAccount('default-user');

    await setAccountDispatchPreferenceMode(account.id, 'prefer');
    const cleared = await setAccountDispatchPreferenceMode(account.id, 'default');

    expect(cleared).toEqual({
      accountId: account.id,
      mode: 'default',
      updatedAt: null,
    });

    const rows = await db.select().from(schema.accountDispatchPreferences).all();
    expect(rows).toHaveLength(0);
  });
});
