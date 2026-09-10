import type { FastifyInstance, FastifyReply } from "fastify";
import { resolve } from "node:path";
import { getContextEngineConfig } from "../../config.js";
import { INITIAL_BACKGROUND_CURSOR } from "./domain.js";
import { createEmptyBackgroundSections, renderBackgroundMarkdown } from "./background-markdown.js";
import { maintainFixedBackground } from "./background-maintainer.js";
import { createSessionBackground } from "./session-background.js";
import { createMainAgentBackgroundHandoff } from "./background-handoff.js";
import {
  parseCreateSessionBackgroundRequest,
  parseMaintainFixedBackgroundRequest
} from "./background-requests.js";
import type {
  BackgroundContextDocument,
  GraphMemoryOwnerType,
  LongTermMemory,
  MemoryChangeEvent,
  MemoryEvent,
  MemoryFeedbackItem,
  ParsedSegment,
  RelationEdge,
  ShortTermMemory,
  DreamingRunStatus,
  DreamingRun
} from "./domain.js";
import type { LlmFactFusionOptions } from "./llm-fact-fusion.js";
import { assembleContext, type AssembleContextRequest } from "./assemble-context.js";
import { ingestFilesFromDirectory } from "./file-ingestion.js";
import { runLlmDreaming, type LlmDreamingOptions } from "./llm-dreaming.js";
import { DreamingRuntime, DreamingRuntimeDisabledError } from "./dreaming-runtime.js";
import { runManualMemoryFlow, type ManualMemoryFlowInput } from "./manual-memory-flow.js";
import { runManualStepFlow, type ManualStepAction, type ManualStepInput } from "./manual-step-flow.js";
import { buildTimelineAggregatedFactsWithLlm } from "./timeline-aggregation.js";
import { refreshLongTermMemoryIndex, refreshShortTermMemoryIndex } from "./indexing.js";
import { longTermLifecycleChangeReason, reconcileLongTermLifecycle } from "./lifecycle.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { cancelLongMemEvalJob, createLongMemEvalJob, getLongMemEvalJob } from "./longmemeval-jobs.js";
import { redactContextSearchResponse, searchContext, type ContextQuery } from "./search-context.js";
import { parseTemporalSearchRange } from "./temporal-query.js";
import { searchRelations, type RelationQuery } from "./search-relations.js";
import { sanitizeDebugSnapshot } from "./debug-snapshot.js";
import type { ContextEngineService, WriteAgentMemoryInput } from "./write-event.js";
import { longTermRetrievalWeight } from "./retrieval-weight.js";
import { cancelLocomoEvaluationJob, createLocomoEvaluationJob, getLocomoEvaluationJob } from "./locomo-evaluation-jobs.js";
import { readLocomoEvaluationDataset } from "./locomo-dataset.js";
import { normalizePrdMemoryType, summarizeStructuredFacts } from "./memory-types.js";
import { getContextPipelineQueueSnapshot } from "./context-pipeline-queue.js";
import { getTimelineFusionScheduler } from "./timeline-fusion-scheduler.js";
import { mergeDataLakeFields, primarySourceRefForEvent, sourceRefsFromEvent } from "./memory-event-fields.js";
import { assembleLongMemEvalContextPackPreview, buildLongMemEvalSelectedItemDetails, clearLongMemEvalData, readCurrentLongMemEvalDebugSnapshotPage, readLongMemEvalDebugSnapshot, readLongMemEvalSelectedItemDetails, type LongMemEvalDebugView } from "./longmemeval.js";
import { readLongMemEvalJsonlResultPage } from "./longmemeval-jsonl-results.js";
import { longMemEvalArtifactStore } from "./longmemeval-artifacts.js";
import { buildLongMemEvalSamplePage, stripLongMemEvalSamplesFromJob } from "./longmemeval-samples.js";
import {
  MemoryGraphQueryServiceError,
  queryMemoryGraph
} from "./memory-graph-query.js";
import {
  MemoryGraphQueryContractError,
  isMemoryGraphLayer,
  isMemoryGraphRelationType,
  type MemoryGraphQueryErrorCode
} from "./memory-graph-query-contract.js";
import {
  contextToolDescriptors,
  searchContextInventory,
  type ContextInventoryKind,
  type ContextInventorySearchRequest
} from "./context-inventory-tool.js";
import { createContextInventoryMcpServer, type JsonRpcRequest } from "./context-inventory-mcp.js";
import {
  ConversationIngestionServiceError,
  createConversationIngestionService,
  parseConversationCallerScope,
  type IngestConversationDocumentInput
} from "./conversation-ingestion/index.js";

