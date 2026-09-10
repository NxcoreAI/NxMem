import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHealthServer } from "../../modules/health/server.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("exposes background context and feedback endpoints", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());

  const backgroundCreate = await server.inject({
    method: "POST",
    url: "/context/background",
    headers: { "content-type": "application/json" },
    payload: {
      fixedText: "固定背景：测试背景文本。",
      dynamicText: "动态背景：测试动态摘要。",
      sourceRefIds: ["src-a", "src-b"],
      conflictIds: ["edge-1"],
      updateSuggestion: {
        status: "pending",
        summary: "建议人工审阅背景更新。"
      }
    }
  });
  assert.equal(backgroundCreate.statusCode, 200);
  const createdBackground = backgroundCreate.json().result as {
    backgroundId: string;
    fixedText: string;
    dynamicText: string;
    sourceRefIds: string[];
    conflictIds: string[];
  };
  assert.equal(createdBackground.fixedText, "固定背景：测试背景文本。");
  assert.equal(createdBackground.sourceRefIds.length, 2);

  const backgroundRead = await server.inject({ method: "GET", url: "/context/background" });
  assert.equal(backgroundRead.statusCode, 200);
  assert.equal(backgroundRead.json().result.backgroundId, createdBackground.backgroundId);

  const eventId = `feedback_${Date.now()}`;
  await server.inject({
    method: "POST",
    url: "/context/events",
    headers: { "content-type": "application/json" },
    payload: {
      event: {
        eventId,
        eventType: "manual_memory_event",
        eventDescription: "反馈接口测试",
        eventTime: new Date().toISOString(),
        sourceApp: "test",
        sourceId: "feedback-demo",
        permissionSnapshot: {
          snapshotId: `ps_${eventId}`,
          tenantId: "local",
          principalId: "debug-user",
          sourceAclVersion: "v1",
          visibility: "private"
        },
        multimodalData: [
          {
            itemId: `item_${eventId}`,
            type: "text",
            format: "plain",
            content: "反馈接口应记录记忆变化事件。",
            ref: "feedback-demo"
          }
        ],
        sourceRefs: [
          {
            sourceRefId: `src_${eventId}`,
            sourceType: "file",
            sourceId: "feedback-demo"
          }
        ]
      },
      idempotencyKey: eventId
    }
  });

  const snapshotBeforeFeedback = await server.inject({ method: "GET", url: "/context/debug/snapshot" });
  const snapshotBeforeFeedbackItems = snapshotBeforeFeedback.json().items as {
    shortTermMemories: Array<{ memoryDataId: string }>;
  };
  const stmId = snapshotBeforeFeedbackItems.shortTermMemories[0]?.memoryDataId;
  assert.ok(stmId);

  const feedbackCreate = await server.inject({
    method: "POST",
    url: "/context/feedback",
    headers: { "content-type": "application/json" },
    payload: {
      targetType: "stm",
      targetId: stmId,
      action: "confirm",
      note: "确认这条记忆。"
    }
  });
  assert.equal(feedbackCreate.statusCode, 200);

  const snapshot = await server.inject({ method: "GET", url: "/context/debug/snapshot" });
  const snapshotItems = snapshot.json().items as {
    feedbackItems: Array<{ targetId: string; action: string }>;
  };
  assert.equal(snapshotItems.feedbackItems.length > 0, true);
  const firstFeedbackItem = snapshotItems.feedbackItems[0]!;
  assert.equal(firstFeedbackItem.targetId, stmId);

  const changesResponse = await server.inject({
    method: "GET",
    url: `/context/memory-change-events?targetId=${encodeURIComponent(stmId)}`
  });
  assert.equal(changesResponse.statusCode, 200);
  const changesJson = changesResponse.json() as {
    result?: { items?: Array<{ storageLayer: string; reason: string }> };
  };
  if (!changesJson.result) {
    throw new Error("expected memory change event result");
  }
  const changes = changesJson.result.items ?? [];
  assert.equal(changes.some((item) => item.storageLayer === "stm" && item.reason === "feedback:confirm"), true);

  const searchResponse = await server.inject({
    method: "GET",
    url: "/context/search-data-lake?q=parsed%20segment"
  });
  assert.equal(searchResponse.statusCode, 200);
  const searchResult = searchResponse.json().result as { items: unknown[] };
  assert.equal(Array.isArray(searchResult.items), true);

  await server.close();
});

