import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPrice } from "./price.mjs";

test("dollars and cents", () => assert.equal(formatPrice(1999), "$19.99"));
test("pads the cents", () => assert.equal(formatPrice(5), "$0.05"));