export function registerContextEngineRoutes(
  app: FastifyInstance,
  service: ContextEngineService,
  repository: ContextEngineRepository,
  dreamingRuntime?: DreamingRuntime
) {
  if (dreamingRuntime?.enabled) registerForegroundActivityHooks(app, dreamingRuntime);
  const contextInventoryMcp = createContextInventoryMcpServer(repository, service);
  const conversationService = createConversationIngestionService(repository);

  app.post("/context/events", async (request, reply) => {
    const body = request.body as {
      event?: unknown;
      idempotencyKey?: unknown;
      llm?: unknown;
      deferPipeline?: unknown;
    };

    if (!body?.event || typeof body.idempotencyKey !== "string") {
      reply.code(400);
      return { ok: false, error: "event and idempotencyKey are required" };
    }

    try {
      const result = await service.writeEvent({
        event: body.event as never,
        idempotencyKey: body.idempotencyKey,
        ...(typeof body.deferPipeline === "boolean" ? { deferPipeline: body.deferPipeline } : {}),
        ...parseLlmOptionsForRequest(body.llm)
      });

      return { ok: true, result };
    } catch (error) {
      request.log.error({ err: error }, "context event write failed");
      reply.code(500);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "context event write failed"
      };
    }
  });

  app.post("/context/ingest/files", async (request, reply) => {
    const body = (request.body ?? {}) as {
      directory?: unknown;
    };

    try {
      const options = typeof body.directory === "string" ? { directory: body.directory } : {};
      const result = await ingestFilesFromDirectory(service, options);

      return { ok: true, result };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "file ingestion failed"
      };
    }
  });

  app.post("/context/agent-memory", async (request, reply) => {
    const body = request.body ?? {};

    const input = parseWriteAgentMemoryInput(body);
    if (!input) {
      reply.code(400);
      return { ok: false, error: "content and idempotencyKey are required" };
    }

    try {
      const result = await service.writeAgentMemory(input);

      return { ok: true, result };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "agent memory write failed"
      };
    }
  });

  app.post("/context/debug/manual-flow", async (request, reply) => {
    const body = (request.body ?? {}) as ManualMemoryFlowInput;
    try {
      request.log.info({ sourceId: body.sourceId, eventType: body.eventType }, "manual memory flow requested");
      const result = await runManualMemoryFlow(service, repository, {
        ...(typeof body.content === "string" ? { content: body.content } : {}),
        ...(typeof body.eventType === "string" ? { eventType: body.eventType } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(typeof body.sourceId === "string" ? { sourceId: body.sourceId } : {}),
        ...(typeof body.eventTime === "string" ? { eventTime: body.eventTime } : {}),
        ...(isVisibility(body.visibility) ? { visibility: body.visibility } : {}),
        ...parseDataLakeCustomFieldsForRequest((body as { customFields?: unknown }).customFields),
        ...parseLlmOptionsForRequest((body as { llm?: unknown }).llm)
      }, {
        log: (stage) => {
          request.log.info({ manualFlowStage: stage }, "manual memory flow stage");
        }
      });
      request.log.info({
        eventId: result.event.eventId,
        ltmId: result.longTermMemory.memoryId,
        stmId: result.shortTermMemory.memoryDataId,
        stageCount: result.stages.length
      }, "manual memory flow completed");

      return { ok: true, result };
    } catch (error) {
      request.log.error({ error }, "manual memory flow failed");
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "manual memory flow failed"
      };
    }
  });

  app.post("/context/debug/manual-step", async (request, reply) => {
    const body = (request.body ?? {}) as ManualStepInput;
    if (!isManualStepAction(body.action)) {
      reply.code(400);
      return { ok: false, error: "valid action is required" };
    }
    const requestEventId = typeof body.eventId === "string" && body.eventId.trim() ? body.eventId.trim() : undefined;

    try {
      request.log.info({ action: body.action, eventId: body.eventId, sourceId: body.sourceId }, "manual step requested");
      const llm = parseLlmOptionsForRequest((body as { llm?: unknown }).llm).llm;
      const result = await runManualStepFlow(repository, {
        action: body.action,
        ...(requestEventId ? { eventId: requestEventId } : {}),
        ...(typeof body.content === "string" ? { content: body.content } : {}),
        ...(typeof body.eventType === "string" ? { eventType: body.eventType } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(typeof body.sourceId === "string" ? { sourceId: body.sourceId } : {}),
        ...(typeof body.eventTime === "string" ? { eventTime: body.eventTime } : {}),
        ...(isVisibility(body.visibility) ? { visibility: body.visibility } : {}),
        ...parseDataLakeCustomFieldsForRequest((body as { customFields?: unknown }).customFields),
        ...(llm ? { llm } : {})
      });
      request.log.info({
        action: body.action,
        eventId: result.event?.eventId,
        parsedSegments: result.parsedSegments.length,
        facts: result.facts.length,
        stmId: result.shortTermMemory?.memoryDataId,
        ltmCount: result.ltmResult?.longTermMemories.length
      }, "manual step completed");

      return { ok: true, result };
    } catch (error) {
      request.log.error({ error }, "manual step failed");
      if (requestEventId) {
        await repository.savePipelineTask({
          taskId: `manual_step_${body.action}_${requestEventId}`,
          eventId: requestEventId,
          taskType: body.action === "event" ? "ingest" : body.action === "data_lake" ? "parse" : body.action === "timeline_fusion" ? "fusion" : body.action === "stm" ? "admission" : "dreaming",
          status: "failed",
          attempt: 1,
          maxAttempts: 1,
          retryable: false,
          stage: `${body.action}_failed`,
          error: error instanceof Error ? error.message : "manual step failed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "manual step failed"
      };
    }
  });

  app.get("/context/debug/snapshot", async () => {
    const snapshot = sanitizeDebugSnapshot(repository.getDebugSnapshot());
    return {
      ok: true,
      items: snapshot,
      timeline: await buildTimeline(snapshot),
      pipelineQueue: getContextPipelineQueueSnapshot(),
      timelineFusionScheduler: getTimelineFusionScheduler(repository).snapshot()
    };
  });

  app.get<{ Params: { factId: string } }>(
    "/context/facts/:factId/versions",
    async (request, reply) => {
      const owner = factAuditOwnerScopeFromHeaders(request.headers);
      if (!owner) {
        reply.code(400);
        return {
          ok: false,
          error: "x-context-tenant-id and x-context-principal-id are required"
        };
      }
      const factId = request.params.factId.trim();
      if (!factId) {
        reply.code(400);
        return { ok: false, error: "factId is required" };
      }
      const [fact] = await repository.getFactItemsByIds([factId]);
      const versions = await repository.getFactVersions({ ...owner, factId });
      if (
        (!fact || fact.tenantId !== owner.tenantId || fact.principalId !== owner.principalId) &&
        versions.length === 0
      ) {
        reply.code(404);
        return { ok: false, error: "fact not found" };
      }
      return {
        ok: true,
        result: {
          factId,
          currentFact: fact?.tenantId === owner.tenantId && fact.principalId === owner.principalId
            ? fact
            : null,
          versions
        }
      };
    }
  );

  app.post("/context/memory-graph/query", async (request, reply) => {
    const startedAt = Date.now();
    const requestId = request.id;
    const graphStoreMode = configuredGraphStoreMode();
    const query = memoryGraphQueryLogSummary(request.body);
    try {
      const response = await queryMemoryGraph(repository, request.body);
      request.log.info({
        requestId,
        graphStoreMode,
        query,
        nodeCount: response.nodes?.items.length ?? 0,
        edgeCount: response.edges?.items.length ?? 0,
        durationMs: Date.now() - startedAt
      }, "memory graph query completed");
      return response;
    } catch (error) {
      const isContractError = error instanceof MemoryGraphQueryContractError;
      const code: MemoryGraphQueryErrorCode = isContractError
        ? error.code
        : "MEMORY_GRAPH_QUERY_FAILED";
      request.log.error({
        ...(error instanceof MemoryGraphQueryServiceError ? { err: error } : {}),
        requestId,
        graphStoreMode,
        query,
        code,
        durationMs: Date.now() - startedAt
      }, "memory graph query failed");
      reply.code(isContractError ? 400 : 500);
      return {
        ok: false,
        error: {
          code,
          message: memoryGraphQueryErrorMessage(code),
          requestId
        }
      };
    }
  });

  app.get("/context/tools", async () => {
    return {
      ok: true,
      result: {
        tools: contextToolDescriptors
      }
    };
  });

  app.post("/context/mcp", { bodyLimit: 4 * 1024 * 1024, logLevel: "silent" }, async (request, reply) => {
    const body = request.body as JsonRpcRequest;
    const response = await contextInventoryMcp.handleRequest(
      body,
      () => contextMcpCallerScopeFromHeaders(request.headers, body)
    );
    if (!response) {
      reply.code(202);
      return;
    }

    reply.header("content-type", "application/json");
    return response;
  });

  app.get("/context/mcp", { logLevel: "silent" }, async (_request, reply) => {
    reply
      .header("content-type", "text/event-stream")
      .header("cache-control", "no-cache")
      .header("connection", "keep-alive");
    return "event: endpoint\ndata: /context/mcp\n\n";
  });

  app.post("/context/tools/search-inventory", async (request, reply) => {
    const body = (request.body ?? {}) as {
      q?: unknown;
      kinds?: unknown;
      rawEventsOnly?: unknown;
      source?: unknown;
      customFields?: unknown;
      limit?: unknown;
      offset?: unknown;
    };
    const contextQuery: ContextInventorySearchRequest = {
      ...(typeof body.q === "string" ? { q: body.q } : {}),
      ...(Array.isArray(body.kinds) ? { kinds: body.kinds.filter(isContextInventoryKind) } : {}),
      ...(body.rawEventsOnly === true ? { rawEventsOnly: true } : {}),
      ...parseContextInventorySourceFilter(body.source),
      ...parseContextInventoryCustomFields(body.customFields)
    };
    const limit = parseOptionalUnknownInteger(body.limit);
    const offset = parseOptionalUnknownInteger(body.offset);
    if (limit !== undefined) contextQuery.limit = limit;
    if (offset !== undefined) contextQuery.offset = offset;

    try {
      return {
        ok: true,
        result: searchContextInventory(repository.getDebugSnapshot(), contextQuery)
      };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "context inventory search failed"
      };
    }
  });

  app.post("/context/tools/write-memory-event", async (request, reply) => {
    const input = parseWriteAgentMemoryInput(request.body ?? {});
    if (!input) {
      reply.code(400);
      return { ok: false, error: "content and idempotencyKey are required" };
    }

    try {
      return {
        ok: true,
        result: {
          tool: "write_memory_event",
          result: await service.writeAgentMemory({
            ...input,
            skipPipeline: true
          })
        }
      };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "memory event write failed"
      };
    }
  });

  app.post(
    "/context/tools/ingest-conversation-batch-document",
    { bodyLimit: 4 * 1024 * 1024 },
    async (request, reply) => {
      try {
        const input = parseConversationIngestionHttpInput(request.body);
        const result = await conversationService.ingest(
          input,
          conversationCallerScopeFromHeaders(request.headers, "ingest_conversation_batch_document")
        );
        return { ok: true, result };
      } catch (caught) {
        if (caught instanceof ConversationIngestionServiceError) {
          reply.code(httpStatusForConversationError(caught));
          return { ok: false, error: caught.toolError };
        }
        throw caught;
      }
    }
  );

  app.post("/context/tools/get-conversation-ingestion-status", async (request, reply) => {
    try {
      const body = request.body as { ingestionId?: unknown } | undefined;
      const ingestionId = typeof body?.ingestionId === "string" ? body.ingestionId : "";
      const result = await conversationService.getStatus(
        ingestionId,
        conversationCallerScopeFromHeaders(request.headers, "get_conversation_ingestion_status")
      );
      return { ok: true, result };
    } catch (caught) {
      if (caught instanceof ConversationIngestionServiceError) {
        reply.code(httpStatusForConversationError(caught));
        return { ok: false, error: caught.toolError };
      }
      throw caught;
    }
  });

  app.delete<{ Params: { eventId: string } }>("/context/events/:eventId", async (request, reply) => {
    const result = await repository.deleteMemoryEventCascade(request.params.eventId);
    if (!result) {
      reply.code(404);
      return { ok: false, error: "context event not found" };
    }

    request.log.info({ eventId: request.params.eventId, deleted: result.deleted }, "context event deleted");
    return { ok: true, result };
  });

  app.delete("/context/debug/data", async (request) => {
    const result = await repository.clearAllContextData();
    request.log.info({ deleted: result.deleted }, "context debug data cleared");
    return { ok: true, result };
  });

  app.get<{ Params: { eventId: string } }>("/context/tasks/by-event/:eventId", async (request, reply) => {
    const task = repository
      .getDebugSnapshot()
      .pipelineTasks
      .filter((item) => item.eventId === request.params.eventId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (!task) {
      reply.code(404);
      return { ok: false, error: "pipeline task not found" };
    }
    return { ok: true, result: task };
  });

  app.post<{ Params: { taskId: string } }>("/context/tasks/:taskId/retry", async (request, reply) => {
    try {
      const result = await service.retryPipelineTask(request.params.taskId);
      return { ok: true, result };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "task retry failed"
      };
    }
  });

  app.get<{ Querystring: {
    q?: string;
    layer?: ContextQuery["layer"];
    limit?: string;
    offset?: string;
    includeInactive?: string;
    referenceTime?: string;
    timezone?: string;
    locale?: string;
    startTime?: string;
    endTime?: string;
    basis?: string;
    sessionId?: string;
    taskId?: string;
    requestId?: string;
  } }>("/context/search", async (request, reply) => {
    const q = (request.query.q ?? "").trim();
    const layer = isSearchLayer(request.query.layer) ? request.query.layer : "all";
    try {
      const contextQuery: ContextQuery = {
        q,
        layer,
        includeInactive: request.query.includeInactive === "true",
        ...(request.query.sessionId ? { sessionId: request.query.sessionId } : {}),
        ...(request.query.taskId ? { taskId: request.query.taskId } : {}),
        requestId: request.query.requestId?.trim() || request.id,
        ...parseTemporalContextFields({
          referenceTime: request.query.referenceTime,
          timezone: request.query.timezone,
          locale: request.query.locale,
          ...((request.query.startTime !== undefined || request.query.endTime !== undefined || request.query.basis !== undefined)
            ? {
                timeRange: {
                  startTime: request.query.startTime,
                  endTime: request.query.endTime,
                  basis: request.query.basis
                }
              }
            : {})
        })
      };
      const limit = parseOptionalInteger(request.query.limit);
      const offset = parseOptionalInteger(request.query.offset);
      if (limit !== undefined) contextQuery.limit = limit;
      if (offset !== undefined) contextQuery.offset = offset;
      const response = redactContextSearchResponse(await searchContext(repository, contextQuery));

      return {
        ok: true,
        ...response
      };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : "context search failed" };
    }
  });

  app.post("/context/search", async (request, reply) => {
    const body = (request.body ?? {}) as Partial<ContextQuery>;
    if (typeof body.q !== "string") {
      reply.code(400);
      return { ok: false, error: "q is required" };
    }

    try {
      const contextQuery: ContextQuery = {
        q: body.q,
        layer: isSearchLayer(body.layer) ? body.layer : "all",
        ...parseTemporalContextFields(body)
      };
      if (typeof body.tenantId === "string") contextQuery.tenantId = body.tenantId;
      if (typeof body.principalId === "string") contextQuery.principalId = body.principalId;
      if (typeof body.sessionId === "string") contextQuery.sessionId = body.sessionId;
      if (typeof body.taskId === "string") contextQuery.taskId = body.taskId;
      contextQuery.requestId = typeof body.requestId === "string" && body.requestId.trim() ? body.requestId.trim() : request.id;
      if (Array.isArray(body.sourceIds)) contextQuery.sourceIds = body.sourceIds.map((item) => String(item).trim()).filter(Boolean);
      if (typeof body.limit === "number") contextQuery.limit = body.limit;
      if (typeof body.offset === "number") contextQuery.offset = body.offset;
      if (typeof body.includeInactive === "boolean") {
        contextQuery.includeInactive = body.includeInactive;
      }
      const response = redactContextSearchResponse(await searchContext(repository, contextQuery));

      return { ok: true, ...response };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : "context search failed" };
    }
  });

  app.get<{
    Querystring: {
      fromId?: string;
      toId?: string;
      relationType?: string;
      relationTypes?: string;
      ownerType?: string;
      ownerTypes?: string;
      q?: string;
      includeInactive?: string;
      limit?: string;
      offset?: string;
    };
  }>("/context/relations/search", async (request) => {
    const relationQuery: RelationQuery = {
      includeInactive: request.query.includeInactive === "true"
    };
    if (typeof request.query.fromId === "string" && request.query.fromId.trim()) {
      relationQuery.fromId = request.query.fromId.trim();
    }
    if (typeof request.query.toId === "string" && request.query.toId.trim()) {
      relationQuery.toId = request.query.toId.trim();
    }
    if (typeof request.query.q === "string" && request.query.q.trim()) {
      relationQuery.q = request.query.q.trim();
    }
    const relationTypes = parseRelationTypes(request.query.relationTypes ?? request.query.relationType);
    if (relationTypes.length) relationQuery.relationTypes = relationTypes;
    const ownerTypes = parseGraphOwnerTypes(request.query.ownerTypes ?? request.query.ownerType);
    if (ownerTypes.length) relationQuery.ownerTypes = ownerTypes;
    const limit = parseOptionalInteger(request.query.limit);
    const offset = parseOptionalInteger(request.query.offset);
    if (limit !== undefined) relationQuery.limit = limit;
    if (offset !== undefined) relationQuery.offset = offset;

    return {
      ok: true,
      result: await searchRelations(repository, relationQuery)
    };
  });

  app.post("/context/evaluations/longmemeval", async (request, reply) => {
    const body = (request.body ?? {}) as {
      datasetPath?: unknown;
      ks?: unknown;
      llm?: unknown;
      llmRuns?: unknown;
      modelConcurrency?: unknown;
      logIngestRequestContext?: unknown;
      enableLtmReinforcement?: unknown;
      evalBatchSize?: unknown;
      answerConcurrency?: unknown;
      judgeConcurrency?: unknown;
      ingestSampleConcurrency?: unknown;
      ingestSessionConcurrency?: unknown;
      batchSize?: unknown;
      diagnosticsPath?: unknown;
      resultFileName?: unknown;
      traceFileName?: unknown;
      resume?: unknown;
      retrySkipped?: unknown;
      resumeLegacy?: unknown;
      answerContextMode?: unknown;
      disableIngestLlm?: unknown;
      allowLlmFallback?: unknown;
      skipStmAdmission?: unknown;
      skipLtmDreaming?: unknown;
      modelOnlyEvaluation?: unknown;
      answerOnlyEvaluation?: unknown;
    };
    if (typeof body.datasetPath !== "string" || !body.datasetPath.trim()) {
      reply.code(400);
      request.log.warn({ datasetPath: body.datasetPath }, "longmemeval evaluation rejected");
      return { ok: false, error: "datasetPath is required" };
    }

    const ks = Array.isArray(body.ks)
      ? body.ks.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)
      : undefined;
    const llm = parseLongMemEvalLlmOptions(body.llm);
    const llmRuns = parseLongMemEvalLlmRuns(body.llmRuns);
    const modelConcurrency = parseOptionalUnknownInteger(body.modelConcurrency);
    const logIngestRequestContext = body.logIngestRequestContext === true;
    const enableLtmReinforcement = body.enableLtmReinforcement === true;
    const evalBatchSize = parseOptionalUnknownInteger(body.evalBatchSize) ?? parseOptionalUnknownInteger(body.batchSize);
    const answerConcurrency = parseOptionalUnknownInteger(body.answerConcurrency);
    const judgeConcurrency = parseOptionalUnknownInteger(body.judgeConcurrency);
    const ingestSampleConcurrency = parseOptionalUnknownInteger(body.ingestSampleConcurrency);
    const ingestSessionConcurrency = parseOptionalUnknownInteger(body.ingestSessionConcurrency);
    const diagnosticsPath = typeof body.diagnosticsPath === "string" && body.diagnosticsPath.trim() ? body.diagnosticsPath.trim() : undefined;
    const resultFileName = typeof body.resultFileName === "string" && body.resultFileName.trim() ? body.resultFileName.trim() : undefined;
    const traceFileName = typeof body.traceFileName === "string" && body.traceFileName.trim() ? body.traceFileName.trim() : undefined;
    const resume = body.resume === true;
    const retrySkipped = body.retrySkipped === true;
    const resumeLegacy = body.resumeLegacy === true;
    const answerContextMode = parseLongMemEvalAnswerContextMode(body.answerContextMode);
    const disableIngestLlm = body.disableIngestLlm === true;
    const allowLlmFallback = body.allowLlmFallback !== false;
    const skipStmAdmission = body.skipStmAdmission === true;
    const skipLtmDreaming = true;
    const modelOnlyEvaluation = body.modelOnlyEvaluation === true;
    const answerOnlyEvaluation = body.answerOnlyEvaluation === true;

    request.log.info(
      { datasetPath: body.datasetPath, ks: ks ?? [], hasJudgeOverride: Boolean(llm?.judge), llmRunCount: llmRuns?.length ?? 0, modelConcurrency, logIngestRequestContext, enableLtmReinforcement, evalBatchSize, answerConcurrency, judgeConcurrency, ingestSampleConcurrency, ingestSessionConcurrency, diagnosticsPath, answerContextMode, disableIngestLlm, allowLlmFallback, skipStmAdmission, skipLtmDreaming, modelOnlyEvaluation, answerOnlyEvaluation },
      "longmemeval evaluation requested"
    );
    try {
      if ((retrySkipped || resumeLegacy) && !resume) {
        throw new Error("retrySkipped and resumeLegacy require resume=true");
      }
      if (diagnosticsPath && resultFileName) {
        throw new Error("Use resultFileName instead of diagnosticsPath when selecting a managed result artifact");
      }
      const result = createLongMemEvalJob({
        datasetPath: body.datasetPath,
        ks: ks ?? [],
        ...(llm ? { llm } : {}),
        ...(llmRuns?.length ? { llmRuns } : {}),
        ...(modelConcurrency ? { modelConcurrency } : {}),
        logIngestRequestContext,
        enableLtmReinforcement,
        ...(evalBatchSize ? { evalBatchSize } : {}),
        ...(answerConcurrency ? { answerConcurrency } : {}),
        ...(judgeConcurrency ? { judgeConcurrency } : {}),
        ...(ingestSampleConcurrency ? { ingestSampleConcurrency } : {}),
        ...(ingestSessionConcurrency ? { ingestSessionConcurrency } : {}),
        ...(diagnosticsPath ? { diagnosticsPath } : {}),
        ...(resultFileName ? { resultBasename: resultFileName } : {}),
        ...(traceFileName ? { traceBasename: traceFileName } : {}),
        resume,
        retrySkipped,
        resumeLegacy,
        answerContextMode,
        disableIngestLlm,
        allowLlmFallback,
        skipStmAdmission,
        skipLtmDreaming,
        modelOnlyEvaluation,
        answerOnlyEvaluation
      }, request.log);
      return { ok: true, result };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : "LongMemEval evaluation request is invalid" };
    }
  });

  app.post("/context/evaluations/locomo", async (request, reply) => {
    const body = (request.body ?? {}) as {
      datasetPath?: unknown;
      command?: unknown;
      storePath?: unknown;
      sampleIds?: unknown;
      sampleRange?: unknown;
      questionLimit?: unknown;
      questionConcurrency?: unknown;
      llm?: unknown;
      disableIngestLlm?: unknown;
      ci?: unknown;
    };
    const datasetPath = typeof body.datasetPath === "string" ? body.datasetPath.trim() : "";
    if (!datasetPath) {
      reply.code(400);
      return { ok: false, error: "datasetPath is required" };
    }
    const command = body.command === "prepare" || body.command === "evaluate" || body.command === "full" ? body.command : "full";
    const sampleIds = Array.isArray(body.sampleIds)
      ? body.sampleIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
      : [];
    const rangeRecord = body.sampleRange && typeof body.sampleRange === "object" ? body.sampleRange as Record<string, unknown> : undefined;
    const start = rangeRecord ? Number(rangeRecord.start) : undefined;
    const end = rangeRecord ? Number(rangeRecord.end) : undefined;
    const sampleRange = Number.isInteger(start) && Number.isInteger(end) ? { start: start!, end: end! } : undefined;
    const questionLimit = parseOptionalUnknownInteger(body.questionLimit);
    const questionConcurrency = parseOptionalUnknownInteger(body.questionConcurrency);
    const llm = parseLongMemEvalLlmOptions(body.llm);
    try {
      const config = getContextEngineConfig();
      const resolvedDatasetPath = resolve(config.projectRoot, datasetPath);
      await readLocomoEvaluationDataset(resolvedDatasetPath);
      const result = createLocomoEvaluationJob({
        datasetPath: resolvedDatasetPath,
        command,
        ...(typeof body.storePath === "string" && body.storePath.trim() ? { storePath: body.storePath.trim() } : {}),
        ...(sampleIds.length ? { sampleIds } : {}),
        ...(sampleRange ? { sampleRange } : {}),
        ...(questionLimit ? { questionLimit } : {}),
        ...(questionConcurrency ? { questionConcurrency } : {}),
        ...(llm ? { llm } : {}),
        disableIngestLlm: body.disableIngestLlm === true,
        ci: body.ci === true
      }, request.log);
      return { ok: true, result };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : "LoCoMo evaluation request is invalid" };
    }
  });

  app.get<{ Params: { jobId: string } }>("/context/evaluations/locomo/:jobId", async (request, reply) => {
    const result = getLocomoEvaluationJob(request.params.jobId);
    if (!result) {
      reply.code(404);
      return { ok: false, error: "LoCoMo evaluation job not found" };
    }
    return { ok: true, result };
  });

  app.post<{ Params: { jobId: string } }>("/context/evaluations/locomo/:jobId/cancel", async (request, reply) => {
    const result = cancelLocomoEvaluationJob(request.params.jobId, request.log);
    if (!result) {
      reply.code(404);
      return { ok: false, error: "LoCoMo evaluation job not found" };
    }
    return { ok: true, result };
  });

  app.post("/context/evaluations/longmemeval/debug-snapshot", async (request, reply) => {
    const body = (request.body ?? {}) as {
      datasetPath?: unknown;
      view?: unknown;
      page?: unknown;
      pageSize?: unknown;
      contentQuery?: unknown;
      sampleQuery?: unknown;
    };
    try {
      const result = await readCurrentLongMemEvalDebugSnapshotPage({
        ...(typeof body.datasetPath === "string" ? { datasetPath: body.datasetPath } : {}),
        view: parseLongMemEvalDebugView(body.view),
        page: parseOptionalUnknownInteger(body.page) ?? 1,
        pageSize: parseOptionalUnknownInteger(body.pageSize) ?? 50,
        filters: {
          ...(typeof body.contentQuery === "string" ? { contentQuery: body.contentQuery } : {}),
          ...(typeof body.sampleQuery === "string" ? { sampleQuery: body.sampleQuery } : {})
        }
      });
      return {
        ok: true,
        items: sanitizeDebugSnapshot(result.items),
        timeline: result.timeline,
        page: result.page,
        pageSize: result.pageSize,
        totalItems: result.totalItems,
        totalPages: result.totalPages
      };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "LongMemEval debug snapshot failed"
      };
    }
  });

  app.post("/context/evaluations/longmemeval/context-pack-preview", async (request, reply) => {
    const body = (request.body ?? {}) as Partial<AssembleContextRequest> & {
      datasetPath?: unknown;
      questionId?: unknown;
      llm?: unknown;
    };
    if (typeof body.task !== "string") {
      reply.code(400);
      return { ok: false, error: "task is required" };
    }
    const datasetPath = typeof body.datasetPath === "string" ? body.datasetPath.trim() : "";
    if (!datasetPath) {
      reply.code(400);
      return { ok: false, error: "datasetPath is required" };
    }
    const questionId = typeof body.questionId === "string" ? body.questionId.trim() : "";
    if (!questionId) {
      reply.code(400);
      return { ok: false, error: "questionId is required" };
    }

    try {
      const result = await assembleLongMemEvalContextPackPreview({
        datasetPath,
        questionId,
        task: body.task,
        ...(typeof body.q === "string" ? { q: body.q } : {}),
        layer: isSearchLayer(body.layer) ? body.layer : "all",
        ...(typeof body.tenantId === "string" ? { tenantId: body.tenantId } : {}),
        ...(typeof body.principalId === "string" ? { principalId: body.principalId } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        ...(typeof body.taskId === "string" ? { taskId: body.taskId } : {}),
        requestId: typeof body.requestId === "string" && body.requestId.trim() ? body.requestId.trim() : request.id,
        ...(Array.isArray(body.sourceIds) ? { sourceIds: body.sourceIds.map((item) => String(item).trim()).filter(Boolean) } : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
        ...(typeof body.offset === "number" ? { offset: body.offset } : {}),
        ...(typeof body.tokenBudget === "number" ? { tokenBudget: body.tokenBudget } : {}),
        llmCompression: typeof body.llmCompression === "boolean" ? body.llmCompression : true,
        ...parseLlmOptionsForRequest((body as { llm?: unknown }).llm),
        ...(typeof body.includeInactive === "boolean" ? { includeInactive: body.includeInactive } : {})
      });

      return { ok: true, result };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "LongMemEval context pack preview failed"
      };
    }
  });

  app.get<{ Querystring: { path?: string; page?: string; pageSize?: string; modelRunId?: string } }>("/context/evaluations/longmemeval/jsonl-results", async (request, reply) => {
    const filePath = typeof request.query.path === "string" ? request.query.path.trim() : "";
    if (!filePath) {
      reply.code(400);
      return { ok: false, error: "LongMemEval JSONL path is required" };
    }

    try {
      longMemEvalArtifactStore.assertManagedPath(filePath);
      const result = await readLongMemEvalJsonlResultPage({
        filePath,
        page: parseOptionalInteger(request.query.page) ?? 1,
        pageSize: parseOptionalInteger(request.query.pageSize) ?? 20,
        ...(request.query.modelRunId?.trim() ? { modelRunId: request.query.modelRunId.trim() } : {})
      });
      return { ok: true, result };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "LongMemEval JSONL result parsing failed"
      };
    }
  });

  app.get<{ Params: { jobId: string }; Querystring: { page?: string; pageSize?: string; modelRunId?: string } }>("/context/evaluations/longmemeval/:jobId/results", async (request, reply) => {
    const job = getLongMemEvalJob(request.params.jobId);
    const requestedModelRunId = request.query.modelRunId?.trim();
    const modelArtifact = requestedModelRunId
      ? job?.modelArtifacts?.find((artifact) => artifact.modelRunId === requestedModelRunId)
      : job?.modelArtifacts?.[0];
    if (requestedModelRunId && job?.modelArtifacts?.length && !modelArtifact) {
      reply.code(404);
      return { ok: false, error: `LongMemEval model run not found: ${requestedModelRunId}` };
    }
    const resultPath = modelArtifact?.resultPath ?? job?.resultPath;
    if (!resultPath) {
      reply.code(404);
      return { ok: false, error: job ? "LongMemEval result artifact is not available" : "LongMemEval job not found" };
    }
    try {
      const result = await readLongMemEvalJsonlResultPage({
        filePath: resultPath,
        page: parseOptionalInteger(request.query.page) ?? 1,
        pageSize: parseOptionalInteger(request.query.pageSize) ?? 20,
        ...(requestedModelRunId ? { modelRunId: requestedModelRunId } : {})
      });
      return { ok: true, result };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : "LongMemEval result parsing failed" };
    }
  });

  app.post("/context/evaluations/longmemeval/selected-items", async (request, reply) => {
    const body = (request.body ?? {}) as {
      datasetPath?: unknown;
      questionId?: unknown;
      selectedItemIds?: unknown;
    };
    const datasetPath = typeof body.datasetPath === "string" ? body.datasetPath.trim() : "";
    const questionId = typeof body.questionId === "string" ? body.questionId.trim() : "";
    const selectedItemIds = Array.isArray(body.selectedItemIds)
      ? body.selectedItemIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
    if (!datasetPath) {
      reply.code(400);
      return { ok: false, error: "datasetPath is required" };
    }
    if (!questionId) {
      reply.code(400);
      return { ok: false, error: "questionId is required" };
    }
    if (!selectedItemIds.length) {
      reply.code(400);
      return { ok: false, error: "selectedItemIds is required" };
    }

    try {
      let result;
      try {
        result = await readLongMemEvalSelectedItemDetails(datasetPath, questionId, selectedItemIds);
      } catch {
        result = {
          ...buildLongMemEvalSelectedItemDetails(repository.getDebugSnapshot(), datasetPath, selectedItemIds),
          questionId,
          question: ""
        };
      }
      return {
        ok: true,
        result
      };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "LongMemEval selected item lookup failed"
      };
    }
  });

  app.get<{ Params: { jobId: string } }>("/context/evaluations/longmemeval/:jobId", async (request, reply) => {
    const job = getLongMemEvalJob(request.params.jobId);
    if (!job) {
      reply.code(404);
      request.log.warn({ jobId: request.params.jobId }, "longmemeval job not found");
      return { ok: false, error: "LongMemEval job not found" };
    }
    return { ok: true, result: stripLongMemEvalSamplesFromJob(job) };
  });

  app.get<{ Params: { jobId: string }; Querystring: { page?: string; pageSize?: string } }>("/context/evaluations/longmemeval/:jobId/samples", async (request, reply) => {
    const job = getLongMemEvalJob(request.params.jobId);
    if (!job) {
      reply.code(404);
      request.log.warn({ jobId: request.params.jobId }, "longmemeval sample page target not found");
      return { ok: false, error: "LongMemEval job not found" };
    }

    const page = buildLongMemEvalSamplePage(
      job,
      parseOptionalInteger(request.query.page) ?? 1,
      parseOptionalInteger(request.query.pageSize) ?? 10
    );
    if (!page) {
      reply.code(404);
      return { ok: false, error: "LongMemEval samples not found" };
    }

    return {
      ok: true,
      result: page
    };
  });

  app.get<{ Params: { jobId: string } }>("/context/evaluations/longmemeval/:jobId/debug-snapshot", async (request, reply) => {
    const job = getLongMemEvalJob(request.params.jobId);
    if (!job) {
      reply.code(404);
      request.log.warn({ jobId: request.params.jobId }, "longmemeval debug snapshot target not found");
      return { ok: false, error: "LongMemEval job not found" };
    }

    try {
      const snapshot = sanitizeDebugSnapshot(await readLongMemEvalDebugSnapshot(job.datasetPath));
      return {
        ok: true,
        items: snapshot,
        timeline: await buildTimeline(snapshot)
      };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "LongMemEval debug snapshot failed"
      };
    }
  });

  app.post<{ Params: { jobId: string } }>("/context/evaluations/longmemeval/:jobId/cancel", async (request, reply) => {
    const job = cancelLongMemEvalJob(request.params.jobId, request.log);
    if (!job) {
      reply.code(404);
      request.log.warn({ jobId: request.params.jobId }, "longmemeval job cancel target not found");
      return { ok: false, error: "LongMemEval job not found" };
    }
    return { ok: true, result: job };
  });

  app.delete("/context/evaluations/longmemeval/database", async (request, reply) => {
    try {
      const result = await clearLongMemEvalData();
      request.log.warn({
        deletedFiles: result.storage.deletedFiles.length,
        storeDirectory: result.storage.storeDirectory,
        graphStore: result.graphStore
      }, "longmemeval database cleared");
      return { ok: true, result };
    } catch (error) {
      reply.code(400);
      request.log.error({ error }, "longmemeval database clear failed");
      return {
        ok: false,
        error: error instanceof Error ? error.message : "LongMemEval database clear failed"
      };
    }
  });

  app.post("/context/assemble", async (request, reply) => {
    const body = (request.body ?? {}) as Partial<AssembleContextRequest>;
    if (typeof body.task !== "string") {
      reply.code(400);
      return { ok: false, error: "task is required" };
    }

    try {
      const result = await assembleContext(repository, {
        task: body.task,
        ...(typeof body.q === "string" ? { q: body.q } : {}),
        layer: isContextPackLayer(body.layer) ? body.layer : "all",
        ...(typeof body.tenantId === "string" ? { tenantId: body.tenantId } : {}),
        ...(typeof body.principalId === "string" ? { principalId: body.principalId } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        ...(typeof body.taskId === "string" ? { taskId: body.taskId } : {}),
        requestId: typeof body.requestId === "string" && body.requestId.trim() ? body.requestId.trim() : request.id,
        ...(Array.isArray(body.sourceIds) ? { sourceIds: body.sourceIds.map((item) => String(item).trim()).filter(Boolean) } : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
        ...(typeof body.offset === "number" ? { offset: body.offset } : {}),
        ...parseTemporalContextFields(body),
        ...(typeof body.tokenBudget === "number" ? { tokenBudget: body.tokenBudget } : {}),
        llmCompression: typeof body.llmCompression === "boolean" ? body.llmCompression : true,
        ...parseLlmOptionsForRequest((body as { llm?: unknown }).llm),
        ...(typeof body.includeInactive === "boolean" ? { includeInactive: body.includeInactive } : {})
      });

      return { ok: true, result };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "context assembly failed"
      };
    }
  });

  app.post("/context/dreaming/runs", async (request, reply) => {
    if (!dreamingRuntime) {
      reply.code(503);
      return { ok: false, error: "DREAMING_RUNTIME_UNAVAILABLE" };
    }
    try {
      const owner = parseRequiredDreamingOwner(request.body, request.headers);
      const result = await dreamingRuntime.createManualRun(owner);
      reply.code(202);
      return { ok: true, result: summarizeDreamingRun(result.run) };
    } catch (error) {
      return dreamingRouteError(reply, error);
    }
  });

  app.get("/context/dreaming/runs", async (request, reply) => {
    if (!dreamingRuntime) {
      reply.code(503);
      return { ok: false, error: "DREAMING_RUNTIME_UNAVAILABLE" };
    }
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const owner = parseRequiredDreamingOwner(query, request.headers);
      const statuses = parseDreamingRunStatuses(query.status);
      return {
        ok: true,
        result: {
          items: (await dreamingRuntime.listRuns(owner, statuses)).map(summarizeDreamingRun)
        }
      };
    } catch (error) {
      return dreamingRouteError(reply, error);
    }
  });

  app.get<{ Params: { runId: string } }>("/context/dreaming/runs/:runId", async (request, reply) => {
    if (!dreamingRuntime) {
      reply.code(503);
      return { ok: false, error: "DREAMING_RUNTIME_UNAVAILABLE" };
    }
    try {
      const owner = parseRequiredDreamingOwner(request.query, request.headers);
      const result = await dreamingRuntime.getRun(request.params.runId, owner);
      if (!result) {
        reply.code(404);
        return { ok: false, error: "DREAMING_RUN_NOT_FOUND" };
      }
      return { ok: true, result };
    } catch (error) {
      return dreamingRouteError(reply, error);
    }
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post<{ Params: { runId: string } }>(`/context/dreaming/runs/:runId/${action}`, async (request, reply) => {
      if (!dreamingRuntime) {
        reply.code(503);
        return { ok: false, error: "DREAMING_RUNTIME_UNAVAILABLE" };
      }
      try {
        const owner = parseRequiredDreamingOwner(request.body, request.headers);
        const result = action === "pause"
          ? await dreamingRuntime.pauseRun(request.params.runId, owner)
          : action === "resume"
            ? await dreamingRuntime.resumeRun(request.params.runId, owner)
            : await dreamingRuntime.cancelRun(request.params.runId, owner);
        reply.code(202);
        return { ok: true, result: summarizeDreamingRun(result) };
      } catch (error) {
        return dreamingRouteError(reply, error);
      }
    });
  }

  app.post("/context/dreaming/run", async (request, reply) => {
    const body = (request.body ?? {}) as {
      memoryDataIds?: unknown;
      tenantId?: unknown;
      principalId?: unknown;
      runId?: unknown;
      policyVersion?: unknown;
      now?: unknown;
      llm?: unknown;
    };
    const llm = parseLlmOptionsForRequest(body.llm).llm;
    const options: LlmDreamingOptions = {
      ...(Array.isArray(body.memoryDataIds)
        ? { memoryDataIds: body.memoryDataIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) }
        : {}),
      ...(typeof body.tenantId === "string" && body.tenantId.trim() ? { tenantId: body.tenantId.trim() } : {}),
      ...(typeof body.principalId === "string" && body.principalId.trim() ? { principalId: body.principalId.trim() } : {}),
      ...(typeof body.runId === "string" && body.runId.trim() ? { runId: body.runId.trim() } : {}),
      ...(typeof body.policyVersion === "string" && body.policyVersion.trim() ? { policyVersion: body.policyVersion.trim() } : {}),
      ...(typeof body.now === "string" && body.now.trim() ? { now: body.now.trim() } : {}),
      ...(llm ? llm : {})
    };

    try {
      request.log.info({ memoryDataIds: options.memoryDataIds }, "llm dreaming requested");
      const result = await runLlmDreaming(repository, options);
      request.log.info({
        traceId: result.trace.traceId,
        ltmCount: result.longTermMemories.length,
        fallbackReason: result.fallbackReason
      }, "llm dreaming completed");
      return { ok: true, result };
    } catch (error) {
      request.log.error({ error }, "llm dreaming failed");
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "llm dreaming failed"
      };
    }
  });

  app.get<{ Params: { traceId: string } }>("/context/packs/:traceId", async (request, reply) => {
    const trace = repository.getDebugSnapshot().packTraces.find((item) => item.traceId === request.params.traceId);
    if (!trace) {
      reply.code(404);
      return { ok: false, error: "context pack trace not found" };
    }

    return { ok: true, result: trace };
  });

  app.get("/context/read", async (request, reply) => {
    try {
      const owner = backgroundOwnerScopeFromHeaders(request.headers);
      const snapshot = repository.getDebugSnapshot();
      const background = await repository.getLatestBackgroundDocument(owner.tenantId, owner.principalId);
      return {
        ok: true,
        result: {
          background: background ?? createDefaultBackgroundDocument(snapshot, owner),
          recentTraces: snapshot.packTraces.slice(-5),
          degradedModeReason: background?.degradedModeReason ?? "snapshot_only"
        }
      };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : "invalid background owner" };
    }
  });

  app.get("/context/background", async (request, reply) => {
    try {
      const owner = backgroundOwnerScopeFromHeaders(request.headers);
      const snapshot = repository.getDebugSnapshot();
      const background = await repository.getLatestBackgroundDocument(owner.tenantId, owner.principalId)
        ?? createDefaultBackgroundDocument(snapshot, owner);
      return { ok: true, result: background };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : "invalid background owner" };
    }
  });

  app.post("/context/background/session", async (request, reply) => {
    try {
      const caller = authenticatedBackgroundOwnerScopeFromHeaders(request.headers);
      const input = parseCreateSessionBackgroundRequest(request.body ?? {}, caller);
      const snapshot = await createSessionBackground(repository, input);
      return {
        ok: true,
        result: snapshot,
        handoff: createMainAgentBackgroundHandoff(snapshot)
      };
    } catch (error) {
      request.log.error({ error }, "session background creation failed");
      reply.code(httpStatusForBackgroundError(error));
      return {
        ok: false,
        error: error instanceof Error ? error.message : "session background creation failed"
      };
    }
  });

  app.post("/context/background/maintenance/run", async (request, reply) => {
    try {
      const caller = authenticatedBackgroundOwnerScopeFromHeaders(request.headers);
      const input = parseMaintainFixedBackgroundRequest(request.body ?? {}, caller);
      const result = await maintainFixedBackground(repository, input);
      return { ok: true, result };
    } catch (error) {
      request.log.error({ error }, "fixed background maintenance failed");
      reply.code(httpStatusForBackgroundError(error));
      return {
        ok: false,
        error: error instanceof Error ? error.message : "fixed background maintenance failed"
      };
    }
  });

  app.post("/context/background", async (request, reply) => {
    const body = (request.body ?? {}) as {
      fixedText?: unknown;
      dynamicText?: unknown;
      sourceRefIds?: unknown;
      conflictIds?: unknown;
      degradedModeReason?: unknown;
      updateSuggestion?: unknown;
      fixedWatermark?: unknown;
      dynamicWindowStart?: unknown;
      dynamicWindowEnd?: unknown;
      dynamicSourceMemoryIds?: unknown;
      latestStmCursor?: unknown;
      dynamicCacheKey?: unknown;
    };
    try {
      const owner = backgroundOwnerScopeFromHeaders(request.headers);
      const snapshot = repository.getDebugSnapshot();
      const existing = await repository.getLatestBackgroundDocument(owner.tenantId, owner.principalId);
      const fallback = existing ?? createDefaultBackgroundDocument(snapshot, owner);
      const now = new Date().toISOString();
      const fixedText = typeof body.fixedText === "string" && body.fixedText.trim()
        ? body.fixedText.trim()
        : fallback.fixedText;
      const fixedWatermark = backgroundCursorFromUnknown(
        body.fixedWatermark,
        fallback.fixedWatermark,
        "BACKGROUND_FIXED_WATERMARK_INVALID"
      );
      const fixedChanged = !existing ||
        fixedText !== existing.fixedText ||
        !sameBackgroundCursor(fixedWatermark, existing.fixedWatermark);
      const fixedRevision = existing
        ? existing.fixedRevision + (fixedChanged ? 1 : 0)
        : 1;
      const fixedTextUpdatedAt = fixedChanged ? now : fallback.fixedTextUpdatedAt;
      const dynamicWindowEnd = backgroundTimestampFromUnknown(
        body.dynamicWindowEnd,
        now,
        "BACKGROUND_DYNAMIC_WINDOW_END_INVALID"
      );
      const dynamicWindowStart = backgroundTimestampFromUnknown(
        body.dynamicWindowStart,
        fixedChanged ? fixedTextUpdatedAt : existing?.dynamicWindowStart ?? fixedTextUpdatedAt,
        "BACKGROUND_DYNAMIC_WINDOW_START_INVALID"
      );
      if (dynamicWindowStart > dynamicWindowEnd) {
        throw new Error("BACKGROUND_DYNAMIC_WINDOW_INVALID");
      }
      const updateSuggestion = parseBackgroundUpdateSuggestion(body.updateSuggestion)
        ?? existing?.updateSuggestion
        ?? { status: "pending", summary: "待审阅背景更新建议", targetSections: [] };
      const dynamicCacheKey = body.dynamicCacheKey === null
        ? undefined
        : typeof body.dynamicCacheKey === "string"
          ? body.dynamicCacheKey.trim() || undefined
          : fixedChanged ? undefined : existing?.dynamicCacheKey;
      const degradedModeReason = typeof body.degradedModeReason === "string"
        ? body.degradedModeReason.trim() || undefined
        : existing?.degradedModeReason;

      const background: BackgroundContextDocument = {
        backgroundId: fixedChanged
          ? `background_${Date.now()}_${Math.random().toString(16).slice(2)}`
          : fallback.backgroundId,
        ...owner,
        fixedText,
        dynamicText: typeof body.dynamicText === "string" && body.dynamicText.trim()
          ? body.dynamicText.trim()
          : fixedChanged
            ? renderBackgroundMarkdown(createEmptyBackgroundSections("dynamic"), "dynamic")
            : fallback.dynamicText,
        fixedRevision,
        fixedTextUpdatedAt,
        fixedWatermark,
        dynamicWindowStart,
        dynamicWindowEnd,
        dynamicSourceMemoryIds: stringArrayFromUnknown(body.dynamicSourceMemoryIds)
          ?? (fixedChanged ? [] : existing?.dynamicSourceMemoryIds)
          ?? [],
        latestStmCursor: backgroundCursorFromUnknown(
          body.latestStmCursor,
          fixedChanged ? fixedWatermark : existing?.latestStmCursor ?? INITIAL_BACKGROUND_CURSOR,
          "BACKGROUND_LATEST_STM_CURSOR_INVALID"
        ),
        sourceRefIds: stringArrayFromUnknown(body.sourceRefIds) ?? fallback.sourceRefIds,
        conflictIds: stringArrayFromUnknown(body.conflictIds) ?? fallback.conflictIds,
        ...(dynamicCacheKey ? { dynamicCacheKey } : {}),
        ...(degradedModeReason ? { degradedModeReason } : {}),
        updateSuggestion,
        createdAt: fixedChanged ? now : fallback.createdAt,
        updatedAt: now
      };
      await repository.saveBackgroundDocument(background);
      return { ok: true, result: background };
    } catch (error) {
      request.log.error({ error }, "background document write failed");
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : "background document write failed" };
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/context/search-data-lake", async (request) => {
    const snapshot = repository.getDebugSnapshot();
    const query = (request.query.q ?? "").trim().toLowerCase();
    const sourceFilters = buildSourceFilters(request.query);
    const customFieldFilters = parseCustomFieldFilters(request.query);
    const limit = parseOptionalInteger(request.query.limit) ?? 25;
    const offset = parseOptionalInteger(request.query.offset) ?? 0;
    const matches = [
      ...snapshot.parsedSegments.map((segment) => {
        const event = snapshot.memoryEvents.find((item) => item.eventId === segment.eventId);
        return {
          id: segment.segmentId,
          type: "segment" as const,
          content: segment.content,
          status: segment.status,
          dataSource: segment.dataSource ?? dataSourceFromEvent(event),
          customFields: mergeDataLakeCustomFields(event?.customFields, segment.customFields),
          sourceRefIds: event ? sourceRefsFromEvent(event).map((item) => item.sourceRefId) : []
        };
      }),
      ...snapshot.facts.map((fact) => ({
        id: fact.factId,
        type: "fact" as const,
        content: fact.factText,
        status: fact.status,
        dataSource: dataSourceFromEvent(snapshot.memoryEvents.find((event) => fact.linkedEventIds.includes(event.eventId))),
        customFields: mergeFactCustomFields(fact.linkedSegmentIds, snapshot.parsedSegments),
        sourceRefIds: fact.linkedSourceRefs.map((item) => item.sourceRefId)
      }))
    ]
      .filter((item) => !query || normalizeSearchableText(item.content).toLowerCase().includes(query))
      .filter((item) => matchesSourceFilters(item.dataSource, sourceFilters))
      .filter((item) => matchesCustomFieldFilters(item.customFields, customFieldFilters));

    return {
      ok: true,
      result: {
        q: query,
        total: matches.length,
        limit,
        offset,
        items: matches.slice(offset, offset + limit)
      }
    };
  });

  app.get<{ Querystring: { targetId?: string; targetType?: string; limit?: string; offset?: string } }>("/context/memory-change-events", async (request) => {
    const snapshot = repository.getDebugSnapshot();
    const targetId = request.query.targetId?.trim();
    const targetType = request.query.targetType?.trim();
    const limit = parseOptionalInteger(request.query.limit) ?? 25;
    const offset = parseOptionalInteger(request.query.offset) ?? 0;
    const items = snapshot.changeEvents
      .filter((item) => !targetId || item.memoryId === targetId || item.memoryDataId === targetId)
      .filter((item) => !targetType || item.storageLayer === targetType)
      .slice(offset, offset + limit);

    return {
      ok: true,
      result: {
        total: items.length,
        limit,
        offset,
        items
      }
    };
  });

  app.post("/context/feedback", async (request, reply) => {
    const body = (request.body ?? {}) as Partial<MemoryFeedbackItem> & { targetId?: unknown; targetType?: unknown };
    if (typeof body.targetId !== "string" || typeof body.targetType !== "string" || typeof body.action !== "string") {
      reply.code(400);
      return { ok: false, error: "targetId, targetType and action are required" };
    }
    if (!isFeedbackTargetType(body.targetType) || !isFeedbackAction(body.action)) {
      reply.code(400);
      return { ok: false, error: "invalid feedback target or action" };
    }

    const item: MemoryFeedbackItem = {
      feedbackId: `feedback_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      targetId: body.targetId,
      targetType: body.targetType,
      action: body.action,
      ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim() } : {}),
      ...(typeof body.tenantId === "string" ? { tenantId: body.tenantId } : {}),
      ...(typeof body.principalId === "string" ? { principalId: body.principalId } : {}),
      ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      ...(typeof body.taskId === "string" ? { taskId: body.taskId } : {}),
      requestId: typeof body.requestId === "string" && body.requestId.trim() ? body.requestId.trim() : request.id,
      createdAt: new Date().toISOString()
    };
    await repository.saveMemoryFeedback(item);
    await repository.saveMemoryChangeEvent(createChangeEvent({
      ...(body.targetType === "ltm" ? { memoryId: body.targetId } : {}),
      ...(body.targetType !== "ltm" ? { memoryDataId: body.targetId } : {}),
      changeType: "feedback_received",
      storageLayer: body.targetType,
      reason: `feedback:${body.action}`
    }));

    if (body.action === "correct" || body.action === "confirm") {
      await repository.savePipelineTask({
        taskId: `revision_${item.feedbackId}`,
        eventId: body.targetId,
        taskType: "revision",
        status: "pending",
        attempt: 1,
        maxAttempts: 1,
        retryable: false,
        stage: `revision_requested:${body.action}`,
        createdAt: item.createdAt,
        updatedAt: item.createdAt
      });
      await repository.saveMemoryChangeEvent(createChangeEvent({
        ...(body.targetType === "ltm" ? { memoryId: body.targetId } : {}),
        ...(body.targetType !== "ltm" ? { memoryDataId: body.targetId } : {}),
        changeType: "revision_requested",
        storageLayer: body.targetType,
        reason: `feedback:${body.action}`
      }));
    }

    return { ok: true, result: item };
  });

  app.post("/context/permissions/invalidate", async (request, reply) => {
    const body = (request.body ?? {}) as {
      sourceRefIds?: unknown;
      reason?: unknown;
    };
    if (!Array.isArray(body.sourceRefIds) || !body.sourceRefIds.some((item) => typeof item === "string" && item.trim())) {
      reply.code(400);
      return { ok: false, error: "sourceRefIds are required" };
    }
    const sourceRefIds = body.sourceRefIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    const result = await repository.markPermissionInvalidated(sourceRefIds, typeof body.reason === "string" ? body.reason : undefined);
    return { ok: true, result };
  });

  app.post<{ Params: { id: string } }>("/context/memories/stm/:id/promote", async (request, reply) => {
    const snapshot = repository.getDebugSnapshot();
    const stm = snapshot.shortTermMemories.find((memory) => memory.memoryDataId === request.params.id);

    if (!stm) {
      reply.code(404);
      return { ok: false, error: "short term memory not found" };
    }

    const promoted: LongTermMemory = {
      memoryId: `ltm_${stm.memoryDataId}`,
      theoryClass: "semantic",
      memoryType: normalizePrdMemoryType(stm.memoryType ?? stm.memoryDataType, "knowledge"),
      content: stm.content,
      ...(stm.structuredFacts ? { structuredFacts: { ...stm.structuredFacts, memoryKind: "long_term" as const } } : {}),
      factSummary: stm.factSummary ?? summarizeStructuredFacts(stm),
      ...(stm.summary ? { summary: stm.summary } : {}),
      sourceRefs: stm.sourceRefs,
      sourceMemoryDataIds: [stm.memoryDataId],
      entityIds: stm.entityIds,
      confidenceLevel: stm.confidenceLevel,
      recallWeight: stm.importanceLevel === "critical" || stm.importanceLevel === "high" ? "high" : "medium",
      solidifyReason: "debug_promote_from_stm",
      matchedRules: [...stm.matchedRules, "debug_promote"],
      lifecycleStatus: "active"
    };

    await repository.replaceLongTermMemory(promoted);
    await repository.replaceShortTermMemory({
      ...stm,
      lifecycleStatus: "archived"
    });
    await repository.saveMemoryChangeEvent(createChangeEvent({
      memoryId: promoted.memoryId,
      memoryDataId: stm.memoryDataId,
      changeType: "created",
      storageLayer: "ltm",
      reason: "debug_promote_from_stm"
    }));

    return { ok: true, result: promoted };
  });

  app.patch<{ Params: { layer: "stm" | "ltm"; id: string } }>(
    "/context/memories/:layer/:id",
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        content?: unknown;
        lifecycleStatus?: unknown;
        summary?: unknown;
        recallWeight?: unknown;
        userRetrievalWeight?: unknown;
      };
      const snapshot = repository.getDebugSnapshot();

      if (request.params.layer === "stm") {
        const memory = snapshot.shortTermMemories.find((item) => item.memoryDataId === request.params.id);
        if (!memory) {
          reply.code(404);
          return { ok: false, error: "short term memory not found" };
        }

        const updated: ShortTermMemory = {
          ...memory,
          ...(typeof body.content === "string" ? { content: body.content } : {}),
          ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
          ...(isRetrievalWeight(body.userRetrievalWeight)
            ? { userRetrievalWeight: body.userRetrievalWeight }
            : {}),
          ...(isShortTermLifecycle(body.lifecycleStatus)
            ? {
                lifecycleStatus: body.lifecycleStatus,
                ...(body.lifecycleStatus === "archived" ? { userRetrievalWeight: 0 } : {})
              }
            : {})
        };
        await repository.replaceShortTermMemory(updated);
        await refreshShortTermMemoryIndex(repository, updated);
        await repository.saveMemoryChangeEvent(createChangeEvent({
          memoryDataId: updated.memoryDataId,
          changeType: "updated",
          storageLayer: "stm",
          reason: `debug_memory_update:${updated.lifecycleStatus}`
        }));
        await repository.saveMemoryChangeEvent(createChangeEvent({
          memoryDataId: updated.memoryDataId,
          changeType: "updated",
          storageLayer: "stm",
          reason: "debug_memory_update"
        }));

        return { ok: true, result: updated };
      }

      const memory = snapshot.longTermMemories.find((item) => item.memoryId === request.params.id);
      if (!memory) {
        reply.code(404);
        return { ok: false, error: "long term memory not found" };
      }
      if (memory.lifecycleStatus === "deleted" && changesDeletedLongTermMemory(body)) {
        reply.code(400);
        return { ok: false, error: "deleted long term memory cannot be restored or updated through lifecycle review" };
      }

      const updated: LongTermMemory = {
        ...memory,
        ...(typeof body.content === "string" ? { content: body.content } : {}),
        ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
        ...(isRecallWeight(body.recallWeight)
          ? {
              recallWeight: body.recallWeight,
              userRetrievalWeight: longTermRetrievalWeight(body.recallWeight)
            }
          : {}),
        ...(isRetrievalWeight(body.userRetrievalWeight)
          ? { userRetrievalWeight: body.userRetrievalWeight }
          : {}),
        ...(isLongTermLifecycle(body.lifecycleStatus)
          ? {
              lifecycleStatus: body.lifecycleStatus,
              ...(body.lifecycleStatus === "archived" ? { userRetrievalWeight: 0 } : {})
            }
          : {})
      };
      await repository.replaceLongTermMemory(updated);
      await refreshLongTermMemoryIndex(repository, updated);
      await reconcileLongTermLifecycle(repository, updated);
      await repository.saveMemoryChangeEvent(createChangeEvent({
        memoryId: updated.memoryId,
        changeType: longTermManualChangeType(memory, updated),
        storageLayer: "ltm",
        reason: longTermManualChangeReason(memory, updated)
      }));

      return { ok: true, result: updated };
    }
  );
}

const foregroundContextRoutes = new Set([
  "/context/events",
  "/context/ingest/files",
  "/context/agent-memory",
  "/context/assemble",
  "/context/memory-graph/query",
  "/context/mcp",
  "/context/tools/write-memory-event",
  "/context/tools/ingest-conversation-batch-document",
  "/context/search",
  "/context/background/session",
  "/context/feedback",
  "/context/permissions/invalidate"
]);

function registerForegroundActivityHooks(app: FastifyInstance, runtime: DreamingRuntime) {
  const releases = new WeakMap<object, () => void>();
  app.addHook("preHandler", async (request) => {
    const route = request.routeOptions.url;
    if (!route || !foregroundContextRoutes.has(route)) return;
    const owner = inferForegroundOwner(request.body, request.headers);
    releases.set(request, await runtime.activityGate.acquire(owner));
  });
  const release = (request: object) => {
    releases.get(request)?.();
    releases.delete(request);
  };
  app.addHook("onResponse", async (request) => release(request));
  app.addHook("onError", async (request) => release(request));
}

function inferForegroundOwner(
  value: unknown,
  headers: Record<string, string | string[] | undefined>
) {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const event = raw.event && typeof raw.event === "object" ? raw.event as Record<string, unknown> : {};
  const permission = event.permissionSnapshot && typeof event.permissionSnapshot === "object"
    ? event.permissionSnapshot as Record<string, unknown>
    : {};
  const tenantId = firstNonEmptyString(
    raw.tenantId,
    permission.tenantId,
    singleHeader(headers["x-context-tenant-id"])
  ) ?? "local";
  const principalId = firstNonEmptyString(
    raw.principalId,
    permission.principalId,
    singleHeader(headers["x-context-principal-id"])
  ) ?? "debug-user";
  return { tenantId, principalId };
}

function parseRequiredDreamingOwner(
  value: unknown,
  headers: Record<string, string | string[] | undefined>
) {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const tenantId = firstNonEmptyString(raw.tenantId, singleHeader(headers["x-context-tenant-id"]));
  const principalId = firstNonEmptyString(raw.principalId, singleHeader(headers["x-context-principal-id"]));
  if (!tenantId || !principalId) throw new Error("DREAMING_OWNER_REQUIRED");
  return { tenantId, principalId };
}

function parseDreamingRunStatuses(value: unknown): DreamingRunStatus[] | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error("DREAMING_RUN_STATUS_INVALID");
  const allowed = new Set<DreamingRunStatus>([
    "queued",
    "waiting_for_idle",
    "running",
    "pausing",
    "paused",
    "completed",
    "cancelled",
    "failed"
  ]);
  const statuses = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!statuses.length || statuses.some((status) => !allowed.has(status as DreamingRunStatus))) {
    throw new Error("DREAMING_RUN_STATUS_INVALID");
  }
  return [...new Set(statuses)] as DreamingRunStatus[];
}

function summarizeDreamingRun(run: DreamingRun) {
  return {
    runId: run.runId,
    triggerType: run.triggerType,
    status: run.status,
    candidateWindowStartAt: run.candidateWindowStartAt,
    candidateCutoffAt: run.candidateCutoffAt,
    candidateCount: run.candidateCount,
    processedCount: run.processedCount,
    consolidatedCount: run.consolidatedCount,
    observingCount: run.observingCount,
    droppedCount: run.droppedCount,
    retryWaitCount: run.retryWaitCount,
    skippedCount: run.skippedCount,
    ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}),
    ...(run.actualStartedAt ? { actualStartedAt: run.actualStartedAt } : {}),
    ...(run.pausedAt ? { pausedAt: run.pausedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {})
  };
}

function dreamingRouteError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "DREAMING_REQUEST_FAILED";
  if (error instanceof DreamingRuntimeDisabledError) reply.code(503);
  else if (message === "DREAMING_RUN_NOT_FOUND") reply.code(404);
  else if (message.includes("NOT_PAUSABLE") || message.includes("NOT_RESUMABLE") || message.includes("NOT_CANCELLABLE")) reply.code(409);
  else reply.code(400);
  return { ok: false, error: message };
}

function firstNonEmptyString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
}

function parseLlmOptionsForRequest(value: unknown): { llm?: LlmFactFusionOptions } {
  if (!value || typeof value !== "object") return {};
  const raw = value as {
    apiKey?: unknown;
    baseUrl?: unknown;
    model?: unknown;
  };
  const llm: LlmFactFusionOptions = {};
  if (typeof raw.apiKey === "string") llm.apiKey = raw.apiKey.trim();
  if (typeof raw.baseUrl === "string" && raw.baseUrl.trim()) llm.baseUrl = raw.baseUrl.trim();
  if (typeof raw.model === "string" && raw.model.trim()) llm.model = raw.model.trim();
  return Object.keys(llm).length ? { llm } : {};
}

function parseDataLakeCustomFieldsForRequest(value: unknown): { customFields?: MemoryEvent["customFields"] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const customFields = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key, field]) => key.trim() && isDataLakeCustomFieldValue(field)
    )
  ) as NonNullable<MemoryEvent["customFields"]>;
  return Object.keys(customFields).length ? { customFields } : {};
}

function isDataLakeCustomFieldValue(value: unknown): value is NonNullable<MemoryEvent["customFields"]>[string] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return true;
  if (Array.isArray(value)) return value.every(isDataLakeCustomFieldValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isDataLakeCustomFieldValue);
  return false;
}

function parseLongMemEvalLlmOptions(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as {
    extraction?: {
      baseUrl?: unknown;
      model?: unknown;
      apiKey?: unknown;
    };
    judge?: {
      baseUrl?: unknown;
      model?: unknown;
      apiKey?: unknown;
    };
    answer?: {
      baseUrl?: unknown;
      model?: unknown;
      apiKey?: unknown;
    };
  };

  const llm = {
    ...(normalizeLlmSection(payload.extraction) ? { extraction: normalizeLlmSection(payload.extraction)! } : {}),
    ...(normalizeLlmSection(payload.judge) ? { judge: normalizeLlmSection(payload.judge)! } : {}),
    ...(normalizeLlmSection(payload.answer) ? { answer: normalizeLlmSection(payload.answer)! } : {})
  };

  return Object.keys(llm).length ? llm : undefined;
}

function parseLongMemEvalLlmRuns(value: unknown) {
  const rawRuns = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { runs?: unknown }).runs)
      ? (value as { runs: unknown[] }).runs
      : [];
  const runs = rawRuns
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const payload = item as {
        runId?: unknown;
        id?: unknown;
        label?: unknown;
        diagnosticsPath?: unknown;
        tracePath?: unknown;
        llm?: unknown;
        extraction?: unknown;
        judge?: unknown;
      };
      const llm = parseLongMemEvalLlmOptions(
        payload.llm && typeof payload.llm === "object"
          ? payload.llm
          : {
              extraction: payload.extraction,
              judge: payload.judge
            }
      );
      return {
        ...(typeof payload.runId === "string" && payload.runId.trim() ? { runId: payload.runId.trim() } : {}),
        ...(typeof payload.id === "string" && payload.id.trim() ? { runId: payload.id.trim() } : {}),
        ...(typeof payload.label === "string" && payload.label.trim() ? { label: payload.label.trim() } : {}),
        ...(llm ? { llm } : {}),
        ...(typeof payload.diagnosticsPath === "string" && payload.diagnosticsPath.trim() ? { diagnosticsPath: payload.diagnosticsPath.trim() } : {}),
        ...(typeof payload.tracePath === "string" && payload.tracePath.trim() ? { tracePath: payload.tracePath.trim() } : {})
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return runs.length ? runs : undefined;
}

function parseLongMemEvalAnswerContextMode(value: unknown) {
  return value === "retrieval" ? "retrieval" : "context_pack";
}

function normalizeLlmSection(value: { baseUrl?: unknown; model?: unknown; apiKey?: unknown } | undefined) {
  if (!value || typeof value !== "object") return undefined;
  const section: { baseUrl?: string; model?: string; apiKey?: string } = {};
  if (typeof value.baseUrl === "string" && value.baseUrl.trim()) section.baseUrl = value.baseUrl.trim();
  if (typeof value.model === "string" && value.model.trim()) section.model = value.model.trim();
  if (typeof value.apiKey === "string" && value.apiKey.trim()) section.apiKey = value.apiKey.trim();
  return Object.keys(section).length ? section : undefined;
}

type DebugSnapshot = ReturnType<ContextEngineRepository["getDebugSnapshot"]>;

function parseLongMemEvalDebugView(value: unknown): LongMemEvalDebugView {
  return value === "timeline" || value === "stm" || value === "ltm" ? value : "dataLake";
}

async function buildTimeline(snapshot: DebugSnapshot) {
  const aggregatedFacts = await buildTimelineAggregatedFactsWithLlm(snapshot.facts);
  return aggregatedFacts
    .map((fact) => {
      const sourceEvents = snapshot.memoryEvents.filter((event) => fact.sourceEventIds.includes(event.eventId));
      const sourceSegments = snapshot.parsedSegments.filter((segment) =>
        fact.sourceEventIds.includes(segment.eventId) && fact.sourceSegmentIds.includes(segment.segmentId)
      );
      const sourceMemoryIds = snapshot.shortTermMemories.filter((memory) =>
        arrayOrEmpty(memory.sourceFactIds).some((factId) => fact.sourceFactIds.includes(factId))
      );

      return {
        fact,
        sourceEvents,
        sourceSegments,
        sourceFacts: snapshot.facts.filter((item) => fact.sourceFactIds.includes(item.factId)),
        shortTermMemories: sourceMemoryIds,
        pipelineTasks: snapshot.pipelineTasks.filter((task) =>
          fact.sourceEventIds.includes(task.eventId)
        ),
        changeEvents: snapshot.changeEvents.filter((change) =>
          (change.memoryDataId ? fact.sourceEventIds.includes(change.memoryDataId) : false) ||
          (change.memoryDataId ? sourceMemoryIds.some((memory) => memory.memoryDataId === change.memoryDataId) : false)
        )
      };
    })
    .sort((a, b) => (
      a.fact.validTimeStart ?? a.fact.evidenceTimeStart ?? ""
    ).localeCompare(b.fact.validTimeStart ?? b.fact.evidenceTimeStart ?? ""));
}

function arrayOrEmpty<T>(items: T[] | undefined): T[] {
  return Array.isArray(items) ? items : [];
}

function memoryGraphQueryLogSummary(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const layers = Array.isArray(input.layers)
    ? input.layers.filter(isMemoryGraphLayer)
    : undefined;
  const relationTypes = Array.isArray(input.relationTypes)
    ? input.relationTypes.filter(isMemoryGraphRelationType)
    : undefined;
  const nodeLimit = memoryGraphPageLimit(input.nodePage);
  const edgeLimit = memoryGraphPageLimit(input.edgePage);
  const page = memoryGraphPageNumber(input.page);
  return {
    layers: layers?.length ? layers : "default",
    relationTypes: relationTypes?.length ? relationTypes : "default",
    nodePage: input.nodePage === null ? "stopped" : "requested",
    edgePage: input.edgePage === null ? "stopped" : "requested",
    ...(nodeLimit !== undefined
      ? { nodeLimit }
      : {}),
    ...(edgeLimit !== undefined
      ? { edgeLimit }
      : {}),
    ...(page !== undefined ? { page } : {})
  };
}

function configuredGraphStoreMode() {
  try {
    return getContextEngineConfig().graphStore.mode;
  } catch {
    return "unknown" as const;
  }
}

function memoryGraphPageLimit(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const limit = (value as Record<string, unknown>).limit;
  return Number.isSafeInteger(limit) ? limit as number : undefined;
}

function memoryGraphPageNumber(value: unknown) {
  return Number.isSafeInteger(value) ? value as number : undefined;
}

function memoryGraphQueryErrorMessage(code: MemoryGraphQueryErrorCode) {
  switch (code) {
    case "INVALID_MEMORY_GRAPH_QUERY":
      return "Invalid memory graph query.";
    case "INVALID_MEMORY_GRAPH_CURSOR":
      return "Invalid memory graph cursor.";
    case "MEMORY_GRAPH_QUERY_FAILED":
      return "Memory graph query failed.";
  }
}

function createChangeEvent(input: Omit<MemoryChangeEvent, "eventId" | "createdAt">): MemoryChangeEvent {
  return {
    ...input,
    eventId: `mce_debug_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString()
  };
}

function createDefaultBackgroundDocument(
  snapshot: ReturnType<ContextEngineRepository["getDebugSnapshot"]>,
  owner: { tenantId: string; principalId: string }
): BackgroundContextDocument {
  const now = new Date().toISOString();
  const ownerMemoryIds = new Set(snapshot.shortTermMemories
    .filter((memory) => memory.tenantId === owner.tenantId && memory.principalId === owner.principalId)
    .map((memory) => memory.memoryDataId));
  return {
    backgroundId: "background_default",
    ...owner,
    fixedText: renderBackgroundMarkdown(createEmptyBackgroundSections("fixed"), "fixed"),
    dynamicText: renderBackgroundMarkdown(createEmptyBackgroundSections("dynamic"), "dynamic"),
    fixedRevision: 1,
    fixedTextUpdatedAt: now,
    fixedWatermark: { ...INITIAL_BACKGROUND_CURSOR },
    dynamicWindowStart: now,
    dynamicWindowEnd: now,
    dynamicSourceMemoryIds: [],
    latestStmCursor: { ...INITIAL_BACKGROUND_CURSOR },
    sourceRefIds: [...new Set(snapshot.memoryEvents
      .filter((event) =>
        event.permissionSnapshot.tenantId === owner.tenantId &&
        event.permissionSnapshot.principalId === owner.principalId
      )
      .flatMap((event) => sourceRefsFromEvent(event).map((item) => item.sourceRefId)))],
    conflictIds: snapshot.relationEdges
      .filter((edge) =>
        edge.relationType === "conflicts_with" &&
        (ownerMemoryIds.has(edge.fromId) || ownerMemoryIds.has(edge.toId))
      )
      .map((edge) => edge.edgeId),
    ...(snapshot.packTraces.length ? {} : { degradedModeReason: "no_pack_traces" }),
    updateSuggestion: {
      status: "pending",
      summary: "建议审阅近期高价值背景变化。",
      targetSections: ["identity", "relationships", "recentTasks", "aiSoul"]
    },
    createdAt: now,
    updatedAt: now
  };
}

function changesDeletedLongTermMemory(body: {
  content?: unknown;
  lifecycleStatus?: unknown;
  summary?: unknown;
  recallWeight?: unknown;
  userRetrievalWeight?: unknown;
}) {
  if (isLongTermLifecycle(body.lifecycleStatus) && body.lifecycleStatus !== "deleted") return true;
  return typeof body.content === "string" || typeof body.summary === "string" || isRecallWeight(body.recallWeight) || isRetrievalWeight(body.userRetrievalWeight);
}

function longTermManualChangeType(
  previous: LongTermMemory,
  updated: LongTermMemory
): MemoryChangeEvent["changeType"] {
  if (previous.lifecycleStatus !== updated.lifecycleStatus) {
    if (updated.lifecycleStatus === "weakened") return "weakened";
    if (updated.lifecycleStatus === "archived") return "archived";
    if (updated.lifecycleStatus === "deleted") return "deleted";
    if (updated.lifecycleStatus === "revised") return "revised";
  }
  if (previous.recallWeight !== updated.recallWeight || previous.userRetrievalWeight !== updated.userRetrievalWeight) {
    return "weakened";
  }
  return "updated";
}

function longTermManualChangeReason(previous: LongTermMemory, updated: LongTermMemory) {
  if (previous.lifecycleStatus !== updated.lifecycleStatus) {
    if (updated.lifecycleStatus === "active" && previous.lifecycleStatus === "archived") return "manual_restore_from_archived";
    if (updated.lifecycleStatus === "active" && previous.lifecycleStatus === "weakened") return "manual_restore_from_weakened";
    return `debug_memory_update:${longTermLifecycleChangeReason(updated.lifecycleStatus)}`;
  }
  if (previous.recallWeight !== updated.recallWeight || previous.userRetrievalWeight !== updated.userRetrievalWeight) {
    return `manual_recall_weight_update:${previous.recallWeight}->${updated.recallWeight}`;
  }
  return `debug_memory_update:${updated.lifecycleStatus}`;
}

function parseBackgroundUpdateSuggestion(
  value: unknown
): NonNullable<BackgroundContextDocument["updateSuggestion"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const suggestion = value as { status?: unknown; summary?: unknown; targetSections?: unknown };
  if (
    suggestion.status !== "pending" &&
    suggestion.status !== "applied" &&
    suggestion.status !== "rejected"
  ) return undefined;
  if (typeof suggestion.summary !== "string" || !suggestion.summary.trim()) return undefined;
  if (suggestion.targetSections !== undefined && !Array.isArray(suggestion.targetSections)) return undefined;
  const targetSections = (suggestion.targetSections ?? []).filter(isBackgroundSectionKey);
  if (Array.isArray(suggestion.targetSections) && targetSections.length !== suggestion.targetSections.length) {
    return undefined;
  }
  return {
    status: suggestion.status,
    summary: suggestion.summary.trim(),
    targetSections: [...new Set(targetSections)]
  };
}

function backgroundCursorFromUnknown(
  value: unknown,
  fallback: BackgroundContextDocument["latestStmCursor"],
  errorCode: string
): BackgroundContextDocument["latestStmCursor"] {
  if (value === undefined) return { ...fallback };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  const cursor = value as { updatedAt?: unknown; memoryDataId?: unknown };
  if (
    typeof cursor.updatedAt !== "string" ||
    !isIsoTimestampValue(cursor.updatedAt) ||
    typeof cursor.memoryDataId !== "string"
  ) {
    throw new Error(errorCode);
  }
  return { updatedAt: cursor.updatedAt, memoryDataId: cursor.memoryDataId };
}

function sameBackgroundCursor(
  left: BackgroundContextDocument["latestStmCursor"],
  right: BackgroundContextDocument["latestStmCursor"]
) {
  return left.updatedAt === right.updatedAt && left.memoryDataId === right.memoryDataId;
}

function backgroundTimestampFromUnknown(value: unknown, fallback: string, errorCode: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !isIsoTimestampValue(value)) throw new Error(errorCode);
  return value;
}

