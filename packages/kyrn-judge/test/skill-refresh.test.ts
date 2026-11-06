import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionUIContext, type Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../coding-agent/test/utilities.ts";
import { parseConfig } from "../src/config.ts";
import { refreshMessage, SkillRefresh, skillFolders } from "../src/extension/features/skill-refresh.ts";
import { SKILLS_CHANGED_MESSAGE } from "../src/extension/features/skills.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { parseSkill, SkillDrafts } from "../src/memory/skill-drafts.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";
import { attended } from "./attended.ts";

const DRAFT = `---
name: release-to-npm
description: Cut a patch release of this package and publish it to npm.
---

## Steps
1. npm version patch
2. npm publish

## Check
npm view shows the version.`;

const dirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "mu-skill-refresh-"));
	dirs.push(dir);
	return dir;
};

/** A skill on disk, as pi would load it. */
function writeSkill(root: string, name: string, description = `Works with ${name} files`): Skill {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, "SKILL.md");
	writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`);
	return {
		name,
		description,
		filePath,
		baseDir: dir,
		sourceInfo: { path: filePath, source: "local", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
	};
}

describe("skills installed or removed during a session", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => {
		vi.stubEnv("MU_LANG", undefined);
		vi.stubEnv("KYRN_LANG", undefined);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	const read: AgentTool = {
		name: "read",
		label: "read",
		description: "read",
		parameters: Type.Object({ path: Type.String() }),
		execute: async (_id, params) => ({
			content: [{ type: "text", text: readFileSync(String((params as { path: string }).path), "utf8") }],
			details: {},
		}),
	};

	/** A session whose prompt lists `loaded`, as pi loaded it at the start; the judge answers with `answers`. */
	async function start(
		loaded: readonly Skill[],
		agentDir: string,
		answers: (questions: readonly string[]) => Record<string, Answer> = () => ({}),
		features: Record<string, unknown> = {},
	) {
		const provider = new MockJudgeProvider((request) => answers(Object.keys(request.questions)));
		const resourceLoader = createTestResourceLoader({
			extensionsResult: await createTestExtensionsResult([
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					only: ["preflight", "skills", "procedures"],
					config: parseConfig({ features: attended(features) }),
					roots: { home: temp(), agentDir },
				}),
			]),
		});
		resourceLoader.getSkills = () => ({ skills: [...loaded], diagnostics: [] });
		const harness = await createHarness({ resourceLoader, tools: [read] });
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
		/** What each request to the model carried: its system prompt and its messages. */
		const requests: { system: string; messages: string }[] = [];
		const reply = (message: ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
			// The prompt rides in the leading system message, with its sections.
			const system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
			const rest = context.messages.filter((message) => message.role !== "system");
			requests.push({ system: (context.systemPrompt ?? "") + system, messages: JSON.stringify(rest) });
			return message;
		};
		const changed = () =>
			harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom_message" && entry.customType === SKILLS_CHANGED_MESSAGE
						? [String(entry.content)]
						: [],
				);
		return { harness, notes, requests, reply, changed };
	}

	it("tells the agent of a skill accepted mid-session with the next message, and leaves the prompt as it was", async () => {
		const agentDir = temp();
		const calendar = writeSkill(join(agentDir, "skills"), "calendar");
		const drafts = new SkillDrafts(join(agentDir, "mu", "skill-drafts"));
		const skill = parseSkill(DRAFT);
		if (!skill) throw new Error("no draft");
		drafts.save(skill, { cwd: "/repo", request: "release" }, []);
		const session = await start([calendar], agentDir);

		session.harness.setResponses([session.reply(fauxAssistantMessage("Hello."))]);
		await session.harness.session.prompt("hello");
		await session.harness.session.prompt("/skills accept release-to-npm");
		expect(session.notes.at(-1)).toContain("The agent hears of it with your next message");
		const installed = join(agentDir, "skills", "release-to-npm", "SKILL.md");

		session.harness.setResponses([session.reply(fauxAssistantMessage("Released."))]);
		await session.harness.session.prompt("cut a patch release");
		const [first, second] = session.requests;
		expect(second.messages).toContain(
			`Skills installed during this session, which the system prompt does not list:\\n- release-to-npm: Cut a patch release of this package and publish it to npm. (read ${installed} to use it)`,
		);
		// The prompt, and so its cached prefix, is the one the session started with.
		expect(first.system).toContain(calendar.filePath);
		expect(second.system).toBe(first.system);
		expect(second.system).not.toContain("release-to-npm");

		// Told once: the next message brings no news.
		session.harness.setResponses([session.reply(fauxAssistantMessage("Done."))]);
		await session.harness.session.prompt("thanks");
		expect(session.changed()).toHaveLength(1);
	});

	it("tells the agent once that a skill's file is gone", async () => {
		const agentDir = temp();
		const calendar = writeSkill(join(agentDir, "skills"), "calendar");
		const sheet = writeSkill(join(agentDir, "skills"), "spreadsheet");
		const session = await start([calendar, sheet], agentDir);
		session.harness.setResponses([session.reply(fauxAssistantMessage("Hello."))]);
		await session.harness.session.prompt("hello");

		rmSync(join(agentDir, "skills", "calendar"), { recursive: true });
		session.harness.setResponses([session.reply(fauxAssistantMessage("Ok."))]);
		await session.harness.session.prompt("what is on today");
		expect(session.changed()).toEqual([
			`Skills removed during this session: their files are gone, so do not use them: calendar (${calendar.filePath}).`,
		]);

		session.harness.setResponses([session.reply(fauxAssistantMessage("Ok."))]);
		await session.harness.session.prompt("and tomorrow");
		expect(session.changed()).toHaveLength(1);
	});

	it("says nothing with refresh off", async () => {
		const agentDir = temp();
		const calendar = writeSkill(join(agentDir, "skills"), "calendar");
		const session = await start([calendar], agentDir, () => ({}), { skills: { refresh: false } });
		session.harness.setResponses([session.reply(fauxAssistantMessage("Hello."))]);
		await session.harness.session.prompt("hello");
		writeSkill(join(agentDir, "skills"), "notes");
		session.harness.setResponses([session.reply(fauxAssistantMessage("Ok."))]);
		await session.harness.session.prompt("again");
		expect(session.changed()).toEqual([]);
	});
});

describe("SkillRefresh", () => {
	const skill = (name: string, filePath = join(tmpdir(), "mu-no-such-dir", name, "SKILL.md")) => ({
		name,
		description: `${name} things`,
		filePath,
	});

	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	it("leaves out what was on disk but not loaded, and starts over on a new list", () => {
		const root = temp();
		const loaded = writeSkill(root, "calendar");
		const listed = { name: loaded.name, description: loaded.description, filePath: loaded.filePath };
		// Switched off in the settings: on disk from the start, never loaded.
		const off = writeSkill(root, "off");
		const offListed = { name: off.name, description: off.description, filePath: off.filePath };
		const refresh = new SkillRefresh();
		expect(refresh.update([listed], [listed, offListed])).toEqual({ added: [], removed: [] });
		expect(refresh.update([listed], [listed, offListed])).toEqual({ added: [], removed: [] });

		const fresh = writeSkill(root, "fresh");
		const freshListed = { name: fresh.name, description: fresh.description, filePath: fresh.filePath };
		expect(refresh.update([listed], [listed, offListed, freshListed])).toEqual({ added: [freshListed], removed: [] });

		// After /reload the list has it: nothing to tell, and its later removal is told once.
		expect(refresh.update([listed, freshListed], [listed, offListed, freshListed])).toEqual({
			added: [],
			removed: [],
		});
		rmSync(join(root, "fresh"), { recursive: true });
		expect(refresh.update([listed, freshListed], [listed, offListed])).toEqual({ added: [], removed: [freshListed] });
		expect(refresh.update([listed, freshListed], [listed, offListed])).toEqual({ added: [], removed: [] });
	});

	it("names the skills past ten, which find_skill lists", () => {
		const added = Array.from({ length: 12 }, (_, index) => skill(`skill-${index}`));
		const text = refreshMessage({ added, removed: [] }) ?? "";
		expect(text.split("\n")).toHaveLength(12);
		expect(text).toContain("- and 2 more (skill-10, skill-11): find_skill lists them");
		expect(refreshMessage({ added: [], removed: [] })).toBeUndefined();
	});

	it("reads a project's own folders only once it is trusted", () => {
		const cwd = temp();
		mkdirSync(join(cwd, ".git"));
		expect(skillFolders("/agent", "/home", cwd, false)).toEqual(["/agent/skills", "/home/.agents/skills"]);
		expect(skillFolders("/agent", "/home", cwd, true)).toEqual([
			"/agent/skills",
			"/home/.agents/skills",
			join(cwd, CONFIG_DIR_NAME, "skills"),
			join(cwd, ".agents", "skills"),
		]);
	});
});
