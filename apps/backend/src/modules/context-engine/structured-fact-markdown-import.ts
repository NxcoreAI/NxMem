import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  DataLakeCustomFields,
  FactItem,
  MemoryEvent,
  ParsedSegment,
  SourceRef
} from "./domain.js";
import { normalizeClaim } from "./fact-fusion.js";
import { admitFactsToMemoryPipeline } from "./parse-event.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { createPipelineTask } from "./pipeline-task.js";
import type { PrdMemoryType } from "./memory-types.js";

const expectedColumns = ["序号", "事实发生时间", "记忆类型", "事实记忆", "来源类型"] as const;
const shanghaiTimezone = "Asia/Shanghai";
const shanghaiOffset = "+08:00";
const factSchemaVersion = "fact-item.v1";

export const declaredMemoryTypes = [
  "产品定义",
  "项目决策",
  "项目进展",
  "产品偏好",
  "风险问题",
  "行动项",
  "需求变更",
  "协作关系",
  "用户洞察"
] as const;

export const declaredSourceTypes = [
  "文档",
  "会议",
  "任务",
  "原型评审",
  "用户访谈",
  "邮件",
  "日程",
  "Agent 对话"
] as const;

export type DeclaredMemoryType = typeof declaredMemoryTypes[number];
export type DeclaredSourceType = typeof declaredSourceTypes[number];

export interface StructuredFactMarkdownRecord {
  externalId: string;
  occurredAt: string;
  declaredMemoryType: DeclaredMemoryType;
  factText: string;
  declaredSourceType: DeclaredSourceType;
  sourceLine: number;
}

export interface StructuredFactMarkdownDataset {
  title: string;
  role: string;
  dataPeriod: string;
  timezone: typeof shanghaiTimezone;
  declaredCount: number;
  sourceSha256: string;
  isSynthetic: true;
  records: StructuredFactMarkdownRecord[];
}

export interface StructuredFactImportOptions {
  datasetId: string;
  sourcePath: string;
  tenantId: string;
  principalId: string;
  mode: "dry-run" | "apply";
}

export interface StructuredFactImportVerification {
  events: number;
  segments: number;
  facts: number;
  shortTermMemories: number;
  indexes: number;
  missingIds: string[];
  mismatches: string[];
}

export interface StructuredFactImportReport {
  mode: StructuredFactImportOptions["mode"];
  datasetId: string;
  sourcePath: string;
  sourceSha256: string;
  declaredRecords: number;
  parsedRecords: number;
  plannedEvents: number;
  plannedSegments: number;
  plannedFacts: number;
  appliedRecords: number;
  verification: StructuredFactImportVerification;
  passed: boolean;
}