function stringArrayFromUnknown(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("BACKGROUND_STRING_ARRAY_INVALID");
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim()))];
}

function isBackgroundSectionKey(
  value: unknown
): value is NonNullable<BackgroundContextDocument["updateSuggestion"]>["targetSections"][number] {
  return value === "identity" ||
    value === "relationships" ||
    value === "recentTasks" ||
    value === "aiSoul";
}

function isIsoTimestampValue(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isFeedbackTargetType(value: unknown): value is MemoryFeedbackItem["targetType"] {
  return value === "fact" || value === "stm" || value === "ltm";
}

function isFeedbackAction(value: unknown): value is MemoryFeedbackItem["action"] {
  return value === "like" || value === "dislike" || value === "correct" || value === "confirm" || value === "ignore" || value === "delete";
}

function isShortTermLifecycle(value: unknown): value is ShortTermMemory["lifecycleStatus"] {
  return (
    value === "active" ||
    value === "pending_confirm" ||
    value === "rejected" ||
    value === "expired" ||
    value === "candidate_queue" ||
    value === "consolidated" ||
    value === "dropped" ||
    value === "archived" ||
    value === "deleted"
  );
}

function isLongTermLifecycle(value: unknown): value is LongTermMemory["lifecycleStatus"] {
  return (
    value === "active" ||
    value === "weakened" ||
    value === "archived" ||
    value === "rejected" ||
    value === "deleted" ||
    value === "revised"
  );
}

function isRecallWeight(value: unknown): value is LongTermMemory["recallWeight"] {
  return value === "low" || value === "medium" || value === "high";
}

function isRetrievalWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isVisibility(value: unknown): value is MemoryEvent["permissionSnapshot"]["visibility"] {
  return value === "private" || value === "team" || value === "tenant" || value === "public";
}

function parseWriteAgentMemoryInput(value: unknown): WriteAgentMemoryInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as {
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
  if (typeof body.content !== "string" || typeof body.idempotencyKey !== "string") return undefined;
  return {
    content: body.content,
    idempotencyKey: body.idempotencyKey,
    ...(typeof body.tenantId === "string" ? { tenantId: body.tenantId } : {}),
    ...(typeof body.principalId === "string" ? { principalId: body.principalId } : {}),
    ...(isVisibility(body.visibility) ? { visibility: body.visibility } : {}),
    ...(typeof body.sourceApp === "string" ? { sourceApp: body.sourceApp } : {}),
    ...(typeof body.sourceId === "string" ? { sourceId: body.sourceId } : {}),
    ...(typeof body.memoryType === "string" ? { memoryType: body.memoryType } : {}),
    ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
    ...(typeof body.eventTime === "string" ? { eventTime: body.eventTime } : {})
  };
}

function isSearchLayer(value: unknown): value is NonNullable<ContextQuery["layer"]> {
  return value === "all" || value === "evidence" || value === "fact" || value === "stm" || value === "ltm";
}

function parseTemporalContextFields(input: {
  referenceTime?: unknown;
  timezone?: unknown;
  locale?: unknown;
  timeRange?: unknown;
}): Pick<ContextQuery, "referenceTime" | "timezone" | "locale" | "timeRange"> {
  const timeRange = parseTemporalSearchRange(input.timeRange);
  return {
    ...(typeof input.referenceTime === "string" && input.referenceTime.trim()
      ? { referenceTime: input.referenceTime.trim() }
      : {}),
    ...(typeof input.timezone === "string" && input.timezone.trim()
      ? { timezone: input.timezone.trim() }
      : {}),
    ...(typeof input.locale === "string" && input.locale.trim()
      ? { locale: input.locale.trim() }
      : {}),
    ...(timeRange ? { timeRange } : {})
  };
}

function isContextPackLayer(value: unknown): value is NonNullable<AssembleContextRequest["layer"]> {
  return value === "all" || value === "stm" || value === "ltm";
}

function isContextInventoryKind(value: unknown): value is ContextInventoryKind {
  return value === "event" || value === "segment" || value === "fact" || value === "stm" || value === "ltm";
}

function parseContextInventorySourceFilter(value: unknown): Pick<ContextInventorySearchRequest, "source"> {
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

function parseContextInventoryCustomFields(value: unknown): Pick<ContextInventorySearchRequest, "customFields"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { customFields: value as NonNullable<ContextInventorySearchRequest["customFields"]> };
}

function parseRelationTypes(value: string | undefined): RelationEdge["relationType"][] {
  return splitQueryList(value).filter(isRelationType);
}

function parseGraphOwnerTypes(value: string | undefined): GraphMemoryOwnerType[] {
  return splitQueryList(value).filter(isGraphOwnerType);
}

function splitQueryList(value: string | undefined) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isGraphOwnerType(value: string): value is GraphMemoryOwnerType {
  return value === "stm" || value === "ltm";
}

function isRelationType(value: string): value is RelationEdge["relationType"] {
  return value === "is_same_as" ||
    value === "alias_of" ||
    value === "derived_from" ||
    value === "supports" ||
    value === "conflicts_with" ||
    value === "same_source" ||
    value === "updates" ||
    value === "related_to" ||
    value === "part_of";
}

function isManualStepAction(value: unknown): value is ManualStepAction {
  return value === "event" || value === "data_lake" || value === "timeline_fusion" || value === "stm" || value === "ltm";
}

function normalizeFilterValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseCustomFieldFilters(query: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(query)
      .filter(([key, value]) => key.startsWith("custom.") && Boolean(value?.trim()))
      .map(([key, value]) => [key.slice("custom.".length), value!.trim()])
  );
}

