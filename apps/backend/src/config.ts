import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ContextEngineConfig {
  projectRoot: string;
  configPath?: string;
  server: {
    host: string;
    port: number;
  };
  storage: {
    storePath: string;
  };
  ingestion: {
    inboxDirectory: string;
  };
  dreaming: {
    enabled: boolean;
    timezone: "Asia/Shanghai";
    schedule: "23:00";
    workerConcurrency: 1;
    maxAttemptsPerCycle: 3;
    reevaluationDays: [1, 3, 7];
    preemptWithinMs: number;
    resumeIdleAfterMs: number;
    candidateLeaseMs: number;
    runLeaseMs: number;
  };
  embedding: {
    protocol: EmbeddingProtocol;
    baseUrl?: string;
    model: string;
    apiKeyEnv: string;
    apiKey?: string;
    apiKeySource: "runtime" | "config" | "env" | "missing";
    dimensions: number;
    sendDimensions: boolean;
    timeoutMs: number;
    maxAttempts: number;
    retryDelayMs: number;
    concurrency: number;
    batchSize: number;
  };
  graphStore: {
    mode: "local" | "neo4j";
    neo4j: {
      uri: string;
      username: string;
      password?: string;
      database: string;
      fulltextIndexName: string;
      vectorIndexName: string;
      vectorDimensions: number;
    };
  };
  llm: {
    provider: "openai-compatible";
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    apiKey?: string;
    apiKeySource: "runtime" | "env" | "missing";
  };
  judgeLlm: {
    provider: "openai-compatible";
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    apiKey?: string;
    apiKeySource: "runtime" | "env" | "missing";
  };
  longMemEval: {
    storage: {
      storeDirectory: string;
    };
    graphStore: {
      mode: "inherit" | "local" | "neo4j";
      neo4j: {
        uri: string;
        username: string;
        password?: string;
        database: string;
        fulltextIndexName: string;
        vectorIndexName: string;
        vectorDimensions: number;
      };
    };
  };
  locomoEvaluation: {
    graphStore: {
      mode: "inherit" | "local" | "neo4j";
      neo4j: {
        uri: string;
        username: string;
        password?: string;
        database: string;
        fulltextIndexName: string;
        vectorIndexName: string;
        vectorDimensions: number;
      };
    };
  };
}

export interface PublicContextEngineConfig {
  server: {
    host: string;
    port: number;
  };
  storage: {
    storePath: string;
  };
  ingestion: {
    inboxDirectory: string;
  };
  dreaming: ContextEngineConfig["dreaming"];
  embedding: {
    protocol: EmbeddingProtocol;
    baseUrl?: string;
    model: string;
    apiKeyEnv: string;
    apiKeyConfigured: boolean;
    dimensions: number;
    sendDimensions: boolean;
    timeoutMs: number;
    maxAttempts: number;
    retryDelayMs: number;
    concurrency: number;
    batchSize: number;
  };
  graphStore: {
    mode: "local" | "neo4j";
    neo4j: {
      uri: string;
      usernameConfigured: boolean;
      passwordConfigured: boolean;
      database: string;
      fulltextIndexName: string;
      vectorIndexName: string;
      vectorDimensions: number;
    };
  };
  llm: {
    provider: "openai-compatible";
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    apiKeyConfigured: boolean;
  };
  judgeLlm: {
    provider: "openai-compatible";
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    apiKeyConfigured: boolean;
  };
  longMemEval: {
    storage: {
      storeDirectory: string;
    };
    graphStore: {
      mode: "inherit" | "local" | "neo4j";
      neo4j: {
        uri: string;
        usernameConfigured: boolean;
        passwordConfigured: boolean;
        database: string;
        fulltextIndexName: string;
        vectorIndexName: string;
        vectorDimensions: number;
      };
    };
  };
}

interface RawContextEngineConfig {
  server?: {
    host?: unknown;
    port?: unknown;
  };
  storage?: {
    storePath?: unknown;
  };
  ingestion?: {
    inboxDirectory?: unknown;
  };
  dreaming?: {
    enabled?: unknown;
    timezone?: unknown;
    schedule?: unknown;
    workerConcurrency?: unknown;
    maxAttemptsPerCycle?: unknown;
    reevaluationDays?: unknown;
    preemptWithinMs?: unknown;
    resumeIdleAfterMs?: unknown;
    candidateLeaseMs?: unknown;
    runLeaseMs?: unknown;
  };
  embedding?: {
    protocol?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    apiKey?: unknown;
    apiKeyEnv?: unknown;
    dimensions?: unknown;
    sendDimensions?: unknown;
    timeoutMs?: unknown;
    maxAttempts?: unknown;
    retryDelayMs?: unknown;
    concurrency?: unknown;
    batchSize?: unknown;
  };
  graphStore?: {
    mode?: unknown;
    neo4j?: {
      uri?: unknown;
      username?: unknown;
      password?: unknown;
      database?: unknown;
      fulltextIndexName?: unknown;
      vectorIndexName?: unknown;
      vectorDimensions?: unknown;
    };
  };
  llm?: {
    provider?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    apiKeyEnv?: unknown;
  };
  judgeLlm?: {
    provider?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    apiKeyEnv?: unknown;
  };
  longMemEval?: {
    storage?: {
      storeDirectory?: unknown;
    };
    graphStore?: {
      mode?: unknown;
      neo4j?: {
        uri?: unknown;
        username?: unknown;
        password?: unknown;
        database?: unknown;
        fulltextIndexName?: unknown;
        vectorIndexName?: unknown;
        vectorDimensions?: unknown;
      };
    };
  };
  locomoEvaluation?: {
    graphStore?: {
      mode?: unknown;
      neo4j?: {
        uri?: unknown;
        username?: unknown;
        password?: unknown;
        database?: unknown;
        fulltextIndexName?: unknown;
        vectorIndexName?: unknown;
        vectorDimensions?: unknown;
      };
    };
  };
}

