import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate } from "./paginate.mjs";

const items = ["a", "b", "c", "d", "e"];
test("first page", () => assert.deepEqual(paginate(items, 1, 2), ["a", "b"]));
test("last page", () => assert.deepEqual(paginate(items, 3, 2), ["e"]));
