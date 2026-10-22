import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { parseSkill, SkillDrafts, skillName } from "../src/memory/skill-drafts.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

const SKILL = `---
name: Release to npm
description: Cut a patch release of this package and publish it to npm.
---

Use it when a patch release is asked for.

## Steps
1. npm version patch --no-git-tag-version
2. Add the release to CHANGELOG.md.
3. npm run build && npm test
4. git tag v<version> && git push --follow-tags
5. npm publish

## Check
npm view <package> version shows <version>.`;

const dirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "mu-procedures-"));
	dirs.push(dir);
	return dir;
};

describe("skill drafts", () => {
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	it("read a writer's reply as a SKILL.md: a folder-safe name, fences dropped, secrets out", () => {
		const skill = parseSkill(`\`\`\`markdown\n${SKILL}\n\`\`\``);
		expect(skill).toMatchObject({ name: "release-to-npm", description: expect.stringContaining("patch release") });
		expect(skill?.markdown.startsWith("---\nname: release-to-npm\n")).toBe(true);
		expect(
			parseSkill(SKILL.replace("npm publish", "NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789 npm publish"))
				?.markdown,
		).toContain("[redacted]");
		expect(parseSkill("Here are the steps: 1. build 2. publish")).toBeUndefined();
		expect(parseSkill("---\nname: x\n---\nno description")).toBeUndefined();
		expect(skillName("  Merge Upstream!! ")).toBe("merge-upstream");
	});

	it("wait under a free name, install where asked, and never replace an installed skill", () => {
		const drafts = new SkillDrafts(join(temp(), "drafts"));
		const skill = parseSkill(SKILL);
		if (!skill) throw new Error("no skill");
		const first = drafts.save(skill, { cwd: "/repo", request: "release" }, []);
		const second = drafts.save(skill, { cwd: "/repo", request: "release again" }, ["release-to-npm-2"]);
		expect([first.name, second.name]).toEqual(["release-to-npm", "release-to-npm-3"]);
		expect(second.markdown).toContain("name: release-to-npm-3");
		expect(drafts.list().map((draft) => draft.name)).toEqual(["release-to-npm", "release-to-npm-3"]);

		const skills = join(temp(), "skills");
		const installed = drafts.accept("release-to-npm", skills);
		expect(installed).toEqual({ path: join(skills, "release-to-npm", "SKILL.md") });
		expect(readFileSync(join(skills, "release-to-npm", "SKILL.md"), "utf8")).toBe(first.markdown);
		expect(drafts.get("release-to-npm")).toBeUndefined();

		// A draft of the same name later meets the installed skill and is refused, not written over it.
		drafts.save(skill, { cwd: "/repo", request: "release" }, []);
		expect(drafts.accept("release-to-npm", skills)).toEqual({ error: "exists" });
		expect(drafts.remove("release-to-npm")).toBe(true);
		expect(drafts.accept("nothing", skills)).toEqual({ error: "missing" });
	});
});

