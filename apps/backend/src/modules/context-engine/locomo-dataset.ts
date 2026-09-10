import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type LocomoCategory = 1 | 2 | 3 | 4 | 5;

export interface LocomoEvaluationTurn {
  diaId: string;
  speaker: string;
  text: string;
  caption?: string;
  imageUrls?: string[];
}

export interface LocomoEvaluationSession {
  sessionId: string;
  sessionNumber: number;
  eventTime: string;
  turns: LocomoEvaluationTurn[];
}

export interface LocomoEvaluationQuestion {
  questionId: string;
  questionIndex: number;
  question: string;
  referenceAnswer: string;
  category: LocomoCategory;
  goldDiaIds: string[];
  referenceTime: string;
}

export interface LocomoEvaluationConversation {
  conversationId: string;
  sampleIdFallback: boolean;
  tenantId: "locomo";
  principalId: string;
  contextScopeId: string;
  sessions: LocomoEvaluationSession[];
  questions: LocomoEvaluationQuestion[];
  observation?: unknown;
}

export interface LocomoEvaluationDataset {
  path: string;
  sha256: string;
  conversations: LocomoEvaluationConversation[];
  stats: {
    conversations: number;
    sessions: number;
    turns: number;
    questions: number;
    questionsWithoutEvidence: number;
    captions: number;
    categories: Record<LocomoCategory, number>;
  };
}

export class LocomoDatasetError extends Error {}

export async function readLocomoEvaluationDataset(path: string): Promise<LocomoEvaluationDataset> {
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new LocomoDatasetError(`invalid JSON: ${formatError(error)}`);
  }
  return parseLocomoEvaluationDataset(raw, { path, sha256 });
}

export function parseLocomoEvaluationDataset(
  raw: unknown,
  identity: { path?: string; sha256?: string } = {}
): LocomoEvaluationDataset {
  if (!Array.isArray(raw) || raw.length === 0) throw new LocomoDatasetError("dataset must be a non-empty array");
  const sha256 = identity.sha256 ?? createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  const seenConversationIds = new Set<string>();
  const conversations = raw.map((value, index) => parseConversation(value, index, sha256, seenConversationIds));
  const categories: Record<LocomoCategory, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sessions = 0;
  let turns = 0;
  let questions = 0;
  let questionsWithoutEvidence = 0;
  let captions = 0;
  for (const conversation of conversations) {
    sessions += conversation.sessions.length;
    turns += conversation.sessions.reduce((sum, session) => sum + session.turns.length, 0);
    captions += conversation.sessions.reduce(
      (sum, session) => sum + session.turns.filter((turn) => turn.caption).length,
      0
    );
    questions += conversation.questions.length;
    for (const question of conversation.questions) {
      categories[question.category] += 1;
      if (question.goldDiaIds.length === 0) questionsWithoutEvidence += 1;
    }
  }
  return {
    path: identity.path ?? "<memory>",
    sha256,
    conversations,
    stats: { conversations: conversations.length, sessions, turns, questions, questionsWithoutEvidence, captions, categories }
  };
}

function parseConversation(
  value: unknown,
  index: number,
  datasetHash: string,
  seenConversationIds: Set<string>
): LocomoEvaluationConversation {
  const record = object(value, `sample[${index}]`);
  const fallback = record.sample_id === undefined || record.sample_id === null || record.sample_id === "";
  const conversationId = fallback ? `sample-${index + 1}` : scalarString(record.sample_id, `sample[${index}].sample_id`);
  if (seenConversationIds.has(conversationId)) throw new LocomoDatasetError(`duplicate sample_id: ${conversationId}`);
  seenConversationIds.add(conversationId);
  const safeId = stableSafeId(conversationId);
  const conversation = object(record.conversation, `${conversationId}.conversation`);
  const sessions = Object.keys(conversation)
    .flatMap((key) => {
      const match = /^session_(\d+)$/.exec(key);
      return match ? [{ key, number: Number(match[1]) }] : [];
    })
    .sort((a, b) => a.number - b.number)
    .map(({ key, number }) => parseSession(conversation, conversationId, key, number));
  if (sessions.length === 0) throw new LocomoDatasetError(`${conversationId}.conversation has no sessions`);
  const sessionNumbers = new Set<number>();
  const diaIds = new Set<string>();
  for (const session of sessions) {
    if (sessionNumbers.has(session.sessionNumber)) throw new LocomoDatasetError(`${conversationId}: duplicate session number ${session.sessionNumber}`);
    sessionNumbers.add(session.sessionNumber);
    for (const turn of session.turns) {
      if (diaIds.has(turn.diaId)) throw new LocomoDatasetError(`${conversationId}: duplicate dia_id ${turn.diaId}`);
      diaIds.add(turn.diaId);
    }
  }
  if (!Array.isArray(record.qa)) throw new LocomoDatasetError(`${conversationId}.qa must be an array`);
  const referenceTime = sessions.at(-1)!.eventTime;
  const questions = record.qa.map((question, questionIndex) =>
    parseQuestion(question, conversationId, questionIndex, referenceTime)
  );
  return {
    conversationId,
    sampleIdFallback: fallback,
    tenantId: "locomo",
    principalId: `locomo:${safeId}`,
    contextScopeId: `locomo:${datasetHash}:${safeId}`,
    sessions,
    questions,
    ...(record.observation !== undefined ? { observation: record.observation } : {})
  };
}

