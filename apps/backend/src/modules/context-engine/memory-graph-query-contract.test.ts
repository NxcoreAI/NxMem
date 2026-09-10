import test from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_GRAPH_LAYERS,
  MEMORY_GRAPH_PAGE_LIMITS,
  MEMORY_GRAPH_RELATION_TYPES,
  MemoryGraphQueryContractError,
  decodeMemoryGraphEdgeCursor,
  decodeMemoryGraphNodeCursor,
  encodeMemoryGraphEdgeCursor,
  encodeMemoryGraphNodeCursor,
  parseMemoryGraphQueryRequest
} from "./memory-graph-query-contract.js";

test("parseMemoryGraphQueryRequest applies deterministic defaults", () => {
  const result = parseMemoryGraphQueryRequest({
    nodePage: {},
    edgePage: {}
  });

  assert.deepEqual(result.layers, [...MEMORY_GRAPH_LAYERS]);
  assert.deepEqual(result.relationTypes, [...MEMORY_GRAPH_RELATION_TYPES]);
  assert.equal(result.page, 1);
  assert.deepEqual(result.nodePage, { limit: MEMORY_GRAPH_PAGE_LIMITS.node.default });
  assert.deepEqual(result.edgePage, { limit: MEMORY_GRAPH_PAGE_LIMITS.edge.default });
});

test("parseMemoryGraphQueryRequest normalizes filters and supports stopping one page", () => {
  const result = parseMemoryGraphQueryRequest({
    page: 2,
    layers: ["ltm", "stm"],
    relationTypes: ["updates", "derived_from"],
    nodePage: { limit: 12, cursor: null },
    edgePage: null
  });

  assert.deepEqual(result.layers, ["stm", "ltm"]);
  assert.deepEqual(result.relationTypes, ["derived_from", "updates"]);
  assert.equal(result.page, 2);
  assert.deepEqual(result.nodePage, { limit: 12 });
  assert.equal(result.edgePage, null);
});

test("parseMemoryGraphQueryRequest strictly rejects invalid queries", () => {
  const invalidQueries = [
    undefined,
    {},
    { nodePage: null, edgePage: null },
    { nodePage: {}, unexpected: true },
    { nodePage: { unexpected: true } },
    { layers: [], nodePage: {} },
    { layers: ["stm", "stm"], nodePage: {} },
    { layers: ["fact"], nodePage: {} },
    { relationTypes: [], nodePage: {} },
    { relationTypes: ["unknown"], nodePage: {} },
    { nodePage: { limit: 0 } },
    { nodePage: { limit: MEMORY_GRAPH_PAGE_LIMITS.node.max + 1 } },
    { edgePage: { limit: 1.5 } },
    { page: 0, nodePage: {} },
    { page: 1.5, nodePage: {} },
    { page: Number.MAX_SAFE_INTEGER, nodePage: { limit: 2 } },
    { page: 2, nodePage: { cursor: "valid-looking-cursor" } },
    { nodePage: { page: 2 } }
  ];

  for (const input of invalidQueries) {
    assertContractCode(
      () => parseMemoryGraphQueryRequest(input),
      "INVALID_MEMORY_GRAPH_QUERY"
    );
  }
});

test("parseMemoryGraphQueryRequest rejects malformed cursor fields", () => {
  for (const cursor of ["", " padded", 42, "x".repeat(4097)]) {
    assertContractCode(
      () => parseMemoryGraphQueryRequest({ nodePage: { cursor } }),
      "INVALID_MEMORY_GRAPH_CURSOR"
    );
  }
});

test("node cursor round-trips and binds only the normalized layer filter", () => {
  const cursor = encodeMemoryGraphNodeCursor(
    { layer: "ltm", id: "ltm_cursor_2" },
    ["stm", "ltm"]
  );

  assert.deepEqual(
    decodeMemoryGraphNodeCursor(cursor, ["ltm", "stm"]),
    { layer: "ltm", id: "ltm_cursor_2" }
  );
  assertContractCode(
    () => decodeMemoryGraphNodeCursor(cursor, ["ltm"]),
    "INVALID_MEMORY_GRAPH_CURSOR"
  );
});

test("edge cursor round-trips and binds layers plus relation types", () => {
  const cursor = encodeMemoryGraphEdgeCursor(
    { id: "edge_updates_2" },
    ["stm", "ltm"],
    ["updates", "derived_from"]
  );

  assert.deepEqual(
    decodeMemoryGraphEdgeCursor(
      cursor,
      ["ltm", "stm"],
      ["derived_from", "updates"]
    ),
    { id: "edge_updates_2" }
  );
  assertContractCode(
    () => decodeMemoryGraphEdgeCursor(cursor, ["stm", "ltm"], ["updates"]),
    "INVALID_MEMORY_GRAPH_CURSOR"
  );
});

test("cursor decoding rejects the wrong type, corruption and unsupported versions", () => {
  const nodeCursor = encodeMemoryGraphNodeCursor(
    { layer: "stm", id: "stm_cursor_1" },
    ["stm", "ltm"]
  );
  assertContractCode(
    () => decodeMemoryGraphEdgeCursor(
      nodeCursor,
      ["stm", "ltm"],
      ["derived_from"]
    ),
    "INVALID_MEMORY_GRAPH_CURSOR"
  );
  assertContractCode(
    () => decodeMemoryGraphNodeCursor("not-a-json-cursor", ["stm", "ltm"]),
    "INVALID_MEMORY_GRAPH_CURSOR"
  );

  const payload = JSON.parse(Buffer.from(nodeCursor, "base64url").toString("utf8"));
  const unsupported = Buffer.from(JSON.stringify({ ...payload, version: 2 }), "utf8")
    .toString("base64url");
  assertContractCode(
    () => decodeMemoryGraphNodeCursor(unsupported, ["stm", "ltm"]),
    "INVALID_MEMORY_GRAPH_CURSOR"
  );
});

test("cursor encoding rejects invalid positions and filter sets", () => {
  assertContractCode(
    () => encodeMemoryGraphNodeCursor({ layer: "ltm", id: "ltm_1" }, ["stm"]),
    "INVALID_MEMORY_GRAPH_CURSOR"
  );
  assertContractCode(
    () => encodeMemoryGraphEdgeCursor({ id: "edge_1" }, ["stm"], []),
    "INVALID_MEMORY_GRAPH_CURSOR"
  );
});

function assertContractCode(
  action: () => unknown,
  code: MemoryGraphQueryContractError["code"]
) {
  assert.throws(action, (error) =>
    error instanceof MemoryGraphQueryContractError && error.code === code
  );
}
