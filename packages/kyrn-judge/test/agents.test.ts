import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgents, parseAgent } from "../src/extension/agents.ts";
import { childArgs, exitedEarly, forwardedExtensionArgs, thinkingForRoute } from "../src/extension/features/swarm.ts";
import { codeOf } from "../src/language.ts";

describe("agent definitions", () => {
	it("ships roles that parse, each with a description the judge can route on", () => {
		const agents = loadAgents(undefined);

		expect(agents.map((agent) => agent.name)).toEqual([
			"browser",
			"investigator",
			"planner",
			"reviewer",
			"scout",
			"worker",
		]);
		for (const agent of agents) {
			expect(agent.source).toBe("built-in");
			expect(agent.description.length).toBeGreaterThan(30);
			expect(agent.systemPrompt.length).toBeGreaterThan(100);
			// Built-ins pin nothing: the judge picks the model and the thinking level per task.
			expect(agent.model).toBeUndefined();
			expect(agent.thinking).toBeUndefined();
		}
		expect(agents.find((agent) => agent.name === "browser")?.tools).toEqual(["browse"]);
		expect(agents.find((agent) => agent.name === "worker")?.tools).toBeUndefined();
		expect(agents.find((agent) => agent.name === "scout")?.tools).not.toContain("edit");
	});

	it("reads pi's agent file format, and the user's file wins over a built-in of the same name", () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-agents-"));
		writeFileSync(
			join(dir, "scout.md"),
			"---\nname: scout\ndescription: My own scout\ntools: read, grep\nmodel: anthropic/claude-haiku-4-5\n---\nLook around.\n",
		);
		writeFileSync(join(dir, "broken.md"), "---\nname: [not, a, name]\n---\nbody");
		writeFileSync(join(dir, "notes.txt"), "not an agent");

		const agents = loadAgents(dir);
		const scout = agents.find((agent) => agent.name === "scout");

		expect(agents).toHaveLength(6);
		expect(scout).toMatchObject({
			source: "user",
			description: "My own scout",
			tools: ["read", "grep"],
			model: "anthropic/claude-haiku-4-5",
			systemPrompt: "Look around.",
		});
	});

	it("rejects names that could not be a judge option, and ignores pins it cannot use", () => {
		const parse = (frontmatter: string) => parseAgent(`---\n${frontmatter}\n---\nprompt`, "user", "/x.md");

		expect(parse("name: other\ndescription: clashes with the escape option")).toBeUndefined();
		expect(parse("name: Has Spaces\ndescription: no")).toBeUndefined();
		expect(parse("name: nodesc")).toBeUndefined();
		// A bare model name cannot be resolved to a provider, and "ultra" is not a thinking level.
		expect(parse("name: ok\ndescription: fine\nmodel: haiku\nthinking: ultra")).toMatchObject({
			name: "ok",
			model: undefined,
			thinking: undefined,
		});
		expect(parse("name: ok\ndescription: fine\nthinking: high")?.thinking).toBe("high");
	});
});

describe("subagent exit", () => {
	it("says how a subagent's process ended early, and puts the same in its code", () => {
		const exited = exitedEarly(3, null, "boom");
		expect(exited.message).toBe("subagent exited with code 3 before it finished: boom");
		expect(codeOf(exited)).toEqual({ code: "exited_early", params: { exitCode: 3 } });
		// Killed: no exit code to make up, the signal instead.
		const killed = exitedEarly(null, "SIGTERM", "");
		expect(killed.message).toBe("subagent was ended by SIGTERM before it finished");
		expect(codeOf(killed)).toEqual({ code: "exited_early", params: { signal: "SIGTERM" } });
	});
});

describe("subagent command line", () => {
	it("passes the role's tools and prompt, and the extensions this process was started with", () => {
		expect(forwardedExtensionArgs(["-e", "/kyrn/ext.ts", "-p", "--extension", "/other.ts", "hi", "-e"])).toEqual([
			"-e",
			"/kyrn/ext.ts",
			"-e",
			"/other.ts",
		]);

		const agent = parseAgent(
			"---\nname: scout\ndescription: finds code\ntools: read, grep\n---\nYou scout.",
			"user",
			"/s.md",
		);
		const args = childArgs(
			{ title: "t", instructions: "Find the session store" },
			{ agent, model: "p/small", thinking: "low", routedBy: "judge" },
			"/tmp/prompt.md",
		);

		// JSON mode: the parent follows every step of the child instead of waiting for its last words.
		expect(args.slice(0, 12)).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--thinking",
			"low",
			"--model",
			"p/small",
			"--tools",
			"read,grep",
			"--append-system-prompt",
			"/tmp/prompt.md",
		]);
		expect(args.at(-1)).toBe("Task: Find the session store");
	});
});

describe("the thinking level a subagent starts with", () => {
	it("keeps the session's level on the session's own model, so the first call reads the parent's cached prefix", () => {
		const route = { model: "p/big", sessionModel: "p/big", sessionThinking: "high", judged: "low" as const };
		expect(thinkingForRoute(route)).toBe("high");
		// No ladder configured: every subagent runs on the session's model.
		expect(thinkingForRoute({ ...route, model: undefined })).toBe("high");
		expect(thinkingForRoute({ ...route, sessionThinking: "max" })).toBe("max");
	});

	it("takes the judge's level on a different model, and a role's pin over both", () => {
		const route = { model: "p/small", sessionModel: "p/big", sessionThinking: "high", judged: "low" as const };
		expect(thinkingForRoute(route)).toBe("low");
		expect(thinkingForRoute({ ...route, pinned: "medium" })).toBe("medium");
		expect(thinkingForRoute({ ...route, model: "p/big", pinned: "medium" })).toBe("medium");
	});
});
