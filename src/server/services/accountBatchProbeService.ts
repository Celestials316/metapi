import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getCredentialModeFromExtraConfig } from './accountExtraConfig.js';
import { probeAccountChat } from './accountProbeService.js';

type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

type ProbeTask =
  | {
    kind: 'result';
    result: AccountBatchProbeResultItem;
  }
  | {
    kind: 'probe';
    accountId: number;
    accountName: string;
    siteName: string;
    modelName: string;
    usedFallbackModel: boolean;
  };

export type AccountBatchProbeStatus = 'success' | 'failed' | 'skipped_disabled' | 'skipped_no_model';

export type AccountBatchProbeResultItem = {
  accountId: number;
  accountName: string;
  siteName: string;
  status: AccountBatchProbeStatus;
  latencyMs: number | null;
  model: string | null;
  usedFallbackModel: boolean;
  message: string;
};

export type AccountBatchProbeStartEvent = {
  totalAccounts: number;
  scheduledAccounts: number;
  hiddenDisabledAccounts: number;
  concurrency: number;
};

export type AccountBatchProbeDoneSummary = {
  totalAccounts: number;
  scheduledAccounts: number;
  hiddenDisabledAccounts: number;
  completedAccounts: number;
  success: number;
  failed: number;
  skipped: number;
  durationMs: number;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveCredentialMode(account: typeof schema.accounts.$inferSelect): 'session' | 'apikey' {
  const explicitMode = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicitMode === 'apikey') return 'apikey';
  if (explicitMode === 'session') return 'session';
  return asTrimmedString(account.accessToken) ? 'session' : 'apikey';
}

function resolveAccountName(account: typeof schema.accounts.$inferSelect): string {
  const username = asTrimmedString(account.username);
  if (username) return username;
  return resolveCredentialMode(account) === 'apikey' ? 'API Key 连接' : '未命名';
}

function buildResult(input: AccountBatchProbeResultItem): AccountBatchProbeResultItem {
  return input;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldContinue?: () => boolean,
): Promise<void> {
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, Math.trunc(concurrency || 1)));
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      if (shouldContinue && !shouldContinue()) return;
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      await worker(items[currentIndex] as T, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
}

async function loadAccountWithSite(accountId: number): Promise<AccountWithSiteRow | null> {
  const row = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();
  return row || null;
}

async function resolveProbeTask(input: {
  accountId: number;
  preferredModel: string;
  includeDisabled: boolean;
}): Promise<ProbeTask | null> {
  const row = await loadAccountWithSite(input.accountId);
  if (!row) {
    return {
      kind: 'result',
      result: buildResult({
        accountId: input.accountId,
        accountName: '连接',
        siteName: '未知站点',
        status: 'failed',
        latencyMs: null,
        model: null,
        usedFallbackModel: false,
        message: '连接不存在',
      }),
    };
  }

  const account = row.accounts;
  const site = row.sites;
  const accountName = resolveAccountName(account);
  const siteName = asTrimmedString(site.name) || '未命名站点';
  const accountDisabled = (account.status || 'active') !== 'active' || (site.status || 'active') !== 'active';
  if (accountDisabled) {
    if (!input.includeDisabled) return null;
    return {
      kind: 'result',
      result: buildResult({
        accountId: account.id,
        accountName,
        siteName,
        status: 'skipped_disabled',
        latencyMs: null,
        model: null,
        usedFallbackModel: false,
        message: '连接已禁用，未发起测活',
      }),
    };
  }

  const modelRows = await db.select({
    modelName: schema.modelAvailability.modelName,
    available: schema.modelAvailability.available,
  }).from(schema.modelAvailability)
    .where(eq(schema.modelAvailability.accountId, account.id))
    .all();
  const disabledRows = await db.select({
    modelName: schema.siteDisabledModels.modelName,
  }).from(schema.siteDisabledModels)
    .where(eq(schema.siteDisabledModels.siteId, site.id))
    .all();

  const disabledSet = new Set(disabledRows.map((rowItem) => rowItem.modelName));
  const availableModels = modelRows
    .filter((rowItem) => !!rowItem.available)
    .map((rowItem) => rowItem.modelName)
    .filter((modelName) => !disabledSet.has(modelName))
    .sort((left, right) => left.localeCompare(right));

  const preferredModel = asTrimmedString(input.preferredModel);
  const resolvedPreferredModel = preferredModel && availableModels.includes(preferredModel)
    ? preferredModel
    : '';
  const fallbackModel = availableModels[0] || '';
  const resolvedModel = resolvedPreferredModel || fallbackModel;

  if (!resolvedModel) {
    return {
      kind: 'result',
      result: buildResult({
        accountId: account.id,
        accountName,
        siteName,
        status: 'skipped_no_model',
        latencyMs: null,
        model: null,
        usedFallbackModel: false,
        message: '该连接没有可用模型',
      }),
    };
  }

  return {
    kind: 'probe',
    accountId: account.id,
    accountName,
    siteName,
    modelName: resolvedModel,
    usedFallbackModel: !resolvedPreferredModel,
  };
}

