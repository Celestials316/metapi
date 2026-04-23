import { minimatch } from 'minimatch';

export type PayloadRuleModel = {
  name: string;
  protocol?: string;
};

export type PayloadValueRule = {
  models: PayloadRuleModel[];
  params: Record<string, unknown>;
};

export type PayloadFilterRule = {
  models: PayloadRuleModel[];
  params: string[];
};

export type PayloadHeaderRule = {
  models: PayloadRuleModel[];
  endpoints?: string[];
  headers: Record<string, string>;
};

export type PayloadHeaderFilterRule = {
  models: PayloadRuleModel[];
  endpoints?: string[];
  headers: string[];
};

export type PayloadStatusCodeRule = {
  models: PayloadRuleModel[];
  endpoints?: string[];
  from: number[];
  to: number;
};

export type PayloadRulesConfig = {
  default: PayloadValueRule[];
  defaultRaw: PayloadValueRule[];
  override: PayloadValueRule[];
  overrideRaw: PayloadValueRule[];
  filter: PayloadFilterRule[];
  headerOverride: PayloadHeaderRule[];
  headerFilter: PayloadHeaderFilterRule[];
  statusCodeMap: PayloadStatusCodeRule[];
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    ) as T;
  }
  return value;
}

function toPathSegments(path: string): string[] {
  const normalized = asTrimmedString(path).replace(/^\.+/, '');
  return normalized
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function parseIndexSegment(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const parsed = Number.parseInt(segment, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasPath(target: unknown, path: string): boolean {
  const segments = toPathSegments(path);
  if (segments.length <= 0) return false;

  let current: unknown = target;
  for (const segment of segments) {
    const index = parseIndexSegment(segment);
    if (index !== null) {
      if (!Array.isArray(current) || index >= current.length) return false;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = toPathSegments(path);
  if (segments.length <= 0) return;

  let current: unknown = target;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    const segmentIndex = parseIndexSegment(segment);
    const isLast = index === segments.length - 1;

    if (segmentIndex !== null) {
      if (!Array.isArray(current)) return;
      while (current.length <= segmentIndex) current.push(undefined);
      if (isLast) {
        current[segmentIndex] = cloneJsonValue(value);
        return;
      }
      if (!isRecord(current[segmentIndex]) && !Array.isArray(current[segmentIndex])) {
        current[segmentIndex] = parseIndexSegment(nextSegment) !== null ? [] : {};
      }
      current = current[segmentIndex];
      continue;
    }

    if (!isRecord(current)) return;
    if (isLast) {
      current[segment] = cloneJsonValue(value);
      return;
    }
    if (!isRecord(current[segment]) && !Array.isArray(current[segment])) {
      current[segment] = parseIndexSegment(nextSegment) !== null ? [] : {};
    }
    current = current[segment];
  }
}

function deletePath(target: Record<string, unknown>, path: string): void {
  const segments = toPathSegments(path);
  if (segments.length <= 0) return;

  let current: unknown = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const segmentIndex = parseIndexSegment(segment);
    if (segmentIndex !== null) {
      if (!Array.isArray(current) || segmentIndex >= current.length) return;
      current = current[segmentIndex];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return;
    current = current[segment];
  }

  const lastSegment = segments[segments.length - 1];
  const lastIndex = parseIndexSegment(lastSegment);
  if (lastIndex !== null) {
    if (!Array.isArray(current) || lastIndex >= current.length) return;
    current.splice(lastIndex, 1);
    return;
  }
  if (!isRecord(current)) return;
  delete current[lastSegment];
}

function normalizePayloadRuleModels(value: unknown): PayloadRuleModel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const name = asTrimmedString(item.name);
      if (!name) return null;
      const protocol = asTrimmedString(item.protocol);
      return {
        name,
        ...(protocol ? { protocol } : {}),
      };
    })
    .filter((item): item is PayloadRuleModel => !!item);
}

function normalizePayloadValueRules(value: unknown): PayloadValueRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const models = normalizePayloadRuleModels(item.models);
      const params = isRecord(item.params) ? cloneJsonValue(item.params) : null;
      if (models.length <= 0 || !params) return null;
      return { models, params };
    })
    .filter((item): item is PayloadValueRule => !!item);
}

function normalizeEndpointNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asTrimmedString(entry).toLowerCase())
    .filter((entry) => entry.length > 0);
}

function normalizePayloadHeaderRules(value: unknown): PayloadHeaderRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const models = normalizePayloadRuleModels(item.models);
      const headers = isRecord(item.headers)
        ? Object.fromEntries(
          Object.entries(item.headers)
            .map(([key, rawValue]) => [asTrimmedString(key), asTrimmedString(rawValue)])
            .filter(([key, rawValue]) => key.length > 0 && rawValue.length > 0),
        )
        : null;
      if (models.length <= 0 || !headers || Object.keys(headers).length <= 0) return null;
      const endpoints = normalizeEndpointNames(item.endpoints);
      return {
        models,
        headers,
        ...(endpoints.length > 0 ? { endpoints } : {}),
      };
    })
    .filter((item): item is PayloadHeaderRule => !!item);
}

function normalizePayloadHeaderFilterRules(value: unknown): PayloadHeaderFilterRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const models = normalizePayloadRuleModels(item.models);
      const headers = Array.isArray(item.headers)
        ? item.headers.map((entry) => asTrimmedString(entry)).filter((entry) => entry.length > 0)
        : [];
      if (models.length <= 0 || headers.length <= 0) return null;
      const endpoints = normalizeEndpointNames(item.endpoints);
      return {
        models,
        headers,
        ...(endpoints.length > 0 ? { endpoints } : {}),
      };
    })
    .filter((item): item is PayloadHeaderFilterRule => !!item);
}

function normalizePayloadStatusCodeRules(value: unknown): PayloadStatusCodeRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const models = normalizePayloadRuleModels(item.models);
      const fromValues = Array.isArray(item.from)
        ? item.from.map((entry) => Math.trunc(Number(entry))).filter((entry) => Number.isFinite(entry) && entry >= 100 && entry <= 599)
        : [];
      const toValue = Math.trunc(Number(item.to));
      if (models.length <= 0 || fromValues.length <= 0 || !Number.isFinite(toValue) || toValue < 100 || toValue > 599) return null;
      const endpoints = normalizeEndpointNames(item.endpoints);
      return {
        models,
        from: Array.from(new Set(fromValues)),
        to: toValue,
        ...(endpoints.length > 0 ? { endpoints } : {}),
      };
    })
    .filter((item): item is PayloadStatusCodeRule => !!item);
}

function normalizePayloadFilterRules(value: unknown): PayloadFilterRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const models = normalizePayloadRuleModels(item.models);
      const params = Array.isArray(item.params)
        ? item.params
          .map((entry) => asTrimmedString(entry))
          .filter((entry) => entry.length > 0)
        : [];
      if (models.length <= 0 || params.length <= 0) return null;
      return { models, params };
    })
    .filter((item): item is PayloadFilterRule => !!item);
}

function modelRuleMatches(rule: PayloadRuleModel, protocol: string, candidates: string[]): boolean {
  if (!rule.name || candidates.length <= 0) return false;
  const ruleProtocol = asTrimmedString(rule.protocol).toLowerCase();
  if (ruleProtocol && protocol && ruleProtocol !== protocol) return false;
  return candidates.some((candidate) => minimatch(candidate, rule.name, { nocase: true }));
}

function endpointMatches(ruleEndpoints: string[] | undefined, endpoint: string): boolean {
  if (!ruleEndpoints || ruleEndpoints.length <= 0) return true;
  const normalizedEndpoint = asTrimmedString(endpoint).toLowerCase();
  if (!normalizedEndpoint) return false;
  return ruleEndpoints.includes(normalizedEndpoint);
}