function parseSession(record: Record<string, unknown>, conversationId: string, key: string, number: number): LocomoEvaluationSession {
  const rawTurns = record[key];
  if (!Array.isArray(rawTurns) || rawTurns.length === 0) throw new LocomoDatasetError(`${conversationId}.${key} must be a non-empty array`);
  const rawDate = requiredString(record[`${key}_date_time`], `${conversationId}.${key}_date_time`);
  const eventTime = parseLocomoDateTime(rawDate);
  if (!eventTime) throw new LocomoDatasetError(`${conversationId}.${key}_date_time is invalid: ${rawDate}`);
  return {
    sessionId: key,
    sessionNumber: number,
    eventTime,
    turns: rawTurns.map((turn, turnIndex) => {
      const item = object(turn, `${conversationId}.${key}[${turnIndex}]`);
      const caption = optionalString(item.blip_caption, `${conversationId}.${key}[${turnIndex}].blip_caption`);
      const imageUrls = optionalStringArray(item.img_url, `${conversationId}.${key}[${turnIndex}].img_url`);
      return {
        diaId: requiredString(item.dia_id, `${conversationId}.${key}[${turnIndex}].dia_id`),
        speaker: requiredString(item.speaker, `${conversationId}.${key}[${turnIndex}].speaker`),
        text: requiredString(item.text, `${conversationId}.${key}[${turnIndex}].text`, true),
        ...(caption ? { caption } : {}),
        ...(imageUrls?.length ? { imageUrls } : {})
      };
    })
  };
}

function parseQuestion(value: unknown, conversationId: string, index: number, referenceTime: string): LocomoEvaluationQuestion {
  const item = object(value, `${conversationId}.qa[${index}]`);
  const category = Number(item.category);
  if (![1, 2, 3, 4, 5].includes(category)) throw new LocomoDatasetError(`${conversationId}.qa[${index}].category must be 1..5`);
  if (!Array.isArray(item.evidence)) throw new LocomoDatasetError(`${conversationId}.qa[${index}].evidence must be an array`);
  const goldDiaIds = [...new Set(item.evidence.flatMap((entry, evidenceIndex) =>
    requiredString(entry, `${conversationId}.qa[${index}].evidence[${evidenceIndex}]`)
      .replace(/[\[\]()]/g, "")
      .split(/[;,]/)
      .map((part) => part.trim())
      .filter(Boolean)
  ))];
  return {
    questionId: `${conversationId}:q${index + 1}`,
    questionIndex: index,
    question: requiredString(item.question, `${conversationId}.qa[${index}].question`),
    referenceAnswer: item.answer === undefined && category === 5
      ? ""
      : scalarString(item.answer, `${conversationId}.qa[${index}].answer`),
    category: category as LocomoCategory,
    goldDiaIds,
    referenceTime
  };
}

export function parseLocomoDateTime(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/i.exec(normalized);
  if (!match) return undefined;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    .indexOf(match[5]!.toLowerCase());
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (month < 0 || hour < 1 || hour > 12 || minute > 59) return undefined;
  if (match[3]!.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (match[3]!.toLowerCase() === "am" && hour === 12) hour = 0;
  const date = new Date(Date.UTC(Number(match[6]), month, Number(match[4]), hour, minute));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== Number(match[4])) return undefined;
  return date.toISOString();
}

function stableSafeId(value: string) {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) throw new LocomoDatasetError("sample_id has no safe identity characters");
  return safe;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocomoDatasetError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new LocomoDatasetError(`${field} must be a${allowEmpty ? "" : " non-empty"} string`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new LocomoDatasetError(`${field} must be a string`);
  return value.trim() || undefined;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry, index) => requiredString(entry, `${field}[${index}]`));
}

function scalarString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  throw new LocomoDatasetError(`${field} must be a string, finite number, or boolean`);
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