const defaultConfigFile = "config/context-engine.json";
const defaultRuntimeConfigFile = "config/context-engine.runtime.json";
const defaultServerHost = "127.0.0.1";
const defaultServerPort = 3001;
const defaultStorePath = "data/context-engine-store.sqlite";
const defaultInboxDirectory = "data/inbox";
const defaultDreamingPreemptWithinMs = 3_000;
const defaultDreamingResumeIdleAfterMs = 120_000;
const defaultDreamingCandidateLeaseMs = 300_000;
const defaultDreamingRunLeaseMs = 300_000;
export type EmbeddingProtocol = "openai-compatible" | "adapter" | "deterministic-test";

const defaultEmbeddingBaseUrl = "";
const defaultEmbeddingModel = "";
const defaultEmbeddingDimensions = 0;
const defaultEmbeddingApiKeyEnv = "EMBEDDING_API_KEY";
const defaultEmbeddingProtocol: EmbeddingProtocol = "openai-compatible";
const defaultEmbeddingTimeoutMs = 60_000;
const defaultEmbeddingMaxAttempts = 3;
const defaultEmbeddingRetryDelayMs = 1_000;
const defaultEmbeddingConcurrency = 4;
const defaultEmbeddingBatchSize = 32;
const defaultGraphStoreMode = "local";
const defaultNeo4jUri = "bolt://127.0.0.1:7687";
const defaultNeo4jDatabase = "neo4j";
const defaultNeo4jFulltextIndexName = "memory_node_fulltext";
const defaultNeo4jVectorIndexName = "memory_node_vector";
const defaultLocomoEvaluationFulltextIndexName = "locomo_memory_node_fulltext";
const defaultLocomoEvaluationVectorIndexName = "locomo_memory_node_vector";
const defaultLongMemEvalStoreDirectory = resolve(tmpdir(), "nexcore-context-engine-longmemeval");
const defaultLlmBaseUrl = "https://api.openai.com/v1";
const defaultLlmModel = "gpt-4o-mini";
const defaultApiKeyEnv = "OPENAI_API_KEY";

let cachedConfig: ContextEngineConfig | undefined;

export function getContextEngineConfig() {
  cachedConfig ??= loadContextEngineConfig();
  return cachedConfig;
}

export function reloadContextEngineConfig(
  explicitConfigPath?: string,
  env: NodeJS.ProcessEnv = process.env
) {
  cachedConfig = loadContextEngineConfig(explicitConfigPath, env);
  return cachedConfig;
}

