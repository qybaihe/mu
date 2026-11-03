import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/config/duration.js";

test("milliseconds", () => assert.equal(parseDuration("250ms"), 250));
test("seconds", () => assert.equal(parseDuration("45s"), 45_000));
test("hours", () => assert.equal(parseDuration("2h"), 7_200_000));
test("days", () => assert.equal(parseDuration("1d"), 86_400_000));
test("hours and minutes", () => assert.equal(parseDuration("1h30m"), 5_400_000));
test("a number is already milliseconds", () => assert.equal(parseDuration(1500), 1500));
test("rejects text that isn't a duration", () => assert.throws(() => parseDuration("soon")));
test("rejects an empty string", () => assert.throws(() => parseDuration("")));
