import { createHealthServer } from "./modules/health/server.js";
import { getContextEngineConfig } from "./config.js";
import { createContextEngineRepository } from "./modules/context-engine/service-bootstrap.js";

const config = getContextEngineConfig();
const repository = await createContextEngineRepository();

const server = createHealthServer(repository);

try {
  await server.listen({ port: config.server.port, host: config.server.host });
  console.log(`backend listening on http://${config.server.host}:${config.server.port}`);
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