export function loadContextEngineConfig(
  explicitConfigPath?: string,
  env: NodeJS.ProcessEnv = process.env
): ContextEngineConfig {
  const configPath = resolveConfigPath(explicitConfigPath ?? env.CONTEXT_ENGINE_CONFIG);
  const raw = readRawConfig(configPath);
  const runtimeConfigPath = resolveRuntimeConfigPath(configPath, env.CONTEXT_ENGINE_RUNTIME_CONFIG);
  const runtime = readRuntimeConfig(runtimeConfigPath);
  const projectRoot = resolveProjectRoot(configPath);
  const apiKeyEnv = readString(raw.llm?.apiKeyEnv, defaultApiKeyEnv);
  const runtimeLlm = runtime.llm ?? {};
  const runtimeApiKey = readString(runtimeLlm.apiKey, "");
  const apiKey = runtimeApiKey || env[apiKeyEnv] || env.OPENAI_API_KEY;
  const port = readInteger(env.PORT, readInteger(raw.server?.port, defaultServerPort));
  const storePath = env.CONTEXT_ENGINE_STORE_PATH ?? readString(raw.storage?.storePath, defaultStorePath);
  const inboxDirectory = env.CONTEXT_ENGINE_INBOX_DIR ?? readString(raw.ingestion?.inboxDirectory, defaultInboxDirectory);
  validateDreamingProductConstraints(raw.dreaming);
  const dreamingEnabled = readBoolean(
    env.CONTEXT_ENGINE_DREAMING_ENABLED,
    readBoolean(raw.dreaming?.enabled, false)
  );
  const runtimeEmbedding = runtime.embedding ?? {};
  const embeddingProtocol = readEmbeddingProtocol(
    runtimeEmbedding.protocol ?? raw.embedding?.protocol ?? env.EMBEDDING_PROTOCOL
  );
  const embeddingBaseUrl = readString(
    runtimeEmbedding.baseUrl,
    readString(raw.embedding?.baseUrl, readString(env.EMBEDDING_BASE_URL, defaultEmbeddingBaseUrl))
  );
  const embeddingModel = readString(
    runtimeEmbedding.model,
    readString(raw.embedding?.model, readString(env.EMBEDDING_MODEL, defaultEmbeddingModel))
  );
  const embeddingApiKeyEnv = readString(raw.embedding?.apiKeyEnv, defaultEmbeddingApiKeyEnv);
  const runtimeEmbeddingApiKey = readString(runtimeEmbedding.apiKey, "");
  const configEmbeddingApiKey = readString(raw.embedding?.apiKey, "");
  const embeddingApiKey = runtimeEmbeddingApiKey
    || configEmbeddingApiKey
    || env[embeddingApiKeyEnv]
    || env.EMBEDDING_API_KEY;
  const embeddingDimensions = readInteger(
    runtimeEmbedding.dimensions,
    readInteger(raw.embedding?.dimensions, readInteger(env.EMBEDDING_DIMENSIONS, defaultEmbeddingDimensions))
  );
  const embeddingSendDimensions = readBoolean(
    runtimeEmbedding.sendDimensions,
    readBoolean(raw.embedding?.sendDimensions, readBoolean(env.EMBEDDING_SEND_DIMENSIONS, true))
  );
  const embeddingTimeoutMs = readInteger(
    runtimeEmbedding.timeoutMs,
    readInteger(raw.embedding?.timeoutMs, readInteger(env.EMBEDDING_TIMEOUT_MS, defaultEmbeddingTimeoutMs))
  );
  const embeddingMaxAttempts = readInteger(
    runtimeEmbedding.maxAttempts,
    readInteger(raw.embedding?.maxAttempts, readInteger(env.EMBEDDING_MAX_ATTEMPTS, defaultEmbeddingMaxAttempts))
  );
  const embeddingRetryDelayMs = readNonNegativeInteger(
    runtimeEmbedding.retryDelayMs,
    readNonNegativeInteger(raw.embedding?.retryDelayMs, readNonNegativeInteger(env.EMBEDDING_RETRY_DELAY_MS, defaultEmbeddingRetryDelayMs))
  );
  const embeddingConcurrency = readInteger(
    runtimeEmbedding.concurrency,
    readInteger(raw.embedding?.concurrency, readInteger(env.EMBEDDING_CONCURRENCY, defaultEmbeddingConcurrency))
  );
  const embeddingBatchSize = readInteger(
    runtimeEmbedding.batchSize,
    readInteger(raw.embedding?.batchSize, readInteger(env.EMBEDDING_BATCH_SIZE, defaultEmbeddingBatchSize))
  );
  validateEmbeddingConfig({
    protocol: embeddingProtocol,
    baseUrl: embeddingBaseUrl,
    model: embeddingModel,
    ...(embeddingApiKey ? { apiKey: embeddingApiKey } : {}),
    dimensions: embeddingDimensions,
    timeoutMs: embeddingTimeoutMs,
    maxAttempts: embeddingMaxAttempts,
    retryDelayMs: embeddingRetryDelayMs,
    concurrency: embeddingConcurrency,
    batchSize: embeddingBatchSize
  });
  const graphStoreMode = readGraphStoreMode(env.CONTEXT_ENGINE_GRAPH_STORE ?? raw.graphStore?.mode);
  const neo4jRaw = raw.graphStore?.neo4j ?? {};
  const neo4jUri = env.NEO4J_URI ?? readString(neo4jRaw.uri, defaultNeo4jUri);
  const neo4jUsername = env.NEO4J_USERNAME ?? readString(neo4jRaw.username, "");
  const neo4jPassword = env.NEO4J_PASSWORD ?? readString(neo4jRaw.password, "");
  const neo4jDatabase = env.NEO4J_DATABASE ?? readString(neo4jRaw.database, defaultNeo4jDatabase);
  const neo4jFulltextIndexName = env.NEO4J_MEMORY_FULLTEXT_INDEX ?? readString(neo4jRaw.fulltextIndexName, defaultNeo4jFulltextIndexName);
  const neo4jVectorIndexName = env.NEO4J_MEMORY_VECTOR_INDEX ?? readString(neo4jRaw.vectorIndexName, defaultNeo4jVectorIndexName);
  const neo4jVectorDimensions = readInteger(
    env.NEO4J_MEMORY_VECTOR_DIMENSIONS,
    readInteger(neo4jRaw.vectorDimensions, embeddingDimensions)
  );
  if (graphStoreMode === "neo4j" && (!neo4jUri || !neo4jUsername || !neo4jPassword)) {
    throw new Error("Neo4j graph store requires NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD");
  }
  const baseUrl = env.OPENAI_BASE_URL ?? readString(runtimeLlm.baseUrl, readString(raw.llm?.baseUrl, defaultLlmBaseUrl));
  const model = env.OPENAI_MODEL ?? readString(runtimeLlm.model, readString(raw.llm?.model, defaultLlmModel));
  const judgeBaseUrl = env.LONGMEMEVAL_JUDGE_BASE_URL ?? readString(runtime.judgeLlm?.baseUrl, readString(raw.judgeLlm?.baseUrl, baseUrl));
  const judgeModel = env.LONGMEMEVAL_JUDGE_MODEL ?? readString(runtime.judgeLlm?.model, readString(raw.judgeLlm?.model, model));
  const judgeApiKeyEnv = readString(raw.judgeLlm?.apiKeyEnv, defaultApiKeyEnv);
  const judgeApiKey = readString(runtime.judgeLlm?.apiKey, "") || env[judgeApiKeyEnv] || env.OPENAI_API_KEY || apiKey;
  const longMemEvalRaw = raw.longMemEval ?? {};
  const longMemEvalGraphRaw = longMemEvalRaw.graphStore ?? {};
  const longMemEvalNeo4jRaw = longMemEvalGraphRaw.neo4j ?? {};
  const longMemEvalStoreDirectory = env.LONGMEMEVAL_STORE_DIR
    ?? readString(longMemEvalRaw.storage?.storeDirectory, defaultLongMemEvalStoreDirectory);
  const longMemEvalGraphStoreMode = readLongMemEvalGraphStoreMode(env.LONGMEMEVAL_GRAPH_STORE ?? longMemEvalGraphRaw.mode);
  const longMemEvalNeo4jUri = env.LONGMEMEVAL_NEO4J_URI ?? readString(longMemEvalNeo4jRaw.uri, neo4jUri);
  const longMemEvalNeo4jUsername = env.LONGMEMEVAL_NEO4J_USERNAME ?? readString(longMemEvalNeo4jRaw.username, neo4jUsername);
  const longMemEvalNeo4jPassword = env.LONGMEMEVAL_NEO4J_PASSWORD ?? readString(longMemEvalNeo4jRaw.password, neo4jPassword);
  const longMemEvalNeo4jDatabase = env.LONGMEMEVAL_NEO4J_DATABASE ?? readString(longMemEvalNeo4jRaw.database, neo4jDatabase);
  const longMemEvalNeo4jFulltextIndexName = env.LONGMEMEVAL_NEO4J_MEMORY_FULLTEXT_INDEX
    ?? readString(longMemEvalNeo4jRaw.fulltextIndexName, neo4jFulltextIndexName);
  const longMemEvalNeo4jVectorIndexName = env.LONGMEMEVAL_NEO4J_MEMORY_VECTOR_INDEX
    ?? readString(longMemEvalNeo4jRaw.vectorIndexName, neo4jVectorIndexName);
  const longMemEvalNeo4jVectorDimensions = readInteger(
    env.LONGMEMEVAL_NEO4J_MEMORY_VECTOR_DIMENSIONS,
    readInteger(longMemEvalNeo4jRaw.vectorDimensions, neo4jVectorDimensions)
  );
  const locomoEvaluationRaw = raw.locomoEvaluation ?? {};
  const locomoEvaluationGraphRaw = locomoEvaluationRaw.graphStore ?? {};
  const locomoEvaluationNeo4jRaw = locomoEvaluationGraphRaw.neo4j ?? {};
  const locomoEvaluationGraphStoreMode = readLongMemEvalGraphStoreMode(
    env.LOCOMO_EVALUATION_GRAPH_STORE ?? locomoEvaluationGraphRaw.mode
  );
  const locomoEvaluationNeo4jUri = env.LOCOMO_EVALUATION_NEO4J_URI
    ?? readString(locomoEvaluationNeo4jRaw.uri, neo4jUri);
  const locomoEvaluationNeo4jUsername = env.LOCOMO_EVALUATION_NEO4J_USERNAME
    ?? readString(locomoEvaluationNeo4jRaw.username, neo4jUsername);
  const locomoEvaluationNeo4jPassword = env.LOCOMO_EVALUATION_NEO4J_PASSWORD
    ?? readString(locomoEvaluationNeo4jRaw.password, neo4jPassword);
  const locomoEvaluationNeo4jDatabase = env.LOCOMO_EVALUATION_NEO4J_DATABASE
    ?? readString(locomoEvaluationNeo4jRaw.database, neo4jDatabase);
  const locomoEvaluationNeo4jFulltextIndexName = env.LOCOMO_EVALUATION_NEO4J_MEMORY_FULLTEXT_INDEX
    ?? readString(locomoEvaluationNeo4jRaw.fulltextIndexName, defaultLocomoEvaluationFulltextIndexName);
  const locomoEvaluationNeo4jVectorIndexName = env.LOCOMO_EVALUATION_NEO4J_MEMORY_VECTOR_INDEX
    ?? readString(locomoEvaluationNeo4jRaw.vectorIndexName, defaultLocomoEvaluationVectorIndexName);
  const locomoEvaluationNeo4jVectorDimensions = readInteger(
    env.LOCOMO_EVALUATION_NEO4J_MEMORY_VECTOR_DIMENSIONS,
    readInteger(locomoEvaluationNeo4jRaw.vectorDimensions, neo4jVectorDimensions)
  );
  if (neo4jVectorDimensions !== embeddingDimensions) {
    throw new Error(`graphStore.neo4j.vectorDimensions must equal embedding.dimensions (${embeddingDimensions}), got ${neo4jVectorDimensions}`);
  }
  if (longMemEvalNeo4jVectorDimensions !== embeddingDimensions) {
    throw new Error(`longMemEval.graphStore.neo4j.vectorDimensions must equal embedding.dimensions (${embeddingDimensions}), got ${longMemEvalNeo4jVectorDimensions}`);
  }
  if (locomoEvaluationNeo4jVectorDimensions !== embeddingDimensions) {
    throw new Error(`locomoEvaluation.graphStore.neo4j.vectorDimensions must equal embedding.dimensions (${embeddingDimensions}), got ${locomoEvaluationNeo4jVectorDimensions}`);
  }
  if (locomoEvaluationGraphStoreMode === "neo4j" && (!locomoEvaluationNeo4jUri || !locomoEvaluationNeo4jUsername || !locomoEvaluationNeo4jPassword)) {
    throw new Error("LoCoMo evaluation Neo4j graph store requires LOCOMO_EVALUATION_NEO4J_URI, LOCOMO_EVALUATION_NEO4J_USERNAME, and LOCOMO_EVALUATION_NEO4J_PASSWORD or graphStore.neo4j fallbacks");
  }
  if (longMemEvalGraphStoreMode === "neo4j" && (!longMemEvalNeo4jUri || !longMemEvalNeo4jUsername || !longMemEvalNeo4jPassword)) {
    throw new Error("LongMemEval Neo4j graph store requires LONGMEMEVAL_NEO4J_URI, LONGMEMEVAL_NEO4J_USERNAME, and LONGMEMEVAL_NEO4J_PASSWORD or graphStore.neo4j fallbacks");
  }
  const apiKeySource: ContextEngineConfig["llm"]["apiKeySource"] = runtimeApiKey
    ? "runtime"
    : apiKey
      ? "env"
      : "missing";
  const judgeApiKeySource: ContextEngineConfig["judgeLlm"]["apiKeySource"] = readString(runtime.judgeLlm?.apiKey, "")
    ? "runtime"
    : judgeApiKey
      ? "env"
      : "missing";
  const embeddingApiKeySource: ContextEngineConfig["embedding"]["apiKeySource"] = runtimeEmbeddingApiKey
    ? "runtime"
    : configEmbeddingApiKey
      ? "config"
      : embeddingApiKey
        ? "env"
        : "missing";

  return {
    projectRoot,
    ...(configPath ? { configPath } : {}),
    server: {
      host: readString(raw.server?.host, defaultServerHost),
      port
    },
    storage: {
      storePath: resolveConfigPathValue(projectRoot, storePath)
    },
    ingestion: {
      inboxDirectory: resolveConfigPathValue(projectRoot, inboxDirectory)
    },
    dreaming: {
      enabled: dreamingEnabled,
      timezone: "Asia/Shanghai",
      schedule: "23:00",
      workerConcurrency: 1,
      maxAttemptsPerCycle: 3,
      reevaluationDays: [1, 3, 7],
      preemptWithinMs: readNonNegativeInteger(raw.dreaming?.preemptWithinMs, defaultDreamingPreemptWithinMs),
      resumeIdleAfterMs: readNonNegativeInteger(raw.dreaming?.resumeIdleAfterMs, defaultDreamingResumeIdleAfterMs),
      candidateLeaseMs: readPositiveInteger(raw.dreaming?.candidateLeaseMs, defaultDreamingCandidateLeaseMs),
      runLeaseMs: readPositiveInteger(raw.dreaming?.runLeaseMs, defaultDreamingRunLeaseMs)
    },
    embedding: {
      protocol: embeddingProtocol,
      ...(embeddingBaseUrl ? { baseUrl: embeddingBaseUrl } : {}),
      model: embeddingModel,
      apiKeyEnv: embeddingApiKeyEnv,
      ...(embeddingApiKey ? { apiKey: embeddingApiKey } : {}),
      apiKeySource: embeddingApiKeySource,
      dimensions: embeddingDimensions,
      sendDimensions: embeddingSendDimensions,
      timeoutMs: embeddingTimeoutMs,
      maxAttempts: embeddingMaxAttempts,
      retryDelayMs: embeddingRetryDelayMs,
      concurrency: embeddingConcurrency,
      batchSize: embeddingBatchSize
    },
    graphStore: {
      mode: graphStoreMode,
      neo4j: {
        uri: neo4jUri,
        username: neo4jUsername,
        ...(neo4jPassword ? { password: neo4jPassword } : {}),
        database: neo4jDatabase,
        fulltextIndexName: neo4jFulltextIndexName,
        vectorIndexName: neo4jVectorIndexName,
        vectorDimensions: neo4jVectorDimensions
      }
    },
    llm: {
      provider: "openai-compatible",
      baseUrl,
      model,
      apiKeyEnv,
      ...(apiKey ? { apiKey } : {}),
      apiKeySource
    },
    judgeLlm: {
      provider: "openai-compatible",
      baseUrl: judgeBaseUrl || baseUrl,
      model: judgeModel || model,
      apiKeyEnv: judgeApiKeyEnv,
      ...(judgeApiKey ? { apiKey: judgeApiKey } : {}),
      apiKeySource: judgeApiKeySource
    },
    longMemEval: {
      storage: {
        storeDirectory: resolveConfigPathValue(projectRoot, longMemEvalStoreDirectory)
      },
      graphStore: {
        mode: longMemEvalGraphStoreMode,
        neo4j: {
          uri: longMemEvalNeo4jUri,
          username: longMemEvalNeo4jUsername,
          ...(longMemEvalNeo4jPassword ? { password: longMemEvalNeo4jPassword } : {}),
          database: longMemEvalNeo4jDatabase,
          fulltextIndexName: longMemEvalNeo4jFulltextIndexName,
          vectorIndexName: longMemEvalNeo4jVectorIndexName,
          vectorDimensions: longMemEvalNeo4jVectorDimensions
        }
      }
    },
    locomoEvaluation: {
      graphStore: {
        mode: locomoEvaluationGraphStoreMode,
        neo4j: {
          uri: locomoEvaluationNeo4jUri,
          username: locomoEvaluationNeo4jUsername,
          ...(locomoEvaluationNeo4jPassword ? { password: locomoEvaluationNeo4jPassword } : {}),
          database: locomoEvaluationNeo4jDatabase,
          fulltextIndexName: locomoEvaluationNeo4jFulltextIndexName,
          vectorIndexName: locomoEvaluationNeo4jVectorIndexName,
          vectorDimensions: locomoEvaluationNeo4jVectorDimensions
        }
      }
    }
  };
}

