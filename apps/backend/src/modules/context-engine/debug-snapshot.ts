import type { ContextDebugSnapshot } from "./persistence/repository.js";

export function sanitizeDebugSnapshot(snapshot: ContextDebugSnapshot): ContextDebugSnapshot {
  const cloned = structuredClone(snapshot);

  for (const event of cloned.memoryEvents) {
    if (typeof event.eventSummary === "string") event.eventSummary = redactSensitiveText(event.eventSummary);
    if (typeof event.eventDescription === "string") event.eventDescription = redactSensitiveText(event.eventDescription);
    event.multimodalData = Array.isArray(event.multimodalData) ? event.multimodalData : [];
    for (const item of event.multimodalData) {
      if (item.content !== undefined) item.content = redactJsonValue(item.content);
      if (typeof item.ref === "string") item.ref = redactSensitiveText(item.ref);
      for (const ref of item.sourceRefs ?? []) redactSourceRef(ref);
    }
    event.sourceRefs = Array.isArray(event.sourceRefs) ? event.sourceRefs : [];
    for (const ref of event.sourceRefs) redactSourceRef(ref);
  }

  for (const segment of cloned.parsedSegments) {
    if (typeof segment.content === "string") segment.content = redactSensitiveText(segment.content);
  }

  for (const fact of cloned.facts) {
    if (typeof fact.factText === "string") fact.factText = redactSensitiveText(fact.factText);
    if (typeof fact.sourceClaim === "string") fact.sourceClaim = redactSensitiveText(fact.sourceClaim);
    if (typeof fact.normalizedClaim === "string") fact.normalizedClaim = redactSensitiveText(fact.normalizedClaim);
  }

  for (const version of cloned.factVersions ?? []) {
    version.factText = redactSensitiveText(version.factText);
    version.normalizedClaim = redactSensitiveText(version.normalizedClaim);
    for (const ref of version.linkedSourceRefs) redactSourceRef(ref);
  }

  for (const memory of cloned.shortTermMemories) {
    if (typeof memory.content === "string") memory.content = redactSensitiveText(memory.content);
    if (typeof memory.factSummary === "string") memory.factSummary = redactSensitiveText(memory.factSummary);
    if (typeof memory.summary === "string") memory.summary = redactSensitiveText(memory.summary);
    if (typeof memory.admissionReason === "string") memory.admissionReason = redactSensitiveText(memory.admissionReason);
  }

  for (const memory of cloned.longTermMemories) {
    if (typeof memory.content === "string") memory.content = redactSensitiveText(memory.content);
    if (typeof memory.factSummary === "string") memory.factSummary = redactSensitiveText(memory.factSummary);
    if (typeof memory.summary === "string") memory.summary = redactSensitiveText(memory.summary);
    if (typeof memory.solidifyReason === "string") memory.solidifyReason = redactSensitiveText(memory.solidifyReason);
  }

  for (const trace of cloned.llmFactFusionTraces) {
    if (typeof trace.prompt === "string") trace.prompt = redactSensitiveText(trace.prompt);
    if (typeof trace.rawResponse === "string") {
      trace.rawResponse = redactSensitiveText(trace.rawResponse);
    }
  }

  for (const trace of cloned.llmStmAdmissionTraces) {
    if (typeof trace.prompt === "string") trace.prompt = redactSensitiveText(trace.prompt);
    if (typeof trace.rawResponse === "string") {
      trace.rawResponse = redactSensitiveText(trace.rawResponse);
    }
  }

  for (const trace of cloned.llmDreamingTraces) {
    if (typeof trace.prompt === "string") trace.prompt = redactSensitiveText(trace.prompt);
    if (typeof trace.rawResponse === "string") {
      trace.rawResponse = redactSensitiveText(trace.rawResponse);
    }
  }

  for (const background of cloned.backgroundDocuments) {
    if (typeof background.fixedText === "string") background.fixedText = redactSensitiveText(background.fixedText);
    if (typeof background.dynamicText === "string") background.dynamicText = redactSensitiveText(background.dynamicText);
    if (background.updateSuggestion) {
      if (typeof background.updateSuggestion.summary === "string") {
        background.updateSuggestion.summary = redactSensitiveText(background.updateSuggestion.summary);
      }
    }
  }

  for (const document of cloned.conversationDocuments) {
    document.rawMarkdown = redactSensitiveText(document.rawMarkdown);
  }

  for (const message of cloned.conversationMessages) {
    message.content = redactSensitiveText(message.content);
  }

  for (const candidate of cloned.conversationFactCandidates) {
    candidate.factText = redactSensitiveText(candidate.factText);
    candidate.normalizedClaim = redactSensitiveText(candidate.normalizedClaim);
    candidate.evidenceQuotes = candidate.evidenceQuotes.map(redactSensitiveText);
    candidate.rawCandidate = redactJsonValue(candidate.rawCandidate);
  }

  return cloned;
}

function redactJsonValue<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map(redactJsonValue) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJsonValue(item)])
    ) as T;
  }
  return value;
}

function redactSourceRef(ref: { sourceId?: string; sourceUrl?: string }) {
  if (typeof ref.sourceId === "string") ref.sourceId = redactSensitiveText(ref.sourceId);
  if (typeof ref.sourceUrl === "string") ref.sourceUrl = redactSensitiveText(ref.sourceUrl);
}

function redactSensitiveText(value: string) {
  return value;
}
