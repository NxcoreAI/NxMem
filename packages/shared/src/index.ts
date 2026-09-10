export type Id = string;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SourceRef {
  sourceRefId: Id;
  sourceType: string;
  sourceId: string;
  sourceUrl?: string;
}

export interface PermissionSnapshot {
  tenantId: Id;
  principalId: Id;
  sourceAclVersion: string;
  visibility: "private" | "team" | "tenant" | "public";
}

export interface MemoryEvent {
  eventId: Id;
  eventType: string;
  eventSummary?: string;
  /** @deprecated Use eventSummary. */
  eventDescription?: string;
  eventTime: string;
  sourceApp?: string;
  sourceId?: string;
  permissionSnapshot: PermissionSnapshot;
  multimodalData?: Array<{
    itemId: Id;
    type: "text" | "document" | "image" | "audio" | "video" | "tool_result";
    format: string;
    content?: JsonValue;
    ref?: string;
    sourceRefs?: SourceRef[];
  }>;
  /** @deprecated Prefer multimodalData[].sourceRefs. */
  sourceRefs?: SourceRef[];
}

export interface ContextPack {
  packId: Id;
  profileContext: string[];
  taskContext: string[];
  recentContext: string[];
  constraints: string[];
  citations: string[];
}

export interface MemoryChangeEvent {
  eventId: Id;
  changeType: "created" | "updated" | "deleted" | "feedback_received";
  storageLayer: "stm" | "ltm" | "fact";
  reason: string;
  createdAt: string;
}
