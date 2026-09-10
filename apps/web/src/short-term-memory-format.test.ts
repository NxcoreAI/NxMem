import test from "node:test";
import assert from "node:assert/strict";

import { formatShortTermMemoryTrail } from "./short-term-memory-format";

test("formatShortTermMemoryTrail handles persisted STM rows without source facts", () => {
  assert.equal(
    formatShortTermMemoryTrail({
      admissionResult: "write_short_term",
      admissionReason: "legacy_sqlite_row"
    }),
    "无来源事实 · 准入 写入短期记忆 · 原因 legacy_sqlite_row"
  );
});

test("formatShortTermMemoryTrail counts available source facts", () => {
  assert.equal(
    formatShortTermMemoryTrail({
      sourceFactIds: ["fact_1", "fact_2"],
      admissionResult: "write_high_priority",
      admissionReason: "important"
    }),
    "2 条事实 · 准入 高优先写入 · 原因 important"
  );
});