export interface ContextEngineRuntimeConfig {
  embedding?: {
    protocol?: EmbeddingProtocol;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    dimensions?: number;
    sendDimensions?: boolean;
    timeoutMs?: number;
    maxAttempts?: number;
    retryDelayMs?: number;
    concurrency?: number;
    batchSize?: number;
  };
  llm?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
  judgeLlm?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
}

export function saveContextEngineRuntimeConfig(
  update: ContextEngineRuntimeConfig,
  explicitConfigPath?: string,
  env: NodeJS.ProcessEnv = process.env
) {
  const configPath = resolveConfigPath(explicitConfigPath ?? env.CONTEXT_ENGINE_CONFIG);
  const runtimeConfigPath = resolveRuntimeConfigPath(configPath, env.CONTEXT_ENGINE_RUNTIME_CONFIG);
  const currentRuntime = readRuntimeConfig(runtimeConfigPath);
  const nextRuntime = mergeRuntimeConfig(currentRuntime, update);

  if (Object.keys(nextRuntime).length === 0) {
    if (existsSync(runtimeConfigPath)) unlinkSync(runtimeConfigPath);
  } else {
    mkdirSync(dirname(runtimeConfigPath), { recursive: true });
    writeFileSync(runtimeConfigPath, JSON.stringify(nextRuntime, null, 2));
  }

  return reloadContextEngineConfig(explicitConfigPath, env);
}

