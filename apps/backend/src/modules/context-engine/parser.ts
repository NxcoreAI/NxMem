import type {
  MemoryEvent,
  MultimodalDataItem,
  ParsedSegment,
  SourceRef
} from "./domain.js";
import {
  customFieldsFromMultimodalContent,
  mergeDataLakeFields,
  multimodalContentToText,
  primarySourceRefForItem,
  sourceRefsFromEvent
} from "./memory-event-fields.js";
import { estimateContextTokens } from "./token-estimator.js";

const DEFAULT_PARSED_SEGMENT_TOKEN_BUDGET = 2000;
const DEFAULT_PARSED_SEGMENT_OVERLAP_TOKENS = 80;

export interface ParsedEvidence {
  sourceRefs: SourceRef[];
  segments: ParsedSegment[];
  unsupportedItems: MultimodalDataItem[];
}

export interface ParserAdapter {
  parse(event: MemoryEvent): Promise<ParsedEvidence>;
}

export function createParserAdapter(): ParserAdapter {
  return {
    async parse(event) {
      const segments: ParsedSegment[] = [];
      const unsupportedItems: MultimodalDataItem[] = [];

      for (const item of event.multimodalData) {
        if (item.type === "text" || item.type === "tool_result" || isExtractedDocument(item)) {
          const content = normalizeTextContent(item);
          const customFields = mergeCustomFields(event.customFields, item.customFields, customFieldsFromMultimodalContent(item.content));
          const chunks = splitParsedContent(content);

          chunks.forEach((chunk, index) => {
            const segmentId = chunks.length === 1
              ? `seg_${event.eventId}_${item.itemId}`
              : `seg_${event.eventId}_${item.itemId}_chunk_${index + 1}`;

            segments.push({
              segmentId,
              eventId: event.eventId,
              modality: item.type,
              content: chunk,
              status: "parsed",
              confidence: "medium",
              dataSource: buildDataSourceDescriptor(event, item),
              ...(customFields ? { customFields } : {})
            });
          });

          continue;
        }

        unsupportedItems.push(item);
        const customFields = mergeCustomFields(event.customFields, item.customFields, customFieldsFromMultimodalContent(item.content));
        segments.push({
          segmentId: `seg_${event.eventId}_${item.itemId}`,
          eventId: event.eventId,
          modality: item.type,
          content: item.ref ?? item.format,
          status: "unsupported",
          confidence: "low",
          dataSource: buildDataSourceDescriptor(event, item),
          ...(customFields ? { customFields } : {})
        });
      }

      return {
        sourceRefs: sourceRefsFromEvent(event),
        segments,
        unsupportedItems
      };
    }
  };
}

function isExtractedDocument(item: MultimodalDataItem): boolean {
  return item.type === "document" && Boolean(multimodalContentToText(item.content));
}

function normalizeTextContent(item: MultimodalDataItem): string {
  const content = multimodalContentToText(item.content);
  if (content) return content;
  return item.format;
}

function splitParsedContent(
  content: string,
  tokenBudget = DEFAULT_PARSED_SEGMENT_TOKEN_BUDGET,
  overlapTokens = DEFAULT_PARSED_SEGMENT_OVERLAP_TOKENS
) {
  const normalized = content.trim();
  if (!normalized || estimateContextTokens(normalized) <= tokenBudget) return [content];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const piece of splitTextPieces(normalized)) {
    const pieceTokens = estimateContextTokens(piece);
    if (pieceTokens > tokenBudget) {
      flushCurrent();
      chunks.push(...splitOversizedPiece(piece, tokenBudget, overlapTokens));
      continue;
    }

    if (current.length && currentTokens + pieceTokens > tokenBudget) {
      flushCurrent();
      current = overlapTail(chunks[chunks.length - 1] ?? "", overlapTokens);
      currentTokens = estimateContextTokens(current.join("\n"));
      if (currentTokens + pieceTokens > tokenBudget) {
        current = [];
        currentTokens = 0;
      }
    }

    current.push(piece);
    currentTokens += pieceTokens;
  }

  flushCurrent();
  return chunks.length ? chunks : [content];

  function flushCurrent() {
    const chunk = current.join("\n").trim();
    if (chunk) chunks.push(chunk);
    current = [];
    currentTokens = 0;
  }
}

