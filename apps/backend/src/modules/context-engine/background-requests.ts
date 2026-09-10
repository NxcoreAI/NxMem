import type {
  BackgroundSectionKey,
  BackgroundStmCursor,
  CreateSessionBackgroundRequest,
  MaintainFixedBackgroundRequest
} from "./domain.js";

export interface BackgroundOwnerScope {
  tenantId: string;
  principalId: string;
}

export function parseCreateSessionBackgroundRequest(
  value: unknown,
  caller?: BackgroundOwnerScope
): CreateSessionBackgroundRequest {
  const input = objectInput(value, "SESSION_BACKGROUND_REQUEST_INVALID");
  const owner = resolveBackgroundOwner(input, caller);
  return {
    ...owner,
    sessionId: requiredString(input.sessionId, "SESSION_BACKGROUND_SESSION_ID_REQUIRED"),
    createdAt: requiredString(input.createdAt, "SESSION_BACKGROUND_CREATED_AT_REQUIRED"),
    ...optionalStringField(input, "referenceTime", "SESSION_BACKGROUND_REFERENCE_TIME_INVALID"),
    ...optionalStringField(input, "timezone", "SESSION_BACKGROUND_TIMEZONE_INVALID"),
    ...optionalStringField(input, "locale", "SESSION_BACKGROUND_LOCALE_INVALID"),
    ...optionalStringField(input, "fixedBackgroundId", "SESSION_BACKGROUND_FIXED_ID_INVALID"),
    ...optionalStringField(input, "dynamicWindowStart", "SESSION_BACKGROUND_WINDOW_START_INVALID"),
    ...optionalStringField(input, "dynamicWindowEnd", "SESSION_BACKGROUND_WINDOW_END_INVALID"),
    ...optionalPositiveIntegerField(input, "tokenBudget", "SESSION_BACKGROUND_TOKEN_BUDGET_INVALID"),
    ...optionalPositiveIntegerField(input, "maxInputTokens", "SESSION_BACKGROUND_MAX_INPUT_TOKENS_INVALID"),
    ...optionalPositiveIntegerField(input, "maxDynamicCandidates", "SESSION_BACKGROUND_MAX_CANDIDATES_INVALID"),
    ...optionalCursorField(input, "latestStmCursor", "SESSION_BACKGROUND_LATEST_CURSOR_INVALID"),
    ...optionalBooleanField(input, "forceRefresh", "SESSION_BACKGROUND_FORCE_REFRESH_INVALID")
  };
}

export function parseMaintainFixedBackgroundRequest(
  value: unknown,
  caller?: BackgroundOwnerScope
): MaintainFixedBackgroundRequest {
  const input = objectInput(value, "BACKGROUND_MAINTENANCE_REQUEST_INVALID");
  const owner = resolveBackgroundOwner(input, caller);
  return {
    ...owner,
    runId: requiredString(input.runId, "BACKGROUND_MAINTENANCE_RUN_ID_REQUIRED"),
    scheduledAt: requiredString(input.scheduledAt, "BACKGROUND_MAINTENANCE_SCHEDULED_AT_REQUIRED"),
    ...optionalStringField(input, "baseBackgroundId", "BACKGROUND_MAINTENANCE_BASE_ID_INVALID"),
    ...optionalNonNegativeIntegerField(input, "expectedFixedRevision", "BACKGROUND_MAINTENANCE_REVISION_INVALID"),
    ...optionalPositiveIntegerField(input, "stmPageSize", "BACKGROUND_MAINTENANCE_PAGE_SIZE_INVALID"),
    ...optionalPositiveIntegerField(input, "maxInputTokens", "BACKGROUND_MAINTENANCE_MAX_INPUT_TOKENS_INVALID"),
    ...optionalSectionLimits(input.sectionLimits),
    ...optionalLlm(input.llm)
  };
}

