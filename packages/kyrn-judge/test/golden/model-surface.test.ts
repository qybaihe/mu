import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../../src/config.ts";
import { createKyrnJudgeExtension } from "../../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../../src/providers/mock.ts";

/**
 * What the main model is given with mu loaded, kept in `model-surface.md`: the system prompt and every tool it is
 * offered, with its description and parameters. A change to any of them, mu's own or one a merge from pi brings in,
 * shows up there as a diff in review. Run the test with `-u` to write the file after a change you meant.
 *
 * Not on Windows, where the shell tool is PowerShell and the prompt says so.
 */
const GOLDEN = fileURLToPath(new URL("./model-surface.md", import.meta.url));
const PI_ROOT = fileURLToPath(new URL("../../../coding-agent/", import.meta.url));

describe.skipIf(process.platform === "win32")("what the main model is given", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is as recorded", async () => {
		// What would change the tools offered: running as a subagent, a Tavily key for the web tools.
		for (const name of ["KYRN_SWARM_DEPTH", "MU_SWARM_DEPTH", "TAVILY_API_KEY"]) vi.stubEnv(name, "");
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					config: parseConfig({ features: { memory: false } }),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		const places: [string, string][] = [
			[PI_ROOT, "<pi>/"],
			[realpathSync(harness.tempDir), "<cwd>"],
			[harness.tempDir, "<cwd>"],
		];
		const plain = (text: string) => places.reduce((done, [from, to]) => done.split(from).join(to), text);
		const parts = [
			"# What the main model is given",
			"",
			"Written by `model-surface.test.ts`: the system prompt and the tools offered with every feature of mu on, in a",
			"fresh session, then what a feature that is off by default changes. Do not edit by hand; run the test with `-u`.",
			"",
			"## System prompt",
			"",
			"```text",
			plain(harness.session.systemPrompt),
			"```",
		];
		for (const tool of harness.session.agent.state.tools) {
			parts.push(
				"",
				`## Tool: ${tool.name}`,
				"",
				"```text",
				plain(tool.description),
				"```",
				"",
				"```json",
				plain(JSON.stringify(tool.parameters, null, "\t")),
				"```",
			);
		}
		// Off by default, and model-facing when on: the write sandbox's bash, with its way out.
		const confined = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					config: parseConfig({ features: { memory: false, confine: { enabled: true } } }),
					only: ["confine"],
					confine: { probe: async () => ({ ok: true }), tmp: [] },
				}),
			],
		});
		harnesses.push(confined);
		await confined.session.bindExtensions({});
		const bash = confined.session.agent.state.tools.find((tool) => tool.name === "bash");
		if (!bash) throw new Error("no bash with the write sandbox on");
		parts.push(
			"",
			"## Tool: bash, with the write sandbox on (`features.confine`)",
			"",
			"```text",
			plain(bash.description),
			"```",
			"",
			"```json",
			plain(JSON.stringify(bash.parameters, null, "\t")),
			"```",
		);
		await expect(`${parts.join("\n")}\n`).toMatchFileSnapshot(GOLDEN);
	});
});