function buildSummaryAccumulator(start: AccountBatchProbeStartEvent): Omit<AccountBatchProbeDoneSummary, 'durationMs'> {
  return {
    totalAccounts: start.totalAccounts,
    scheduledAccounts: start.scheduledAccounts,
    hiddenDisabledAccounts: start.hiddenDisabledAccounts,
    completedAccounts: 0,
    success: 0,
    failed: 0,
    skipped: 0,
  };
}

function applyResultToSummary(
  summary: Omit<AccountBatchProbeDoneSummary, 'durationMs'>,
  result: AccountBatchProbeResultItem,
) {
  summary.completedAccounts += 1;
  if (result.status === 'success') {
    summary.success += 1;
    return;
  }
  if (result.status === 'failed') {
    summary.failed += 1;
    return;
  }
  summary.skipped += 1;
}

export async function executeAccountBatchProbe(input: {
  accountIds: number[];
  preferredModel: string;
  includeDisabled: boolean;
  concurrency: number;
  onStart?: (event: AccountBatchProbeStartEvent) => void | Promise<void>;
  onResult?: (result: AccountBatchProbeResultItem) => void | Promise<void>;
  shouldContinue?: () => boolean;
}): Promise<AccountBatchProbeDoneSummary> {
  const uniqueAccountIds = Array.from(new Set((input.accountIds || [])
    .map((item) => Number.parseInt(String(item), 10))
    .filter((item) => Number.isFinite(item) && item > 0)));
  const preferredModel = asTrimmedString(input.preferredModel);
  const startedAt = Date.now();

  const preparedTasks = await Promise.all(uniqueAccountIds.map(async (accountId) => await resolveProbeTask({
    accountId,
    preferredModel,
    includeDisabled: input.includeDisabled === true,
  })));

  const tasks = preparedTasks.filter((item): item is ProbeTask => !!item);
  const hiddenDisabledAccounts = uniqueAccountIds.length - tasks.length;
  const startEvent: AccountBatchProbeStartEvent = {
    totalAccounts: uniqueAccountIds.length,
    scheduledAccounts: tasks.length,
    hiddenDisabledAccounts,
    concurrency: Math.max(1, Math.min(tasks.length || 1, Math.trunc(input.concurrency || 1))),
  };
  await input.onStart?.(startEvent);

  const summary = buildSummaryAccumulator(startEvent);

  await mapWithConcurrency(tasks, input.concurrency, async (task) => {
    let result: AccountBatchProbeResultItem;

    if (task.kind === 'result') {
      result = task.result;
    } else {
      try {
        const probeResult = await probeAccountChat({
          accountId: task.accountId,
          modelName: task.modelName,
        });
        result = buildResult({
          accountId: task.accountId,
          accountName: task.accountName,
          siteName: task.siteName,
          status: probeResult.success ? 'success' : 'failed',
          latencyMs: probeResult.latencyMs,
          model: probeResult.model || task.modelName,
          usedFallbackModel: task.usedFallbackModel,
          message: probeResult.success
            ? (asTrimmedString(probeResult.replyText) || '上游返回成功，但没有可展示文本')
            : (asTrimmedString(probeResult.errorMessage) || '测活失败'),
        });
      } catch (error) {
        result = buildResult({
          accountId: task.accountId,
          accountName: task.accountName,
          siteName: task.siteName,
          status: 'failed',
          latencyMs: null,
          model: task.modelName,
          usedFallbackModel: task.usedFallbackModel,
          message: error instanceof Error ? error.message : '测活失败',
        });
      }
    }

    applyResultToSummary(summary, result);
    await input.onResult?.(result);
  }, input.shouldContinue);

  return {
    ...summary,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}
