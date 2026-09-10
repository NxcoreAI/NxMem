import { getContextEngineConfig } from "../../config.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import {
  CONTEXT_ENGINE_TEMPORAL_BACKFILL_VERSION,
  runTemporalBackfill
} from "./temporal-backfill.js";

const versionArgument = process.argv.find((argument) => argument.startsWith("--version="));
const version = versionArgument?.slice("--version=".length) || CONTEXT_ENGINE_TEMPORAL_BACKFILL_VERSION;
const repository = new SqliteContextEngineRepository(getContextEngineConfig().storage.storePath);

try {
  const result = await runTemporalBackfill(repository, { version });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "failed") process.exitCode = 1;
} finally {
  repository.close();
}
