import type {
  DataLakeCustomFieldValue,
  DataLakeCustomFields,
  DataLakeSourceDescriptor,
  FactItem,
  LongTermMemory,
  MemoryEvent,
  ParsedSegment,
  ShortTermMemory,
  SourceRef
} from "./domain.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import {
  customFieldsFromMultimodalContent,
  mergeDataLakeFields,
  multimodalContentToText,
  primarySourceRefForEvent,
  sourceRefsFromEvent
} from "./memory-event-fields.js";
import { conversationIngestionToolContracts } from "./conversation-ingestion/tool-descriptors.js";

export type ContextInventoryKind = "event" | "segment" | "fact" | "stm" | "ltm";

export interface ContextInventorySearchRequest {
  q?: string;
  kinds?: ContextInventoryKind[];
  rawEventsOnly?: boolean;
  source?: Partial<Pick<DataLakeSourceDescriptor, "sourceApp" | "sourceId" | "sourceName" | "sourceType" | "connectorId">>;
  customFields?: Record<string, DataLakeCustomFieldValue>;
  limit?: number;
  offset?: number;
}

export interface ContextInventoryItem {
  id: string;
  kind: ContextInventoryKind;
  content: string;
  status?: string;
  dataSource?: DataLakeSourceDescriptor;
  customFields?: DataLakeCustomFields;
  sourceRefs: SourceRef[];
  eventIds: string[];
  factIds: string[];
  memoryIds: string[];
}

export interface ContextInventorySearchResponse {
  tool: "search_context_inventory";
  query: ContextInventorySearchRequest;
  total: number;
  limit: number;
  offset: number;
  items: ContextInventoryItem[];
}

