import { existsSync, readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { CascadeJudge } from "../src/cascade.ts";
import { BUILT_IN_JUDGES, parseConfig } from "../src/config.ts";
import { DecisionEngine } from "../src/decision.ts";
import { toolAdmission, toolAdmissionBatch } from "../src/decisions/tool-admission.ts";
import { chunkLines, describeCall, printsFile } from "../src/extension/features/admission.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const noise = Array.from(
	{ length: 120 },
	(_, index) => `npm warn deprecated left-pad@1.${index}.0: use String.prototype.padStart`,
);
const failure = ["FAIL test/login.test.ts", "  expected session cookie to be set", "  at login.test.ts:42:7"];
const output = [
	"> npm test",
	...noise.slice(0, 60),
	...failure,
	...noise.slice(60),
	"Tests: 1 failed, 211 passed",
].join("\n");

const runTests: AgentTool = {
	name: "run_tests",
	label: "Run tests",
	description: "Run the test suite",
	parameters: Type.Object({ command: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: output }], details: {} }),
};

/** A tool that prints the same long output whatever it is asked: a shell, or a page fetch. */
function printing(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({ command: Type.Optional(Type.String()), url: Type.Optional(Type.String()) }),
		execute: async () => ({ content: [{ type: "text", text: output }], details: {} }),
	};
}

/** Calls a chunk a repeated warning unless it shows the failing test: one chunk per request (`chunk`), or many (`c1`… asked by `k1`…). */
function kindJudge(): MockJudgeProvider {
	return new MockJudgeProvider((request): Record<string, Answer> => {
		const state = request.state as Record<string, unknown>;
		const answers: Record<string, Answer> = {};
		for (const id of Object.keys(request.questions)) {
			const chunk = id === "kind" ? state.chunk : state[`c${id.slice(1)}`];
			if (typeof chunk !== "string") continue;
			const choice = chunk.includes("FAIL") ? "error" : "warning";
			answers[id] = { type: "choice", choice, probabilities: { [choice]: 0.95 } };
		}
		return answers;
	});
}

/** The requests that classified chunks. */
const admissionCalls = (provider: MockJudgeProvider) =>
	provider.calls.filter((call) => Object.keys(call.questions).some((id) => id === "kind" || /^k\d+$/.test(id)));

/** The chunks between the first and the last, which are the ones put to the judge. */
const middleChunks = chunkLines(output, 1200).length - 2;

function toolResultText(harness: Harness): string {
	const result = harness.session.messages.find((message) => message.role === "toolResult");
	const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
	return content.map((block) => block.text ?? "").join("\n");
}

describe("tool output admission", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function run(
		mode: "shadow" | "active",
		provider = kindJudge(),
		config: Record<string, unknown> = {},
		call: { tool: AgentTool; args: Record<string, string> } = { tool: runTests, args: { command: "npm test" } },
	): Promise<Harness> {
		// About what a result keeps, not about who allows the command that made it.
		vi.stubEnv("MU_PERMISSIONS", "full");
		const harness = await createHarness({
			tools: [call.tool],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode,
					...(Object.keys(config).length ? { config: parseConfig(config) } : {}),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxText("Running the suite to find the failing test."), fauxToolCall(call.tool.name, call.args)],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("The login test fails."),
		]);
		await harness.session.prompt("Why is CI red?");
		return harness;
	}

	it("keeps the failing test, the first and the last chunk, and archives what it drops", async () => {
		const provider = kindJudge();
		const harness = await run("active", provider);
		const text = toolResultText(harness);

		expect(text).toContain("FAIL test/login.test.ts");
		expect(text.startsWith("> npm test")).toBe(true);
		expect(text).toContain("Tests: 1 failed, 211 passed");
		expect(text.length).toBeLessThan(output.length / 2);

		const pointer = /full output: (\S+)\]/.exec(text);
		expect(pointer).not.toBeNull();
		const archive = pointer?.[1] ?? "";
		expect(existsSync(archive)).toBe(true);
		expect(readFileSync(archive, "utf8")).toBe(output);

		expect(text).toContain("of warning output omitted");

		// A hosted judge saw every middle chunk in one request, with the call that produced them, not the conversation.
		const calls = admissionCalls(provider);
		expect(calls).toHaveLength(1);
		expect(middleChunks).toBeGreaterThan(1);
		expect(Object.keys(calls[0].state as object)).toEqual([
			"call",
			...Array.from({ length: middleChunks }, (_, index) => `c${index + 1}`),
		]);
		expect(Object.keys(calls[0].questions)).toEqual(
			Array.from({ length: middleChunks }, (_, index) => `k${index + 1}`),
		);
		expect(calls[0].state).toMatchObject({ call: "run_tests: npm test" });
	});

	it("asks a local judge one chunk at a time, with the same result", async () => {
		const provider = kindJudge();
		const harness = await run("active", provider, { tiers: ["laya"] });
		const text = toolResultText(harness);
		expect(text).toContain("FAIL test/login.test.ts");
		expect(text).toContain("of warning output omitted");
		const calls = admissionCalls(provider);
		expect(calls).toHaveLength(middleChunks);
		for (const call of calls) expect(Object.keys(call.state as object)).toEqual(["call", "chunk"]);
	});

	it("past the wait, lets the output through whole and only records the verdict", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = new MockJudgeProvider(async (request) => {
			// Only the chunk verdicts are slow; the questions before the turn answer at once.
			if (!Object.keys(request.questions).some((id) => id === "kind" || /^k\d+$/.test(id))) return {};
			await held;
			return kindJudge()
				.evaluate(request)
				.then((response) => response.answers);
		});
		const startedAt = Date.now();
		const harness = await run("active", slow, { features: { admission: { waitMs: 60 } } });
		expect(toolResultText(harness)).toBe(output);
		expect(Date.now() - startedAt).toBeLessThan(2000);
		expect(admissionCalls(slow)).toHaveLength(1);
		release();
	});

	it("changes nothing in shadow mode", async () => {
		const harness = await run("shadow");
		expect(toolResultText(harness)).toBe(output);
	});

	it("keeps everything when the judge is unsure", async () => {
		const harness = await run("active", new MockJudgeProvider());
		expect(toolResultText(harness)).toBe(output);
	});

	it("does not judge a file the agent printed or a page it fetched, and still judges a build log", async () => {
		const bash = printing("bash");
		const prints: { tool: AgentTool; args: Record<string, string> }[] = [
			{ tool: bash, args: { command: "cd /app && cat build.log" } },
			{ tool: bash, args: { command: "sed -n 1,400p build.log | grep -v '^$'" } },
			{ tool: printing("web_fetch"), args: { url: "https://example.com/build.log" } },
		];
		for (const call of prints) {
			const provider = kindJudge();
			// mu's own web_fetch would go to the network: this one stands in for it.
			const harness = await run("active", provider, { features: { web: false } }, call);
			expect(toolResultText(harness), JSON.stringify(call.args)).toBe(output);
			expect(admissionCalls(provider)).toEqual([]);
		}

		const build = kindJudge();
		const text = toolResultText(
			await run("active", build, {}, { tool: bash, args: { command: "cd /app && make 2>&1 | tail -400" } }),
		);
		expect(text).toContain("of warning output omitted");
		expect(admissionCalls(build)).toHaveLength(1);

		// With no print commands listed, a cat is judged like anything else.
		const every = kindJudge();
		const config = { features: { admission: { printCommands: [] } } };
		await run("active", every, config, { tool: bash, args: { command: "cat build.log" } });
		expect(admissionCalls(every)).toHaveLength(1);
	});
});

