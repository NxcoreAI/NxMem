import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getContextEngineConfig } from "../../config.js";
import { createHealthServer } from "../../modules/health/server.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("scan files ingests supported files and skips unsupported ones", async () => {
  const inboxDirectory = await mkdtemp(join(getContextEngineConfig().ingestion.inboxDirectory, "context-ingest-"));
  await writeFile(join(inboxDirectory, "note.md"), "导入测试：这是一个可摄入文件。");
  await writeFile(join(inboxDirectory, "preview.gif"), "not-really-an-image");

  const server = createHealthServer(new InMemoryContextEngineRepository());
  try {
    const response = await server.inject({
      method: "POST",
      url: "/context/ingest/files",
      headers: { "content-type": "application/json" },
      payload: { directory: inboxDirectory }
    });

    assert.equal(response.statusCode, 200);
    const json = response.json() as {
      ok: boolean;
      result?: {
        ingested: Array<{ path: string }>;
        skipped: Array<{ path: string; reason: string }>;
        progress?: {
          progress: number;
          total: number;
          remembered: number;
        };
      };
    };

    assert.equal(json.ok, true);
    assert.equal(json.result?.ingested.some((item) => item.path.endsWith("note.md")), true);
    assert.equal(json.result?.skipped.some((item) => item.path.endsWith("preview.gif") && item.reason === "unsupported_extension"), true);
    assert.ok(json.result?.progress);
    assert.equal(typeof json.result.progress.progress, "number");
    assert.equal(json.result.progress.total, 1);
    assert.equal(json.result.progress.remembered, 1);
  } finally {
    await server.close();
    await rm(inboxDirectory, { recursive: true, force: true });
  }
});
