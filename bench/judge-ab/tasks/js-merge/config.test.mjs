import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeConfig } from "./config.mjs";

test("nested objects are merged", () => {
	const merged = mergeConfig({ server: { port: 80, host: "localhost" }, debug: false }, { server: { port: 8080 } });
	assert.deepEqual(merged, { server: { port: 8080, host: "localhost" }, debug: false });
});
test("the defaults are left alone", () => {
	const defaults = { server: { port: 80 } };
	mergeConfig(defaults, { server: { port: 1 } });
	assert.equal(defaults.server.port, 80);
});
