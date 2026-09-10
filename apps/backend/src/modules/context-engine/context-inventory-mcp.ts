import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { assembleContext, type AssembleContextRequest } from "./assemble-context.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { getContextEngineConfig } from "../../config.js";
import { createContextEngineService, type ContextEngineService, type WriteAgentMemoryInput } from "./write-event.js";
import { maintainFixedBackground } from "./background-maintainer.js";
import { createSessionBackground } from "./session-background.js";
import { createMainAgentSessionBackgroundResult } from "./background-handoff.js";
import {
  parseCreateSessionBackgroundRequest,
  parseMaintainFixedBackgroundRequest
} from "./background-requests.js";
import {
  contextToolDescriptors,
  searchContextInventory,
  type ContextInventoryKind,
  type ContextInventorySearchRequest
} from "./context-inventory-tool.js";
import {
  ConversationIngestionServiceError,
  createConversationIngestionWorker,
  createConversationIngestionService,
  parseConversationCallerScope,
  type ConversationCallerScope,
  type ConversationIngestionService,
  type IngestConversationDocumentInput
} from "./conversation-ingestion/index.js";
import { parseTemporalSearchRange } from "./temporal-query.js";
import { getTimelineFusionScheduler } from "./timeline-fusion-scheduler.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SEARCH_CONTEXT_TOOL_NAME = "search_context";
const LEGACY_SEARCH_CONTEXT_TOOL_NAME = "search_context_inventory";
const GET_CONTEXT_PACK_TOOL_NAME = "get_context_pack";
const INSPECT_INVENTORY_TOOL_NAME = "inspect_context_inventory";
const WRITE_MEMORY_EVENT_TOOL_NAME = "write_memory_event";
const INGEST_CONVERSATION_DOCUMENT_TOOL_NAME = "ingest_conversation_batch_document";
const GET_CONVERSATION_INGESTION_STATUS_TOOL_NAME = "get_conversation_ingestion_status";
const MAINTAIN_FIXED_BACKGROUND_TOOL_NAME = "maintain_fixed_background";
const CREATE_SESSION_BACKGROUND_TOOL_NAME = "create_session_background";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export function createContextInventoryMcpServer(
  repository: ContextEngineRepository,
  service: ContextEngineService = createContextEngineService(repository),
  conversationService: ConversationIngestionService = createConversationIngestionService(repository)
) {
  return {
    async handleRequest(
      request: JsonRpcRequest,
      callerScope?: ConversationCallerScope | (() => ConversationCallerScope)
    ): Promise<JsonRpcResponse | undefined> {
      if (!("id" in request)) {
        return undefined;
      }

      try {
        if (request.method === "initialize") {
          return result(request.id ?? null, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: {
                listChanged: false
              }
            },
            serverInfo: {
              name: "nexcore-context-inventory",
              version: "0.1.0"
            }
          });
        }

        if (request.method === "ping") {
          return result(request.id ?? null, {});
        }

        if (request.method === "tools/list") {
          return result(request.id ?? null, {
            tools: contextToolDescriptors.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }))
          });
        }

        if (request.method === "tools/call") {
          const params = parseToolCallParams(request.params);
          if (params.name === INGEST_CONVERSATION_DOCUMENT_TOOL_NAME) {
            return await callConversationTool(request.id ?? null, async () =>
              await conversationService.ingest(
                parseIngestConversationDocumentArguments(params.arguments),
                resolveConversationCallerScope(callerScope, "ingest_conversation_batch_document")
              )
            );
          }

          if (params.name === GET_CONVERSATION_INGESTION_STATUS_TOOL_NAME) {
            return await callConversationTool(request.id ?? null, async () =>
              await conversationService.getStatus(
                parseGetConversationIngestionStatusArguments(params.arguments),
                resolveConversationCallerScope(callerScope, "get_conversation_ingestion_status")
              )
            );
          }

          if (params.name === MAINTAIN_FIXED_BACKGROUND_TOOL_NAME) {
            const scope = resolveBackgroundCallerScope(callerScope);
            const maintenance = await maintainFixedBackground(
              repository,
              parseMaintainFixedBackgroundRequest(params.arguments, scope)
            );
            return result(request.id ?? null, {
              content: [{ type: "text", text: JSON.stringify(maintenance, null, 2) }],
              structuredContent: maintenance as unknown as Record<string, unknown>,
              isError: false
            });
          }

          if (params.name === CREATE_SESSION_BACKGROUND_TOOL_NAME) {
            const scope = resolveBackgroundCallerScope(callerScope);
            const snapshot = await createSessionBackground(
              repository,
              parseCreateSessionBackgroundRequest(params.arguments, scope)
            );
            const structuredContent = createMainAgentSessionBackgroundResult(snapshot);
            return result(request.id ?? null, {
              content: [{ type: "text", text: structuredContent.serializedPrompt }],
              structuredContent: structuredContent as unknown as Record<string, unknown>,
              isError: false
            });
          }

          if (params.name === WRITE_MEMORY_EVENT_TOOL_NAME) {
            const writeResult = await service.writeAgentMemory({
              ...parseWriteMemoryEventArguments(params.arguments),
              skipPipeline: true
            });
            const structuredContent = {
              tool: WRITE_MEMORY_EVENT_TOOL_NAME,
              result: writeResult
            };
            return result(request.id ?? null, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(structuredContent, null, 2)
                }
              ],
              structuredContent,
              isError: false
            });
          }

          if (isContextPackToolName(params.name)) {
            const contextPack = await assembleContext(repository, parseContextPackArguments(params.arguments));
            const agentContextPack = {
              contextPack: contextPack.serializedPrompt,
              serializedPrompt: contextPack.serializedPrompt,
              temporal: contextPack.temporal
            };
            return result(request.id ?? null, {
              content: [
                {
                  type: "text",
                  text: contextPack.serializedPrompt
                }
              ],
              structuredContent: agentContextPack,
              isError: false
            });
          }

          if (params.name !== INSPECT_INVENTORY_TOOL_NAME) {
            return error(request.id ?? null, -32602, `Unknown tool: ${params.name}`);
          }
          const searchResult = searchContextInventory(repository.getDebugSnapshot(), parseInventoryArguments(params.arguments));
          return result(request.id ?? null, {
            content: [
              {
                type: "text",
                text: JSON.stringify(searchResult, null, 2)
              }
            ],
            structuredContent: searchResult,
            isError: false
          });
        }

        return error(request.id ?? null, -32601, `Method not found: ${request.method}`);
      } catch (caught) {
        return error(
          request.id ?? null,
          -32603,
          caught instanceof Error ? caught.message : "Internal error"
        );
      }
    }
  };
}

