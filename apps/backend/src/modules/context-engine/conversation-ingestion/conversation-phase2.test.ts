import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InMemoryContextEngineRepository } from "../persistence/memory-repository.js";
import { createConversationIngestionService } from "./conversation-ingestion-service.js";
import { createConversationIngestionWorker } from "./conversation-ingestion-worker.js";
import type { ConversationCallerScope } from "./domain.js";
import { validConversationFixture } from "./fixtures/index.js";

const callerScope: ConversationCallerScope = {
  tenantId: "tenant_fixture",
  principalId: "principal_fixture",
  sourceApp: "coding-agent",
  allowedVisibilities: ["private"]
};

test("worker reports a polling error and continues polling", { timeout: 2_000 }, async () => {
  const repository = new InMemoryContextEngineRepository();
  const expectedError = new Error("simulated claim failure");
  const reportedErrors: unknown[] = [];
  let claimAttempts = 0;
  let resolvePolledAgain: (() => void) | undefined;
  const polledAgain = new Promise<void>((resolve) => {
    resolvePolledAgain = resolve;
  });
  repository.claimNextConversationIngestionJob = async () => {
    claimAttempts += 1;
    if (claimAttempts === 1) throw expectedError;
    resolvePolledAgain?.();
    return undefined;
  };
  let resolveErrorReported: (() => void) | undefined;
  const errorReported = new Promise<void>((resolve) => {
    resolveErrorReported = resolve;
  });
  const worker = createConversationIngestionWorker(repository, {
    pollIntervalMs: 5,
    onError: (error) => {
      reportedErrors.push(error);
      resolveErrorReported?.();
    }
  });

  worker.start();
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([errorReported, polledAgain]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("worker did not continue polling")), 1_000);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    worker.stop();
  }

  assert.deepEqual(reportedErrors, [expectedError]);
  assert.ok(claimAttempts >= 2);
});

test("document worker keeps legacy evidence rows while skipping segmentation and evidence grouping", async () => {
  const repository = new InMemoryContextEngineRepository();
  const document = validConversationFixture.document;
  const response = await createConversationIngestionService(repository).ingest({
    document,
    idempotencyKey: "document-no-phase2",
    documentSha256: createHash("sha256").update(document, "utf8").digest("hex"),
    processingMode: "async"
  }, callerScope);
  const ingestionId = response.sessions[0]!.ingestionId;
  let receivedSessionId = "";
  const worker = createConversationIngestionWorker(repository, {
    phase3: {
      apiKey: "test-key",
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        const payload = JSON.parse(request.messages.find((item) => item.role === "user")!.content) as {
          session: { sessionId: string };
        };
        receivedSessionId = payload.session.sessionId;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      disableStmAdmissionLlm: true,
      disableLtmConsolidationLlm: true
    }
  });

  assert.equal(await worker.runOnce(), true);
  assert.equal(receivedSessionId, validConversationFixture.session.sessionId);
  assert.equal(repository.conversationMessages.length, validConversationFixture.messages.length);
  assert.equal(repository.conversationMessages.every((message) => message.timeConfidence === "low"), true);
  assert.equal(repository.getDebugSnapshot().parsedSegments.length, 0);
  assert.equal(repository.conversationMessageSegments.length, 0);
  assert.equal(repository.conversationEvidenceGroups.length, 0);
  assert.equal((await repository.getConversationIngestion(ingestionId))?.processingStatus, "processing_succeeded");
});
