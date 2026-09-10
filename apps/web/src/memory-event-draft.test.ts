import test from "node:test";
import assert from "node:assert/strict";

import { buildDebugMemoryEvent } from "./memory-event-draft.js";

test("buildDebugMemoryEvent writes new memory event field shape", () => {
  const event = buildDebugMemoryEvent(
    {
      source: "PRD.md",
      eventType: "manual_memory_event",
      description: "事件概要",
      content: '{"text":"记忆正文","project":"ospx-new","task":{"id":"task-1"}}',
      eventTime: "2026-07-06T09:00",
      visibility: "private",
      customFields: ""
    },
    {
      eventTime: "2026-07-06T01:00:00.000Z",
      safeId: "PRD_md_123"
    }
  );

  assert.equal(event.eventSummary, "事件概要");
  assert.equal("eventDescription" in event, false);
  assert.equal("customFields" in event, false);
  assert.equal("sourceRefs" in event, false);
  assert.deepEqual(event.multimodalData[0]?.content, {
    text: "记忆正文",
    project: "ospx-new",
    task: {
      id: "task-1"
    }
  });
  assert.deepEqual(event.multimodalData[0]?.sourceRefs, [{
    sourceRefId: "src_PRD_md_123",
    sourceType: "file",
    sourceId: "PRD.md"
  }]);
});

test("buildDebugMemoryEvent rejects non JSON content", () => {
  assert.throws(
    () => buildDebugMemoryEvent(
      {
        source: "manual",
        eventType: "manual_memory_event",
        description: "事件概要",
        content: "不是 JSON",
        eventTime: "2026-07-06T09:00",
        visibility: "private",
        customFields: ""
      },
      {
        eventTime: "2026-07-06T01:00:00.000Z",
        safeId: "manual_123"
      }
    ),
    /内容必须是 JSON 对象/
  );
});