export async function runContextInventoryMcpServer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  repository: ContextEngineRepository = createDefaultInventoryRepository()
) {
  const server = createContextInventoryMcpServer(repository);
  const conversationWorker = createConversationIngestionWorker(repository);
  const timelineFusionScheduler = getTimelineFusionScheduler(repository);
  await timelineFusionScheduler.start();
  conversationWorker.start();
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.once("close", () => {
    conversationWorker.stop();
    timelineFusionScheduler.stop();
  });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (caught) {
      output.write(`${JSON.stringify(error(null, -32700, "Parse error", caught instanceof Error ? caught.message : caught))}\n`);
      continue;
    }

    const response = await server.handleRequest(request);
    if (response) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}

function createDefaultInventoryRepository() {
  const config = getContextEngineConfig();
  return new SqliteContextEngineRepository(config.storage.storePath);
}

function result(id: string | number | null, payload: Record<string, unknown>): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: payload
  };
}

function error(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {})
    }
  };
}

async function callConversationTool<T extends object>(
  id: string | number | null,
  call: () => Promise<T>
): Promise<JsonRpcResponse> {
  try {
    const structuredContent = await call();
    return result(id, {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent: structuredContent as Record<string, unknown>,
      isError: false
    });
  } catch (caught) {
    if (!(caught instanceof ConversationIngestionServiceError)) throw caught;
    return result(id, {
      content: [{ type: "text", text: JSON.stringify(caught.toolError, null, 2) }],
      structuredContent: caught.toolError,
      isError: true
    });
  }
}

function parseToolCallParams(params: unknown): { name: string; arguments?: unknown } {
  if (!params || typeof params !== "object") {
    throw new Error("tools/call params are required");
  }
  const input = params as { name?: unknown; arguments?: unknown };
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new Error("tools/call params.name is required");
  }
  return {
    name: input.name,
    arguments: input.arguments
  };
}