export class StructuredFactMarkdownValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`structured fact Markdown validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "StructuredFactMarkdownValidationError";
  }
}

export function parseStructuredFactMarkdown(markdown: string): StructuredFactMarkdownDataset {
  const normalized = markdown.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const issues: string[] = [];
  const title = lines.find((line) => /^#\s+/u.test(line))?.replace(/^#\s+/u, "").trim() ?? "";
  const role = readMetadataValue(lines, "角色设定") ?? "";
  const dataPeriod = readMetadataValue(lines, "数据周期") ?? "";
  const timezone = readMetadataValue(lines, "时区")?.split(/[（(]/u)[0]?.trim() ?? "";
  const declaredCountText = readMetadataValue(lines, "条目数量") ?? "";
  const declaredCount = /^\d+$/u.test(declaredCountText) ? Number.parseInt(declaredCountText, 10) : Number.NaN;
  const records: StructuredFactMarkdownRecord[] = [];

  if (!title) issues.push("missing level-one title");
  if (!role) issues.push("missing 角色设定 metadata");
  if (!dataPeriod) issues.push("missing 数据周期 metadata");
  if (timezone !== shanghaiTimezone) {
    issues.push(`时区 must be ${shanghaiTimezone}, received ${timezone || "<empty>"}`);
  }
  if (!Number.isInteger(declaredCount) || declaredCount <= 0) {
    issues.push(`条目数量 must be a positive integer, received ${declaredCountText || "<empty>"}`);
  }
  if (!/全部内容均为虚构/u.test(normalized)) {
    issues.push("document must explicitly declare that all content is synthetic");
  }

  let currentSectionDate: string | undefined;
  let tableCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const dateHeading = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/u.exec(line);
    if (dateHeading?.[1]) currentSectionDate = dateHeading[1];

    const cells = parseMarkdownTableRow(line);
    if (!cells || !sameColumns(cells, expectedColumns)) continue;
    tableCount += 1;

    const separatorLine = lines[index + 1] ?? "";
    const separatorCells = parseMarkdownTableRow(separatorLine);
    if (!separatorCells || separatorCells.length !== expectedColumns.length || !separatorCells.every(isTableSeparator)) {
      issues.push(`line ${index + 2}: invalid Markdown table separator`);
      continue;
    }

    index += 2;
    while (index < lines.length && (lines[index] ?? "").trimStart().startsWith("|")) {
      const sourceLine = index + 1;
      const row = parseMarkdownTableRow(lines[index] ?? "");
      if (!row || row.length !== expectedColumns.length) {
        issues.push(`line ${sourceLine}: expected ${expectedColumns.length} table cells`);
        index += 1;
        continue;
      }

      const parsed = parseRecord(row, sourceLine, currentSectionDate, issues);
      if (parsed) records.push(parsed);
      index += 1;
    }
    index -= 1;
  }

  if (tableCount === 0) issues.push("no supported fact table found");
  if (Number.isInteger(declaredCount) && declaredCount > 0 && records.length !== declaredCount) {
    issues.push(`declared ${declaredCount} records but parsed ${records.length}`);
  }

  const seenIds = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (seenIds.has(record.externalId)) issues.push(`duplicate record id ${record.externalId}`);
    seenIds.add(record.externalId);
    const expectedId = String(index + 1).padStart(3, "0");
    if (record.externalId !== expectedId) {
      issues.push(`record ${index + 1} must have id ${expectedId}, received ${record.externalId}`);
    }
  }

  if (issues.length) throw new StructuredFactMarkdownValidationError(issues);

  return {
    title,
    role,
    dataPeriod,
    timezone: shanghaiTimezone,
    declaredCount,
    sourceSha256: createHash("sha256").update(markdown).digest("hex"),
    isSynthetic: true,
    records
  };
}

export async function importStructuredFactMarkdown(
  repository: ContextEngineRepository | undefined,
  dataset: StructuredFactMarkdownDataset,
  options: StructuredFactImportOptions
): Promise<StructuredFactImportReport> {
  assertImportOptions(options);
  const artifacts = dataset.records.map((record) => buildImportArtifacts(dataset, record, options));

  if (options.mode === "dry-run") {
    return {
      mode: options.mode,
      datasetId: options.datasetId,
      sourcePath: options.sourcePath,
      sourceSha256: dataset.sourceSha256,
      declaredRecords: dataset.declaredCount,
      parsedRecords: dataset.records.length,
      plannedEvents: artifacts.length,
      plannedSegments: artifacts.length,
      plannedFacts: artifacts.length,
      appliedRecords: 0,
      verification: emptyVerification(),
      passed: dataset.declaredCount === dataset.records.length
    };
  }

  if (!repository) throw new Error("repository is required in apply mode");
  assertNoOwnershipConflicts(repository, artifacts, options.datasetId);

  const writeErrors: string[] = [];
  let appliedRecords = 0;
  for (const artifact of artifacts) {
    try {
      await repository.saveMemoryEvent(artifact.event);
      await repository.saveParsedSegment(artifact.segment);
      await repository.saveFactItem(artifact.fact);
      appliedRecords += 1;
    } catch (error) {
      writeErrors.push(`${artifact.fact.factId}.fact_write: ${errorMessage(error)}`);
    }
  }

  for (const artifact of artifacts) {
    try {
      const task = {
        ...createPipelineTask(artifact.event),
        taskType: "fusion" as const,
        status: "running" as const,
        stage: "deterministic_fact_imported"
      };
      await repository.savePipelineTask(task);
      await repository.saveMemoryChangeEvent({
        eventId: `mce_${artifact.fact.factId}_deterministic_import`,
        memoryDataId: artifact.fact.factId,
        changeType: "created",
        storageLayer: "fact",
        reason: "deterministic_structured_fact_import",
        createdAt: new Date().toISOString()
      });
      await admitFactsToMemoryPipeline(repository, artifact.event, [artifact.fact], {
        task,
        fallbackSourceRefs: artifact.fact.linkedSourceRefs,
        disableStmAdmissionLlm: true
      });
    } catch (error) {
      writeErrors.push(`${artifact.fact.factId}.stm_write: ${errorMessage(error)}`);
    }
  }

  const verification = verifyImportedArtifacts(repository, artifacts, options.datasetId);
  verification.mismatches.push(...writeErrors);
  return {
    mode: options.mode,
    datasetId: options.datasetId,
    sourcePath: options.sourcePath,
    sourceSha256: dataset.sourceSha256,
    declaredRecords: dataset.declaredCount,
    parsedRecords: dataset.records.length,
    plannedEvents: artifacts.length,
    plannedSegments: artifacts.length,
    plannedFacts: artifacts.length,
    appliedRecords,
    verification,
    passed: verification.missingIds.length === 0 && verification.mismatches.length === 0
  };
}

export function memoryTypeForDeclaredType(value: DeclaredMemoryType): PrdMemoryType {
  switch (value) {
    case "产品定义":
    case "用户洞察":
      return "knowledge";
    case "项目决策":
    case "项目进展":
    case "需求变更":
    case "风险问题":
      return "project";
    case "产品偏好":
      return "preference";
    case "行动项":
      return "task";
    case "协作关系":
      return "relationship";
  }
}

function parseRecord(
  cells: string[],
  sourceLine: number,
  currentSectionDate: string | undefined,
  issues: string[]
): StructuredFactMarkdownRecord | undefined {
  const [externalId = "", occurredAtText = "", memoryTypeText = "", factText = "", sourceTypeText = ""] = cells;
  let valid = true;

  if (!/^\d{3}$/u.test(externalId)) {
    issues.push(`line ${sourceLine}: 序号 must contain exactly three digits`);
    valid = false;
  }
  const occurredAt = parseShanghaiTimestamp(occurredAtText);
  if (!occurredAt) {
    issues.push(`line ${sourceLine}: invalid 事实发生时间 ${occurredAtText || "<empty>"}`);
    valid = false;
  } else if (currentSectionDate && !occurredAt.startsWith(`${currentSectionDate}T`)) {
    issues.push(`line ${sourceLine}: timestamp does not match section ${currentSectionDate}`);
    valid = false;
  }
  if (!isDeclaredMemoryType(memoryTypeText)) {
    issues.push(`line ${sourceLine}: unsupported 记忆类型 ${memoryTypeText || "<empty>"}`);
    valid = false;
  }
  if (!factText.trim()) {
    issues.push(`line ${sourceLine}: 事实记忆 must not be empty`);
    valid = false;
  }
  if (!isDeclaredSourceType(sourceTypeText)) {
    issues.push(`line ${sourceLine}: unsupported 来源类型 ${sourceTypeText || "<empty>"}`);
    valid = false;
  }

  if (!valid || !occurredAt || !isDeclaredMemoryType(memoryTypeText) || !isDeclaredSourceType(sourceTypeText)) {
    return undefined;
  }
  return {
    externalId,
    occurredAt,
    declaredMemoryType: memoryTypeText,
    factText: factText.trim(),
    declaredSourceType: sourceTypeText,
    sourceLine
  };
}

function buildImportArtifacts(
  dataset: StructuredFactMarkdownDataset,
  record: StructuredFactMarkdownRecord,
  options: StructuredFactImportOptions
) {
  const namespace = sanitizeStableId(options.datasetId);
  const sourceFile = basename(options.sourcePath);
  const eventId = `synthetic_fact_${namespace}_${record.externalId}`;
  const itemId = `item_${record.externalId}`;
  const segmentId = `seg_${eventId}_${itemId}`;
  const factId = `fact_${namespace}_${record.externalId}`;
  const sourceRef: SourceRef = {
    sourceRefId: `src_${namespace}_${record.externalId}`,
    sourceType: "synthetic_markdown_row",
    sourceId: `${options.datasetId}:${record.externalId}`
  };
  const canonicalMemoryType = memoryTypeForDeclaredType(record.declaredMemoryType);
  const customFields: DataLakeCustomFields = {
    datasetId: options.datasetId,
    datasetSha256: dataset.sourceSha256,
    externalFactId: record.externalId,
    declaredMemoryType: record.declaredMemoryType,
    declaredSourceType: record.declaredSourceType,
    canonicalMemoryType,
    sourceFile,
    sourceLine: record.sourceLine,
    timezone: dataset.timezone,
    role: dataset.role,
    dataPeriod: dataset.dataPeriod,
    isSynthetic: true
  };
  const dataSource = {
    sourceApp: "synthetic-markdown-import",
    sourceId: sourceRef.sourceId,
    sourceName: sourceFile,
    sourceType: sourceRef.sourceType,
    syncVersion: dataset.sourceSha256
  };
  const event: MemoryEvent = {
    eventId,
    eventType: `structured_fact_import_${canonicalMemoryType}`,
    eventSummary: record.factText,
    eventTime: record.occurredAt,
    sourceApp: "synthetic-markdown-import",
    sourceId: sourceRef.sourceId,
    dataSource,
    customFields,
    permissionSnapshot: {
      snapshotId: `ps_${namespace}_${record.externalId}`,
      tenantId: options.tenantId,
      principalId: options.principalId,
      sourceAclVersion: `synthetic-dataset:${dataset.sourceSha256}`,
      visibility: "private"
    },
    multimodalData: [{
      itemId,
      type: "text",
      format: "markdown-table-row",
      content: {
        text: record.factText,
        validTimeStart: record.occurredAt,
        ...customFields
      },
      ref: `${sourceFile}#${record.externalId}`,
      sourceRefs: [sourceRef],
      timeBasis: "absolute",
      timeConfidence: "high"
    }]
  };
  const segment: ParsedSegment = {
    segmentId,
    eventId,
    modality: "text",
    content: record.factText,
    status: "parsed",
    confidence: "high",
    dataSource,
    customFields
  };
  const fact: FactItem = {
    factId,
    factType: canonicalMemoryType,
    factText: record.factText,
    normalizedClaim: normalizeClaim(record.factText),
    linkedEventIds: [eventId],
    linkedSegmentIds: [segmentId],
    linkedSourceRefs: [sourceRef],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: record.occurredAt,
    validTimeStart: record.occurredAt,
    timeBasis: "absolute",
    timeConfidence: "high",
    schemaVersion: factSchemaVersion
  };

  return { event, segment, fact };
}

