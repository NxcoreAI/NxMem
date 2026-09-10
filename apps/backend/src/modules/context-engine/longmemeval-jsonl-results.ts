import { resolve } from "node:path";
import { readJsonlRecords } from "./longmemeval-artifacts.js";

export interface LongMemEvalJsonlResultItem {
  lineNumber: number;
  sampleIndex?: number;
  runId?: string;
  modelRunId?: string;
  status?: string;
  completedAt?: string;
  datasetPath?: string;
  questionId: string;
  questionType: string;
  question: string;
  answer: string;
  hypothesis: string;
  correct?: boolean;
  exactMatch?: boolean;
  score?: number;
  reason?: string;
  errorReason?: string;
  answerFallbackUsed?: boolean;
  answerFallbackReason?: string;
  selectedItemCount: number;
  selectedItemIds: string[];
  selectedItems: Array<{
    id: string;
    layer: string;
    score?: number;
    sourceIds: string[];
    sourceSessionIds: string[];
    sourceRoles: string[];
    factIds: string[];
    memoryIds: string[];
    relationTypes: string[];
    evidenceTime?: string;
    validTime?: string;
  }>;
  droppedReasons: Record<string, number>;
  answerContextMode?: string;
  tokenBudget?: { requested?: number; used?: number };
  failureClassification?: { stage: string; basis?: string; detail?: string };
}

export interface LongMemEvalJsonlModelGroup {
  modelRunId: string;
  totalItems: number;
  judgedItems: number;
  correctItems: number;
  accuracy?: number;
}

export interface LongMemEvalJsonlResultSummary {
  filePath: string;
  datasetPath?: string;
  totalItems: number;
  judgedItems: number;
  correctItems: number;
  incorrectItems: number;
  accuracy?: number;
  exactMatchItems: number;
  exactMatchAccuracy?: number;
  answerFallbacks: number;
  ignoredIncompleteTail: boolean;
  modelGroups: Record<string, LongMemEvalJsonlModelGroup>;
  questionTypeAccuracy: Record<string, {
    total: number;
    judged: number;
    correct: number;
    accuracy?: number;
  }>;
  errorReasons: Record<string, number>;
  selection: {
    rowsWithSelection: number;
    totalSelectedItems: number;
    droppedReasons: Record<string, number>;
  };
}

export interface LongMemEvalJsonlResultPage {
  summary: LongMemEvalJsonlResultSummary;
  page: number;
  pageSize: number;
  totalPages: number;
  items: LongMemEvalJsonlResultItem[];
}

export async function readLongMemEvalJsonlResultPage(input: {
  filePath: string;
  page: number;
  pageSize: number;
  modelRunId?: string;
}): Promise<LongMemEvalJsonlResultPage> {
  const filePath = resolve(input.filePath);
  const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize || 20)));
  const requestedPage = Math.max(1, Math.floor(input.page || 1));
  const summary = createEmptySummary(filePath);
  const scanned = await readJsonlRecords(filePath, { missingAsEmpty: false });
  summary.ignoredIncompleteTail = scanned.ignoredIncompleteTail;
  const latestItems = new Map<string, LongMemEvalJsonlResultItem>();
  const legacyItems: LongMemEvalJsonlResultItem[] = [];
  for (const record of scanned.records) {
    const item = normalizeLongMemEvalJsonlResult(record.value, record.lineNumber);
    const identityKey = readResultIdentityKey(record.value, item);
    if (identityKey) latestItems.set(identityKey, item);
    else legacyItems.push(item);
  }
  const allItems = [...legacyItems, ...latestItems.values()]
    .filter((item) => !input.modelRunId || (item.modelRunId ?? "default") === input.modelRunId)
    .sort(compareLongMemEvalItems);
  for (const item of allItems) {
    addJsonlResultToSummary(summary, item);
  }

  const totalPages = Math.max(1, Math.ceil(summary.totalItems / pageSize));
  const normalizedPage = Math.min(requestedPage, totalPages);
  if (normalizedPage !== requestedPage) {
    const start = (normalizedPage - 1) * pageSize;
    return { summary, page: normalizedPage, pageSize, totalPages, items: allItems.slice(start, start + pageSize) };
  }
  const start = (normalizedPage - 1) * pageSize;

  return {
    summary,
    page: normalizedPage,
    pageSize,
    totalPages,
    items: allItems.slice(start, start + pageSize)
  };
}