export const contextToolDescriptors = [
  {
    name: "write_memory_event",
    endpoint: "POST /context/tools/write-memory-event",
    description: "Write a confirmed memory event from an Agent. This only creates a controlled raw MemoryEvent for audit/provenance; it does not parse facts, run STM admission, write STM, or write LTM. Use follow-up pipeline/manual-step tools when the event should become searchable memory.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The confirmed memory content to write, in the user's original language when possible."
        },
        idempotencyKey: {
          type: "string",
          description: "Stable caller-generated key for this memory write. Reuse the same key on retry to avoid duplicates."
        },
        summary: {
          type: "string",
          description: "Optional short reason or summary for why this memory is being written."
        },
        sourceApp: {
          type: "string",
          description: "Optional source application. Defaults to agent."
        },
        sourceId: {
          type: "string",
          description: "Optional source object/session identifier for provenance."
        },
        memoryType: {
          type: "string",
          description: "Optional event type. Defaults to agent_memory."
        },
        eventTime: {
          type: "string",
          description: "Optional ISO timestamp for the source event time. Defaults to now."
        },
        tenantId: { type: "string" },
        principalId: { type: "string" },
        visibility: {
          enum: ["private", "team", "tenant", "public"],
          description: "Optional permission visibility. Defaults to private."
        }
      },
      required: ["content", "idempotencyKey"]
    }
  },
  {
    name: "search_context",
    endpoint: "POST /context/assemble",
    description: "Retrieve relevant historical context for the user's current task and assemble an agent-ready Context Pack. Use the user's original task as the primary semantic query. Context Engine resolves one temporal query and searches concrete evidence, eligible short-term memory (STM), and long-term memory (LTM), including content derived from ingested conversation and external data sources. It applies keyword, vector, graph, lifecycle, permission, temporal hard filtering, ranking, cross-layer deduplication, conflict, citation, and token-budget processing before returning the Context Pack. Use this as the default read-only context retrieval tool whenever answering the task may depend on facts, preferences, decisions, events, or other information from the user's history. Preserve the original language in task and q. Do not translate the query before calling this tool. This tool does not write, update, or delete memory.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The user's original question or task in their original language, for example 我跟谁吃晚饭."
        },
        q: {
          type: "string",
          description: "Optional retrieval query in the user's original wording/language. Omit unless it should differ from task."
        },
        layer: {
          enum: ["all", "stm", "ltm"],
          description: "Optional memory layer. Omit or use all for normal retrieval."
        },
        sourceIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional sourceId scope."
        },
        referenceTime: {
          type: "string",
          description: "Optional RFC3339 reference time used to resolve relative expressions. Defaults to request receive time."
        },
        timezone: {
          type: "string",
          description: "Optional IANA timezone for local-day expressions, for example Asia/Shanghai."
        },
        locale: {
          type: "string",
          description: "Optional BCP 47 locale, for example zh-CN."
        },
        timeRange: {
          type: "object",
          properties: {
            startTime: { type: "string", description: "Inclusive RFC3339 range start." },
            endTime: { type: "string", description: "Exclusive RFC3339 range end." },
            basis: {
              enum: ["evidence", "valid", "auto"],
              description: "Time axis used for hard filtering; auto accepts either and reports the matched axis."
            }
          },
          required: ["startTime", "endTime"],
          additionalProperties: false
        },
        limit: { type: "number", default: 50 },
        offset: { type: "number", default: 0 },
        tokenBudget: { type: "number", default: 1200 },
        includeInactive: {
          type: "boolean",
          description: "Include inactive memories only for debugging or explicit historical inspection."
        }
      },
      required: ["task"]
    }
  },
  {
    name: "maintain_fixed_background",
    endpoint: "POST /context/mcp",
    description: "Run an idempotent fixed-background maintenance window for the authenticated tenant and principal. Intended for scheduled maintenance; retry with the same runId.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Stable maintenance run identifier. Reuse it when retrying the same scheduled window."
        },
        scheduledAt: {
          type: "string",
          description: "Exclusive ISO timestamp ending the maintenance window."
        },
        baseBackgroundId: { type: "string" },
        expectedFixedRevision: { type: "integer", minimum: 0 },
        stmPageSize: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
        maxInputTokens: { type: "integer", minimum: 1, default: 8000 },
        sectionLimits: {
          type: "object",
          properties: {
            identity: { type: "integer", minimum: 1 },
            relationships: { type: "integer", minimum: 1 },
            recentTasks: { type: "integer", minimum: 1 },
            aiSoul: { type: "integer", minimum: 1 }
          },
          additionalProperties: false
        }
      },
      required: ["runId", "scheduledAt"]
    }
  },
  {
    name: "create_session_background",
    endpoint: "POST /context/mcp",
    description: "Create or reuse the authenticated user's background snapshot before the main Agent handles the first message. Inspect status before using serializedPrompt.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Stable session identifier. Reuse it to get the same snapshot unless forceRefresh is true."
        },
        createdAt: {
          type: "string",
          description: "ISO timestamp when the session was created."
        },
        referenceTime: {
          type: "string",
          description: "Optional RFC3339 reference time for the dynamic window. Defaults to request receive time."
        },
        timezone: {
          type: "string",
          description: "Optional IANA timezone used to determine the local-day snapshot boundary."
        },
        locale: {
          type: "string",
          description: "Optional BCP 47 locale for temporal context."
        },
        fixedBackgroundId: { type: "string" },
        dynamicWindowStart: { type: "string" },
        dynamicWindowEnd: { type: "string" },
        tokenBudget: { type: "integer", minimum: 1, default: 1200 },
        maxInputTokens: { type: "integer", minimum: 1, default: 8000 },
        maxDynamicCandidates: { type: "integer", minimum: 1, default: 200 },
        latestStmCursor: {
          type: "object",
          properties: {
            updatedAt: { type: "string" },
            memoryDataId: { type: "string" }
          },
          required: ["updatedAt", "memoryDataId"],
          additionalProperties: false
        },
        forceRefresh: { type: "boolean", default: false }
      },
      required: ["sessionId", "createdAt"]
    }
  },
  {
    name: "inspect_context_inventory",
    endpoint: "POST /context/tools/search-inventory",
    description: "Debug/inspect raw context inventory across events, data lake segments, facts, STM, and LTM. This is for inventory inspection, not the default agent answer context. For user questions, prefer search_context. Preserve the user's original query language in q; do not translate it before calling this tool.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Optional case-insensitive text query. Use the user's original wording/language first; for example keep 晚餐 instead of translating it to dinner." },
        kinds: {
          type: "array",
          items: { enum: ["event", "segment", "fact", "stm", "ltm"] },
          description: "Optional inventory layers to search. Do not pass only ['event'] unless the user explicitly asks for raw source events; omit this field for normal searches."
        },
        rawEventsOnly: {
          type: "boolean",
          description: "Set true only when the user explicitly asks to inspect raw MemoryEvent records. Without this, ['event'] is expanded to all inventory layers."
        },
        source: {
          type: "object",
          properties: {
            sourceApp: { type: "string" },
            sourceId: { type: "string" },
            sourceName: { type: "string" },
            sourceType: { type: "string" },
            connectorId: { type: "string" }
          }
        },
        customFields: {
          type: "object",
          description: "Exact-match custom field filters. Nested fields use dot paths, for example task.id."
        },
        limit: { type: "number", default: 25 },
        offset: { type: "number", default: 0 }
      }
    }
  },
  ...conversationIngestionToolContracts.map(({ successSchema: _successSchema, errorSchema: _errorSchema, ...tool }) => tool)
] as const;