test("searches data lake by data source metadata and custom fields", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const eventId = `data_lake_metadata_${Date.now()}`;

  await server.inject({
    method: "POST",
    url: "/context/events",
    headers: { "content-type": "application/json" },
    payload: {
      event: {
        eventId,
        eventType: "document_import",
        eventDescription: "数据湖元数据检索测试",
        eventTime: "2026-07-01T03:00:00.000Z",
        sourceApp: "notion",
        sourceId: "notion-page-42",
        dataSource: {
          sourceApp: "notion",
          sourceId: "notion-page-42",
          sourceName: "Product Wiki",
          sourceType: "document",
          sourceUri: "notion://page/42",
          connectorId: "notion-connector",
          syncCursor: "cursor-42",
          syncVersion: "2026-07-01"
        },
        customFields: {
          project: "ospx-ff",
          priority: "P0",
          owner: "context-team",
          task: {
            id: "task-123",
            owner: "context-team"
          }
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
            content: "自定义字段应能参与数据湖过滤。",
            ref: "notion-page-42",
            customFields: {
              section: "requirements",
              quarter: "2026Q3"
            }
          }
        ],
        sourceRefs: [
          {
            sourceRefId: `src_${eventId}`,
            sourceType: "document",
            sourceId: "notion-page-42",
            sourceUrl: "notion://page/42"
          }
        ]
      },
      idempotencyKey: eventId
    }
  });

  const searchResponse = await server.inject({
    method: "GET",
    url: "/context/search-data-lake?sourceApp=notion&sourceType=document&custom.project=ospx-ff&custom.section=requirements"
  });
  assert.equal(searchResponse.statusCode, 200);
  const searchResult = searchResponse.json().result as {
    total: number;
    items: Array<{
      id: string;
      dataSource?: {
        sourceApp?: string;
        sourceName?: string;
        sourceType?: string;
        connectorId?: string;
      };
      customFields?: Record<string, unknown>;
    }>;
  };
  assert.equal(searchResult.total >= 1, true);
  const segment = searchResult.items.find((item) => item.id === `seg_${eventId}_item_${eventId}`);
  assert.ok(segment);
  assert.equal(segment.dataSource?.sourceApp, "notion");
  assert.equal(segment.dataSource?.sourceName, "Product Wiki");
  assert.equal(segment.dataSource?.sourceType, "document");
  assert.equal(segment.dataSource?.connectorId, "notion-connector");
  assert.equal(segment.customFields?.project, "ospx-ff");
  assert.equal(segment.customFields?.section, "requirements");

  const existsResponse = await server.inject({
    method: "GET",
    url: "/context/search-data-lake?custom.task.owner.__exists=true"
  });
  assert.equal(existsResponse.statusCode, 200);
  assert.equal(existsResponse.json().result.items.some((item: { id: string }) => item.id === `seg_${eventId}_item_${eventId}`), true);

  const nestedValueResponse = await server.inject({
    method: "GET",
    url: "/context/search-data-lake?custom.task.id=task-123"
  });
  assert.equal(nestedValueResponse.statusCode, 200);
  assert.equal(nestedValueResponse.json().result.items.some((item: { id: string }) => item.id === `seg_${eventId}_item_${eventId}`), true);

  const filteredResponse = await server.inject({
    method: "GET",
    url: "/context/search-data-lake?sourceApp=slack&custom.project=ospx-ff"
  });
  assert.equal(filteredResponse.statusCode, 200);
  assert.equal(filteredResponse.json().result.total, 0);

  await server.close();
});

