import type { BackgroundSectionKey } from "./domain.js";

export const BACKGROUND_SECTION_KEYS = [
  "identity",
  "relationships",
  "recentTasks",
  "aiSoul"
] as const satisfies readonly BackgroundSectionKey[];

export type BackgroundSections = Record<BackgroundSectionKey, string>;
export type BackgroundMarkdownMode = "fixed" | "dynamic";

const SECTION_DEFINITIONS: ReadonlyArray<{
  key: BackgroundSectionKey;
  heading: string;
}> = [
  { key: "identity", heading: "## 👤 用户身份" },
  { key: "relationships", heading: "## 👥 重要人物关系" },
  { key: "recentTasks", heading: "## 📋 最近任务" },
  { key: "aiSoul", heading: "## 🤖 AI 灵魂" }
];

const EMPTY_SECTION_TEXT: Record<BackgroundMarkdownMode, string> = {
  fixed: "- 暂无已确认信息。",
  dynamic: "- 本时间窗口没有新增信息。"
};

export function createEmptyBackgroundSections(
  mode: BackgroundMarkdownMode = "fixed"
): BackgroundSections {
  const placeholder = EMPTY_SECTION_TEXT[mode];
  return {
    identity: placeholder,
    relationships: placeholder,
    recentTasks: placeholder,
    aiSoul: placeholder
  };
}

export function renderBackgroundMarkdown(
  sections: BackgroundSections,
  mode: BackgroundMarkdownMode = "fixed"
) {
  return SECTION_DEFINITIONS
    .map(({ key, heading }) => {
      const text = normalizeBackgroundSectionMarkdown(sections[key], EMPTY_SECTION_TEXT[mode]);
      return `${heading}\n${text}`;
    })
    .join("\n\n");
}

export function parseBackgroundMarkdown(markdown: string): BackgroundSections {
  if (typeof markdown !== "string" || !markdown.trim()) {
    throw new Error("BACKGROUND_MARKDOWN_REQUIRED");
  }

  const headingByText = new Map(SECTION_DEFINITIONS.map((item) => [item.heading, item]));
  const linesBySection = new Map<BackgroundSectionKey, string[]>();
  let currentKey: BackgroundSectionKey | undefined;
  let nextSectionIndex = 0;

  for (const rawLine of markdown.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    const heading = headingByText.get(line.trim());
    if (heading) {
      const expected = SECTION_DEFINITIONS[nextSectionIndex];
      if (!expected || expected.key !== heading.key) {
        throw new Error(`BACKGROUND_MARKDOWN_SECTION_ORDER_INVALID:${heading.key}`);
      }
      if (linesBySection.has(heading.key)) {
        throw new Error(`BACKGROUND_MARKDOWN_SECTION_DUPLICATE:${heading.key}`);
      }
      currentKey = heading.key;
      linesBySection.set(currentKey, []);
      nextSectionIndex += 1;
      continue;
    }

    if (/^#{1,6}\s/u.test(line.trim())) {
      throw new Error(`BACKGROUND_MARKDOWN_HEADING_INVALID:${line.trim()}`);
    }
    if (!currentKey) {
      if (line.trim()) throw new Error("BACKGROUND_MARKDOWN_CONTENT_BEFORE_FIRST_SECTION");
      continue;
    }
    linesBySection.get(currentKey)!.push(line);
  }

  if (nextSectionIndex !== SECTION_DEFINITIONS.length) {
    const missing = SECTION_DEFINITIONS[nextSectionIndex]?.key ?? "unknown";
    throw new Error(`BACKGROUND_MARKDOWN_SECTION_MISSING:${missing}`);
  }

  return Object.fromEntries(SECTION_DEFINITIONS.map(({ key }) => {
    const text = trimBlankLines(linesBySection.get(key) ?? []).join("\n").trim();
    if (!text) throw new Error(`BACKGROUND_MARKDOWN_SECTION_EMPTY:${key}`);
    return [key, text];
  })) as BackgroundSections;
}

export function normalizeBackgroundSectionMarkdown(text: string, fallback: string) {
  const normalized = typeof text === "string" ? text.replace(/\r\n?/gu, "\n").trim() : "";
  if (!normalized) return fallback;
  const lines = trimBlankLines(normalized.split("\n"));
  if (lines.some((line) => /^#{1,6}\s/u.test(line.trim()))) {
    throw new Error("BACKGROUND_SECTION_HEADING_NOT_ALLOWED");
  }
  return lines
    .filter((line) => Boolean(line.trim()))
    .map((line) => {
      const trimmed = line.trim();
      if (/^[-*+]\s+/u.test(trimmed)) return `- ${trimmed.replace(/^[-*+]\s+/u, "")}`;
      return `- ${trimmed}`;
    })
    .join("\n") || fallback;
}

function trimBlankLines(lines: string[]) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start += 1;
  while (end > start && !lines[end - 1]?.trim()) end -= 1;
  return lines.slice(start, end);
}