type DataLakeSourceFilterKey = "sourceApp" | "sourceId" | "sourceType" | "sourceName" | "connectorId";

function buildSourceFilters(query: Record<string, string | undefined>): Partial<Record<DataLakeSourceFilterKey, string>> {
  const filters: Partial<Record<DataLakeSourceFilterKey, string>> = {};
  for (const key of ["sourceApp", "sourceId", "sourceType", "sourceName", "connectorId"] as const) {
    const value = normalizeFilterValue(query[key]);
    if (value) filters[key] = value;
  }
  return filters;
}

function dataSourceFromEvent(event: MemoryEvent | undefined) {
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

function mergeDataLakeCustomFields(
  eventFields: MemoryEvent["customFields"],
  segmentFields: ParsedSegment["customFields"]
) {
  return mergeDataLakeFields(eventFields, segmentFields) ?? {};
}

function mergeFactCustomFields(segmentIds: string[], segments: ParsedSegment[]) {
  return segmentIds.reduce<NonNullable<MemoryEvent["customFields"]>>((fields, segmentId) => {
    const segment = segments.find((item) => item.segmentId === segmentId);
    return {
      ...fields,
      ...(segment?.customFields ?? {})
    };
  }, {});
}

function matchesSourceFilters(
  dataSource: ReturnType<typeof dataSourceFromEvent>,
  filters: Partial<Record<DataLakeSourceFilterKey, string>>
) {
  return Object.entries(filters).every(([key, value]) => {
    if (!value) return true;
    return String(dataSource?.[key as keyof NonNullable<typeof dataSource>] ?? "") === value;
  });
}

function matchesCustomFieldFilters(
  fields: Record<string, unknown> | undefined,
  filters: Record<string, string>
) {
  return Object.entries(filters).every(([key, value]) => {
    if (key.endsWith(".__exists")) {
      const path = key.slice(0, -"__exists".length - 1);
      return getCustomFieldPath(fields, path).exists === parseBooleanFilter(value);
    }
    const field = getCustomFieldPath(fields, key);
    return field.exists && String(field.value) === value;
  });
}

function getCustomFieldPath(fields: Record<string, unknown> | undefined, path: string) {
  let current: unknown = fields;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(segment in current)) {
      return { exists: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function parseBooleanFilter(value: string) {
  return value === "true" || value === "1" || value === "yes";
}

function normalizeSearchableText(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseOptionalInteger(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseOptionalUnknownInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") return parseOptionalInteger(value);
  return undefined;
}

function parseConversationIngestionHttpInput(value: unknown): IngestConversationDocumentInput {
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

function conversationCallerScopeFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  tool: "ingest_conversation_batch_document" | "get_conversation_ingestion_status"
) {
  return parseConversationCallerScope({
    tenantId: singleHeader(headers["x-context-tenant-id"]),
    principalId: singleHeader(headers["x-context-principal-id"]),
    sourceApp: singleHeader(headers["x-context-source-app"]),
    allowedVisibilities: singleHeader(headers["x-context-allowed-visibilities"])
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  }, tool);
}

function contextMcpCallerScopeFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  request: JsonRpcRequest
) {
  if (isBackgroundMcpToolRequest(request)) {
    const tenantId = singleHeader(headers["x-context-tenant-id"])?.trim();
    const principalId = singleHeader(headers["x-context-principal-id"])?.trim();
    const sourceApp = singleHeader(headers["x-context-source-app"])?.trim();
    if (!tenantId || !principalId || !sourceApp) {
      throw new Error("BACKGROUND_CALLER_SCOPE_REQUIRED");
    }
  }
  return conversationCallerScopeFromHeaders(headers, conversationToolNameFromRequest(request));
}

function backgroundOwnerScopeFromHeaders(
  headers: Record<string, string | string[] | undefined>
) {
  const tenantId = singleHeader(headers["x-context-tenant-id"])?.trim();
  const principalId = singleHeader(headers["x-context-principal-id"])?.trim();
  if (!tenantId && !principalId) {
    return { tenantId: "local", principalId: "debug-user" };
  }
  if (!tenantId || !principalId) {
    throw new Error("BACKGROUND_OWNER_HEADERS_INCOMPLETE");
  }
  return { tenantId, principalId };
}

function authenticatedBackgroundOwnerScopeFromHeaders(
  headers: Record<string, string | string[] | undefined>
) {
  const tenantId = singleHeader(headers["x-context-tenant-id"])?.trim();
  const principalId = singleHeader(headers["x-context-principal-id"])?.trim();
  if (!tenantId && !principalId) return undefined;
  if (!tenantId || !principalId) throw new Error("BACKGROUND_OWNER_HEADERS_INCOMPLETE");
  return { tenantId, principalId };
}

function factAuditOwnerScopeFromHeaders(
  headers: Record<string, string | string[] | undefined>
) {
  const tenantId = singleHeader(headers["x-context-tenant-id"])?.trim();
  const principalId = singleHeader(headers["x-context-principal-id"])?.trim();
  return tenantId && principalId ? { tenantId, principalId } : undefined;
}

function httpStatusForBackgroundError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("OWNER_SCOPE_MISMATCH") || message.includes("CALLER_SCOPE_REQUIRED")) return 403;
  if (
    message.includes("CONFLICT") ||
    message.includes("LEASE") ||
    message.includes("ATTEMPTS_EXHAUSTED")
  ) {
    return 409;
  }
  if (message.includes("ANALYZER") || message.includes("LLM_")) return 502;
  return 400;
}

function conversationToolNameFromRequest(request: JsonRpcRequest) {
  if (request.method !== "tools/call" || !request.params || typeof request.params !== "object") {
    return "ingest_conversation_batch_document";
  }
  const name = (request.params as { name?: unknown }).name;
  return name === "get_conversation_ingestion_status"
    ? "get_conversation_ingestion_status"
    : "ingest_conversation_batch_document";
}

function isBackgroundMcpToolRequest(request: JsonRpcRequest) {
  if (request.method !== "tools/call" || !request.params || typeof request.params !== "object") {
    return false;
  }
  const name = (request.params as { name?: unknown }).name;
  return name === "maintain_fixed_background" || name === "create_session_background";
}

function singleHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function httpStatusForConversationError(error: ConversationIngestionServiceError) {
  if (error.toolError.code === "INGESTION_NOT_FOUND") return 404;
  if (error.toolError.code === "PERMISSION_SCOPE_MISMATCH") return 403;
  if (
    error.toolError.code === "CURSOR_MISMATCH" ||
    error.toolError.code === "MESSAGE_CONTENT_CONFLICT" ||
    error.toolError.code === "IDEMPOTENCY_KEY_CONFLICT" ||
    error.toolError.code === "BATCH_ID_CONFLICT"
  ) return 409;
  if (error.toolError.code === "DOCUMENT_TOO_LARGE") return 413;
  return 400;
}
