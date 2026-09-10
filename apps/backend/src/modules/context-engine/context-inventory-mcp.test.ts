import test from "node:test";
import assert from "node:assert/strict";
import { createContextEngineService } from "./write-event.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import { createContextInventoryMcpServer } from "./context-inventory-mcp.js";
import { createHealthServer } from "../health/server.js";

test("context inventory MCP server exposes and calls search_context_inventory", async () => {
  const repository = new InMemoryContextEngineRepository();
  const service = createContextEngineService(repository);
  const eventId = `mcp_context_inventory_${Date.now()}`;

  await service.writeEvent({
    idempotencyKey: eventId,
    event: {
      eventId,
      eventType: "document_import",
      eventSummary: "MCP Context 库存测试",
      eventTime: "2026-07-01T03:00:00.000Z",
      sourceApp: "notion",
      sourceId: "notion-mcp-context-inventory",
      dataSource: {
        sourceApp: "notion",
        sourceId: "notion-mcp-context-inventory",
        sourceName: "MCP Context Inventory",
        sourceType: "document"
      },
      customFields: {
        project: "ospx-ff",
        owner: "context-team"
      },
      permissionSnapshot: {
        snapshotId: `ps_${eventId}`,
        tenantId: "local",
        principalId: "debug-user",
        sourceAclVersion: "notion-acl-v1",
        visibility: "private"
      },
      multimodalData: [
        {
          itemId: `item_${eventId}`,
          type: "text",
          format: "plain",
          content: "MCP 工具应该检索 context 库存。",
          customFields: {
            project: "ospx-ff",
            section: "requirements"
          },
          sourceRefs: [
            {
              sourceRefId: `src_${eventId}`,
              sourceType: "document",
              sourceId: "notion-mcp-context-inventory"
            }
          ]
        }
      ]
    }
  });

  const mcp = createContextInventoryMcpServer(repository);
  const initialize = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" }
    }
  });

  assert.equal(initialize?.jsonrpc, "2.0");
  assert.equal(initialize?.id, 1);
  assert.ok(initialize?.result);
  assert.equal(initialize.result.protocolVersion, "2025-06-18");
  assert.deepEqual(initialize.result.capabilities, { tools: { listChanged: false } });

  const list = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list"
  });
  assert.ok(list?.result);
  const tools = list.result.tools as Array<{ name: string; inputSchema: { type: string } }>;
  assert.equal(tools.some((tool) => tool.name === "search_context"), true);
  assert.equal(tools.some((tool) => tool.name === "inspect_context_inventory"), true);
  assert.equal(tools.some((tool) => tool.name === "write_memory_event"), true);
  assert.equal(tools.find((tool) => tool.name === "search_context")?.inputSchema.type, "object");

  const call = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "inspect_context_inventory",
      arguments: {
        q: "MCP 工具",
        kinds: ["segment", "fact", "stm"],
        customFields: {
          project: "ospx-ff"
        },
        limit: 10
      }
    }
  });
  assert.ok(call?.result);
  const toolResult = call.result as {
    content: Array<{ type: string; text: string }>;
    structuredContent: {
      tool: string;
      items: Array<{ kind: string; content: string; customFields?: Record<string, unknown> }>;
    };
    isError: boolean;
  };
  const structured = toolResult.structuredContent as {
    tool: string;
    items: Array<{ kind: string; content: string; customFields?: Record<string, unknown> }>;
  };

  assert.equal(call?.id, 3);
  assert.equal(toolResult.isError, false);
  assert.equal(toolResult.content[0]?.type, "text");
  assert.equal(structured.tool, "search_context_inventory");
  assert.equal(structured.items.some((item) => item.kind === "segment"), true);
  assert.equal(structured.items.some((item) => item.kind === "fact"), true);
  assert.equal(structured.items.some((item) => item.kind === "stm"), true);
  assert.equal(structured.items.every((item) => item.customFields?.project === "ospx-ff"), true);

  const eventOnlyCall = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "inspect_context_inventory",
      arguments: {
        q: "MCP 工具",
        kinds: ["event"],
        limit: 10
      }
    }
  });
  const eventOnlyStructured = eventOnlyCall?.result?.structuredContent as {
    query: { kinds: string[]; rawEventsOnly?: boolean };
    items: Array<{ kind: string }>;
  };
  assert.deepEqual(eventOnlyStructured.query.kinds, ["event", "segment", "fact", "stm", "ltm"]);
  assert.equal(eventOnlyStructured.query.rawEventsOnly, undefined);
  assert.equal(eventOnlyStructured.items.some((item) => item.kind === "segment"), true);

  const contextPackCall = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "search_context",
      arguments: {
        task: "MCP 工具应该如何检索 context？",
        q: "MCP 工具",
        limit: 10
      }
    }
  });
  const contextPackResult = contextPackCall?.result as {
    content: Array<{ type: string; text: string }>;
    structuredContent: {
      contextPack: string;
      serializedPrompt: string;
      temporal: { referenceTime: string };
    };
  };
  assert.equal(contextPackResult.content[0]?.text.includes("【Context Pack】"), true);
  assert.equal(contextPackResult.content[0]?.text.includes("MCP 工具"), true);
  assert.equal(contextPackResult.structuredContent.contextPack, contextPackResult.content[0]?.text);
  assert.equal(contextPackResult.structuredContent.serializedPrompt, contextPackResult.content[0]?.text);
  assert.equal(typeof contextPackResult.structuredContent.temporal?.referenceTime, "string");

  const writeCall = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "write_memory_event",
      arguments: {
        content: "Agent 记忆写入工具应复用受控 MemoryEvent 摄入链路。",
        idempotencyKey: `mcp-write-memory-${eventId}`,
        summary: "MCP write memory tool smoke",
        sourceApp: "agent",
        sourceId: "mcp-write-memory-session"
      }
    }
  });
  const writeResult = writeCall?.result as {
    content: Array<{ type: string; text: string }>;
    structuredContent: {
      tool: string;
      result: {
        accepted: boolean;
        deduplicated: boolean;
        eventId: string;
        factIds: string[];
        pipelineStatus?: string;
        memoryDataId?: string;
      };
    };
    isError: boolean;
  };
  assert.equal(writeResult.isError, false);
  assert.equal(writeResult.structuredContent.tool, "write_memory_event");
  assert.equal(writeResult.structuredContent.result.accepted, true);
  assert.equal(writeResult.structuredContent.result.deduplicated, false);
  assert.equal(writeResult.structuredContent.result.pipelineStatus, "event_only");
  assert.equal(writeResult.structuredContent.result.eventId.startsWith("agent_memory_mcp-write-memory-"), true);
  assert.deepEqual(writeResult.structuredContent.result.factIds, []);
  assert.equal(writeResult.structuredContent.result.memoryDataId, undefined);
  assert.equal(writeResult.content[0]?.text.includes("write_memory_event"), true);
});

