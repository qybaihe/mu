#!/usr/bin/env node

// Regenerate packages/ai/model-catalog.json, the model catalog CI builds from, with mu's own generator
// (packages/ai/scripts/generate-models.ts, from live sources), and check that it hydrates this checkout.
// The weekly model-catalog workflow runs this and opens a pull request when the catalog changed.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateModelCatalog } from "../packages/ai/scripts/hydrate-model-catalog.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = join(root, "packages/ai/model-catalog.json");
const output = mkdtempSync(join(tmpdir(), "mu-model-catalog-"));
try {
	execFileSync(
		process.execPath,
		["packages/ai/scripts/generate-models.ts", "--strict", "--json-only", "--pretty", "--json-output", output],
		{ cwd: root, stdio: ["ignore", "ignore", "inherit"] },
	);
	const catalog = join(output, "models.all.json");
	// Refuse a catalog the checkout can't build with, e.g. one that lacks a provider mu has.
	hydrateModelCatalog(join(root, "packages/ai"), catalog, { validateOnly: true });
	copyFileSync(catalog, snapshot);
	console.log("Updated packages/ai/model-catalog.json");
} finally {
	rmSync(output, { recursive: true, force: true });
}