test("exposes an agent tool for searching context inventory", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const eventId = `context_inventory_tool_${Date.now()}`;

  await server.inject({
    method: "POST",
    url: "/context/events",
    headers: { "content-type": "application/json" },
    payload: {
      event: {
        eventId,
        eventType: "document_import",
        eventSummary: "Context 库存工具测试",
        eventTime: "2026-07-01T03:00:00.000Z",
        sourceApp: "notion",
        sourceId: "notion-context-inventory",
        dataSource: {
          sourceApp: "notion",
          sourceId: "notion-context-inventory",
          sourceName: "Context Inventory",
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
            content: "库存工具应该能检索 context 库存里面的内容。",
            ref: "notion-context-inventory",
            customFields: {
              project: "ospx-ff",
              section: "requirements"
            }
          }
        ],
        sourceRefs: [
          {
            sourceRefId: `src_${eventId}`,
            sourceType: "document",
            sourceId: "notion-context-inventory"
          }
        ]
      },
      idempotencyKey: eventId
    }
  });

  const toolsResponse = await server.inject({ method: "GET", url: "/context/tools" });
  assert.equal(toolsResponse.statusCode, 200);
  const searchToolDescriptor = toolsResponse.json().result.tools.find((tool: { name: string }) => tool.name === "search_context") as {
    description: string;
    inputSchema: { properties: { task: { description: string }; q: { description: string } } };
  } | undefined;
  const inventoryToolDescriptor = toolsResponse.json().result.tools.find((tool: { name: string }) => tool.name === "inspect_context_inventory") as {
    description: string;
    inputSchema: { properties: { q: { description: string }; rawEventsOnly?: { type: string } } };
  } | undefined;
  const writeToolDescriptor = toolsResponse.json().result.tools.find((tool: { name: string }) => tool.name === "write_memory_event") as {
    description: string;
    inputSchema: { properties: { content: { type: string }; idempotencyKey: { type: string }; visibility?: { enum: string[] } } };
  } | undefined;
  assert.ok(searchToolDescriptor);
  assert.ok(inventoryToolDescriptor);
  assert.ok(writeToolDescriptor);
  assert.equal(
    searchToolDescriptor.description.includes("original language"),
    true
  );
  assert.equal(searchToolDescriptor.inputSchema.properties.task.description.includes("我跟谁吃晚饭"), true);
  assert.equal(inventoryToolDescriptor.inputSchema.properties.q.description.includes("晚餐"), true);
  assert.equal(inventoryToolDescriptor.inputSchema.properties.rawEventsOnly?.type, "boolean");
  assert.equal(writeToolDescriptor.inputSchema.properties.content.type, "string");
  assert.equal(writeToolDescriptor.inputSchema.properties.idempotencyKey.type, "string");
  assert.deepEqual(writeToolDescriptor.inputSchema.properties.visibility?.enum, ["private", "team", "tenant", "public"]);

  const fullInventoryResponse = await server.inject({
    method: "POST",
    url: "/context/tools/search-inventory",
    headers: { "content-type": "application/json" },
    payload: {
      q: "库存工具",
      kinds: ["segment", "fact", "stm"],
      limit: 10
    }
  });
  assert.equal(fullInventoryResponse.statusCode, 200);
  const fullInventory = fullInventoryResponse.json().result as {
    tool: string;
    items: Array<{ id: string; kind: string; content: string; sourceRefs: Array<{ sourceRefId: string }> }>;
  };
  assert.equal(fullInventory.tool, "search_context_inventory");
  assert.equal(fullInventory.items.some((item) => item.kind === "segment" && item.id === `seg_${eventId}_item_${eventId}`), true);
  assert.equal(fullInventory.items.some((item) => item.kind === "fact"), true);
  assert.equal(fullInventory.items.some((item) => item.kind === "stm"), true);
  assert.equal(fullInventory.items.every((item) => item.sourceRefs.some((ref) => ref.sourceRefId === `src_${eventId}`)), true);

  const eventOnlyDefaultResponse = await server.inject({
    method: "POST",
    url: "/context/tools/search-inventory",
    headers: { "content-type": "application/json" },
    payload: {
      q: "库存工具",
      kinds: ["event"],
      limit: 10
    }
  });
  assert.equal(eventOnlyDefaultResponse.statusCode, 200);
  const eventOnlyDefault = eventOnlyDefaultResponse.json().result as {
    query: { kinds: string[]; rawEventsOnly?: boolean };
    items: Array<{ kind: string }>;
  };
  assert.deepEqual(eventOnlyDefault.query.kinds, ["event", "segment", "fact", "stm", "ltm"]);
  assert.equal(eventOnlyDefault.query.rawEventsOnly, undefined);
  assert.equal(eventOnlyDefault.items.some((item) => item.kind === "segment"), true);

  const rawEventsOnlyResponse = await server.inject({
    method: "POST",
    url: "/context/tools/search-inventory",
    headers: { "content-type": "application/json" },
    payload: {
      q: "库存工具",
      kinds: ["event"],
      rawEventsOnly: true,
      limit: 10
    }
  });
  assert.equal(rawEventsOnlyResponse.statusCode, 200);
  const rawEventsOnly = rawEventsOnlyResponse.json().result as {
    query: { kinds: string[]; rawEventsOnly?: boolean };
    items: Array<{ kind: string }>;
  };
  assert.deepEqual(rawEventsOnly.query.kinds, ["event"]);
  assert.equal(rawEventsOnly.query.rawEventsOnly, true);
  assert.equal(rawEventsOnly.items.every((item) => item.kind === "event"), true);

  const filteredInventoryResponse = await server.inject({
    method: "POST",
    url: "/context/tools/search-inventory",
    headers: { "content-type": "application/json" },
    payload: {
      q: "库存工具",
      kinds: ["segment", "fact"],
      customFields: {
        project: "ospx-ff",
        section: "requirements"
      }
    }
  });
  assert.equal(filteredInventoryResponse.statusCode, 200);
  const filteredInventory = filteredInventoryResponse.json().result as {
    total: number;
    items: Array<{ kind: string; customFields?: Record<string, unknown> }>;
  };
  assert.equal(filteredInventory.total >= 2, true);
  assert.equal(filteredInventory.items.every((item) => item.customFields?.project === "ospx-ff"), true);

  const writeResponse = await server.inject({
    method: "POST",
    url: "/context/tools/write-memory-event",
    headers: { "content-type": "application/json" },
    payload: {
      content: "Agent 工具写入的记忆事件应先变成 FactItem 再准入 STM。",
      idempotencyKey: `debug-write-memory-${eventId}`,
      summary: "Debug write memory tool smoke",
      sourceApp: "agent",
      sourceId: "debug-write-memory-session",
      visibility: "private"
    }
  });
  assert.equal(writeResponse.statusCode, 200);
  const writeResult = writeResponse.json().result as {
    tool: string;
    result: {
      accepted: boolean;
      deduplicated: boolean;
      eventId: string;
      factIds: string[];
      memoryDataId?: string;
    };
  };
  assert.equal(writeResult.tool, "write_memory_event");
  assert.equal(writeResult.result.accepted, true);
  assert.equal(writeResult.result.deduplicated, false);
  assert.equal((writeResult.result as { pipelineStatus?: string }).pipelineStatus, "event_only");
  assert.equal(writeResult.result.eventId.startsWith("agent_memory_debug-write-memory-"), true);
  assert.deepEqual(writeResult.result.factIds, []);
  assert.equal(writeResult.result.memoryDataId, undefined);
  const taskResponse = await server.inject({
    method: "GET",
    url: `/context/tasks/by-event/${writeResult.result.eventId}`
  });
  assert.equal(taskResponse.statusCode, 200);
  const taskResult = taskResponse.json().result as {
    eventId: string;
    status: string;
  };
  assert.equal(taskResult.eventId, writeResult.result.eventId);
  assert.equal(["pending", "running", "succeeded"].includes(taskResult.status), true);

  await server.close();
});

