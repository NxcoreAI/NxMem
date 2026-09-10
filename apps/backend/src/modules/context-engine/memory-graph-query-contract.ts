import { createHash } from "node:crypto";
import type {
  GraphMemoryOwnerType,
  RelationEdge,
  SourceRef
} from "./domain.js";

export const MEMORY_GRAPH_SCHEMA_VERSION = "memory-graph.v1" as const;
export const MEMORY_GRAPH_CURSOR_VERSION = 1 as const;

export const MEMORY_GRAPH_LAYERS = ["stm", "ltm"] as const satisfies readonly GraphMemoryOwnerType[];
export const MEMORY_GRAPH_RELATION_TYPES = [
  "is_same_as",
  "alias_of",
  "derived_from",
  "supports",
  "conflicts_with",
  "same_source",
  "updates",
  "related_to",
  "part_of"
] as const satisfies readonly RelationEdge["relationType"][];

export const MEMORY_GRAPH_PAGE_LIMITS = {
  node: { default: 100, max: 200 },
  edge: { default: 500, max: 1000 }
} as const;

export type MemoryGraphLayer = GraphMemoryOwnerType;
export type MemoryGraphRelationType = RelationEdge["relationType"];

export interface MemoryGraphPageRequest {
  limit?: number;
  cursor?: string | null;
}

export interface MemoryGraphQueryRequest {
  page?: number;
  layers?: MemoryGraphLayer[];
  relationTypes?: MemoryGraphRelationType[];
  nodePage?: MemoryGraphPageRequest | null;
  edgePage?: MemoryGraphPageRequest | null;
}

export interface NormalizedMemoryGraphPageRequest {
  limit: number;
  cursor?: string;
}

export interface NormalizedMemoryGraphQueryRequest {
  page?: number;
  layers: MemoryGraphLayer[];
  relationTypes: MemoryGraphRelationType[];
  nodePage: NormalizedMemoryGraphPageRequest | null;
  edgePage: NormalizedMemoryGraphPageRequest | null;
}

export interface MemoryGraphNodeCursor {
  layer: MemoryGraphLayer;
  id: string;
}

export interface MemoryGraphEdgeCursor {
  id: string;
}

export interface MemoryGraphNodeResponse {
  id: string;
  layer: MemoryGraphLayer;
  memoryType?: string;
  content: string;
  factSummary?: string;
  lifecycleStatus: string;
  retrievalWeight: number;
  sourceRefs: SourceRef[];
  entityIds: string[];
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  evidenceTimeConfidence?: "low" | "medium" | "high";
  validTimeStart?: string;
  validTimeEnd?: string;
  validTimeConfidence?: "low" | "medium" | "high";
  refreshedAt: string;
}

export interface MemoryGraphEdgeResponse {
  id: string;
  from: string;
  to: string;
  type: MemoryGraphRelationType;
  evidence?: string;
  strength?: number;
  confidence?: NonNullable<RelationEdge["confidence"]>;
  source?: NonNullable<RelationEdge["source"]>;
  createdAt?: string;
}

export interface MemoryGraphPageResponse<T> {
  items: T[];
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MemoryGraphQueryResponse {
  ok: true;
  schemaVersion: typeof MEMORY_GRAPH_SCHEMA_VERSION;
  generatedAt: string;
  page?: number;
  nodes: MemoryGraphPageResponse<MemoryGraphNodeResponse> | null;
  edges: MemoryGraphPageResponse<MemoryGraphEdgeResponse> | null;
}

export type MemoryGraphQueryErrorCode =
  | "INVALID_MEMORY_GRAPH_QUERY"
  | "INVALID_MEMORY_GRAPH_CURSOR"
  | "MEMORY_GRAPH_QUERY_FAILED";

export interface MemoryGraphQueryErrorResponse {
  ok: false;
  error: {
    code: MemoryGraphQueryErrorCode;
    message: string;
    requestId: string;
  };
}

export class MemoryGraphQueryContractError extends Error {
  readonly code: Extract<
    MemoryGraphQueryErrorCode,
    "INVALID_MEMORY_GRAPH_QUERY" | "INVALID_MEMORY_GRAPH_CURSOR"
  >;

