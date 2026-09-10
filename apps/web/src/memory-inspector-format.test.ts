import test from "node:test";
import assert from "node:assert/strict";

import { formatMemoryInspectorSummary } from "./memory-inspector-format";

test("formatMemoryInspectorSummary exposes PRD memory type and fact summary for STM", () => {
  assert.deepEqual(
    formatMemoryInspectorSummary({
      memoryDataId: "stm_1",
      memoryDataType: "manual_memory_event",
      memoryType: "preference",
      factSummary: "偏好：PRD 规则需要配例子。",
      summary: "补充解释：用户明确表达了 PRD 写作偏好。",
      content: "用户偏好 PRD 规则配例子。"
    }),
    {
      id: "stm_1",
      type: "preference",
      factSummary: "偏好：PRD 规则需要配例子。"
    }
  );
});

test("formatMemoryInspectorSummary falls back to legacy fields", () => {
  assert.deepEqual(
    formatMemoryInspectorSummary({
      memoryId: "ltm_1",
      memoryType: "knowledge",
      summary: "补充解释：由做梦流程巩固。",
      content: "记忆引擎使用双存储层。"
    }),
    {
      id: "ltm_1",
      type: "knowledge",
      factSummary: "补充解释：由做梦流程巩固。"
    }
  );
});

test("formatMemoryInspectorSummary exposes graph node memory fields", () => {
  assert.deepEqual(
    formatMemoryInspectorSummary({
      graphNodeId: "graph_ltm_1",
      ownerId: "ltm_1",
      ownerType: "ltm",
      memoryType: "project",
      factSummary: "项目：图节点保留短摘要。",
      content: "图节点需要和 LTM 一致。"
    }),
    {
      id: "graph_ltm_1",
      type: "project",
      factSummary: "项目：图节点保留短摘要。"
    }
  );
});
