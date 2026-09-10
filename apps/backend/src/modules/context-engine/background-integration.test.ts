import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../health/server.js";
import { createContextInventoryMcpServer } from "./context-inventory-mcp.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

const owner = {
  tenantId: "tenant-background-api",
  principalId: "user-background-api"
};

test("background HTTP endpoints run maintenance and create an idempotent session snapshot", async () => {
  const repository = new InMemoryContextEngineRepository();
  const server = createHealthServer(repository);
  try {
    const maintenance = await server.inject({
      method: "POST",
      url: "/context/background/maintenance/run",
      payload: {
        ...owner,
        runId: "background-maintenance:2026-07-21:user-background-api",
        scheduledAt: "2026-07-21T23:00:00.000Z"
      }
    });
    assert.equal(maintenance.statusCode, 200);
    assert.equal(maintenance.json().result.status, "unchanged");
    assert.equal(maintenance.json().result.llmAnalysisCallCount, 0);

    const request = {
      ...owner,
      sessionId: "web:session-background-api",
      createdAt: "2026-07-21T23:30:00.000Z"
    };
    const first = await server.inject({
      method: "POST",
      url: "/context/background/session",
      payload: request
    });
    const replay = await server.inject({
      method: "POST",
      url: "/context/background/session",
      payload: request
    });
    assert.equal(first.statusCode, 200);
    assert.equal(replay.statusCode, 200);
    assert.equal(first.json().result.snapshotId, replay.json().result.snapshotId);
    assert.equal(first.json().result.sessionId, request.sessionId);
    assert.equal(first.json().result.status, "degraded");
    assert.equal(typeof first.json().result.serializedPrompt, "string");
    assert.equal(first.json().handoff.status, "degraded");
    assert.match(first.json().handoff.serializedPrompt, /role="memory_evidence"/u);

    const crossOwner = await server.inject({
      method: "POST",
      url: "/context/background/session",
      headers: {
        "x-context-tenant-id": owner.tenantId,
        "x-context-principal-id": owner.principalId
      },
      payload: {
        ...request,
        principalId: "another-user"
      }
    });
    assert.equal(crossOwner.statusCode, 403);
    assert.match(crossOwner.json().error, /BACKGROUND_OWNER_SCOPE_MISMATCH/u);
  } finally {
    await server.close();
  }
});

test("background MCP tools expose maintenance and inject an Agent-ready first-turn prompt", async () => {
  const repository = new InMemoryContextEngineRepository();
  const mcp = createContextInventoryMcpServer(repository);
  const caller = {
    ...owner,
    sourceApp: "agent-runtime",
    allowedVisibilities: ["private"] as const
  };

  const listed = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list"
  });
  const tools = listed?.result?.tools as Array<{
    name: string;
    inputSchema: { properties: Record<string, { type?: string }> };
  }>;
  assert.equal(tools.some((tool) => tool.name === "maintain_fixed_background"), true);
  assert.equal(tools.some((tool) => tool.name === "create_session_background"), true);
  const sessionTool = tools.find((tool) => tool.name === "create_session_background");
  assert.equal(sessionTool?.inputSchema.properties.referenceTime?.type, "string");
  assert.equal(sessionTool?.inputSchema.properties.timezone?.type, "string");
  assert.equal(sessionTool?.inputSchema.properties.locale?.type, "string");

  const maintenance = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "maintain_fixed_background",
      arguments: {
        runId: "background-maintenance:mcp:2026-07-21",
        scheduledAt: "2026-07-21T23:00:00.000Z"
      }
    }
  }, caller);
  assert.equal(maintenance?.result?.isError, false);
  assert.equal((maintenance?.result?.structuredContent as { status: string }).status, "unchanged");

  const session = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "create_session_background",
      arguments: {
        sessionId: "mcp:session-background-api",
        createdAt: "2026-07-21T23:30:00.000Z",
        referenceTime: "2026-07-22T00:30:00.000Z",
        timezone: "Asia/Shanghai",
        locale: "zh-CN"
      }
    }
  }, caller);
  const result = session?.result as {
    content: Array<{ type: string; text: string }>;
    structuredContent: {
      status: string;
      serializedPrompt: string;
      fixedText: string;
      dynamicText: string;
      dynamicCacheKey: string;
      referenceTime: string;
      timezone: string;
      locale: string;
      localDate: string;
      background: { fixedRevision: number };
      conflicts: Array<{ conflictId: string }>;
    };
    isError: boolean;
  };
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.status, "degraded");
  assert.equal(result.content[0]?.text, result.structuredContent.serializedPrompt);
  assert.match(result.structuredContent.serializedPrompt, /role="memory_evidence"/u);
  assert.match(result.structuredContent.serializedPrompt, /may be incomplete/u);
  assert.equal(typeof result.structuredContent.fixedText, "string");
  assert.equal(typeof result.structuredContent.dynamicText, "string");
  assert.equal(typeof result.structuredContent.dynamicCacheKey, "string");
  assert.equal(result.structuredContent.referenceTime, "2026-07-22T00:30:00.000Z");
  assert.equal(result.structuredContent.timezone, "Asia/Shanghai");
  assert.equal(result.structuredContent.locale, "zh-CN");
  assert.equal(result.structuredContent.localDate, "2026-07-22");
  assert.equal(typeof result.structuredContent.background.fixedRevision, "number");
  assert.deepEqual(result.structuredContent.conflicts, []);

  const crossOwner = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "create_session_background",
      arguments: {
        sessionId: "mcp:cross-owner",
        createdAt: "2026-07-21T23:30:00.000Z",
        tenantId: owner.tenantId,
        principalId: "another-user"
      }
    }
  }, caller);
  assert.match(crossOwner?.error?.message ?? "", /BACKGROUND_OWNER_SCOPE_MISMATCH/u);
});

test("HTTP MCP background calls resolve owner scope from headers", async () => {
  const repository = new InMemoryContextEngineRepository();
  const server = createHealthServer(repository);
  try {
    const response = await server.inject({
      method: "POST",
      url: "/context/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-context-tenant-id": owner.tenantId,
        "x-context-principal-id": owner.principalId,
        "x-context-source-app": "agent-runtime"
      },
      payload: {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "create_session_background",
          arguments: {
            sessionId: "mcp-http:session-background-api",
            createdAt: "2026-07-21T23:30:00.000Z"
          }
        }
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().result.structuredContent.status, "degraded");
    assert.match(response.json().result.content[0].text, /role="memory_evidence"/u);

    const missingScope = await server.inject({
      method: "POST",
      url: "/context/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      payload: {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "create_session_background",
          arguments: {
            sessionId: "mcp-http:missing-scope",
            createdAt: "2026-07-21T23:30:00.000Z"
          }
        }
      }
    });
    assert.equal(missingScope.statusCode, 200);
    assert.match(missingScope.json().error.message, /BACKGROUND_CALLER_SCOPE_REQUIRED/u);
  } finally {
    await server.close();
  }
});
