import { createHash } from "node:crypto";
import type { ContextEngineConfig } from "../../config.js";
import type { GraphMemoryStore } from "./persistence/graph-store.js";
import { Neo4jGraphMemoryStore } from "./persistence/neo4j-graph-store.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";

export const LOCOMO_GRAPH_NAMESPACE = "locomo_native";

export async function openLocomoEvaluationRepository(input: {
  config: ContextEngineConfig;
  storePath: string;
  readOnly?: boolean;
  initializeGraph?: boolean;
}) {
  const graphStore = await createConfiguredLocomoGraphStore(input.config, {
    ...(input.initializeGraph !== undefined ? { initialize: input.initializeGraph } : {})
  });
  const repository = new SqliteContextEngineRepository(input.storePath, graphStore, { readOnly: input.readOnly === true });
  return {
    repository,
    graphStore,
    async close() {
      repository.close();
      if (graphStore?.close) await graphStore.close();
    }
  };
}

export async function createConfiguredLocomoGraphStore(
  config: ContextEngineConfig,
  options: { initialize?: boolean } = {}
): Promise<GraphMemoryStore | undefined> {
  const mode = graphMode(config);
  if (mode === "local") return undefined;
  const source = graphConfig(config);
  const graphStore = new Neo4jGraphMemoryStore({
    uri: source.uri,
    username: source.username,
    password: source.password ?? "",
    database: source.database,
    fulltextIndexName: namespacedIndex(source.fulltextIndexName, "fulltext"),
    vectorIndexName: namespacedIndex(source.vectorIndexName, "vector"),
    vectorDimensions: source.vectorDimensions
  });
  if (options.initialize !== false) await graphStore.initialize();
  return graphStore;
}

export function locomoGraphFingerprint(config: ContextEngineConfig) {
  if (graphMode(config) === "local") return "local";
  const source = graphConfig(config);
  return createHash("sha256").update(JSON.stringify({
    mode: "neo4j",
    namespace: LOCOMO_GRAPH_NAMESPACE,
    uri: source.uri,
    database: source.database,
    fulltextIndexName: namespacedIndex(source.fulltextIndexName, "fulltext"),
    vectorIndexName: namespacedIndex(source.vectorIndexName, "vector"),
    vectorDimensions: source.vectorDimensions
  })).digest("hex");
}

function graphMode(config: ContextEngineConfig) {
  return config.locomoEvaluation.graphStore.mode === "inherit" ? config.graphStore.mode : config.locomoEvaluation.graphStore.mode;
}

function graphConfig(config: ContextEngineConfig) {
  return config.locomoEvaluation.graphStore.mode === "neo4j" ? config.locomoEvaluation.graphStore.neo4j : config.graphStore.neo4j;
}

function namespacedIndex(configuredName: string, kind: "fulltext" | "vector") {
  return `${LOCOMO_GRAPH_NAMESPACE}_${kind}_${createHash("sha256").update(configuredName).digest("hex").slice(0, 8)}`;
}
