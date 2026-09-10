export type CustomFieldValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: CustomFieldValue }
  | CustomFieldValue[];

export interface DataLakeSearchFilters {
  q?: string;
  sourceApp?: string;
  sourceId?: string;
  sourceType?: string;
  sourceName?: string;
  connectorId?: string;
  customFields?: Record<string, CustomFieldValue>;
  customFieldExists?: string[];
}

export type CustomFieldInputParseResult =
  | { ok: true; fields: Record<string, CustomFieldValue> }
  | { ok: false; error: string };

export function parseCustomFieldInput(text: string): CustomFieldInputParseResult {
  if (!text.trim()) return { ok: true, fields: {} };
  const fields = parseCustomFieldFilterText(text);
  if (Object.keys(fields).length) return { ok: true, fields };
  return {
    ok: false,
    error: "自定义字段必须是 JSON 对象，或 key=value 列表。"
  };
}

export function parseCustomFieldFilterText(text: string): Record<string, CustomFieldValue> {
  const jsonFields = parseCustomFieldJson(text);
  if (jsonFields) return jsonFields;

  return Object.fromEntries(
    text
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.indexOf("=");
        if (separatorIndex === -1) return [entry, ""];
        return [entry.slice(0, separatorIndex).trim(), entry.slice(separatorIndex + 1).trim()];
      })
      .filter(([key, value]) => key && value)
  );
}

function parseCustomFieldJson(text: string): Record<string, CustomFieldValue> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([key, value]) => key.trim() && isCustomFieldValue(value))
    ) as Record<string, CustomFieldValue>;
  } catch {
    return undefined;
  }
}

export function buildDataLakeSearchUrl(filters: DataLakeSearchFilters): string {
  const params = new URLSearchParams();
  appendFilter(params, "q", filters.q);
  appendFilter(params, "sourceApp", filters.sourceApp);
  appendFilter(params, "sourceId", filters.sourceId);
  appendFilter(params, "sourceType", filters.sourceType);
  appendFilter(params, "sourceName", filters.sourceName);
  appendFilter(params, "connectorId", filters.connectorId);

  const customParams = [
    ...flattenCustomFieldFilters(filters.customFields ?? {}).map(({ path, value }) => ({ key: `custom.${path}`, value })),
    ...(filters.customFieldExists ?? []).map((path) => ({ key: `custom.${path}.__exists`, value: "true" }))
  ];
  if (filters.customFieldExists?.length) {
    customParams.sort((left, right) => left.key.localeCompare(right.key));
  }
  for (const { key, value } of customParams) {
    appendFilter(params, key, value);
  }

  const query = params.toString();
  return query ? `/context/search-data-lake?${query}` : "/context/search-data-lake";
}

export function parseCustomFieldExistsText(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatCustomFieldBadges(fields: Record<string, CustomFieldValue> | undefined): string[] {
  return Object.entries(fields ?? {}).map(([key, value]) => `${key}=${formatCustomFieldValue(value)}`);
}

function appendFilter(params: URLSearchParams, key: string, value: CustomFieldValue | string | undefined) {
  const normalized = value === undefined ? undefined : formatCustomFieldValue(value).trim();
  if (normalized) params.set(key, normalized);
}

function isCustomFieldValue(value: unknown): value is CustomFieldValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return true;
  if (Array.isArray(value)) return value.every(isCustomFieldValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isCustomFieldValue);
  return false;
}

function flattenCustomFieldFilters(fields: Record<string, CustomFieldValue>, prefix = ""): Array<{ path: string; value: CustomFieldValue }> {
  return Object.entries(fields).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainCustomFieldObject(value)) {
      return flattenCustomFieldFilters(value, path);
    }
    return [{ path, value }];
  });
}

function isPlainCustomFieldObject(value: CustomFieldValue): value is { [key: string]: CustomFieldValue } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function formatCustomFieldValue(value: CustomFieldValue): string {
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}