describe("procedures", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => {
		// The messages below are the English ones.
		vi.stubEnv("MU_LANG", undefined);
		vi.stubEnv("KYRN_LANG", undefined);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	const bash: AgentTool = {
		name: "bash",
		label: "bash",
		description: "bash",
		parameters: Type.Object({ command: Type.String() }),
		execute: async (_id, params) => {
			const command = String((params as { command: string }).command);
			if (command.includes("fail")) throw new Error("exit 1");
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
	const run = (command: string) =>
		fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
	const RELEASE = [
		"git status --short",
		"npm version patch --no-git-tag-version",
		"npm run build",
		"npm test",
		"git tag v1.4.1",
		"git push --follow-tags",
		"npm publish",
	];

	/** The agent's replies in order; the call that drafts a skill gets the draft, whenever it comes. */
	const router =
		(agent: ReturnType<typeof fauxAssistantMessage>[], heard: string[]): FauxResponseFactory =>
		(context) => {
			const request = JSON.stringify(context.messages);
			if (request.includes("reusable skill")) {
				heard.push(request);
				return fauxAssistantMessage(SKILL);
			}
			return agent.shift() ?? fauxAssistantMessage("no more agent replies");
		};

	async function start(kind: "procedure" | "one_off") {
		const agentDir = temp();
		const events: KyrnPresentationEvent[] = [];
		const provider = new MockJudgeProvider((request: JudgeRequest): Record<string, Answer> => {
			if (!("kind" in request.questions)) return {};
			return {
				kind: {
					type: "choice",
					choice: kind,
					probabilities: {
						procedure: kind === "procedure" ? 0.9 : 0.1,
						one_off: kind === "procedure" ? 0.1 : 0.9,
					},
				},
			};
		});
		const harness = await createHarness({
			tools: [bash],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					config: parseConfig({}),
					only: ["preflight", "procedures"],
					roots: { home: agentDir, agentDir },
					onPresentation: (event) => events.push(event),
				}),
			],
		});
		harnesses.push(harness);
		const notes: string[] = [];
		const known: Record<string, unknown> = {
			notify: (message: string) => notes.push(message),
			setStatus: () => undefined,
		};
		const ui = new Proxy(known, {
			get: (target, key) => (key in target ? target[key as string] : () => undefined),
		}) as unknown as ExtensionUIContext;
		await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		const drafts = new SkillDrafts(join(agentDir, "mu", "skill-drafts"));
		const asked = () => provider.calls.filter((call) => "kind" in call.questions);
		return { harness, notes, drafts, agentDir, events, asked };
	}

	it("drafts a long run that ended well as a skill, which waits until the user installs it", async () => {
		const session = await start("procedure");
		const heard: string[] = [];
		const agent = [...RELEASE.map(run), fauxAssistantMessage("Released v1.4.1 and published it.")];
		session.harness.setResponses(Array.from({ length: 12 }, () => router(agent, heard)));
		await session.harness.session.prompt("cut a patch release");
		await vi.waitFor(() => expect(session.drafts.list()).toHaveLength(1));

		// One question, over the run's digest; the writer got the same digest.
		expect(session.asked()).toHaveLength(1);
		expect(JSON.stringify(session.asked()[0].state)).toContain("npm publish");
		expect(heard[0]).toContain("npm version patch");
		const [draft] = session.drafts.list();
		expect(draft).toMatchObject({ name: "release-to-npm", request: "cut a patch release" });
		expect(session.notes.some((note) => note.includes('drafted the skill "release-to-npm" from this run'))).toBe(
			true,
		);
		expect(session.events.some((event) => event.kind === "skill.drafted")).toBe(true);
		// Waiting is not installed: nothing is where pi looks for skills.
		expect(existsSync(join(session.agentDir, "skills"))).toBe(false);

		await session.harness.session.prompt("/skills accept release-to-npm");
		expect(readFileSync(join(session.agentDir, "skills", "release-to-npm", "SKILL.md"), "utf8")).toBe(draft.markdown);
		expect(session.drafts.list()).toEqual([]);
		expect(session.notes.at(-1)).toContain("Installed the skill");
	});

	it("asks nothing about a short run, or one whose last step failed", async () => {
		const session = await start("procedure");
		session.harness.setResponses([run("npm test"), run("git status"), fauxAssistantMessage("Tests pass.")]);
		await session.harness.session.prompt("run the tests");
		session.harness.setResponses([
			...RELEASE.slice(0, 6).map(run),
			run("npm publish fail"),
			fauxAssistantMessage("Publishing failed."),
		]);
		await session.harness.session.prompt("cut a patch release");
		expect(session.asked()).toEqual([]);
	});

	it("leaves a one-off run alone, and the writer is never called", async () => {
		const session = await start("one_off");
		const heard: string[] = [];
		const agent = [...RELEASE.map(run), fauxAssistantMessage("Released v1.4.1 and published it.")];
		session.harness.setResponses(Array.from({ length: 12 }, () => router(agent, heard)));
		await session.harness.session.prompt("cut a patch release");
		await vi.waitFor(() => expect(session.asked()).toHaveLength(1));
		expect(heard).toEqual([]);
		expect(session.drafts.list()).toEqual([]);
	});
});