export function createPublicContextEngineConfig(config = getContextEngineConfig()): PublicContextEngineConfig {
  return {
    server: config.server,
    storage: config.storage,
    ingestion: config.ingestion,
    dreaming: config.dreaming,
    embedding: {
      protocol: config.embedding.protocol,
      ...(config.embedding.baseUrl ? { baseUrl: config.embedding.baseUrl } : {}),
      model: config.embedding.model,
      apiKeyEnv: config.embedding.apiKeyEnv,
      apiKeyConfigured: config.embedding.apiKeySource !== "missing",
      dimensions: config.embedding.dimensions,
      sendDimensions: config.embedding.sendDimensions,
      timeoutMs: config.embedding.timeoutMs,
      maxAttempts: config.embedding.maxAttempts,
      retryDelayMs: config.embedding.retryDelayMs,
      concurrency: config.embedding.concurrency,
      batchSize: config.embedding.batchSize
    },
    graphStore: {
      mode: config.graphStore.mode,
      neo4j: {
        uri: config.graphStore.neo4j.uri,
        usernameConfigured: Boolean(config.graphStore.neo4j.username),
        passwordConfigured: Boolean(config.graphStore.neo4j.password),
        database: config.graphStore.neo4j.database,
        fulltextIndexName: config.graphStore.neo4j.fulltextIndexName,
        vectorIndexName: config.graphStore.neo4j.vectorIndexName,
        vectorDimensions: config.graphStore.neo4j.vectorDimensions
      }
    },
    llm: {
      provider: config.llm.provider,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      apiKeyEnv: config.llm.apiKeyEnv,
      apiKeyConfigured: config.llm.apiKeySource !== "missing"
    },
    judgeLlm: {
      provider: config.judgeLlm.provider,
      baseUrl: config.judgeLlm.baseUrl,
      model: config.judgeLlm.model,
      apiKeyEnv: config.judgeLlm.apiKeyEnv,
      apiKeyConfigured: config.judgeLlm.apiKeySource !== "missing"
    },
    longMemEval: {
      storage: config.longMemEval.storage,
      graphStore: {
        mode: config.longMemEval.graphStore.mode,
        neo4j: {
          uri: config.longMemEval.graphStore.neo4j.uri,
          usernameConfigured: Boolean(config.longMemEval.graphStore.neo4j.username),
          passwordConfigured: Boolean(config.longMemEval.graphStore.neo4j.password),
          database: config.longMemEval.graphStore.neo4j.database,
          fulltextIndexName: config.longMemEval.graphStore.neo4j.fulltextIndexName,
          vectorIndexName: config.longMemEval.graphStore.neo4j.vectorIndexName,
          vectorDimensions: config.longMemEval.graphStore.neo4j.vectorDimensions
        }
      }
    }
  };
}