test("searches data lake metadata from JSON multimodal content without custom fields", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const eventId = `data_lake_json_content_${Date.now()}`;

  await server.inject({
    method: "POST",
    url: "/context/events",
    headers: { "content-type": "application/json" },
    payload: {
      event: {
        eventId,
        eventType: "document_import",
        eventSummary: "数据湖 JSON 内容检索测试",
        eventTime: "2026-07-01T03:00:00.000Z",
        sourceApp: "notion",
        sourceId: "notion-page-json-42",
        permissionSnapshot: {
          snapshotId: `ps_${eventId}`,
          tenantId: "local",
          principalId: "debug-user",
          sourceAclVersion: "notion-acl-v2",
          visibility: "private"
        },
        multimodalData: [
          {
            itemId: `item_${eventId}`,
            type: "text",
            format: "json",
            content: {
              text: "JSON 内容字段应能参与数据湖全文检索。",
              project: "ospx-new",
              section: "requirements",
              task: {
                id: "task-json-123",
                owner: "context-team"
              }
            },
            sourceRefs: [{
              sourceRefId: `src_${eventId}`,
              sourceType: "document",
              sourceId: "notion-page-json-42",
              sourceUrl: "notion://page/json-42"
            }]
          }
        ]
      },
      idempotencyKey: eventId
    }
  });

  const searchResponse = await server.inject({
    method: "GET",
    url: "/context/search-data-lake?sourceApp=notion&sourceType=document&custom.project=ospx-new&custom.section=requirements&q=JSON%20内容字段"
  });
  assert.equal(searchResponse.statusCode, 200);
  const searchResult = searchResponse.json().result as {
    total: number;
    items: Array<{
      id: string;
      dataSource?: {
        sourceApp?: string;
        sourceId?: string;
        sourceType?: string;
      };
      customFields?: Record<string, unknown>;
    }>;
  };
  const segment = searchResult.items.find((item) => item.id === `seg_${eventId}_item_${eventId}`);
  assert.ok(segment);
  assert.equal(segment.dataSource?.sourceApp, "notion");
  assert.equal(segment.dataSource?.sourceId, "notion-page-json-42");
  assert.equal(segment.dataSource?.sourceType, "document");
  assert.equal(segment.customFields?.project, "ospx-new");
  assert.equal(segment.customFields?.section, "requirements");

  const nestedValueResponse = await server.inject({
    method: "GET",
    url: "/context/search-data-lake?custom.task.id=task-json-123"
  });
  assert.equal(nestedValueResponse.statusCode, 200);
  assert.equal(nestedValueResponse.json().result.items.some((item: { id: string }) => item.id === `seg_${eventId}_item_${eventId}`), true);

  await server.close();
});

