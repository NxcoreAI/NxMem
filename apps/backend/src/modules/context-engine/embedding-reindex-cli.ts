import "dotenv/config";
import { reindexConfiguredRepositoryEmbeddings } from "./embedding-reindex.js";

reindexConfiguredRepositoryEmbeddings({
  onProgress(progress) {
    process.stderr.write(`embedding reindex ${progress.processed}/${progress.total} (batch ${progress.batchIndex}/${progress.batchCount})\n`);
  }
}).then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
