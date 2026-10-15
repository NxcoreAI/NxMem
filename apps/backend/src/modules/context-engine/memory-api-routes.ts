import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ContextEngineRepository } from "./persistence/repository.js";
import type { ContextEngineService } from "./write-event.js";
import type { MemoryEvent } from "./domain.js";
import { searchContext } from "./search-context.js";

const MEMORY_API_TENANT_ID = "memory-api";

function memoryApiScopeId(userId: string): string {
  return `memory-api:${userId}`;
}

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() ? content : undefined;
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          return (item as { text: string }).text;
        }
        return "";
      })
      .filter((part) => part.trim());
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

function authenticate(request: FastifyRequest): boolean {
  const expected = process.env.MEMORY_SYSTEM_KEY?.trim();
  if (!expected) return true;
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^(bearer|token)\s+(.+)$/i.exec(header.trim()) : undefined;
  const presented = match ? match[2] : request.headers["x-api-key"];
  if (typeof presented !== "string" || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rejectUnauthenticated(reply: FastifyReply) {
  reply.code(401);
  return { detail: { reason: "invalid or missing memory system key" } };
}

interface MemoryApiMessage {
  role: string;
  content: unknown;
  timestamp?: number;
}

function parseAddBody(body: unknown):
  | { ok: true; requestId: string; userId: string; sessionId: string; messages: MemoryApiMessage[] }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
  const raw = body as Record<string, unknown>;
  const requestId = typeof raw.request_id === "string" ? raw.request_id.trim() : "";
  const userId = typeof raw.user_id === "string" ? raw.user_id.trim() : "";
  const sessionId = typeof raw.session_id === "string" ? raw.session_id.trim() : "";
  if (!requestId) return { ok: false, error: "request_id is required" };
  if (!userId) return { ok: false, error: "user_id is required" };
  if (!sessionId) return { ok: false, error: "session_id is required" };
  if (!Array.isArray(raw.messages) || !raw.messages.length) {
    return { ok: false, error: "messages must be a non-empty array" };
  }
  const messages: MemoryApiMessage[] = [];
  for (const [index, item] of raw.messages.entries()) {
    if (!item || typeof item !== "object") return { ok: false, error: `messages[${index}] must be an object` };
    const message = item as Record<string, unknown>;
    if (typeof message.role !== "string" || !message.role.trim()) {
      return { ok: false, error: `messages[${index}].role is required` };
    }
    if (extractTextContent(message.content) === undefined) {
      return { ok: false, error: `messages[${index}].content must be non-empty text` };
    }
    messages.push({
      role: message.role,
      content: message.content,
      ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? { timestamp: message.timestamp }
        : {})
    });
  }
  return { ok: true, requestId, userId, sessionId, messages };
}

export function buildMemoryApiEvent(input: {
  requestId: string;
  userId: string;
  sessionId: string;
  messages: MemoryApiMessage[];
}): MemoryEvent {
  const { requestId, userId, sessionId, messages } = input;
  const eventId = `mem_${createHash("sha1").update(requestId).digest("hex").slice(0, 24)}`;
  const lastTimestamp = messages.reduce((max, message) => Math.max(max, message.timestamp ?? 0), 0);
  const eventTime = lastTimestamp > 0 ? new Date(lastTimestamp).toISOString() : new Date().toISOString();
  const text = messages
    .map((message) => `${message.role}: ${extractTextContent(message.content)}`)
    .join("\n\n");
  return {
    eventId,
    eventType: "memory_api_add",
    eventTime,
    sourceApp: "memory-api",
    sourceId: sessionId,
    contextScopeId: memoryApiScopeId(userId),
    permissionSnapshot: {
      snapshotId: `ps_${eventId}`,
      tenantId: MEMORY_API_TENANT_ID,
      principalId: userId,
      sourceAclVersion: "mem-v1",
      visibility: "private"
    },
    multimodalData: [
      {
        itemId: `item_${eventId}`,
        type: "text",
        format: "plain",
        content: text,
        ref: sessionId,
        sourceRefs: [{
          sourceRefId: `src_${eventId}`,
          sourceType: "memory_api_session",
          sourceId: sessionId
        }],
        timeBasis: "source_time",
        timeConfidence: lastTimestamp > 0 ? "high" : "low"
      }
    ],
    sourceRefs: [
      {
        sourceRefId: `src_${eventId}`,
        sourceType: "memory_api_session",
        sourceId: sessionId
      }
    ]
  };
}

function parseSearchBody(body: unknown):
  | { ok: true; query: string; userId: string; topK: number }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
  const raw = body as Record<string, unknown>;
  const query = extractTextContent(raw.query);
  const userId = typeof raw.user_id === "string" ? raw.user_id.trim() : "";
  const topK = typeof raw.top_k === "number" ? raw.top_k : Number(raw.top_k);
  if (query === undefined) return { ok: false, error: "query must be non-empty text" };
  if (!userId) return { ok: false, error: "user_id is required" };
  if (!Number.isFinite(topK) || topK <= 0) return { ok: false, error: "top_k must be a positive number" };
  let retrievalQuery = query;
  if (Array.isArray(raw.options) && raw.options.length) {
    const options = raw.options.map((item) => String(item)).filter((item) => item.trim());
    if (options.length) retrievalQuery = `${query}\nOptions:\n${options.map((item) => `- ${item}`).join("\n")}`;
  }
  return { ok: true, query: retrievalQuery, userId, topK: Math.floor(topK) };
}

export function registerMemoryApiRoutes(
  app: FastifyInstance,
  service: ContextEngineService,
  repository: ContextEngineRepository
) {
  app.get("/v1/memories/health", async () => ({ status: "ok" }));

  app.post("/v1/memories/add", async (request, reply) => {
    if (!authenticate(request)) return rejectUnauthenticated(reply);
    const parsed = parseAddBody(request.body);
    if (!parsed.ok) {
      reply.code(400);
      return { detail: { reason: parsed.error } };
    }
    const event = buildMemoryApiEvent(parsed);
    try {
      await service.writeEvent({ event, idempotencyKey: `mem:${parsed.requestId}` });
    } catch (error) {
      request.log.error({ err: error, requestId: parsed.requestId }, "memory api add failed");
      reply.code(500);
      return { detail: { reason: error instanceof Error ? error.message : "add failed" } };
    }
    return {
      success: true,
      request_id: parsed.requestId,
      user_id: parsed.userId,
      session_id: parsed.sessionId
    };
  });

  app.post("/v1/memories/search", async (request, reply) => {
    if (!authenticate(request)) return rejectUnauthenticated(reply);
    const parsed = parseSearchBody(request.body);
    if (!parsed.ok) {
      reply.code(400);
      return { detail: { reason: parsed.error } };
    }
    try {
      const search = await searchContext(repository, {
        q: parsed.query,
        layer: "all",
        contextScopeId: memoryApiScopeId(parsed.userId),
        tenantId: MEMORY_API_TENANT_ID,
        principalId: parsed.userId,
        limit: parsed.topK
      });
      const data = search.results
        .slice()
        .sort((left, right) => right.score - left.score)
        .slice(0, parsed.topK)
        .map((result) => ({
          id: result.id,
          content: result.content,
          score: result.score,
          ...(result.temporal.evidenceTime ? { created_at: result.temporal.evidenceTime } : {})
        }));
      return { data };
    } catch (error) {
      request.log.error({ err: error, userId: parsed.userId }, "memory api search failed");
      reply.code(500);
      return { detail: { reason: error instanceof Error ? error.message : "search failed" } };
    }
  });
}