test("backend exposes context inventory MCP over HTTP", async () => {
  const repository = new InMemoryContextEngineRepository();
  const service = createContextEngineService(repository);
  const server = createHealthServer(repository);
  const eventId = `mcp_http_context_inventory_${Date.now()}`;

  await service.writeEvent({
    idempotencyKey: eventId,
    event: {
      eventId,
      eventType: "document_import",
      eventSummary: "HTTP MCP Context 库存测试",
      eventTime: "2026-07-01T03:00:00.000Z",
      sourceApp: "notion",
      sourceId: "notion-http-mcp-context-inventory",
      customFields: {
        project: "ospx-ff"
      },
      permissionSnapshot: {
        snapshotId: `ps_${eventId}`,
        tenantId: "local",
        principalId: "debug-user",
        sourceAclVersion: "notion-acl-v1",
        visibility: "private"
      },
      multimodalData: [
        {
          itemId: `item_${eventId}`,
          type: "text",
          format: "plain",
          content: "HTTP MCP 工具应该检索 context 库存。",
          customFields: {
            project: "ospx-ff"
          },
          sourceRefs: [
            {
              sourceRefId: `src_${eventId}`,
              sourceType: "document",
              sourceId: "notion-http-mcp-context-inventory"
            }
          ]
        }
      ]
    }
  });

  const initialize = await server.inject({
    method: "POST",
    url: "/context/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "http-test-client", version: "0.0.0" }
      }
    }
  });
  assert.equal(initialize.statusCode, 200);
  assert.equal(initialize.headers["content-type"]?.toString().startsWith("application/json"), true);
  assert.equal(initialize.json().result.capabilities.tools.listChanged, false);

  const call = await server.inject({
    method: "POST",
    url: "/context/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18"
    },
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "inspect_context_inventory",
        arguments: {
          q: "HTTP MCP",
          kinds: ["segment", "fact", "stm"],
          customFields: {
            project: "ospx-ff"
          },
          limit: 10
        }
      }
    }
  });
  assert.equal(call.statusCode, 200);
  const structured = call.json().result.structuredContent as {
    items: Array<{ kind: string; content: string; customFields?: Record<string, unknown> }>;
  };
  assert.equal(structured.items.some((item) => item.kind === "segment"), true);
  assert.equal(structured.items.some((item) => item.kind === "fact"), true);
  assert.equal(structured.items.some((item) => item.kind === "stm"), true);

  const notification = await server.inject({
    method: "POST",
    url: "/context/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    payload: {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }
  });
  assert.equal(notification.statusCode, 202);
  assert.equal(notification.body, "");

  const get = await server.inject({
    method: "GET",
    url: "/context/mcp",
    headers: {
      accept: "text/event-stream"
    }
  });
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers["content-type"]?.toString().startsWith("text/event-stream"), true);
  assert.equal(get.body, "event: endpoint\ndata: /context/mcp\n\n");

  await server.close();
});

test("inspect_context_inventory tolerates non-string inventory content", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveMemoryEvent({
    eventId: "mcp_non_string_content_event",
    eventType: "tool_result",
    eventSummary: "非字符串内容库存测试",
    eventTime: "2026-07-01T03:00:00.000Z",
    sourceApp: "tool",
    sourceId: "tool-result",
    permissionSnapshot: {
      snapshotId: "ps_mcp_non_string_content_event",
      tenantId: "local",
      principalId: "debug-user",
      sourceAclVersion: "tool-v1",
      visibility: "private"
    },
    multimodalData: [
      {
        itemId: "item_mcp_non_string_content_event",
        type: "tool_result",
        format: "json",
        content: { result: "Needle Inventory Payload" }
      }
    ]
  });
  await repository.saveParsedSegment({
    segmentId: "seg_mcp_non_string_content_event",
    eventId: "mcp_non_string_content_event",
    modality: "tool_result",
    content: { result: "Needle Inventory Payload" } as unknown as string,
    status: "parsed",
    confidence: "medium"
  });

  const mcp = createContextInventoryMcpServer(repository);
  const call = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "inspect_context_inventory",
      arguments: {
        q: "needle",
        kinds: ["segment"],
        limit: 10
      }
    }
  });

  assert.equal(call?.error, undefined);
  const structured = call?.result?.structuredContent as {
    items: Array<{ id: string; content: string }>;
  };
  assert.equal(structured.items.some((item) => item.id === "seg_mcp_non_string_content_event"), true);
  assert.equal(typeof structured.items[0]?.content, "string");
});
