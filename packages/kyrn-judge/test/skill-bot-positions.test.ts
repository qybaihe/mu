import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillsFromDir } from "../../coding-agent/src/core/skills.ts";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { POSITIONS_SKILL_PATH } from "../src/extension/features/swarm.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

/** Resolves to `<package>/skills/bot-positions/` from the test's own place, as the features do for their skills. */
const SKILL_DIR = dirname(fileURLToPath(new URL("../skills/bot-positions/SKILL.md", import.meta.url)));

describe("the bot-positions skill", () => {
	it("is a valid pi skill that says when it applies, in the words a user would use", () => {
		const { skills, diagnostics } = loadSkillsFromDir({ dir: SKILL_DIR, source: "test" });
		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name)).toEqual(["bot-positions"]);
		expect(skills[0].description).toMatch(/position/i);
		expect(skills[0].description).toMatch(/建岗|岗位/);
	});

	it("keeps the mechanism hooks a position file is built from", () => {
		const body = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
		for (const must of [
			"~/.mu/agent/agents",
			"自动委派的唯一依据",
			"身份行",
			"收尾时（记忆分工铁律）",
			"LESSON:",
			"产出文件路径 + 一行验证证据",
			"cwd 必传",
			"嵌套一层封顶",
		]) {
			expect(body, must).toContain(must);
		}
	});

	it("carries no one person's paths or conventions", () => {
		const body = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
		for (const banned of [
			/linus/i,
			/C:\/Users/i,
			/[A-Za-z]:\/mu\b/,
			/TOOL-ROUTING/i,
			/litter-sweep/i,
			/~\/\.agents/,
			/总台/,
		]) {
			expect(body.match(banned), String(banned)).toBeNull();
		}
	});
});

describe("the skill outside the desktop's builtin dir", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("rides the swarm feature at discovery, so the CLI and the TUI load it too", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					config: parseConfig({}),
					only: ["swarm"],
				}),
			],
		});
		harnesses.push(harness);
		const found = await harness.session.extensionRunner.emitResourcesDiscover(harness.tempDir, "startup");
		expect(found.skillPaths.map((entry) => entry.path)).toContain(POSITIONS_SKILL_PATH);
	});
});