function resolveConfigPath(configPath: string | undefined) {
  if (configPath) return resolve(configPath);

  const repoConfigPath = resolve(repositoryRoot(), defaultConfigFile);
  if (existsSync(repoConfigPath)) return repoConfigPath;

  const cwdConfigPath = resolve(process.cwd(), defaultConfigFile);
  return existsSync(cwdConfigPath) ? cwdConfigPath : undefined;
}

function resolveRuntimeConfigPath(configPath: string | undefined, overridePath?: string) {
  if (overridePath && overridePath.trim()) {
    return resolve(overridePath);
  }

  if (configPath) {
    return resolve(dirname(configPath), `${basename(configPath, ".json")}.runtime.json`);
  }

  return resolve(repositoryRoot(), defaultRuntimeConfigFile);
}

function readRawConfig(configPath: string | undefined): RawContextEngineConfig {
  if (!configPath || !existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, "utf8")) as RawContextEngineConfig;
}

function readRuntimeConfig(runtimeConfigPath: string | undefined): ContextEngineRuntimeConfig {
  if (!runtimeConfigPath || !existsSync(runtimeConfigPath)) return {};
  return JSON.parse(readFileSync(runtimeConfigPath, "utf8")) as ContextEngineRuntimeConfig;
}

function mergeRuntimeConfig(
  current: ContextEngineRuntimeConfig,
  update: ContextEngineRuntimeConfig
): ContextEngineRuntimeConfig {
  const currentLlm = current.llm ?? {};
  const updateLlm = update.llm ?? {};
  const currentJudge = current.judgeLlm ?? {};
  const updateJudge = update.judgeLlm ?? {};
  const embedding = Object.fromEntries(
    Object.entries({
      ...(current.embedding ?? {}),
      ...(update.embedding ?? {})
    }).filter(([, value]) => value !== undefined)
  ) as NonNullable<ContextEngineRuntimeConfig["embedding"]>;
  const llm = {
    ...(readString(currentLlm.baseUrl, "") ? { baseUrl: readString(currentLlm.baseUrl, "") } : {}),
    ...(readString(currentLlm.model, "") ? { model: readString(currentLlm.model, "") } : {}),
    ...(readString(currentLlm.apiKey, "") ? { apiKey: readString(currentLlm.apiKey, "") } : {}),
    ...(readString(updateLlm.baseUrl, "") ? { baseUrl: readString(updateLlm.baseUrl, "") } : updateLlm.baseUrl === "" ? { baseUrl: "" } : {}),
    ...(readString(updateLlm.model, "") ? { model: readString(updateLlm.model, "") } : updateLlm.model === "" ? { model: "" } : {}),
    ...(readString(updateLlm.apiKey, "") ? { apiKey: readString(updateLlm.apiKey, "") } : updateLlm.apiKey === "" ? { apiKey: "" } : {})
  };
  const judgeLlm = {
    ...(readString(currentJudge.baseUrl, "") ? { baseUrl: readString(currentJudge.baseUrl, "") } : {}),
    ...(readString(currentJudge.model, "") ? { model: readString(currentJudge.model, "") } : {}),
    ...(readString(currentJudge.apiKey, "") ? { apiKey: readString(currentJudge.apiKey, "") } : {}),
    ...(readString(updateJudge.baseUrl, "") ? { baseUrl: readString(updateJudge.baseUrl, "") } : updateJudge.baseUrl === "" ? { baseUrl: "" } : {}),
    ...(readString(updateJudge.model, "") ? { model: readString(updateJudge.model, "") } : updateJudge.model === "" ? { model: "" } : {}),
    ...(readString(updateJudge.apiKey, "") ? { apiKey: readString(updateJudge.apiKey, "") } : updateJudge.apiKey === "" ? { apiKey: "" } : {})
  };

  const normalized = {
    ...(Object.keys(embedding).length ? { embedding } : {}),
    ...(Object.keys(llm).length ? { llm } : {}),
    ...(Object.keys(judgeLlm).length ? { judgeLlm } : {})
  } satisfies ContextEngineRuntimeConfig;

  return normalized;
}