type DebugSnapshot = ReturnType<ContextEngineRepository["getDebugSnapshot"]>;

export function searchContextInventory(
  snapshot: DebugSnapshot,
  request: ContextInventorySearchRequest
): ContextInventorySearchResponse {
  const q = normalizeInventoryQuery(request.q);
  const defaultKinds: ContextInventoryKind[] = ["event", "segment", "fact", "stm", "ltm"];
  const selectedKinds = normalizeInventoryKinds(request.kinds, request.rawEventsOnly, defaultKinds);
  const kinds = new Set<ContextInventoryKind>(selectedKinds);
  const limit = clampPageSize(request.limit);
  const offset = Math.max(0, request.offset ?? 0);
  const query: ContextInventorySearchRequest = {
    ...(request.q ? { q: request.q } : {}),
    kinds: [...kinds],
    ...(request.rawEventsOnly ? { rawEventsOnly: true } : {}),
    ...(request.source ? { source: request.source } : {}),
    ...(request.customFields ? { customFields: request.customFields } : {}),
    limit,
    offset
  };

  const matches = buildInventoryItems(snapshot)
    .filter((item) => kinds.has(item.kind))
    .filter((item) => !q || normalizeInventoryText(item.content).toLowerCase().includes(q))
    .filter((item) => matchesSourceFilters(item.dataSource, request.source))
    .filter((item) => matchesCustomFieldFilters(item.customFields, request.customFields));

  return {
    tool: "search_context_inventory",
    query,
    total: matches.length,
    limit,
    offset,
    items: matches.slice(offset, offset + limit)
  };
}

function normalizeInventoryKinds(
  kinds: ContextInventoryKind[] | undefined,
  rawEventsOnly: boolean | undefined,
  defaultKinds: ContextInventoryKind[]
) {
  if (!kinds?.length) return defaultKinds;
  if (kinds.length === 1 && kinds[0] === "event" && rawEventsOnly !== true) {
    return defaultKinds;
  }
  return kinds;
}

function normalizeInventoryQuery(value: string | undefined) {
  const query = value?.trim().toLowerCase() ?? "";
  if (!query) return "";
  const asksForCurrentInventory = (
    (query.includes("上下文") || query.includes("context")) &&
    (
      query.includes("有什么") ||
      query.includes("有哪些") ||
      query.includes("列") ||
      query.includes("全部") ||
      query.includes("现在") ||
      query.includes("current") ||
      query.includes("what") ||
      query.includes("list") ||
      query.includes("all")
    )
  );
  return asksForCurrentInventory ? "" : query;
}

