import test from "node:test";
import assert from "node:assert/strict";
import { isDebugShellEnabled } from "./DebugShell.js";

test("debug shell is enabled in development mode", () => {
  assert.equal(isDebugShellEnabled({ dev: true }), true);
});