function normalizeLongMemEvalJsonlResult(record: Record<string, unknown>, lineNumber: number): LongMemEvalJsonlResultItem {
  const judgment = readRecord(record.judgment);
  const answerContext = readRecord(record.answerContext) ?? readRecord(record.selection);
  const droppedReasons = mergeReasonCounts(readReasonCounts(answerContext?.droppedSummary), readDroppedReasons(answerContext?.dropped));
  const selectedItemIds = readSelectedItemIds(record, answerContext);
  const selectedItems = readSelectedItems(record, answerContext, selectedItemIds);
  const correct = readCorrect(record, judgment);
  const exactMatch = readBoolean(record.exactMatch);
  const score = readNumber(judgment?.score ?? record.score);
  const reason = readString(judgment?.reason) ?? readString(record.reason) ?? readString(record.errorReason) ?? readString(record.failureReason);
  const answerFallbackReason = readString(record.answerFallbackReason);
  const answerFallbackUsed = readBoolean(record.answerFallbackUsed) ?? Boolean(record.answerFallbackReason);
  const errorReason = correct === false
    ? reason ?? answerFallbackReason ?? "incorrect"
    : answerFallbackUsed
      ? answerFallbackReason ?? "answer_fallback"
      : undefined;
  const answerContextMode = readString(record.answerContextMode ?? answerContext?.mode);
  const datasetPath = readString(record.datasetPath);
  const sampleIdentity = readRecord(record.sampleIdentity);
  const sampleIndex = readInteger(record.sampleIndex ?? sampleIdentity?.index);
  const runId = readString(record.runId);
  const modelRunId = readString(record.modelRunId) ?? "default";
  const status = readString(record.status) ?? (record.skipped === true ? "skipped" : "success");
  const completedAt = readString(record.completedAt);
  const tokenBudget = readRecord(answerContext?.tokenBudget);
  const evidenceTrace = readRecord(answerContext?.evidenceTrace);
  const failureClassification = readRecord(evidenceTrace?.failureClassification);
  const tokenBudgetRequested = readNumber(tokenBudget?.requested);
  const tokenBudgetUsed = readNumber(tokenBudget?.used);
  const failureStage = readString(failureClassification?.stage);
  const failureBasis = readString(failureClassification?.basis);
  const failureDetail = readString(failureClassification?.detail);

  return {
    lineNumber,
    ...(sampleIndex !== undefined ? { sampleIndex } : {}),
    ...(runId ? { runId } : {}),
    ...(modelRunId ? { modelRunId } : {}),
    ...(status ? { status } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(datasetPath ? { datasetPath } : {}),
    questionId: readString(record.questionId) ?? readString(record.question_id) ?? readString(record.id) ?? `line-${lineNumber}`,
    questionType: readString(record.questionType) ?? readString(record.question_type) ?? readString(record.type) ?? "unknown",
    question: readString(record.question) ?? readString(record.query) ?? "",
    answer: stringifyAnswer(record.answer ?? record.groundTruth ?? record.ground_truth),
    hypothesis: readString(record.hypothesis) ?? readString(record.prediction) ?? readString(record.response) ?? readString(record.modelResponse) ?? "",
    ...(typeof correct === "boolean" ? { correct } : {}),
    ...(typeof exactMatch === "boolean" ? { exactMatch } : {}),
    ...(typeof score === "number" ? { score } : {}),
    ...(reason ? { reason } : {}),
    ...(errorReason ? { errorReason } : {}),
    ...(answerFallbackUsed ? { answerFallbackUsed } : {}),
    ...(answerFallbackReason ? { answerFallbackReason } : {}),
    selectedItemCount: selectedItemIds.length,
    selectedItemIds,
    selectedItems,
    droppedReasons,
    ...(answerContextMode ? { answerContextMode } : {}),
    ...(tokenBudgetRequested !== undefined || tokenBudgetUsed !== undefined ? {
      tokenBudget: {
        ...(tokenBudgetRequested !== undefined ? { requested: tokenBudgetRequested } : {}),
        ...(tokenBudgetUsed !== undefined ? { used: tokenBudgetUsed } : {})
      }
    } : {}),
    ...(failureStage ? {
      failureClassification: {
        stage: failureStage,
        ...(failureBasis ? { basis: failureBasis } : {}),
        ...(failureDetail ? { detail: failureDetail } : {})
      }
    } : {})
  };
}

function createEmptySummary(filePath: string): LongMemEvalJsonlResultSummary {
  return {
    filePath,
    totalItems: 0,
    judgedItems: 0,
    correctItems: 0,
    incorrectItems: 0,
    exactMatchItems: 0,
    answerFallbacks: 0,
    ignoredIncompleteTail: false,
    modelGroups: {},
    questionTypeAccuracy: {},
    errorReasons: {},
    selection: {
      rowsWithSelection: 0,
      totalSelectedItems: 0,
      droppedReasons: {}
    }
  };
}

function addJsonlResultToSummary(summary: LongMemEvalJsonlResultSummary, item: LongMemEvalJsonlResultItem) {
  if (!summary.datasetPath && item.datasetPath) summary.datasetPath = item.datasetPath;
  summary.totalItems += 1;
  const modelRunId = item.modelRunId ?? "default";
  const modelGroup = summary.modelGroups[modelRunId] ??= {
    modelRunId,
    totalItems: 0,
    judgedItems: 0,
    correctItems: 0
  };
  modelGroup.totalItems += 1;
  const typeSummary = summary.questionTypeAccuracy[item.questionType] ??= { total: 0, judged: 0, correct: 0 };
  typeSummary.total += 1;
  if (typeof item.correct === "boolean") {
    summary.judgedItems += 1;
    modelGroup.judgedItems += 1;
    typeSummary.judged += 1;
    if (item.correct) {
      summary.correctItems += 1;
      modelGroup.correctItems += 1;
      typeSummary.correct += 1;
    } else {
      summary.incorrectItems += 1;
      increment(summary.errorReasons, item.errorReason ?? item.reason ?? "incorrect");
    }
  }
  if (item.exactMatch) summary.exactMatchItems += 1;
  if (item.answerFallbackUsed) summary.answerFallbacks += 1;
  if (item.selectedItemCount > 0) {
    summary.selection.rowsWithSelection += 1;
    summary.selection.totalSelectedItems += item.selectedItemCount;
  }
  for (const [reason, count] of Object.entries(item.droppedReasons)) {
    increment(summary.selection.droppedReasons, reason, count);
  }
  if (summary.judgedItems > 0) {
    summary.accuracy = summary.correctItems / summary.judgedItems;
  }
  if (summary.totalItems > 0) {
    summary.exactMatchAccuracy = summary.exactMatchItems / summary.totalItems;
  }
  if (typeSummary.judged > 0) {
    typeSummary.accuracy = typeSummary.correct / typeSummary.judged;
  }
  if (modelGroup.judgedItems > 0) {
    modelGroup.accuracy = modelGroup.correctItems / modelGroup.judgedItems;
  }
}

function readResultIdentityKey(record: Record<string, unknown>, item: LongMemEvalJsonlResultItem) {
  const sampleIdentity = readRecord(record.sampleIdentity);
  const questionId = readString(sampleIdentity?.questionId) ?? item.questionId;
  if (item.sampleIndex === undefined || !questionId || !readString(record.runId)) return undefined;
  return `${item.modelRunId ?? "default"}\u0000${item.sampleIndex}\u0000${questionId}`;
}

function compareLongMemEvalItems(left: LongMemEvalJsonlResultItem, right: LongMemEvalJsonlResultItem) {
  const model = (left.modelRunId ?? "default").localeCompare(right.modelRunId ?? "default");
  if (model !== 0) return model;
  const leftIndex = left.sampleIndex ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = right.sampleIndex ?? Number.MAX_SAFE_INTEGER;
  return leftIndex - rightIndex || left.lineNumber - right.lineNumber;
}

function readCorrect(record: Record<string, unknown>, judgment?: Record<string, unknown>) {
  const explicit = readBoolean(record.correct ?? record.isCorrect ?? record.is_correct);
  if (typeof explicit === "boolean") return explicit;
  const label = readString(judgment?.label ?? record.label)?.toLowerCase();
  if (label === "correct" || label === "yes" || label === "true") return true;
  if (label === "incorrect" || label === "no" || label === "false") return false;
  const score = readNumber(judgment?.score ?? record.score);
  if (typeof score === "number") return score > 0;
  return undefined;
}

function readSelectedItemIds(record: Record<string, unknown>, answerContext?: Record<string, unknown>) {
  const selected = toStringArray(answerContext?.selectedItemIds ?? record.selectedItemIds);
  if (selected.length) return selected;
  return toObjectArray(answerContext?.selectedItems ?? record.selectedItems)
    .map((item) => readString(item.id))
    .filter((item): item is string => Boolean(item));
}

function readSelectedItems(
  record: Record<string, unknown>,
  answerContext: Record<string, unknown> | undefined,
  selectedItemIds: string[]
) {
  const normalized = toObjectArray(answerContext?.selectedItems ?? record.selectedItems).flatMap((item) => {
    const id = readString(item.id);
    if (!id) return [];
    const temporal = readRecord(item.temporal);
    const score = readNumber(item.score);
    const evidenceTime = readString(temporal?.evidenceTime);
    const validTime = readString(temporal?.validTime);
    return [{
      id,
      layer: readString(item.layer) ?? inferSelectedItemLayer(id),
      ...(score !== undefined ? { score } : {}),
      sourceIds: toStringArray(item.sourceIds),
      sourceSessionIds: toStringArray(item.sourceSessionIds),
      sourceRoles: toStringArray(item.sourceRoles),
      factIds: toStringArray(item.factIds),
      memoryIds: toStringArray(item.memoryIds),
      relationTypes: toStringArray(item.relationTypes),
      ...(evidenceTime ? { evidenceTime } : {}),
      ...(validTime ? { validTime } : {})
    }];
  });
  const byId = new Map(normalized.map((item) => [item.id, item] as const));
  return selectedItemIds.map((id) => byId.get(id) ?? {
    id,
    layer: inferSelectedItemLayer(id),
    sourceIds: [],
    sourceSessionIds: [],
    sourceRoles: [],
    factIds: [],
    memoryIds: [],
    relationTypes: []
  });
}

function inferSelectedItemLayer(id: string) {
  if (id.startsWith("stm_")) return "stm";
  if (id.startsWith("ltm_")) return "ltm";
  if (id.startsWith("fact_")) return "fact";
  return "unknown";
}

function readDroppedReasons(value: unknown) {
  const result: Record<string, number> = {};
  for (const item of toObjectArray(value)) {
    const reason = readString(item.reason) ?? "unknown";
    increment(result, reason);
  }
  return result;
}

function readReasonCounts(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    const numericCount = readNumber(count);
    if (typeof numericCount === "number") result[key] = numericCount;
  }
  return result;
}

function mergeReasonCounts(...items: Array<Record<string, number>>) {
  const result: Record<string, number> = {};
  for (const item of items) {
    for (const [key, count] of Object.entries(item)) {
      increment(result, key, count);
    }
  }
  return result;
}

function increment(target: Record<string, number>, key: string, count = 1) {
  target[key] = (target[key] ?? 0) + count;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => readString(item)).filter((item): item is string => Boolean(item)) : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "correct", "1"].includes(normalized)) return true;
    if (["false", "no", "incorrect", "0"].includes(normalized)) return false;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  const number = readNumber(value);
  return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
}

function stringifyAnswer(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}
