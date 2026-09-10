import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../health/server.js";
import { createContextInventoryMcpServer } from "./context-inventory-mcp.js";
import { refreshLongTermMemoryIndex } from "./indexing.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import type { LongTermMemory } from "./domain.js";

test("HTTP search routes accept temporal fields and reject invalid half-open ranges", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveMemory(repository, "ltm_route_inside", "route temporal inside", "2026-08-01T02:00:00.000Z");
  await saveMemory(repository, "ltm_route_outside", "route temporal outside", "2026-09-01T02:00:00.000Z");
  const server = createHealthServer(repository);

  const postResponse = await server.inject({
    method: "POST",
    url: "/context/search",
    payload: {
      q: "route temporal",
      layer: "ltm",
      referenceTime: "2026-08-01T12:00:00.000Z",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      timeRange: {
        startTime: "2026-08-01T00:00:00.000Z",
        endTime: "2026-08-02T00:00:00.000Z",
        basis: "valid"
      }
    }
  });
  assert.equal(postResponse.statusCode, 200);
  const postPayload = postResponse.json() as {
    temporal: { basis: string; timezone: string; locale: string };
    results: Array<{ id: string; temporal: { matchedBasis?: string } }>;
  };
  assert.equal(postPayload.temporal.basis, "valid");
  assert.equal(postPayload.temporal.timezone, "Asia/Shanghai");
  assert.equal(postPayload.temporal.locale, "zh-CN");
  assert.deepEqual(postPayload.results.map((item) => item.id), ["ltm_route_inside"]);
  assert.equal(postPayload.results[0]?.temporal.matchedBasis, "valid");

  const getResponse = await server.inject({
    method: "GET",
    url: "/context/search?q=route%20temporal&layer=ltm&referenceTime=2026-08-01T12%3A00%3A00.000Z&timezone=Asia%2FShanghai&startTime=2026-08-01T00%3A00%3A00.000Z&endTime=2026-08-02T00%3A00%3A00.000Z&basis=valid"
  });
  assert.equal(getResponse.statusCode, 200);
  assert.deepEqual(getResponse.json().results.map((item: { id: string }) => item.id), ["ltm_route_inside"]);

  const invalid = await server.inject({
    method: "GET",
    url: "/context/search?q=test&startTime=2026-08-02T00%3A00%3A00.000Z&endTime=2026-08-01T00%3A00%3A00.000Z&basis=evidence"
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, "TEMPORAL_RANGE_INVALID");
  await server.close();
});

test("MCP schema and argument parser pass temporal fields into Context Pack searches", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveMemory(repository, "ltm_mcp_inside", "MCP temporal inside", "2026-08-01T02:00:00.000Z");
  await saveMemory(repository, "ltm_mcp_outside", "MCP temporal outside", "2026-09-01T02:00:00.000Z");
  const mcp = createContextInventoryMcpServer(repository);

  const list = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list"
  });
  const searchTool = (list?.result?.tools as Array<{
    name: string;
    inputSchema: { properties: Record<string, { type?: string; properties?: Record<string, unknown> }> };
  }>).find((tool) => tool.name === "search_context");
  assert.equal(searchTool?.inputSchema.properties.referenceTime?.type, "string");
  assert.equal(searchTool?.inputSchema.properties.timezone?.type, "string");
  assert.equal(searchTool?.inputSchema.properties.locale?.type, "string");
  assert.equal(searchTool?.inputSchema.properties.timeRange?.type, "object");
  assert.ok(searchTool?.inputSchema.properties.timeRange?.properties?.basis);

  const call = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "search_context",
      arguments: {
        task: "MCP temporal",
        q: "MCP temporal",
        layer: "ltm",
        referenceTime: "2026-08-01T12:00:00.000Z",
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
        timeRange: {
          startTime: "2026-08-01T00:00:00.000Z",
          endTime: "2026-08-02T00:00:00.000Z",
          basis: "valid"
        },
        tokenBudget: 800
      }
    }
  });
  const content = (call?.result?.content as Array<{ text: string }>)[0]?.text ?? "";
  assert.equal(content.includes("MCP temporal inside"), true);
  assert.equal(content.includes("MCP temporal outside"), false);

  const invalid = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "search_context",
      arguments: {
        task: "invalid temporal range",
        timeRange: {
          startTime: "2026-08-02T00:00:00.000Z",
          endTime: "2026-08-01T00:00:00.000Z",
          basis: "valid"
        }
      }
    }
  });
  assert.equal(invalid?.error?.message, "TEMPORAL_RANGE_INVALID");
});

async function saveMemory(
  repository: InMemoryContextEngineRepository,
  memoryId: string,
  content: string,
  validTimeStart: string
) {
  const memory: LongTermMemory = {
    memoryId,
    theoryClass: "prospective",
    memoryType: "event",
    content,
    sourceRefs: [{ sourceRefId: `${memoryId}_source`, sourceType: "file", sourceId: `${memoryId}_source` }],
    sourceMemoryDataIds: [],
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "temporal interface test",
    matchedRules: ["test"],
    lifecycleStatus: "active",
    accessState: "visible",
    validTimeStart,
    validTimeConfidence: "high"
  };
  await repository.saveLongTermMemory(memory);
  await refreshLongTermMemoryIndex(repository, memory);
}
