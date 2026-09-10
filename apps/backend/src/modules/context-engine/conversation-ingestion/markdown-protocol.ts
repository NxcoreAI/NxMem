import {
  CONTEXT_CONVERSATION_SCHEMA_VERSION,
  CONVERSATION_INGESTION_ERROR_CODES,
  CONVERSATION_INGESTION_LIMITS,
  CONVERSATION_ROLES,
  type ConversationDocumentFrontMatter,
  type ConversationDocumentMessage,
  type ConversationDocumentSession,
  type ConversationIngestionErrorCode
} from "./domain.js";

const nonEmptyString = { type: "string", minLength: 1 } as const;

export const conversationFrontMatterSchema = {
  $id: "context-conversation-md.v3.front-matter",
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: { const: CONTEXT_CONVERSATION_SCHEMA_VERSION },
    batch_id: nonEmptyString
  },
  required: ["schema_version", "batch_id"]
} as const;

export const conversationMessageSchema = {
  $id: "context-conversation-md.v3.message",
  type: "object",
  additionalProperties: false,
  properties: {
    role: { enum: CONVERSATION_ROLES },
    content: nonEmptyString,
    messageId: nonEmptyString,
    createdAt: { type: "string", format: "date-time" },
    completedAt: { type: "string", format: "date-time" }
  },
  required: ["role", "content"]
} as const;

export const conversationSessionSchema = {
  $id: "context-conversation-md.v3.session",
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: nonEmptyString,
    previousCursor: nonEmptyString,
    cursor: nonEmptyString,
    visibility: { enum: ["team", "tenant", "public"] },
    timezone: nonEmptyString,
    locale: nonEmptyString,
    messages: {
      type: "array",
      minItems: 1,
      items: conversationMessageSchema
    }
  },
  required: ["sessionId", "cursor", "messages"]
} as const;

export const contextConversationMarkdownProtocol = {
  schemaVersion: CONTEXT_CONVERSATION_SCHEMA_VERSION,
  mediaType: "text/markdown; charset=utf-8",
  frontMatter: {
    location: "document_start",
    count: 1,
    schema: conversationFrontMatterSchema
  },
  sessions: {
    fenceLanguage: "context-session",
    minimumCount: 1,
    maximumCount: CONVERSATION_INGESTION_LIMITS.directSessionCount,
    payloadEncoding: "json",
    schema: conversationSessionSchema
  },
  hashing: {
    algorithm: "sha256",
    encoding: "lowercase_hex",
    input: "exact_utf8_document_bytes"
  }
} as const;

export interface ConversationProtocolValidationIssue {
  code: ConversationIngestionErrorCode;
  path: string;
  message: string;
}

export interface ConversationProtocolValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ConversationProtocolValidationIssue[];
}

const FRONT_MATTER_FIELDS = new Set(Object.keys(conversationFrontMatterSchema.properties));
const SESSION_FIELDS = new Set(Object.keys(conversationSessionSchema.properties));
const MESSAGE_FIELDS = new Set(Object.keys(conversationMessageSchema.properties));

export function validateConversationFrontMatter(
  value: unknown
): ConversationProtocolValidationResult<ConversationDocumentFrontMatter> {
  const issues: ConversationProtocolValidationIssue[] = [];
  if (!isRecord(value)) return invalid("INVALID_FRONT_MATTER", "$", "Front Matter must be an object.");
  rejectUnknownFields(value, FRONT_MATTER_FIELDS, "INVALID_FRONT_MATTER", issues);
  if (typeof value.schema_version !== "string" || !value.schema_version) {
    issues.push(issue("INVALID_FRONT_MATTER", "$.schema_version", "schema_version is required."));
  } else if (value.schema_version !== CONTEXT_CONVERSATION_SCHEMA_VERSION) {
    issues.push(issue(
      "UNSUPPORTED_SCHEMA_VERSION",
      "$.schema_version",
      `Unsupported schema_version: ${value.schema_version}.`
    ));
  }
  requireNonEmptyString(value, "batch_id", "INVALID_FRONT_MATTER", issues);
  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: value as unknown as ConversationDocumentFrontMatter, issues: [] };
}