function rulesMatch(models: PayloadRuleModel[], protocol: string, candidates: string[]): boolean {
  if (models.length <= 0 || candidates.length <= 0) return false;
  return models.some((rule) => modelRuleMatches(rule, protocol, candidates));
}

function setHeaderCaseInsensitive(target: Record<string, string>, key: string, value: string): void {
  const normalizedKey = key.trim();
  if (!normalizedKey) return;
  const lowered = normalizedKey.toLowerCase();
  for (const existingKey of Object.keys(target)) {
    if (existingKey.toLowerCase() === lowered) {
      delete target[existingKey];
    }
  }
  target[normalizedKey] = value;
}

function deleteHeaderCaseInsensitive(target: Record<string, string>, key: string): void {
  const lowered = key.trim().toLowerCase();
  if (!lowered) return;
  for (const existingKey of Object.keys(target)) {
    if (existingKey.toLowerCase() === lowered) {
      delete target[existingKey];
    }
  }
}

function parseRawRuleValue(value: unknown): unknown {
  if (typeof value !== 'string') return cloneJsonValue(value);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function createEmptyPayloadRulesConfig(): PayloadRulesConfig {
  return {
    default: [],
    defaultRaw: [],
    override: [],
    overrideRaw: [],
    filter: [],
    headerOverride: [],
    headerFilter: [],
    statusCodeMap: [],
  };
}

export function normalizePayloadRulesConfig(value: unknown): PayloadRulesConfig {
  if (!isRecord(value)) return createEmptyPayloadRulesConfig();
  return {
    default: normalizePayloadValueRules(value.default),
    defaultRaw: normalizePayloadValueRules(value.defaultRaw ?? value['default-raw']),
    override: normalizePayloadValueRules(value.override),
    overrideRaw: normalizePayloadValueRules(value.overrideRaw ?? value['override-raw']),
    filter: normalizePayloadFilterRules(value.filter),
    headerOverride: normalizePayloadHeaderRules(value.headerOverride ?? value['header-override']),
    headerFilter: normalizePayloadHeaderFilterRules(value.headerFilter ?? value['header-filter']),
    statusCodeMap: normalizePayloadStatusCodeRules(value.statusCodeMap ?? value['status-code-map']),
  };
}

export function applyPayloadRules(input: {
  rules: PayloadRulesConfig;
  payload: Record<string, unknown>;
  modelName?: string;
  requestedModel?: string;
  protocol?: string;
}): Record<string, unknown> {
  const rules = normalizePayloadRulesConfig(input.rules as unknown);
  const candidates = Array.from(new Set(
    [input.modelName, input.requestedModel]
      .map((value) => asTrimmedString(value))
      .filter((value) => value.length > 0),
  ));
  if (candidates.length <= 0) return input.payload;

  const hasAnyRules = rules.default.length > 0
    || rules.defaultRaw.length > 0
    || rules.override.length > 0
    || rules.overrideRaw.length > 0
    || rules.filter.length > 0
    || rules.headerOverride.length > 0
    || rules.headerFilter.length > 0
    || rules.statusCodeMap.length > 0;
  if (!hasAnyRules) return input.payload;

  const protocol = asTrimmedString(input.protocol).toLowerCase();
  const original = cloneJsonValue(input.payload);
  const output = cloneJsonValue(input.payload);
  const appliedDefaults = new Set<string>();

  for (const rule of rules.default) {
    if (!rulesMatch(rule.models, protocol, candidates)) continue;
    for (const [path, value] of Object.entries(rule.params)) {
      const normalizedPath = asTrimmedString(path);
      if (!normalizedPath || hasPath(original, normalizedPath) || appliedDefaults.has(normalizedPath)) continue;
      setPath(output, normalizedPath, value);
      appliedDefaults.add(normalizedPath);
    }
  }

  for (const rule of rules.defaultRaw) {
    if (!rulesMatch(rule.models, protocol, candidates)) continue;
    for (const [path, value] of Object.entries(rule.params)) {
      const normalizedPath = asTrimmedString(path);
      if (!normalizedPath || hasPath(original, normalizedPath) || appliedDefaults.has(normalizedPath)) continue;
      const parsed = parseRawRuleValue(value);
      if (parsed === undefined) continue;
      setPath(output, normalizedPath, parsed);
      appliedDefaults.add(normalizedPath);
    }
  }

  for (const rule of rules.override) {
    if (!rulesMatch(rule.models, protocol, candidates)) continue;
    for (const [path, value] of Object.entries(rule.params)) {
      const normalizedPath = asTrimmedString(path);
      if (!normalizedPath) continue;
      setPath(output, normalizedPath, value);
    }
  }

  for (const rule of rules.overrideRaw) {
    if (!rulesMatch(rule.models, protocol, candidates)) continue;
    for (const [path, value] of Object.entries(rule.params)) {
      const normalizedPath = asTrimmedString(path);
      if (!normalizedPath) continue;
      const parsed = parseRawRuleValue(value);
      if (parsed === undefined) continue;
      setPath(output, normalizedPath, parsed);
    }
  }

  for (const rule of rules.filter) {
    if (!rulesMatch(rule.models, protocol, candidates)) continue;
    for (const path of rule.params) {
      const normalizedPath = asTrimmedString(path);
      if (!normalizedPath) continue;
      deletePath(output, normalizedPath);
    }
  }

  return output;
}

export function applyPayloadHeaderRules(input: {
  rules: PayloadRulesConfig;
  headers: Record<string, string>;
  modelName?: string;
  requestedModel?: string;
  protocol?: string;
  endpoint?: string;
}): Record<string, string> {
  const rules = normalizePayloadRulesConfig(input.rules as unknown);
  const candidates = Array.from(new Set(
    [input.modelName, input.requestedModel]
      .map((value) => asTrimmedString(value))
      .filter((value) => value.length > 0),
  ));
  if (candidates.length <= 0) return input.headers;

  if (rules.headerOverride.length <= 0 && rules.headerFilter.length <= 0) {
    return input.headers;
  }

  const protocol = asTrimmedString(input.protocol).toLowerCase();
  const endpoint = asTrimmedString(input.endpoint).toLowerCase();
  const output = { ...input.headers };

  for (const rule of rules.headerOverride) {
    if (!rulesMatch(rule.models, protocol, candidates) || !endpointMatches(rule.endpoints, endpoint)) continue;
    for (const [key, value] of Object.entries(rule.headers)) {
      setHeaderCaseInsensitive(output, key, value);
    }
  }

  for (const rule of rules.headerFilter) {
    if (!rulesMatch(rule.models, protocol, candidates) || !endpointMatches(rule.endpoints, endpoint)) continue;
    for (const key of rule.headers) {
      deleteHeaderCaseInsensitive(output, key);
    }
  }

  return output;
}

export function mapPayloadStatusCode(input: {
  rules: PayloadRulesConfig;
  status: number;
  modelName?: string;
  requestedModel?: string;
  protocol?: string;
  endpoint?: string;
}): number {
  const rules = normalizePayloadRulesConfig(input.rules as unknown);
  const currentStatus = Math.trunc(Number(input.status));
  if (!Number.isFinite(currentStatus) || currentStatus < 100 || currentStatus > 599) {
    return input.status;
  }

  const candidates = Array.from(new Set(
    [input.modelName, input.requestedModel]
      .map((value) => asTrimmedString(value))
      .filter((value) => value.length > 0),
  ));
  if (candidates.length <= 0 || rules.statusCodeMap.length <= 0) return currentStatus;

  const protocol = asTrimmedString(input.protocol).toLowerCase();
  const endpoint = asTrimmedString(input.endpoint).toLowerCase();
  for (const rule of input.rules.statusCodeMap) {
    if (!rulesMatch(rule.models, protocol, candidates) || !endpointMatches(rule.endpoints, endpoint)) continue;
    if (rule.from.includes(currentStatus)) {
      return rule.to;
    }
  }

  return currentStatus;
}