describe("who judges admission", () => {
	const laya = BUILT_IN_JUDGES.laya.profile;
	const call = "bash: make";
	const chunks = chunkLines(output, 1200).slice(1, -1);

	it("is never the local judge: the next tier answers, and with none behind it everything is kept", async () => {
		const local = kindJudge();
		const hosted = kindJudge();
		const engine = new DecisionEngine({
			judge: new CascadeJudge([
				{ judge: new Judge({ provider: local }), profile: laya },
				{ judge: new Judge({ provider: hosted }) },
			]),
			defaultMode: "active",
		});
		const [batch] = await engine.decideMany(toolAdmissionBatch, [{ call, chunks }]);
		expect(batch.source).toBe("judge");
		expect(batch.outcome.some((outcome) => outcome.drop)).toBe(true);
		expect(hosted.calls).toHaveLength(1);

		const alone = new DecisionEngine({
			judge: new CascadeJudge([{ judge: new Judge({ provider: local }), profile: laya }]),
			defaultMode: "active",
		});
		expect(await alone.decide(toolAdmission, { call, chunk: chunks[0] })).toMatchObject({
			source: "fallback",
			outcome: { kind: "unknown", drop: false },
			reason: "abstain",
		});
		const [kept] = await alone.decideMany(toolAdmissionBatch, [{ call, chunks }]);
		expect(kept.source).toBe("fallback");
		expect(kept.outcome.every((outcome) => !outcome.drop)).toBe(true);
		expect(local.calls).toEqual([]);
	});
});

describe("admission helpers", () => {
	it("chunks on line boundaries and splits a line that is too long on its own", () => {
		expect(chunkLines("aa\nbb\ncc", 5)).toEqual(["aa\nbb", "cc"]);
		expect(chunkLines("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
	});

	it("tells a command that only prints files from one that does more", () => {
		for (const command of [
			"cat src/main.c",
			"cd /app && cat hi.c && readelf -lS a.out",
			'cd "/my dir" && head -50 notes.txt',
			"cat a.patch; echo ===; sed -n 1,80p b.c",
			'grep -nE "error|warning" -r src 2>/dev/null | head -40',
			"nl -ba f.py | sed -n '100,200p'",
			"tail -n 200 build.log",
			"git show HEAD~1",
		]) {
			expect(printsFile(command), command).toBe(true);
		}
		for (const command of [
			"npm test",
			"make 2>&1 | tail -100",
			"cat setup.py && python3 setup.py build",
			"cat > main.c <<'EOF'\nint main(void) { return 0; }\nEOF\ngcc main.c && ./a.out",
			"tail -f build.log",
			"sed -i s/a/b/ f.c",
			"cat $(ls *.c)",
			"cat a.txt > b.txt",
			"head -100 x.log || true",
			"echo done",
		]) {
			expect(printsFile(command), command).toBe(false);
		}
		expect(printsFile("cat src/main.c", [])).toBe(false);
	});

	it("describes a call by its command, pattern or path", () => {
		expect(describeCall("bash", { command: "npm test" })).toBe("bash: npm test");
		expect(describeCall("custom", { a: 1 })).toBe('custom: {"a":1}');
	});
});
