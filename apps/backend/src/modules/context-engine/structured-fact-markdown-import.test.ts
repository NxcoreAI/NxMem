import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ContextIndexEntry } from "./domain.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import {
  importStructuredFactMarkdown,
  memoryTypeForDeclaredType,
  parseStructuredFactMarkdown,
  StructuredFactMarkdownValidationError
} from "./structured-fact-markdown-import.js";

const fixturePath = fileURLToPath(new URL("../../../../../极核产品经理一周事实记忆假数据.md", import.meta.url));
const importOptions = {
  datasetId: "synthetic-pm-week-20260715-20260721-v1",
  sourcePath: fixturePath,
  tenantId: "synthetic-test",
  principalId: "synthetic-product-manager"
} as const;

test("parses all 108 structured facts without changing content", async () => {
  const dataset = parseStructuredFactMarkdown(await readFile(fixturePath, "utf8"));

  assert.equal(dataset.declaredCount, 108);
  assert.equal(dataset.records.length, 108);
  assert.equal(new Set(dataset.records.map((record) => record.externalId)).size, 108);
  assert.equal(dataset.records[0]?.externalId, "001");
  assert.equal(dataset.records[0]?.occurredAt, "2026-07-15T08:00:00+08:00");
  assert.equal(dataset.records[0]?.factText, "用户确认极核是一个更懂用户的个人上下文中枢。");
  assert.equal(dataset.records[107]?.externalId, "108");
  assert.equal(dataset.records[107]?.occurredAt, "2026-07-21T18:05:00+08:00");
});

test("rejects a missing table record before writing anything", async () => {
  const markdown = await readFile(fixturePath, "utf8");
  const missing = markdown.replace(/^\| 054 \|.*\n/mu, "");

  assert.throws(
    () => parseStructuredFactMarkdown(missing),
    (error) => error instanceof StructuredFactMarkdownValidationError &&
      error.issues.some((issue) => issue.includes("declared 108 records but parsed 107"))
  );
});

test("dry-run validates the dataset without mutating the repository", async () => {
  const repository = new InMemoryContextEngineRepository();
  const dataset = parseStructuredFactMarkdown(await readFile(fixturePath, "utf8"));
  const report = await importStructuredFactMarkdown(repository, dataset, {
    ...importOptions,
    mode: "dry-run"
  });

  assert.equal(report.passed, true);
  assert.equal(report.plannedFacts, 108);
  assert.equal(report.appliedRecords, 0);
  assert.equal(repository.getDebugSnapshot().facts.length, 0);
});

test("apply writes and verifies one event, segment, fact, STM and index per row idempotently", async () => {
  const repository = new InMemoryContextEngineRepository();
  const dataset = parseStructuredFactMarkdown(await readFile(fixturePath, "utf8"));

  const first = await importStructuredFactMarkdown(repository, dataset, {
    ...importOptions,
    mode: "apply"
  });
  const second = await importStructuredFactMarkdown(repository, dataset, {
    ...importOptions,
    mode: "apply"
  });

  assert.equal(first.passed, true);
  assert.deepEqual(first.verification, {
    events: 108,
    segments: 108,
    facts: 108,
    shortTermMemories: 108,
    indexes: 108,
    missingIds: [],
    mismatches: []
  });
  assert.equal(second.passed, true);

  const snapshot = repository.getDebugSnapshot();
  assert.equal(snapshot.memoryEvents.length, 108);
  assert.equal(snapshot.parsedSegments.length, 108);
  assert.equal(snapshot.facts.length, 108);
  assert.equal(snapshot.shortTermMemories.length, 108);
  assert.equal(snapshot.indexEntries.filter((entry) => entry.ownerType === "stm").length, 108);

  const firstFact = snapshot.facts.find((fact) => fact.factId.endsWith("_001"));
  assert.equal(firstFact?.factText, "用户确认极核是一个更懂用户的个人上下文中枢。");
  assert.equal(firstFact?.factType, "knowledge");
  assert.equal(firstFact?.validTimeStart, "2026-07-15T08:00:00+08:00");
  assert.equal(firstFact?.linkedSourceRefs[0]?.sourceType, "synthetic_markdown_row");

  const row54 = snapshot.parsedSegments.find((segment) => segment.customFields?.externalFactId === "054");
  assert.equal(row54?.customFields?.declaredSourceType, "Agent 对话");
  assert.equal(row54?.customFields?.isSynthetic, true);
});

test("maps every declared memory type to a canonical engine type", () => {
  assert.equal(memoryTypeForDeclaredType("产品定义"), "knowledge");
  assert.equal(memoryTypeForDeclaredType("项目决策"), "project");
  assert.equal(memoryTypeForDeclaredType("产品偏好"), "preference");
  assert.equal(memoryTypeForDeclaredType("行动项"), "task");
  assert.equal(memoryTypeForDeclaredType("协作关系"), "relationship");
});

test("continues after one index failure and reports the incomplete record", async () => {
  class FailingIndexRepository extends InMemoryContextEngineRepository {
    override async saveIndexEntry(entry: ContextIndexEntry) {
      if (entry.ownerId.endsWith("_054")) throw new Error("simulated_index_failure");
      await super.saveIndexEntry(entry);
    }
  }

  const repository = new FailingIndexRepository();
  const dataset = parseStructuredFactMarkdown(await readFile(fixturePath, "utf8"));
  const report = await importStructuredFactMarkdown(repository, dataset, {
    ...importOptions,
    mode: "apply"
  });

  assert.equal(report.passed, false);
  assert.equal(report.verification.facts, 108);
  assert.equal(report.verification.indexes, 107);
  assert.equal(report.verification.missingIds.includes("index:stm_fact_synthetic-pm-week-20260715-20260721-v1_054"), true);
  assert.equal(report.verification.mismatches.some((item) => item.includes("simulated_index_failure")), true);
  assert.equal(repository.getDebugSnapshot().facts.some((fact) => fact.factId.endsWith("_108")), true);
});