test("persists llm runtime config through context config endpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-runtime-config-"));
  const configPath = join(directory, "context-engine.json");
  await writeFile(configPath, JSON.stringify({
    llm: {
      baseUrl: "https://file.example.com/v1",
      model: "file-model",
      apiKeyEnv: "CUSTOM_LLM_KEY"
    }
  }));
  const previousConfig = process.env.CONTEXT_ENGINE_CONFIG;
  const previousRuntimeConfig = process.env.CONTEXT_ENGINE_RUNTIME_CONFIG;
  process.env.CONTEXT_ENGINE_CONFIG = configPath;
  delete process.env.CONTEXT_ENGINE_RUNTIME_CONFIG;

  const server = createHealthServer(new InMemoryContextEngineRepository());
  const runtimeConfigPath = join(directory, "context-engine.runtime.json");

  try {
    const updateResponse = await server.inject({
      method: "PUT",
      url: "/context/config",
      headers: { "content-type": "application/json" },
      payload: {
        llm: {
          baseUrl: "https://runtime.example.com/v1",
          model: "runtime-model",
          apiKey: "runtime-secret"
        }
      }
    });
    assert.equal(updateResponse.statusCode, 200);
    const updateJson = updateResponse.json() as {
      config?: {
        llm: {
          baseUrl: string;
          model: string;
          apiKeyConfigured: boolean;
        };
      };
    };
    assert.equal(updateJson.config?.llm.baseUrl, "https://runtime.example.com/v1");
    assert.equal(updateJson.config?.llm.model, "runtime-model");
    assert.equal(updateJson.config?.llm.apiKeyConfigured, true);

    const readResponse = await server.inject({ method: "GET", url: "/context/config" });
    assert.equal(readResponse.statusCode, 200);
    const readJson = readResponse.json() as {
      config?: {
        llm: {
          baseUrl: string;
          model: string;
          apiKeyConfigured: boolean;
        };
      };
    };
    assert.equal(readJson.config?.llm.baseUrl, "https://runtime.example.com/v1");
    assert.equal(readJson.config?.llm.model, "runtime-model");
    assert.equal(readJson.config?.llm.apiKeyConfigured, true);
  } finally {
    await server.close();
    if (previousConfig === undefined) {
      delete process.env.CONTEXT_ENGINE_CONFIG;
    } else {
      process.env.CONTEXT_ENGINE_CONFIG = previousConfig;
    }
    if (previousRuntimeConfig === undefined) {
      delete process.env.CONTEXT_ENGINE_RUNTIME_CONFIG;
    } else {
      process.env.CONTEXT_ENGINE_RUNTIME_CONFIG = previousRuntimeConfig;
    }
    await rm(runtimeConfigPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
