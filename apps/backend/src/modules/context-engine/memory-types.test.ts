import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeFactSummary,
  summarizeFactsForMemory,
  summarizeStructuredFacts,
  theoryClassForMemoryType
} from "./memory-types.js";

test("maps every product memory type to its fixed theory class", () => {
  assert.deepEqual({
    person_profile: theoryClassForMemoryType("person_profile"),
    fact: theoryClassForMemoryType("fact"),
    relationship: theoryClassForMemoryType("relationship"),
    project: theoryClassForMemoryType("project"),
    knowledge: theoryClassForMemoryType("knowledge"),
    preference: theoryClassForMemoryType("preference"),
    workflow_pattern: theoryClassForMemoryType("workflow_pattern"),
    ai_persona: theoryClassForMemoryType("ai_persona"),
    event: theoryClassForMemoryType("event"),
    task: theoryClassForMemoryType("task")
  }, {
    person_profile: "semantic",
    fact: "semantic",
    relationship: "semantic",
    project: "semantic",
    knowledge: "semantic",
    preference: "procedural",
    workflow_pattern: "procedural",
    ai_persona: "procedural",
    event: "episodic",
    task: "prospective"
  });
});

test("summarizeFactsForMemory compacts long requirement text into a short label", () => {
  assert.equal(
    summarizeFactsForMemory(
      [
        {
          factId: "fact_1",
          factType: "requirement",
          factText: "上下文引擎需支持多模态记忆事件捕获、来源引用保留、长短记忆状态展示及可追溯上下文包检索",
          normalizedClaim: "上下文引擎需支持多模态记忆事件捕获、来源引用保留、长短记忆状态展示及可追溯上下文包检索",
          linkedEventIds: [],
          linkedSegmentIds: [],
          linkedSourceRefs: [],
          entityIds: [],
          confidenceLevel: "high",
          version: 1,
          status: "active",
          observedAt: "2026-07-01T00:00:00.000Z",
          validTimeStart: "2026-07-01T00:00:00.000Z",
          timeBasis: "source_time",
          timeConfidence: "high",
          schemaVersion: "fact-item.v1"
        }
      ],
      "fallback"
    ),
    "多模态记忆事件捕获"
  );
});

test("summarizeFactsForMemory avoids cutting technical tokens in half", () => {
  assert.equal(
    summarizeFactsForMemory(
      [
        {
          factId: "fact_2",
          factType: "implementation",
          factText: "实现方案包含 write_event 与 parse_event 路径",
          normalizedClaim: "实现方案包含 write_event 与 parse_event 路径",
          linkedEventIds: [],
          linkedSegmentIds: [],
          linkedSourceRefs: [],
          entityIds: [],
          confidenceLevel: "high",
          version: 1,
          status: "active",
          observedAt: "2026-07-01T00:00:00.000Z",
          validTimeStart: "2026-07-01T00:00:00.000Z",
          timeBasis: "source_time",
          timeConfidence: "high",
          schemaVersion: "fact-item.v1"
        }
      ],
      "fallback"
    ),
    "write_event"
  );
});

test("summarizeFactsForMemory uses a semantic boundary instead of raw fixed-width truncation", () => {
  const summary = summarizeFactsForMemory(
    [
      {
        factId: "fact_3",
        factType: "requirement",
        factText: "上下文包预算控制必须优先使用语义摘要，然后再按相关句子抽取",
        normalizedClaim: "上下文包预算控制必须优先使用语义摘要，然后再按相关句子抽取",
        linkedEventIds: [],
        linkedSegmentIds: [],
        linkedSourceRefs: [],
        entityIds: [],
        confidenceLevel: "high",
        version: 1,
        status: "active",
        observedAt: "2026-07-01T00:00:00.000Z",
        validTimeStart: "2026-07-01T00:00:00.000Z",
        timeBasis: "source_time",
        timeConfidence: "high",
        schemaVersion: "fact-item.v1"
      }
    ],
    "fallback"
  );

  assert.equal(summary, "预算控制");
  assert.notEqual(summary, "上下文包预算控制必须优先");
});

test("summarizeFactsForMemory summarizes meeting facts within 20 chars without prefix truncation", () => {
  const summary = summarizeFactsForMemory(
    [
      {
        factId: "fact_4",
        factType: "meeting",
        factText: "本次会议讨论了新一代上下文引擎的架构升级、记忆召回预算和上线风险",
        normalizedClaim: "本次会议讨论了新一代上下文引擎的架构升级、记忆召回预算和上线风险",
        linkedEventIds: [],
        linkedSegmentIds: [],
        linkedSourceRefs: [],
        entityIds: [],
        confidenceLevel: "high",
        version: 1,
        status: "active",
        observedAt: "2026-07-01T00:00:00.000Z",
        validTimeStart: "2026-07-01T00:00:00.000Z",
        timeBasis: "source_time",
        timeConfidence: "high",
        schemaVersion: "fact-item.v1"
      }
    ],
    "fallback"
  );

  assert.equal(summary.length <= 20, true);
  assert.equal(summary, "新一代上下文引擎架构升级");
  assert.notEqual(summary, "本次会议讨论了新一代");
});

test("summarizeStructuredFacts keeps concise claims intact", () => {
  assert.equal(
    summarizeStructuredFacts({
      structuredFacts: {
        schemaVersion: "memory-structured-facts.v1",
        memoryKind: "long_term",
        facts: [
          {
            claim: "长期偏好",
            explanation: "PRD 要专业并配例子。"
          }
        ]
      },
      content: "fallback content",
      summary: "fallback summary"
    }),
    "长期偏好"
  );
});

test("fact summaries never expose generated placeholder text", () => {
  const summary = summarizeFactsForMemory(
    [
      {
        factId: "fact_placeholder",
        factType: "note",
        factText: "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
        normalizedClaim: "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
        linkedEventIds: [],
        linkedSegmentIds: [],
        linkedSourceRefs: [],
        entityIds: [],
        confidenceLevel: "high",
        version: 1,
        status: "active",
        observedAt: "2026-07-01T00:00:00.000Z",
        validTimeStart: "2026-07-01T00:00:00.000Z",
        timeBasis: "source_time",
        timeConfidence: "high",
        schemaVersion: "fact-item.v1"
      }
    ],
    ""
  );

  assert.notEqual(summary, "摘要待生成");
  assert.equal(normalizeFactSummary("摘要待生成"), "");
});
