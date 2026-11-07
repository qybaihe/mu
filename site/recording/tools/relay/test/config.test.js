import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../src/config/load.js";

test("fills in defaults", () => {
  const { queues } = normalize({ queues: { mail: {} } });
  assert.equal(queues.mail.concurrency, 1);
  assert.equal(queues.mail.attempts, 3);
});
test("poll defaults to one second", () => assert.equal(normalize({}).pollMs, 1000));
test("keeps a queue's own concurrency", () => {
  assert.equal(normalize({ queues: { a: { concurrency: 8 } } }).queues.a.concurrency, 8);
});