export function validateConversationMessage(
  value: unknown,
  sessionIndex = 0,
  messageIndex = 0
): ConversationProtocolValidationResult<ConversationDocumentMessage> {
  const issues: ConversationProtocolValidationIssue[] = [];
  const path = `$.sessions[${sessionIndex}].messages[${messageIndex}]`;
  if (!isRecord(value)) return invalid("INVALID_MESSAGE_BLOCK", path, "Message must be a JSON object.");
  rejectUnknownFields(value, MESSAGE_FIELDS, "INVALID_MESSAGE_BLOCK", issues, path);
  requireEnum(value, "role", CONVERSATION_ROLES, "INVALID_MESSAGE_BLOCK", issues, path);
  requireNonEmptyString(value, "content", "INVALID_MESSAGE_BLOCK", issues, path);
  optionalNonEmptyString(value, "messageId", "INVALID_MESSAGE_BLOCK", issues, path);
  optionalNonEmptyString(value, "createdAt", "INVALID_MESSAGE_BLOCK", issues, path);
  optionalNonEmptyString(value, "completedAt", "INVALID_MESSAGE_BLOCK", issues, path);
  validateMessageTemporalFields(value, issues, path);
  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: value as unknown as ConversationDocumentMessage, issues: [] };
}

export function validateConversationSession(
  value: unknown,
  sessionIndex = 0
): ConversationProtocolValidationResult<ConversationDocumentSession> {
  const issues: ConversationProtocolValidationIssue[] = [];
  const path = `$.sessions[${sessionIndex}]`;
  if (!isRecord(value)) return invalid("INVALID_SESSION_BLOCK", path, "Session block must be a JSON object.");
  rejectUnknownFields(value, SESSION_FIELDS, "INVALID_SESSION_BLOCK", issues, path);
  requireNonEmptyString(value, "sessionId", "INVALID_SESSION_BLOCK", issues, path);
  optionalNonEmptyString(value, "previousCursor", "INVALID_SESSION_BLOCK", issues, path);
  requireNonEmptyString(value, "cursor", "INVALID_SESSION_BLOCK", issues, path);
  optionalEnum(value, "visibility", ["team", "tenant", "public"], "INVALID_SESSION_BLOCK", issues, path);
  optionalNonEmptyString(value, "timezone", "INVALID_SESSION_BLOCK", issues, path);
  optionalNonEmptyString(value, "locale", "INVALID_SESSION_BLOCK", issues, path);
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    issues.push(issue("INVALID_MESSAGE_BLOCK", `${path}.messages`, "messages must contain at least one message."));
  } else {
    value.messages.forEach((message, messageIndex) => {
      issues.push(...validateConversationMessage(message, sessionIndex, messageIndex).issues);
    });
    validateSessionTemporalFields(value, issues, path);
  }
  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: value as unknown as ConversationDocumentSession, issues: [] };
}

export function parseConversationSessionJson(
  json: string,
  sessionIndex = 0
): ConversationProtocolValidationResult<ConversationDocumentSession> {
  try {
    return validateConversationSession(JSON.parse(json), sessionIndex);
  } catch (caught) {
    return invalid(
      "INVALID_SESSION_BLOCK",
      `$.sessions[${sessionIndex}]`,
      caught instanceof Error ? `Session block is not valid JSON: ${caught.message}` : "Session block is not valid JSON."
    );
  }
}

export function validateConversationBatch(
  frontMatter: unknown,
  sessions: readonly unknown[]
): ConversationProtocolValidationResult<{
  frontMatter: ConversationDocumentFrontMatter;
  sessions: ConversationDocumentSession[];
}> {
  const frontMatterResult = validateConversationFrontMatter(frontMatter);
  const sessionResults = sessions.map((session, index) => validateConversationSession(session, index));
  const issues = [
    ...frontMatterResult.issues,
    ...sessionResults.flatMap((result) => result.issues)
  ];
  if (sessions.length === 0) {
    issues.push(issue("INVALID_SESSION_BLOCK", "$.sessions", "At least one Session is required."));
  }
  if (!frontMatterResult.value || sessionResults.some((result) => !result.value)) return { ok: false, issues };

  const parsedSessions = sessionResults.map((result) => result.value as ConversationDocumentSession);
  if (parsedSessions.length > CONVERSATION_INGESTION_LIMITS.directSessionCount) {
    issues.push(issue(
      "DOCUMENT_TOO_LARGE",
      "$.sessions",
      `A document accepts at most ${CONVERSATION_INGESTION_LIMITS.directSessionCount} sessions.`
    ));
  }
  const totalMessages = parsedSessions.reduce((sum, session) => sum + session.messages.length, 0);
  if (totalMessages > CONVERSATION_INGESTION_LIMITS.directMessageCount) {
    issues.push(issue(
      "DOCUMENT_TOO_LARGE",
      "$.sessions",
      `A document accepts at most ${CONVERSATION_INGESTION_LIMITS.directMessageCount} messages in total.`
    ));
  }
  const seenSessionIds = new Set<string>();
  parsedSessions.forEach((session, index) => {
    if (seenSessionIds.has(session.sessionId)) {
      issues.push(issue(
        "INVALID_SESSION_BLOCK",
        `$.sessions[${index}].sessionId`,
        `Duplicate sessionId: ${session.sessionId}.`
      ));
    }
    seenSessionIds.add(session.sessionId);
  });
  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: { frontMatter: frontMatterResult.value, sessions: parsedSessions }, issues: [] };
}

