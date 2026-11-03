import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob, nextAttemptAt } from "../src/queue/worker.js";

test("returns the handler's result", async () => {
  assert.equal(await runJob({ id: 1 }, { timeoutMs: 1000 }, async () => "done"), "done");
});
test("backoff doubles with each attempt", () => {
  assert.equal(nextAttemptAt(0, 3, { backoffMs: 1000 }), 4000);
});
