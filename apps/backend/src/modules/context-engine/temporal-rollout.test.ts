import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import { createConversationIngestionService } from "./conversation-ingestion/conversation-ingestion-service.js";
import { extendedConversationFixture } from "./conversation-ingestion/fixtures/index.js";
import { searchContext } from "./search-context.js";
import {
  getTemporalFeatureFlags,
  shouldIncludeConversationMessageTimestamps
} from "./temporal-rollout.js";

test("keeps Agent message timestamps disabled by default and parses rollout env values", () => {
  assert.equal(shouldIncludeConversationMessageTimestamps(), false);
  assert.deepEqual(getTemporalFeatureFlags({}, {
    CONTEXT_ENGINE_TEMPORAL_READ: "false",
    CONTEXT_ENGINE_EVIDENCE_LAYER: "0",
    CONTEXT_ENGINE_TEMPORAL_HARD_FILTER: "off",
    CONVERSATION_INGESTION_INCLUDE_MESSAGE_TIMESTAMPS: "true"
  }), {
    temporalRead: false,
    evidenceLayer: false,
    temporalHardFilter: false,
    agentMessageTimestamps: true
  });
});

test("records hard-filter shadow differences without exposing message content in trace", async () => {
  const repository = await repositoryWithExtendedConversation();
  const response = await searchContext(repository, {
    q: "深圳",
    layer: "evidence",
    tenantId: "tenant_rollout",
    principalId: "principal_rollout",
    timeRange: {
      startTime: "2026-07-24T00:00:00.000Z",
      endTime: "2026-07-25T00:00:00.000Z",
      basis: "evidence"
    }
  }, {
    featureFlags: {
      temporalRead: true,
      evidenceLayer: true,
      temporalHardFilter: false
    }
  });

  assert.equal(response.results.length, 1);
  assert.equal(response.trace.featureFlags?.temporalHardFilter, false);
  assert.equal(response.trace.shadow?.enabled, true);
  assert.equal(response.trace.shadow?.resultCount, 0);
  assert.deepEqual(response.trace.shadow?.removedResultIds, [
    `evidence:${response.results[0]!.id}`
  ]);
  assert.equal(JSON.stringify(response.trace).includes("我计划明天去深圳"), false);
});

test("records evidence-layer shadow additions while the rollout flag is off", async () => {
  const repository = await repositoryWithExtendedConversation();
  const response = await searchContext(repository, {
    q: "深圳",
    layer: "evidence",
    tenantId: "tenant_rollout",
    principalId: "principal_rollout"
  }, {
    featureFlags: {
      temporalRead: true,
      evidenceLayer: false,
      temporalHardFilter: true
    }
  });

  assert.equal(response.results.length, 0);
  assert.equal(response.trace.shadow?.resultCount, 1);
  assert.match(response.trace.shadow?.addedResultIds[0] ?? "", /^evidence:/u);
});

async function repositoryWithExtendedConversation() {
  const repository = new InMemoryContextEngineRepository();
  const document = extendedConversationFixture.document;
  await createConversationIngestionService(repository).ingest({
    document,
    documentSha256: createHash("sha256").update(document, "utf8").digest("hex"),
    idempotencyKey: `rollout-${Math.random()}`,
    processingMode: "async"
  }, {
    tenantId: "tenant_rollout",
    principalId: "principal_rollout",
    sourceApp: "coding-agent",
    allowedVisibilities: ["private"]
  });
  return repository;
}