export function validateConversationCursor(
  previousCursor: string | undefined,
  committedServerCursor: string | undefined
): ConversationProtocolValidationIssue[] {
  if (previousCursor === committedServerCursor) return [];
  return [issue(
    "CURSOR_MISMATCH",
    "$.previousCursor",
    `previousCursor does not match the committed server cursor ${committedServerCursor ?? "<none>"}.`
  )];
}

export function validateDirectConversationDocumentSize(document: string): ConversationProtocolValidationIssue[] {
  const byteSize = Buffer.byteLength(document, "utf8");
  if (byteSize <= CONVERSATION_INGESTION_LIMITS.directDocumentBytes) return [];
  return [issue(
    "DOCUMENT_TOO_LARGE",
    "$.document",
    `Document is ${byteSize} bytes; the limit is ${CONVERSATION_INGESTION_LIMITS.directDocumentBytes} bytes.`
  )];
}

function invalid(code: ConversationIngestionErrorCode, path: string, message: string): ConversationProtocolValidationResult<never> {
  return { ok: false, issues: [issue(code, path, message)] };
}

function issue(code: ConversationIngestionErrorCode, path: string, message: string) {
  if (!CONVERSATION_INGESTION_ERROR_CODES.includes(code)) throw new Error(`Unknown ingestion error code: ${code}`);
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: ConversationIngestionErrorCode,
  issues: ConversationProtocolValidationIssue[],
  path = "$"
) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) issues.push(issue(code, `${path}.${field}`, `Unknown field: ${field}.`));
  }
}

function requireNonEmptyString(
  value: Record<string, unknown>,
  field: string,
  code: ConversationIngestionErrorCode,
  issues: ConversationProtocolValidationIssue[],
  path = "$"
) {
  if (typeof value[field] !== "string" || !(value[field] as string).trim()) {
    issues.push(issue(code, `${path}.${field}`, `${field} must be a non-empty string.`));
  }
}

function optionalNonEmptyString(
  value: Record<string, unknown>,
  field: string,
  code: ConversationIngestionErrorCode,
  issues: ConversationProtocolValidationIssue[],
  path = "$"
) {
  if (field in value && (typeof value[field] !== "string" || !(value[field] as string).trim())) {
    issues.push(issue(code, `${path}.${field}`, `${field} must be a non-empty string when provided.`));
  }
}

function requireEnum(
  value: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  code: ConversationIngestionErrorCode,
  issues: ConversationProtocolValidationIssue[],
  path = "$"
) {
  if (typeof value[field] !== "string" || !allowed.includes(value[field] as string)) {
    issues.push(issue(code, `${path}.${field}`, `${field} must be one of: ${allowed.join(", ")}.`));
  }
}

function optionalEnum(
  value: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  code: ConversationIngestionErrorCode,
  issues: ConversationProtocolValidationIssue[],
  path = "$"
) {
  if (field in value && (typeof value[field] !== "string" || !allowed.includes(value[field] as string))) {
    issues.push(issue(code, `${path}.${field}`, `${field} must be one of: ${allowed.join(", ")}.`));
  }
}