function buildInventoryItems(snapshot: DebugSnapshot): ContextInventoryItem[] {
  return [
    ...snapshot.memoryEvents.map((event) => eventToInventoryItem(event)),
    ...snapshot.parsedSegments.map((segment) => segmentToInventoryItem(snapshot, segment)),
    ...snapshot.facts.map((fact) => factToInventoryItem(snapshot, fact)),
    ...snapshot.shortTermMemories.map((memory) => stmToInventoryItem(snapshot, memory)),
    ...snapshot.longTermMemories.map((memory) => ltmToInventoryItem(snapshot, memory))
  ];
}

function eventToInventoryItem(event: MemoryEvent): ContextInventoryItem {
  const dataSource = dataSourceFromEvent(event);
  const customFields = mergeDataLakeFields(
    event.customFields,
    ...event.multimodalData.map((item) => mergeDataLakeFields(item.customFields, customFieldsFromMultimodalContent(item.content)))
  );
  return {
    id: event.eventId,
    kind: "event",
    content: normalizeInventoryText([
      event.eventSummary ?? event.eventDescription ?? event.eventType,
      ...event.multimodalData.map((item) => multimodalContentToText(item.content))
    ].filter(Boolean).join("\n")),
    status: "raw",
    ...(dataSource ? { dataSource } : {}),
    ...(customFields ? { customFields } : {}),
    sourceRefs: sourceRefsFromEvent(event),
    eventIds: [event.eventId],
    factIds: [],
    memoryIds: []
  };
}

function segmentToInventoryItem(snapshot: DebugSnapshot, segment: ParsedSegment): ContextInventoryItem {
  const event = snapshot.memoryEvents.find((item) => item.eventId === segment.eventId);
  const dataSource = segment.dataSource ?? dataSourceFromEvent(event);
  const customFields = mergeDataLakeFields(event?.customFields, segment.customFields);
  return {
    id: segment.segmentId,
    kind: "segment",
    content: normalizeInventoryText(segment.content),
    status: segment.status,
    ...(dataSource ? { dataSource } : {}),
    ...(customFields ? { customFields } : {}),
    sourceRefs: event ? sourceRefsFromEvent(event) : [],
    eventIds: [segment.eventId],
    factIds: [],
    memoryIds: []
  };
}

function factToInventoryItem(snapshot: DebugSnapshot, fact: FactItem): ContextInventoryItem {
  const dataSource = dataSourceFromEvent(snapshot.memoryEvents.find((event) => fact.linkedEventIds.includes(event.eventId)));
  const customFields = customFieldsForFact(snapshot, fact);
  return {
    id: fact.factId,
    kind: "fact",
    content: normalizeInventoryText(fact.factText),
    status: fact.status,
    ...(dataSource ? { dataSource } : {}),
    ...(customFields ? { customFields } : {}),
    sourceRefs: fact.linkedSourceRefs,
    eventIds: fact.linkedEventIds,
    factIds: [fact.factId],
    memoryIds: []
  };
}

function stmToInventoryItem(snapshot: DebugSnapshot, memory: ShortTermMemory): ContextInventoryItem {
  const facts = snapshot.facts.filter((fact) => memory.sourceFactIds.includes(fact.factId));
  const dataSource = dataSourceFromSourceRefs(memory.sourceRefs);
  const customFields = mergeDataLakeFields(...facts.map((fact) => customFieldsForFact(snapshot, fact)));
  return {
    id: memory.memoryDataId,
    kind: "stm",
    content: normalizeInventoryText(memory.content),
    status: memory.lifecycleStatus,
    ...(dataSource ? { dataSource } : {}),
    ...(customFields ? { customFields } : {}),
    sourceRefs: memory.sourceRefs,
    eventIds: facts.flatMap((fact) => fact.linkedEventIds),
    factIds: memory.sourceFactIds,
    memoryIds: [memory.memoryDataId]
  };
}