function resolveProjectRoot(configPath: string | undefined) {
  if (!configPath) return repositoryRoot();
  const configDirectory = dirname(configPath);
  return configDirectory.endsWith("/config") ? dirname(configDirectory) : configDirectory;
}

function repositoryRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function resolveConfigPathValue(projectRoot: string, value: string) {
  return resolve(projectRoot, value);
}

function readString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readInteger(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function readNonNegativeInteger(value: unknown, fallback: number) {
  const parsed = readInteger(value, fallback);
  return parsed >= 0 ? parsed : fallback;
}

function readPositiveInteger(value: unknown, fallback: number) {
  const parsed = readInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function readBoolean(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function validateDreamingProductConstraints(raw: RawContextEngineConfig["dreaming"]) {
  if (!raw) return;
  const fixedConstraints: Array<[string, unknown, unknown]> = [
    ["timezone", raw.timezone, "Asia/Shanghai"],
    ["schedule", raw.schedule, "23:00"],
    ["workerConcurrency", raw.workerConcurrency, 1],
    ["maxAttemptsPerCycle", raw.maxAttemptsPerCycle, 3]
  ];
  for (const [field, value, expected] of fixedConstraints) {
    if (value !== undefined && value !== expected) {
      throw new Error(`dreaming.${field} is fixed at ${String(expected)}`);
    }
  }
  if (raw.reevaluationDays !== undefined && (
    !Array.isArray(raw.reevaluationDays) ||
    raw.reevaluationDays.length !== 3 ||
    raw.reevaluationDays.some((value, index) => value !== [1, 3, 7][index])
  )) {
    throw new Error("dreaming.reevaluationDays is fixed at [1,3,7]");
  }
}

function readEmbeddingProtocol(value: unknown): EmbeddingProtocol {
  const normalized = readString(value, defaultEmbeddingProtocol).toLowerCase();
  if (normalized === "openai-compatible" || normalized === "adapter" || normalized === "deterministic-test") {
    return normalized;
  }
  throw new Error(`Unsupported embedding protocol: ${normalized}`);
}

function validateEmbeddingConfig(input: {
  protocol: EmbeddingProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimensions: number;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  concurrency: number;
  batchSize: number;
}) {
  if (!input.model) throw new Error("Embedding requires EMBEDDING_MODEL or embedding.model");
  if (!Number.isInteger(input.dimensions) || input.dimensions <= 0) {
    throw new Error("Embedding requires a positive EMBEDDING_DIMENSIONS or embedding.dimensions");
  }
  if (input.protocol !== "deterministic-test" && !input.baseUrl) {
    throw new Error("Remote embedding requires EMBEDDING_BASE_URL or embedding.baseUrl");
  }
  if (input.protocol === "openai-compatible" && !input.apiKey) {
    throw new Error("OpenAI-compatible embedding requires embedding.apiKey or EMBEDDING_API_KEY");
  }
  for (const [name, value] of [
    ["timeoutMs", input.timeoutMs],
    ["maxAttempts", input.maxAttempts],
    ["concurrency", input.concurrency],
    ["batchSize", input.batchSize]
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`embedding.${name} must be a positive integer`);
  }
  if (!Number.isInteger(input.retryDelayMs) || input.retryDelayMs < 0) {
    throw new Error("embedding.retryDelayMs must be a non-negative integer");
  }
}

function readGraphStoreMode(value: unknown): ContextEngineConfig["graphStore"]["mode"] {
  const normalized = readString(value, defaultGraphStoreMode).toLowerCase();
  if (normalized === "local" || normalized === "neo4j") return normalized;
  throw new Error(`Unsupported CONTEXT_ENGINE_GRAPH_STORE: ${normalized}`);
}

function readLongMemEvalGraphStoreMode(value: unknown): ContextEngineConfig["longMemEval"]["graphStore"]["mode"] {
  const normalized = readString(value, "inherit").toLowerCase();
  if (normalized === "inherit" || normalized === "local" || normalized === "neo4j") return normalized;
  throw new Error(`Unsupported LONGMEMEVAL_GRAPH_STORE: ${normalized}`);
}