function parseIngestConversationDocumentArguments(value: unknown): IngestConversationDocumentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { document: "", idempotencyKey: "", documentSha256: "" };
  }
  const input = value as Record<string, unknown>;
  return {
    ...input,
    document: typeof input.document === "string" ? input.document : "",
    idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : "",
    documentSha256: typeof input.documentSha256 === "string" ? input.documentSha256 : "",
    ...(input.processingMode === "async"
      ? { processingMode: input.processingMode }
      : input.processingMode !== undefined
        ? { processingMode: input.processingMode as never }
        : {})
  };
}

function parseGetConversationIngestionStatusArguments(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const input = value as Record<string, unknown>;
  return typeof input.ingestionId === "string" ? input.ingestionId : "";
}

function conversationCallerScopeFromEnvironment(
  tool: "ingest_conversation_batch_document" | "get_conversation_ingestion_status"
) {
  const allowedVisibilities = process.env.CONTEXT_MCP_ALLOWED_VISIBILITIES?.split(",").map((item) => item.trim());
  return parseConversationCallerScope({
    tenantId: process.env.CONTEXT_MCP_TENANT_ID,
    principalId: process.env.CONTEXT_MCP_PRINCIPAL_ID,
    sourceApp: process.env.CONTEXT_MCP_SOURCE_APP,
    ...(allowedVisibilities ? { allowedVisibilities } : {})
  }, tool);
}

function resolveConversationCallerScope(
  callerScope: ConversationCallerScope | (() => ConversationCallerScope) | undefined,
  tool: "ingest_conversation_batch_document" | "get_conversation_ingestion_status"
) {
  if (typeof callerScope === "function") return callerScope();
  return callerScope ?? conversationCallerScopeFromEnvironment(tool);
}

function resolveBackgroundCallerScope(
  callerScope: ConversationCallerScope | (() => ConversationCallerScope) | undefined
) {
  const scope = resolveConversationCallerScope(callerScope, "ingest_conversation_batch_document");
  return {
    tenantId: scope.tenantId,
    principalId: scope.principalId
  };
}

function parseInventoryArguments(value: unknown): ContextInventorySearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as {
    q?: unknown;
    kinds?: unknown;
    rawEventsOnly?: unknown;
    source?: unknown;
    customFields?: unknown;
    limit?: unknown;
    offset?: unknown;
  };
  const request: ContextInventorySearchRequest = {
    ...(typeof input.q === "string" ? { q: input.q } : {}),
    ...(Array.isArray(input.kinds) ? { kinds: input.kinds.filter(isContextInventoryKind) } : {}),
    ...(input.rawEventsOnly === true ? { rawEventsOnly: true } : {}),
    ...parseSourceFilter(input.source),
    ...parseCustomFields(input.customFields)
  };
  const limit = parseOptionalInteger(input.limit);
  const offset = parseOptionalInteger(input.offset);
  if (limit !== undefined) request.limit = limit;
  if (offset !== undefined) request.offset = offset;
  return request;
}

function parseContextPackArguments(value: unknown): AssembleContextRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("search_context requires task or q");
  }
  const input = value as {
    task?: unknown;
    q?: unknown;
    layer?: unknown;
    tenantId?: unknown;
    principalId?: unknown;
    sourceIds?: unknown;
    limit?: unknown;
    offset?: unknown;
    tokenBudget?: unknown;
    includeInactive?: unknown;
    referenceTime?: unknown;
    timezone?: unknown;
    locale?: unknown;
    timeRange?: unknown;
  };
  const task = typeof input.task === "string" && input.task.trim()
    ? input.task
    : typeof input.q === "string" && input.q.trim()
      ? input.q
      : "";
  if (!task.trim()) {
    throw new Error("search_context requires task or q");
  }
  const timeRange = parseTemporalSearchRange(input.timeRange);

  const request: AssembleContextRequest = {
    task,
    ...(typeof input.q === "string" && input.q.trim() ? { q: input.q } : {}),
    ...(isSearchLayer(input.layer) ? { layer: input.layer } : {}),
    ...(typeof input.tenantId === "string" && input.tenantId.trim() ? { tenantId: input.tenantId.trim() } : {}),
    ...(typeof input.principalId === "string" && input.principalId.trim() ? { principalId: input.principalId.trim() } : {}),
    ...(Array.isArray(input.sourceIds) ? { sourceIds: input.sourceIds.map(String).map((item) => item.trim()).filter(Boolean) } : {}),
    ...(typeof input.referenceTime === "string" && input.referenceTime.trim()
      ? { referenceTime: input.referenceTime.trim() }
      : {}),
    ...(typeof input.timezone === "string" && input.timezone.trim() ? { timezone: input.timezone.trim() } : {}),
    ...(typeof input.locale === "string" && input.locale.trim() ? { locale: input.locale.trim() } : {}),
    ...(timeRange ? { timeRange } : {}),
    ...(input.includeInactive === true ? { includeInactive: true } : {})
  };
  const limit = parseOptionalInteger(input.limit);
  const offset = parseOptionalInteger(input.offset);
  const tokenBudget = parseOptionalInteger(input.tokenBudget);
  if (limit !== undefined) request.limit = limit;
  if (offset !== undefined) request.offset = offset;
  if (tokenBudget !== undefined) request.tokenBudget = tokenBudget;
  return request;
}

