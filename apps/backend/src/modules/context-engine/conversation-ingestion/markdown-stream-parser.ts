import type { ConversationDocumentFrontMatter, ConversationDocumentSession } from "./domain.js";
import {
  parseConversationSessionJson,
  validateConversationBatch,
  type ConversationProtocolValidationIssue
} from "./markdown-protocol.js";

export interface ParsedConversationDocument {
  frontMatter: ConversationDocumentFrontMatter;
  sessions: ConversationDocumentSession[];
}

export class ConversationDocumentParseError extends Error {
  constructor(readonly issues: ConversationProtocolValidationIssue[]) {
    super(issues.map((item) => `${item.path}: ${item.message}`).join("; "));
    this.name = "ConversationDocumentParseError";
  }
}

export function parseConversationMarkdownDocument(document: string): ParsedConversationDocument {
  if (!document.endsWith("\n")) {
    throw new ConversationDocumentParseError([{
      code: "INVALID_FRONT_MATTER",
      path: "$.document",
      message: "The V3 document must end with one LF."
    }]);
  }
  const lines = document.split(/\n/u);
  if (lines[0] !== "---") {
    throw new ConversationDocumentParseError([{
      code: "INVALID_FRONT_MATTER",
      path: "$",
      message: "The document must start with exactly one YAML Front Matter block."
    }]);
  }
  const frontMatterEnd = lines.indexOf("---", 1);
  if (frontMatterEnd < 0) {
    throw new ConversationDocumentParseError([{
      code: "INVALID_FRONT_MATTER",
      path: "$",
      message: "The opening Front Matter block is not closed."
    }]);
  }

  const frontMatter = parseFlatYamlFrontMatter(lines.slice(1, frontMatterEnd));
  const sessions: ConversationDocumentSession[] = [];
  const issues: ConversationProtocolValidationIssue[] = [];
  let index = frontMatterEnd + 1;
  while (index < lines.length - 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (!line.startsWith("```")) {
      issues.push({
        code: "INVALID_SESSION_BLOCK",
        path: "$.document",
        message: `Unexpected content outside context-session blocks on line ${index + 1}.`
      });
      break;
    }
    if (line !== "```context-session") {
      issues.push({
        code: "INVALID_SESSION_BLOCK",
        path: `$.sessions[${sessions.length}]`,
        message: `Unsupported fenced block info string on line ${index + 1}: ${line.slice(3) || "<empty>"}.`
      });
      break;
    }
    const blockStart = index;
    const blockLines: string[] = [];
    index += 1;
    while (index < lines.length && lines[index] !== "```") {
      blockLines.push(lines[index] ?? "");
      index += 1;
    }
    if (index >= lines.length) {
      issues.push({
        code: "INVALID_SESSION_BLOCK",
        path: `$.sessions[${sessions.length}]`,
        message: `The context-session block starting on line ${blockStart + 1} is not closed.`
      });
      break;
    }
    const parsed = parseConversationSessionJson(blockLines.join("\n"), sessions.length);
    issues.push(...parsed.issues);
    if (parsed.value) sessions.push(parsed.value);
    index += 1;
  }
  if (sessions.length === 0 && issues.length === 0) {
    issues.push({
      code: "INVALID_SESSION_BLOCK",
      path: "$.sessions",
      message: "At least one context-session block is required."
    });
  }
  if (issues.length) throw new ConversationDocumentParseError(issues);
  const validation = validateConversationBatch(frontMatter, sessions);
  if (!validation.value) throw new ConversationDocumentParseError(validation.issues);
  return validation.value;
}

function parseFlatYamlFrontMatter(lines: string[]) {
  const result: Record<string, unknown> = {};
  const issues: ConversationProtocolValidationIssue[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      issues.push({ code: "INVALID_FRONT_MATTER", path: `$.__line_${index + 2}`, message: "Use key: value syntax." });
      return;
    }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || !rawValue) {
      issues.push({ code: "INVALID_FRONT_MATTER", path: `$.${key}`, message: "Keys and values must be non-empty scalars." });
      return;
    }
    if (key in result) {
      issues.push({ code: "INVALID_FRONT_MATTER", path: `$.${key}`, message: `Duplicate Front Matter field: ${key}.` });
      return;
    }
    try {
      result[key] = parseYamlScalar(rawValue);
    } catch (caught) {
      issues.push({
        code: "INVALID_FRONT_MATTER",
        path: `$.${key}`,
        message: caught instanceof Error ? caught.message : "Invalid YAML scalar."
      });
    }
  });
  if (issues.length) throw new ConversationDocumentParseError(issues);
  return result;
}

function parseYamlScalar(value: string): string | number | boolean | null {
  if (value.startsWith('"')) {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "string") throw new Error("Quoted Front Matter values must be strings.");
    return parsed;
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error("Unclosed single-quoted Front Matter value.");
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  if (/^-?\d+$/u.test(value)) return Number.parseInt(value, 10);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^[\[\]{},&*!|>@`]/u.test(value)) throw new Error("Only flat scalar Front Matter values are supported.");
  return value;
}