function ltmToInventoryItem(snapshot: DebugSnapshot, memory: LongTermMemory): ContextInventoryItem {
  const sourceStm = snapshot.shortTermMemories.filter((item) => memory.sourceMemoryDataIds.includes(item.memoryDataId));
  const sourceStmItems = sourceStm.map((item) => stmToInventoryItem(snapshot, item));
  const dataSource = dataSourceFromSourceRefs(memory.sourceRefs);
  const customFields = mergeDataLakeFields(...sourceStmItems.map((item) => item.customFields));
  return {
    id: memory.memoryId,
    kind: "ltm",
    content: normalizeInventoryText(memory.content),
    status: memory.lifecycleStatus,
    ...(dataSource ? { dataSource } : {}),
    ...(customFields ? { customFields } : {}),
    sourceRefs: memory.sourceRefs,
    eventIds: sourceStmItems.flatMap((item) => item.eventIds),
    factIds: sourceStm.flatMap((item) => item.sourceFactIds),
    memoryIds: [memory.memoryId, ...memory.sourceMemoryDataIds]
  };
}

function customFieldsForFact(snapshot: DebugSnapshot, fact: FactItem) {
  return mergeDataLakeFields(
    ...fact.linkedEventIds.map((eventId) => snapshot.memoryEvents.find((event) => event.eventId === eventId)?.customFields),
    ...fact.linkedSegmentIds.map((segmentId) => snapshot.parsedSegments.find((segment) => segment.segmentId === segmentId)?.customFields)
  );
}

function dataSourceFromEvent(event: MemoryEvent | undefined): DataLakeSourceDescriptor | undefined {
  if (!event) return undefined;
  const primarySource = primarySourceRefForEvent(event);
  const sourceType = event.dataSource?.sourceType ?? primarySource?.sourceType;
  const sourceUri = event.dataSource?.sourceUri ?? primarySource?.sourceUrl;
  return {
    sourceApp: event.dataSource?.sourceApp ?? event.sourceApp ?? primarySource?.sourceType ?? "unknown",
    sourceId: event.dataSource?.sourceId ?? event.sourceId ?? primarySource?.sourceId ?? event.eventId,
    ...(event.dataSource?.sourceName ? { sourceName: event.dataSource.sourceName } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(sourceUri ? { sourceUri } : {}),
    ...(event.dataSource?.connectorId ? { connectorId: event.dataSource.connectorId } : {}),
    ...(event.dataSource?.syncCursor ? { syncCursor: event.dataSource.syncCursor } : {}),
    ...(event.dataSource?.syncVersion ? { syncVersion: event.dataSource.syncVersion } : {})
  };
}

function dataSourceFromSourceRefs(sourceRefs: SourceRef[]): DataLakeSourceDescriptor | undefined {
  const primary = sourceRefs[0];
  if (!primary) return undefined;
  return {
    sourceApp: primary.sourceType,
    sourceId: primary.sourceId,
    sourceType: primary.sourceType,
    ...(primary.sourceUrl ? { sourceUri: primary.sourceUrl } : {})
  };
}

function matchesSourceFilters(
  dataSource: DataLakeSourceDescriptor | undefined,
  filters: ContextInventorySearchRequest["source"]
) {
  if (!filters) return true;
  return Object.entries(filters).every(([key, value]) => {
    if (value === undefined || value === null || value === "") return true;
    return String(dataSource?.[key as keyof DataLakeSourceDescriptor] ?? "") === String(value);
  });
}

function matchesCustomFieldFilters(
  fields: DataLakeCustomFields | undefined,
  filters: ContextInventorySearchRequest["customFields"]
) {
  if (!filters) return true;
  return Object.entries(filters).every(([key, value]) => {
    const field = getCustomFieldPath(fields, key);
    return field.exists && String(field.value) === String(value);
  });
}

function getCustomFieldPath(fields: DataLakeCustomFields | undefined, path: string) {
  let current: unknown = fields;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(segment in current)) {
      return { exists: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function normalizeInventoryText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clampPageSize(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return 25;
  return Math.min(Math.max(Math.floor(value), 1), 100);
}