function verifyImportedArtifacts(
  repository: ContextEngineRepository,
  artifacts: Array<ReturnType<typeof buildImportArtifacts>>,
  datasetId: string
): StructuredFactImportVerification {
  const snapshot = repository.getDebugSnapshot();
  const eventById = new Map(snapshot.memoryEvents.map((item) => [item.eventId, item]));
  const segmentById = new Map(snapshot.parsedSegments.map((item) => [item.segmentId, item]));
  const factById = new Map(snapshot.facts.map((item) => [item.factId, item]));
  const stmById = new Map(snapshot.shortTermMemories.map((item) => [item.memoryDataId, item]));
  const indexOwnerIds = new Set(snapshot.indexEntries.filter((item) => item.ownerType === "stm").map((item) => item.ownerId));
  const missingIds: string[] = [];
  const mismatches: string[] = [];
  let events = 0;
  let segments = 0;
  let facts = 0;
  let shortTermMemories = 0;
  let indexes = 0;

  const expectedEventIds = new Set(artifacts.map((artifact) => artifact.event.eventId));
  for (const event of snapshot.memoryEvents) {
    if (event.customFields?.datasetId === datasetId && !expectedEventIds.has(event.eventId)) {
      mismatches.push(`unexpected dataset event ${event.eventId}`);
    }
  }

  for (const artifact of artifacts) {
    const event = eventById.get(artifact.event.eventId);
    const segment = segmentById.get(artifact.segment.segmentId);
    const fact = factById.get(artifact.fact.factId);
    const stmId = `stm_${artifact.fact.factId}`;
    const stm = stmById.get(stmId);

    if (!event) missingIds.push(artifact.event.eventId);
    else {
      events += 1;
      compareField(mismatches, artifact.event.eventId, "eventTime", artifact.event.eventTime, event.eventTime);
      compareField(mismatches, artifact.event.eventId, "datasetId", artifact.event.customFields?.datasetId, event.customFields?.datasetId);
      compareField(
        mismatches,
        artifact.event.eventId,
        "tenantId",
        artifact.event.permissionSnapshot.tenantId,
        event.permissionSnapshot.tenantId
      );
      compareField(
        mismatches,
        artifact.event.eventId,
        "principalId",
        artifact.event.permissionSnapshot.principalId,
        event.permissionSnapshot.principalId
      );
    }
    if (!segment) missingIds.push(artifact.segment.segmentId);
    else {
      segments += 1;
      compareField(mismatches, artifact.segment.segmentId, "content", artifact.segment.content, segment.content);
      compareField(
        mismatches,
        artifact.segment.segmentId,
        "externalFactId",
        artifact.segment.customFields?.externalFactId,
        segment.customFields?.externalFactId
      );
      compareField(
        mismatches,
        artifact.segment.segmentId,
        "declaredMemoryType",
        artifact.segment.customFields?.declaredMemoryType,
        segment.customFields?.declaredMemoryType
      );
      compareField(
        mismatches,
        artifact.segment.segmentId,
        "declaredSourceType",
        artifact.segment.customFields?.declaredSourceType,
        segment.customFields?.declaredSourceType
      );
    }
    if (!fact) missingIds.push(artifact.fact.factId);
    else {
      facts += 1;
      compareField(mismatches, artifact.fact.factId, "factText", artifact.fact.factText, fact.factText);
      compareField(mismatches, artifact.fact.factId, "factType", artifact.fact.factType, fact.factType);
      compareField(mismatches, artifact.fact.factId, "normalizedClaim", artifact.fact.normalizedClaim, fact.normalizedClaim);
      compareField(mismatches, artifact.fact.factId, "validTimeStart", artifact.fact.validTimeStart, fact.validTimeStart);
      compareField(
        mismatches,
        artifact.fact.factId,
        "sourceRefId",
        artifact.fact.linkedSourceRefs[0]?.sourceRefId,
        fact.linkedSourceRefs[0]?.sourceRefId
      );
    }
    if (!stm) missingIds.push(stmId);
    else {
      shortTermMemories += 1;
      if (!stm.sourceFactIds.includes(artifact.fact.factId)) {
        mismatches.push(`${stmId}.sourceFactIds does not include ${artifact.fact.factId}`);
      }
    }
    if (!indexOwnerIds.has(stmId)) missingIds.push(`index:${stmId}`);
    else indexes += 1;
  }

  return { events, segments, facts, shortTermMemories, indexes, missingIds, mismatches };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function assertNoOwnershipConflicts(
  repository: ContextEngineRepository,
  artifacts: Array<ReturnType<typeof buildImportArtifacts>>,
  datasetId: string
) {
  const snapshot = repository.getDebugSnapshot();
  const expectedEventIds = new Set(artifacts.map((item) => item.event.eventId));
  const expectedFactIds = new Set(artifacts.map((item) => item.fact.factId));

  for (const event of snapshot.memoryEvents) {
    if (!expectedEventIds.has(event.eventId)) continue;
    if (event.customFields?.datasetId !== datasetId) {
      throw new Error(`event id conflict: ${event.eventId} is not owned by dataset ${datasetId}`);
    }
  }
  for (const fact of snapshot.facts) {
    if (!expectedFactIds.has(fact.factId)) continue;
    const linkedEventId = fact.linkedEventIds[0];
    const linkedEvent = snapshot.memoryEvents.find((event) => event.eventId === linkedEventId);
    if (linkedEvent?.customFields?.datasetId !== datasetId) {
      throw new Error(`fact id conflict: ${fact.factId} is not owned by dataset ${datasetId}`);
    }
  }
}

function assertImportOptions(options: StructuredFactImportOptions) {
  const issues: string[] = [];
  if (!options.datasetId.trim()) issues.push("datasetId is required");
  if (!options.sourcePath.trim()) issues.push("sourcePath is required");
  if (!options.tenantId.trim()) issues.push("tenantId is required");
  if (!options.principalId.trim()) issues.push("principalId is required");
  if (options.datasetId.trim() && !sanitizeStableId(options.datasetId)) issues.push("datasetId must contain letters or digits");
  if (issues.length) throw new StructuredFactMarkdownValidationError(issues);
}

function emptyVerification(): StructuredFactImportVerification {
  return {
    events: 0,
    segments: 0,
    facts: 0,
    shortTermMemories: 0,
    indexes: 0,
    missingIds: [],
    mismatches: []
  };
}

function compareField(
  mismatches: string[],
  id: string,
  field: string,
  expected: unknown,
  actual: unknown
) {
  if (expected !== actual) mismatches.push(`${id}.${field}: expected ${String(expected)}, received ${String(actual)}`);
}

function readMetadataValue(lines: string[], label: string) {
  const marker = `**${label}：**`;
  const line = lines.find((item) => item.includes(marker));
  if (!line) return undefined;
  return line.slice(line.indexOf(marker) + marker.length).trim();
}

function parseShanghaiTimestamp(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/u.exec(value.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  const candidate = `${year}-${month}-${day}T${hour}:${minute}:00${shanghaiOffset}`;
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) return undefined;
  const roundTrip = new Intl.DateTimeFormat("en-CA", {
    timeZone: shanghaiTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(parsed));
  const expected = `${year}-${month}-${day}, ${hour}:${minute}`;
  return roundTrip === expected ? candidate : undefined;
}

function parseMarkdownTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const character of trimmed.slice(1, -1)) {
    if (escaped) {
      current += character === "|" ? "|" : `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells;
}

function sameColumns(actual: string[], expected: readonly string[]) {
  return actual.length === expected.length && actual.every((cell, index) => cell === expected[index]);
}

function isTableSeparator(value: string) {
  return /^:?-{3,}:?$/u.test(value);
}

function isDeclaredMemoryType(value: string): value is DeclaredMemoryType {
  return (declaredMemoryTypes as readonly string[]).includes(value);
}

function isDeclaredSourceType(value: string): value is DeclaredSourceType {
  return (declaredSourceTypes as readonly string[]).includes(value);
}

function sanitizeStableId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}