function splitTextPieces(content: string) {
  const pieces: string[] = [];
  const dialogueBlocks = content
    .split(/(?=^\s*(?:user|assistant|system|tool):\s*)/gim)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of dialogueBlocks.length ? dialogueBlocks : [content]) {
    const paragraphs = block.split(/\n{2,}/g).map((paragraph) => paragraph.trim()).filter(Boolean);
    for (const paragraph of paragraphs.length ? paragraphs : [block]) {
      if (estimateContextTokens(paragraph) <= DEFAULT_PARSED_SEGMENT_TOKEN_BUDGET) {
        pieces.push(paragraph);
        continue;
      }

      pieces.push(...splitSentences(paragraph));
    }
  }

  return pieces.length ? pieces : [content];
}

function splitSentences(paragraph: string) {
  return paragraph
    .split(/(?<=[.!?。！？])\s+/gu)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitOversizedPiece(piece: string, tokenBudget: number, overlapTokens: number) {
  const chunks: string[] = [];
  const chars = Array.from(piece);
  let start = 0;

  while (start < chars.length) {
    let end = Math.min(chars.length, start + Math.max(1, tokenBudget * 4));
    while (end > start + 1 && estimateContextTokens(chars.slice(start, end).join("")) > tokenBudget) {
      end = start + Math.max(1, Math.floor((end - start) * 0.8));
    }

    const chunk = chars.slice(start, end).join("").trim();
    if (chunk) chunks.push(chunk);
    if (end >= chars.length) break;

    const overlapChars = estimateOverlapChars(chars.slice(start, end), overlapTokens);
    start = Math.max(end - overlapChars, start + 1);
  }

  return chunks;
}

function overlapTail(chunk: string, overlapTokens: number) {
  if (!chunk || overlapTokens <= 0) return [];
  const pieces = splitSentences(chunk);
  const tail: string[] = [];
  let tokens = 0;

  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index]!;
    tail.unshift(piece);
    tokens += estimateContextTokens(piece);
    if (tokens >= overlapTokens) break;
  }

  return tail;
}

function estimateOverlapChars(chars: string[], overlapTokens: number) {
  if (overlapTokens <= 0) return 0;
  let start = chars.length;
  while (start > 0 && estimateContextTokens(chars.slice(start).join("")) < overlapTokens) {
    start -= 1;
  }
  return chars.length - start;
}

function buildDataSourceDescriptor(event: MemoryEvent, item?: MultimodalDataItem) {
  const primarySource = primarySourceRefForItem(event, item);
  const sourceType = event.dataSource?.sourceType ?? primarySource?.sourceType;
  const sourceUri = event.dataSource?.sourceUri ?? primarySource?.sourceUrl;
  return {
    sourceApp: event.dataSource?.sourceApp ?? event.sourceApp ?? primarySource?.sourceType ?? "unknown",
    sourceId: event.dataSource?.sourceId ?? event.sourceId ?? primarySource?.sourceId ?? event.eventId,
    ...(event.dataSource?.sourceName ? { sourceName: event.dataSource.sourceName } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(sourceUri ? { sourceUri } : {}),
    ...(event.dataSource?.connectorId ? { connectorId: event.dataSource.connectorId } : {}),
    ...(event.dataSource?.syncCursor ? { syncCursor: event.dataSource.syncCursor } : {}),
    ...(event.dataSource?.syncVersion ? { syncVersion: event.dataSource.syncVersion } : {})
  };
}

function mergeCustomFields(
  eventFields: MemoryEvent["customFields"],
  itemFields: MultimodalDataItem["customFields"],
  contentFields: ReturnType<typeof customFieldsFromMultimodalContent>
) {
  return mergeDataLakeFields(eventFields, itemFields, contentFields);
}
