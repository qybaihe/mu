import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

// mu: mu's launcher names mu's own extension with `-e`, and that extension registers `/mcp`. It replaces pi's
// built-in MCP extension on purpose, so pi leaves the built-in out without a warning on every start. An extension
// found in the agent folder still gets the warning: two MCP clients there are an accident.
const MCP_EXTENSION = `
export default function(pi) {
  pi.registerCommand("mcp", { description: "own mcp", handler: async () => {} });
}`;

describe("a built-in extension replaced by another extension", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `builtin-replaced-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const builtinMcp = {
		name: "mcp",
		replaceable: true,
		builtin: true,
		factory: (pi: ExtensionAPI) =>
			pi.registerCommand("mcp", { description: "built-in mcp", handler: async () => {} }),
	} as const;

	it("is left out without a warning when the extension is named on the command line", async () => {
		const own = join(tempDir, "own-mcp.ts");
		writeFileSync(own, MCP_EXTENSION);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalExtensionPaths: [own],
			extensionFactories: [builtinMcp],
		});
		await loader.reload();

		const result = loader.getExtensions();
		expect(result.extensions.map((extension) => extension.path)).toEqual([own]);
		expect(result.warnings ?? []).toEqual([]);
	});

	it("is left out with a warning when the extension was found in the agent folder", async () => {
		const extensions = join(agentDir, "extensions");
		mkdirSync(extensions, { recursive: true });
		writeFileSync(join(extensions, "other-mcp.ts"), MCP_EXTENSION);
		const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [builtinMcp] });
		await loader.reload();

		const result = loader.getExtensions();
		expect(result.extensions.map((extension) => extension.path)).toEqual([join(extensions, "other-mcp.ts")]);
		expect(result.warnings?.map((warning) => warning.path)).toEqual(["builtin:mcp"]);
	});
});