  constructor(code: MemoryGraphQueryContractError["code"], message: string = code) {
    super(message);
    this.name = "MemoryGraphQueryContractError";
    this.code = code;
  }
}

const queryKeys = new Set(["page", "layers", "relationTypes", "nodePage", "edgePage"]);
const pageKeys = new Set(["limit", "cursor"]);

export function parseMemoryGraphQueryRequest(value: unknown): NormalizedMemoryGraphQueryRequest {
  const input = strictObject(value, queryKeys);
  const layers = parseEnumList(input.layers, MEMORY_GRAPH_LAYERS);
  const relationTypes = parseEnumList(input.relationTypes, MEMORY_GRAPH_RELATION_TYPES);
  const nodePage = parsePage(input.nodePage, "node");
  const edgePage = parsePage(input.edgePage, "edge");
  if (!nodePage && !edgePage) throw invalidQuery();
  const page = parseUnifiedPage(input.page, nodePage, edgePage);

  return {
    ...(page !== undefined ? { page } : {}),
    layers,
    relationTypes,
    nodePage,
    edgePage
  };
}

export function isMemoryGraphLayer(value: unknown): value is MemoryGraphLayer {
  return typeof value === "string" && MEMORY_GRAPH_LAYERS.some((layer) => layer === value);
}

export function isMemoryGraphRelationType(value: unknown): value is MemoryGraphRelationType {
  return typeof value === "string" && MEMORY_GRAPH_RELATION_TYPES.some((type) => type === value);
}

export function encodeMemoryGraphNodeCursor(
  after: MemoryGraphNodeCursor,
  layers: readonly MemoryGraphLayer[]
) {
  const normalizedLayers = normalizeCursorLayers(layers);
  const normalizedAfter = normalizeNodeCursor(after, normalizedLayers);
  return encodeCursorEnvelope({
    version: MEMORY_GRAPH_CURSOR_VERSION,
    type: "node",
    filter: cursorFilterFingerprint("node", normalizedLayers),
    after: normalizedAfter
  });
}

export function decodeMemoryGraphNodeCursor(
  cursor: string,
  layers: readonly MemoryGraphLayer[]
): MemoryGraphNodeCursor {
  const normalizedLayers = normalizeCursorLayers(layers);
  const envelope = decodeCursorEnvelope(cursor);
  if (
    envelope.type !== "node" ||
    envelope.filter !== cursorFilterFingerprint("node", normalizedLayers)
  ) {
    throw invalidCursor();
  }
  return normalizeNodeCursor(envelope.after, normalizedLayers);
}

export function encodeMemoryGraphEdgeCursor(
  after: MemoryGraphEdgeCursor,
  layers: readonly MemoryGraphLayer[],
  relationTypes: readonly MemoryGraphRelationType[]
) {
  const normalizedLayers = normalizeCursorLayers(layers);
  const normalizedRelationTypes = normalizeCursorRelationTypes(relationTypes);
  return encodeCursorEnvelope({
    version: MEMORY_GRAPH_CURSOR_VERSION,
    type: "edge",
    filter: cursorFilterFingerprint("edge", normalizedLayers, normalizedRelationTypes),
    after: normalizeEdgeCursor(after)
  });
}

export function decodeMemoryGraphEdgeCursor(
  cursor: string,
  layers: readonly MemoryGraphLayer[],
  relationTypes: readonly MemoryGraphRelationType[]
): MemoryGraphEdgeCursor {
  const normalizedLayers = normalizeCursorLayers(layers);
  const normalizedRelationTypes = normalizeCursorRelationTypes(relationTypes);
  const envelope = decodeCursorEnvelope(cursor);
  if (
    envelope.type !== "edge" ||
    envelope.filter !== cursorFilterFingerprint("edge", normalizedLayers, normalizedRelationTypes)
  ) {
    throw invalidCursor();
  }
  return normalizeEdgeCursor(envelope.after);
}

function parsePage(
  value: unknown,
  kind: keyof typeof MEMORY_GRAPH_PAGE_LIMITS
): NormalizedMemoryGraphPageRequest | null {
  if (value === undefined || value === null) return null;
  const input = strictObject(value, pageKeys);
  const limits = MEMORY_GRAPH_PAGE_LIMITS[kind];
  const limit = input.limit === undefined ? limits.default : input.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > limits.max) {
    throw invalidQuery();
  }

  const cursor = input.cursor;
  if (cursor !== undefined && cursor !== null) {
    if (
      typeof cursor !== "string" ||
      !cursor ||
      cursor !== cursor.trim() ||
      cursor.length > 4096
    ) {
      throw invalidCursor();
    }
  }

  return {
    limit: limit as number,
    ...(typeof cursor === "string" ? { cursor } : {})
  };
}

function parseUnifiedPage(
  value: unknown,
  nodePage: NormalizedMemoryGraphPageRequest | null,
  edgePage: NormalizedMemoryGraphPageRequest | null
) {
  const usesCursor = Boolean(nodePage?.cursor || edgePage?.cursor);
  if (value === undefined) return usesCursor ? undefined : 1;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || usesCursor) {
    throw invalidQuery();
  }
  for (const page of [nodePage, edgePage]) {
    if (page && !Number.isSafeInteger(((value as number) - 1) * page.limit)) {
      throw invalidQuery();
    }
  }
  return value as number;
}