function validateMessageTemporalFields(
  value: Record<string, unknown>,
  issues: ConversationProtocolValidationIssue[],
  path: string
) {
  const hasMessageId = "messageId" in value;
  const hasCreatedAt = "createdAt" in value;
  const hasCompletedAt = "completedAt" in value;
  const hasTemporalFields = hasMessageId || hasCreatedAt || hasCompletedAt;
  if (!hasTemporalFields) return;

  if (hasMessageId !== hasCreatedAt) {
    issues.push(issue(
      "INVALID_MESSAGE_BLOCK",
      `${path}.${hasMessageId ? "createdAt" : "messageId"}`,
      "messageId and createdAt must be provided together."
    ));
  }
  if (hasCompletedAt && (!hasMessageId || !hasCreatedAt)) {
    issues.push(issue(
      "INVALID_MESSAGE_BLOCK",
      `${path}.completedAt`,
      "completedAt requires messageId and createdAt."
    ));
  }
  if (typeof value.createdAt === "string" && !isRfc3339Timestamp(value.createdAt)) {
    issues.push(issue(
      "INVALID_MESSAGE_BLOCK",
      `${path}.createdAt`,
      "createdAt must be an RFC3339 timestamp with Z or a UTC offset."
    ));
  }
  if (typeof value.completedAt === "string" && !isRfc3339Timestamp(value.completedAt)) {
    issues.push(issue(
      "INVALID_MESSAGE_BLOCK",
      `${path}.completedAt`,
      "completedAt must be an RFC3339 timestamp with Z or a UTC offset."
    ));
  }
  if (
    typeof value.createdAt === "string" &&
    typeof value.completedAt === "string" &&
    isRfc3339Timestamp(value.createdAt) &&
    isRfc3339Timestamp(value.completedAt) &&
    Date.parse(value.completedAt) < Date.parse(value.createdAt)
  ) {
    issues.push(issue(
      "INVALID_MESSAGE_BLOCK",
      `${path}.completedAt`,
      "completedAt must be greater than or equal to createdAt."
    ));
  }
}

function validateSessionTemporalFields(
  value: Record<string, unknown>,
  issues: ConversationProtocolValidationIssue[],
  path: string
) {
  if (!Array.isArray(value.messages) || value.messages.length === 0) return;
  const messages = value.messages.filter(isRecord);
  const temporalModes = messages.map((message) => hasMessageTemporalFields(message));
  const hasExtendedMessages = temporalModes.some(Boolean);
  const hasLegacyMessages = temporalModes.some((extended) => !extended);
  const hasTimezone = "timezone" in value;
  const hasLocale = "locale" in value;

  if (hasExtendedMessages && hasLegacyMessages) {
    issues.push(issue(
      "INVALID_SESSION_BLOCK",
      `${path}.messages`,
      "A Session must not mix legacy and extended message formats."
    ));
  }
  if (hasExtendedMessages && !hasTimezone) {
    issues.push(issue(
      "INVALID_SESSION_BLOCK",
      `${path}.timezone`,
      "timezone is required for an extended Session."
    ));
  }
  if (hasExtendedMessages && !hasLocale) {
    issues.push(issue(
      "INVALID_SESSION_BLOCK",
      `${path}.locale`,
      "locale is required for an extended Session."
    ));
  }
  if ((hasTimezone || hasLocale) && !hasExtendedMessages) {
    issues.push(issue(
      "INVALID_SESSION_BLOCK",
      `${path}.${hasTimezone ? "timezone" : "locale"}`,
      "timezone and locale are only valid for an extended Session."
    ));
  }
  if (typeof value.timezone === "string" && !isValidIanaTimezone(value.timezone)) {
    issues.push(issue(
      "INVALID_SESSION_BLOCK",
      `${path}.timezone`,
      "timezone must be a valid IANA timezone."
    ));
  }
  if (typeof value.locale === "string" && !isValidLocale(value.locale)) {
    issues.push(issue(
      "INVALID_SESSION_BLOCK",
      `${path}.locale`,
      "locale must be a valid BCP 47 locale."
    ));
  }

  const seenMessageIds = new Set<string>();
  let previousCreatedAt: number | undefined;
  messages.forEach((message, messageIndex) => {
    const messagePath = `${path}.messages[${messageIndex}]`;
    if (typeof message.messageId === "string") {
      if (seenMessageIds.has(message.messageId)) {
        issues.push(issue(
          "INVALID_SESSION_BLOCK",
          `${messagePath}.messageId`,
          `Duplicate messageId: ${message.messageId}.`
        ));
      }
      seenMessageIds.add(message.messageId);
    }
    if (typeof message.createdAt !== "string" || !isRfc3339Timestamp(message.createdAt)) return;
    const createdAt = Date.parse(message.createdAt);
    if (previousCreatedAt !== undefined && createdAt < previousCreatedAt) {
      issues.push(issue(
        "INVALID_SESSION_BLOCK",
        `${messagePath}.createdAt`,
        "Messages must be ordered by non-decreasing createdAt."
      ));
    }
    previousCreatedAt = createdAt;
  });
}

function hasMessageTemporalFields(value: Record<string, unknown>) {
  return "messageId" in value || "createdAt" in value || "completedAt" in value;
}

function isRfc3339Timestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const offset = value.endsWith("Z") ? undefined : value.slice(-6);
  if (!offset) return true;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  return hours <= 23 && minutes <= 59;
}

function isValidIanaTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isValidLocale(value: string) {
  try {
    return Boolean(new Intl.Locale(value).baseName);
  } catch {
    return false;
  }
}