function parseWriteMemoryEventArguments(value: unknown): WriteAgentMemoryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("write_memory_event requires content and idempotencyKey");
  }
  const input = value as {
    content?: unknown;
    idempotencyKey?: unknown;
    tenantId?: unknown;
    principalId?: unknown;
    visibility?: unknown;
    sourceApp?: unknown;
    sourceId?: unknown;
    memoryType?: unknown;
    summary?: unknown;
    eventTime?: unknown;
  };
  if (typeof input.content !== "string" || typeof input.idempotencyKey !== "string") {
    throw new Error("write_memory_event requires content and idempotencyKey");
  }
  return {
    content: input.content,
    idempotencyKey: input.idempotencyKey,
    ...(typeof input.tenantId === "string" && input.tenantId.trim() ? { tenantId: input.tenantId.trim() } : {}),
    ...(typeof input.principalId === "string" && input.principalId.trim() ? { principalId: input.principalId.trim() } : {}),
    ...(isVisibility(input.visibility) ? { visibility: input.visibility } : {}),
    ...(typeof input.sourceApp === "string" && input.sourceApp.trim() ? { sourceApp: input.sourceApp.trim() } : {}),
    ...(typeof input.sourceId === "string" && input.sourceId.trim() ? { sourceId: input.sourceId.trim() } : {}),
    ...(typeof input.memoryType === "string" && input.memoryType.trim() ? { memoryType: input.memoryType.trim() } : {}),
    ...(typeof input.summary === "string" && input.summary.trim() ? { summary: input.summary.trim() } : {}),
    ...(typeof input.eventTime === "string" && input.eventTime.trim() ? { eventTime: input.eventTime.trim() } : {})
  };
}

function isContextPackToolName(value: string) {
  return value === SEARCH_CONTEXT_TOOL_NAME ||
    value === GET_CONTEXT_PACK_TOOL_NAME ||
    value === LEGACY_SEARCH_CONTEXT_TOOL_NAME;
}

function parseSourceFilter(value: unknown): Pick<ContextInventorySearchRequest, "source"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const parsed: NonNullable<ContextInventorySearchRequest["source"]> = {};
  for (const key of ["sourceApp", "sourceId", "sourceName", "sourceType", "connectorId"] as const) {
    if (typeof source[key] === "string" && source[key].trim()) {
      parsed[key] = source[key].trim();
    }
  }
  return Object.keys(parsed).length ? { source: parsed } : {};
}

function parseCustomFields(value: unknown): Pick<ContextInventorySearchRequest, "customFields"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { customFields: value as NonNullable<ContextInventorySearchRequest["customFields"]> };
}

function parseOptionalInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isContextInventoryKind(value: unknown): value is ContextInventoryKind {
  return value === "event" || value === "segment" || value === "fact" || value === "stm" || value === "ltm";
}

function isSearchLayer(value: unknown): value is NonNullable<AssembleContextRequest["layer"]> {
  return value === "all" || value === "stm" || value === "ltm";
}

function isVisibility(value: unknown): value is NonNullable<WriteAgentMemoryInput["visibility"]> {
  return value === "private" || value === "team" || value === "tenant" || value === "public";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runContextInventoryMcpServer();
}