function parseEnumList<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (value === undefined) return [...allowed];
  if (!Array.isArray(value) || !value.length) throw invalidQuery();

  const selected = new Set<T>();
  for (const item of value) {
    if (typeof item !== "string" || !allowed.some((candidate) => candidate === item)) {
      throw invalidQuery();
    }
    if (selected.has(item as T)) throw invalidQuery();
    selected.add(item as T);
  }
  return allowed.filter((item) => selected.has(item));
}

type MemoryGraphCursorEnvelope = {
  version: typeof MEMORY_GRAPH_CURSOR_VERSION;
  type: "node" | "edge";
  filter: string;
  after: unknown;
};

const cursorEnvelopeKeys = new Set(["version", "type", "filter", "after"]);
const nodeCursorKeys = new Set(["layer", "id"]);
const edgeCursorKeys = new Set(["id"]);

function encodeCursorEnvelope(envelope: MemoryGraphCursorEnvelope) {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function decodeCursorEnvelope(cursor: string): MemoryGraphCursorEnvelope {
  if (
    typeof cursor !== "string" ||
    !cursor ||
    cursor.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw invalidCursor();
  }

  try {
    const buffer = Buffer.from(cursor, "base64url");
    if (!buffer.length || buffer.toString("base64url") !== cursor) throw invalidCursor();
    const input = strictCursorObject(JSON.parse(buffer.toString("utf8")), cursorEnvelopeKeys);
    if (
      input.version !== MEMORY_GRAPH_CURSOR_VERSION ||
      (input.type !== "node" && input.type !== "edge") ||
      typeof input.filter !== "string" ||
      !/^[a-f0-9]{64}$/u.test(input.filter)
    ) {
      throw invalidCursor();
    }
    return {
      version: input.version,
      type: input.type,
      filter: input.filter,
      after: input.after
    };
  } catch (error) {
    if (error instanceof MemoryGraphQueryContractError) throw error;
    throw invalidCursor();
  }
}

function normalizeNodeCursor(
  value: unknown,
  layers: readonly MemoryGraphLayer[]
): MemoryGraphNodeCursor {
  const input = strictCursorObject(value, nodeCursorKeys);
  if (!isMemoryGraphLayer(input.layer) || !layers.includes(input.layer)) throw invalidCursor();
  return {
    layer: input.layer,
    id: cursorIdentifier(input.id)
  };
}

function normalizeEdgeCursor(value: unknown): MemoryGraphEdgeCursor {
  const input = strictCursorObject(value, edgeCursorKeys);
  return { id: cursorIdentifier(input.id) };
}

function normalizeCursorLayers(values: readonly MemoryGraphLayer[]) {
  if (!Array.isArray(values) || !values.length) throw invalidCursor();
  const selected = new Set(values);
  if (selected.size !== values.length || [...selected].some((value) => !isMemoryGraphLayer(value))) {
    throw invalidCursor();
  }
  return MEMORY_GRAPH_LAYERS.filter((layer) => selected.has(layer));
}

function normalizeCursorRelationTypes(values: readonly MemoryGraphRelationType[]) {
  if (!Array.isArray(values) || !values.length) throw invalidCursor();
  const selected = new Set(values);
  if (
    selected.size !== values.length ||
    [...selected].some((value) => !isMemoryGraphRelationType(value))
  ) {
    throw invalidCursor();
  }
  return MEMORY_GRAPH_RELATION_TYPES.filter((type) => selected.has(type));
}

function cursorFilterFingerprint(
  type: "node" | "edge",
  layers: readonly MemoryGraphLayer[],
  relationTypes: readonly MemoryGraphRelationType[] = []
) {
  const filter = type === "node"
    ? { layers }
    : { layers, relationTypes };
  return createHash("sha256").update(JSON.stringify(filter), "utf8").digest("hex");
}

function cursorIdentifier(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 1024
  ) {
    throw invalidCursor();
  }
  return value;
}

function strictCursorObject(value: unknown, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidCursor();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== allowedKeys.size ||
    Object.keys(input).some((key) => !allowedKeys.has(key))
  ) {
    throw invalidCursor();
  }
  return input;
}

function strictObject(value: unknown, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidQuery();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw invalidQuery();
  return input;
}

function invalidQuery() {
  return new MemoryGraphQueryContractError(
    "INVALID_MEMORY_GRAPH_QUERY",
    "Invalid memory graph query."
  );
}

function invalidCursor() {
  return new MemoryGraphQueryContractError(
    "INVALID_MEMORY_GRAPH_CURSOR",
    "Invalid memory graph cursor."
  );
}