function resolveBackgroundOwner(
  input: Record<string, unknown>,
  caller?: BackgroundOwnerScope
): BackgroundOwnerScope {
  const tenantId = optionalString(input.tenantId, "BACKGROUND_TENANT_INVALID");
  const principalId = optionalString(input.principalId, "BACKGROUND_PRINCIPAL_INVALID");
  if (Boolean(tenantId) !== Boolean(principalId)) {
    throw new Error("BACKGROUND_OWNER_INCOMPLETE");
  }
  if (caller) {
    const normalizedCaller = {
      tenantId: caller.tenantId.trim(),
      principalId: caller.principalId.trim()
    };
    if (!normalizedCaller.tenantId || !normalizedCaller.principalId) {
      throw new Error("BACKGROUND_CALLER_SCOPE_REQUIRED");
    }
    if (
      (tenantId && tenantId !== normalizedCaller.tenantId) ||
      (principalId && principalId !== normalizedCaller.principalId)
    ) {
      throw new Error("BACKGROUND_OWNER_SCOPE_MISMATCH");
    }
    return normalizedCaller;
  }
  if (!tenantId || !principalId) throw new Error("BACKGROUND_OWNER_REQUIRED");
  return { tenantId, principalId };
}

function objectInput(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function optionalString(value: unknown, code: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function optionalStringField<K extends string>(input: Record<string, unknown>, key: K, code: string) {
  const value = optionalString(input[key], code);
  return value === undefined ? {} : { [key]: value } as Record<K, string>;
}

function optionalPositiveIntegerField<K extends string>(
  input: Record<string, unknown>,
  key: K,
  code: string
) {
  const value = optionalInteger(input[key], code);
  if (value === undefined) return {};
  if (value <= 0) throw new Error(code);
  return { [key]: value } as Record<K, number>;
}

function optionalNonNegativeIntegerField<K extends string>(
  input: Record<string, unknown>,
  key: K,
  code: string
) {
  const value = optionalInteger(input[key], code);
  if (value === undefined) return {};
  if (value < 0) throw new Error(code);
  return { [key]: value } as Record<K, number>;
}

function optionalInteger(value: unknown, code: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(code);
  return value;
}

function optionalBooleanField<K extends string>(input: Record<string, unknown>, key: K, code: string) {
  const value = input[key];
  if (value === undefined) return {};
  if (typeof value !== "boolean") throw new Error(code);
  return { [key]: value } as Record<K, boolean>;
}

function optionalCursorField<K extends string>(input: Record<string, unknown>, key: K, code: string) {
  const value = input[key];
  if (value === undefined) return {};
  const cursor = objectInput(value, code);
  if (
    typeof cursor.updatedAt !== "string" ||
    !isIsoTimestamp(cursor.updatedAt) ||
    typeof cursor.memoryDataId !== "string"
  ) {
    throw new Error(code);
  }
  return {
    [key]: {
      updatedAt: cursor.updatedAt,
      memoryDataId: cursor.memoryDataId
    } satisfies BackgroundStmCursor
  } as Record<K, BackgroundStmCursor>;
}

function optionalSectionLimits(value: unknown): { sectionLimits?: Partial<Record<BackgroundSectionKey, number>> } {
  if (value === undefined) return {};
  const input = objectInput(value, "BACKGROUND_MAINTENANCE_SECTION_LIMITS_INVALID");
  const limits: Partial<Record<BackgroundSectionKey, number>> = {};
  for (const key of ["identity", "relationships", "recentTasks", "aiSoul"] as const) {
    if (input[key] === undefined) continue;
    const parsed = optionalInteger(input[key], "BACKGROUND_MAINTENANCE_SECTION_LIMITS_INVALID");
    if (parsed === undefined || parsed <= 0) throw new Error("BACKGROUND_MAINTENANCE_SECTION_LIMITS_INVALID");
    limits[key] = parsed;
  }
  if (Object.keys(input).some((key) => !["identity", "relationships", "recentTasks", "aiSoul"].includes(key))) {
    throw new Error("BACKGROUND_MAINTENANCE_SECTION_LIMITS_INVALID");
  }
  return { sectionLimits: limits };
}

function optionalLlm(value: unknown): Pick<MaintainFixedBackgroundRequest, "llm"> {
  if (value === undefined) return {};
  const input = objectInput(value, "BACKGROUND_MAINTENANCE_LLM_INVALID");
  const llm: NonNullable<MaintainFixedBackgroundRequest["llm"]> = {};
  for (const key of ["baseUrl", "model", "apiKey"] as const) {
    const parsed = optionalString(input[key], "BACKGROUND_MAINTENANCE_LLM_INVALID");
    if (parsed !== undefined) llm[key] = parsed;
  }
  return { llm };
}

function isIsoTimestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
