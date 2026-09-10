import test from "node:test";
import assert from "node:assert/strict";

import { formatContextEventTitle } from "./memory-event-format.js";

test("formatContextEventTitle prefers eventSummary over content and legacy description", () => {
  assert.equal(
    formatContextEventTitle({
      eventType: "manual_memory_event",
      eventSummary: "事件概要：同步新字段",
      eventDescription: "旧描述不应展示",
      multimodalData: [
        {
          content: {
            text: "JSON 内容不应覆盖概要",
            project: "ospx-new"
          }
        }
      ]
    }),
    "事件概要：同步新字段"
  );
});

test("formatContextEventTitle falls back to JSON text content before legacy description", () => {
  assert.equal(
    formatContextEventTitle({
      eventType: "manual_memory_event",
      eventDescription: "旧描述",
      multimodalData: [
        {
          content: {
            text: "JSON 内容文本"
          }
        }
      ]
    }),
    "JSON 内容文本"
  );
});
