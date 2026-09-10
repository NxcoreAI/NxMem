import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptyBackgroundSections,
  parseBackgroundMarkdown,
  renderBackgroundMarkdown
} from "./background-markdown.js";

test("background Markdown renders and parses the four sections in a stable order", () => {
  const markdown = renderBackgroundMarkdown({
    identity: "用户是一名后端工程师。\n- 专业领域：Context Engine。",
    relationships: "张三是当前项目协作者。",
    recentTasks: "- 正在实现背景分析模块。",
    aiSoul: "回答应沿用用户的技术方案主线。"
  });

  assert.equal(markdown.indexOf("## 👤 用户身份") < markdown.indexOf("## 👥 重要人物关系"), true);
  assert.equal(markdown.indexOf("## 👥 重要人物关系") < markdown.indexOf("## 📋 最近任务"), true);
  assert.equal(markdown.indexOf("## 📋 最近任务") < markdown.indexOf("## 🤖 AI 灵魂"), true);
  assert.deepEqual(parseBackgroundMarkdown(markdown), {
    identity: "- 用户是一名后端工程师。\n- 专业领域：Context Engine。",
    relationships: "- 张三是当前项目协作者。",
    recentTasks: "- 正在实现背景分析模块。",
    aiSoul: "- 回答应沿用用户的技术方案主线。"
  });
});

test("background Markdown keeps all sections when no facts are available", () => {
  const fixed = renderBackgroundMarkdown(createEmptyBackgroundSections("fixed"), "fixed");
  const dynamic = renderBackgroundMarkdown(createEmptyBackgroundSections("dynamic"), "dynamic");

  assert.equal((fixed.match(/^## /gmu) ?? []).length, 4);
  assert.equal((fixed.match(/暂无已确认信息。/gu) ?? []).length, 4);
  assert.equal((dynamic.match(/本时间窗口没有新增信息。/gu) ?? []).length, 4);
});

test("background Markdown rejects missing, reordered, or injected headings", () => {
  assert.throws(
    () => parseBackgroundMarkdown("## 👥 重要人物关系\n- 张三是协作者。"),
    /BACKGROUND_MARKDOWN_SECTION_ORDER_INVALID/
  );
  assert.throws(
    () => parseBackgroundMarkdown("## 👤 用户身份\n- 后端工程师。"),
    /BACKGROUND_MARKDOWN_SECTION_MISSING/
  );
  assert.throws(
    () => renderBackgroundMarkdown({
      ...createEmptyBackgroundSections("fixed"),
      identity: "## injected\n- 不允许"
    }),
    /BACKGROUND_SECTION_HEADING_NOT_ALLOWED/
  );
});
