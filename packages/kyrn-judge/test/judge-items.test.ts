import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { describeAnswers } from "../src/extension/features/judge-items.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

/** Login tests are a yes, session tests a maybe, the rest a no. */
function itemJudge(): MockJudgeProvider {
	return new MockJudgeProvider((request: JudgeRequest): Record<string, Answer> => {
		const state = request.state as Record<string, string>;
		const answers: Record<string, Answer> = {};
		for (const id of Object.keys(request.questions)) {
			const item = state[`i${id.slice(1)}`];
			if (typeof item !== "string") continue;
			const probability = item.includes("login") ? 0.95 : item.includes("session") ? 0.5 : 0.02;
			answers[id] = { type: "boolean", probability };
		}
		return answers;
	});
}

const itemCalls = (provider: MockJudgeProvider) =>
	provider.calls.filter((call) => Object.keys(call.questions).some((id) => /^q\d+$/.test(id)));

function toolResult(harness: Harness): { text: string; isError: boolean } {
	const result = harness.session.messages.find((message) => message.role === "toolResult") as
		| { content?: { type: string; text?: string }[]; isError?: boolean }
		| undefined;
	return {
		text: (result?.content ?? []).map((block) => block.text ?? "").join("\n"),
		isError: result?.isError === true,
	};
}

describe("describeAnswers", () => {
	it("lists the yeses and the unsure ones item by item, the noes by number, highest first", () => {
		const text = describeAnswers(
			"Is this test about login?",
			["a", "login fails", "b", "c", "session", "login ok", "d"],
			[0.01, 0.9, 0.02, 0.1, 0.5, 0.97, null],
		);
		expect(text.split("\n")).toEqual([
			"Jev answered 6 of 7 items: Is this test about login?",
			"yes (p >= 0.8): 2",
			"#6  0.97  login ok",
			"#2  0.90  login fails",
			"unsure: 1",
			"#5  0.50  session",
			"no (p <= 0.2): 3 (#1, #3-4)",
			"not answered: 1 (#7)",
		]);
	});
});

describe("the judge_items tool", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function call(
		provider: MockJudgeProvider,
		items: string[],
		mode: "active" | "shadow" | "off" = "active",
	): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode,
					only: ["judgeItems"],
					config: parseConfig({ modes: { "judge.items": mode } }),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("judge_items", { question: "Is this test about login?", items, context: "A web app" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Two of them are about login."),
		]);
		await harness.session.prompt("Which tests cover login?");
		return harness;
	}

	it("answers each item with its probability, the judge reading every item with the shared context", async () => {
		const provider = itemJudge();
		const harness = await call(provider, ["login redirects", "renders footer", "session expires", "login rejects"]);
		const { text, isError } = toolResult(harness);
		expect(isError).toBe(false);
		expect(text).toContain("#1  0.95  login redirects");
		expect(text).toContain("#4  0.95  login rejects");
		expect(text).toContain("#3  0.50  session expires");
		expect(text).toContain("no (p <= 0.2): 1 (#2)");
		const [request] = itemCalls(provider);
		expect(request.state).toMatchObject({ context: "A web app", i1: "login redirects", i4: "login rejects" });
	});

	it("puts many items to the judge in several requests, and answers in shadow too, because the model asked", async () => {
		const provider = itemJudge();
		const items = Array.from({ length: 40 }, (_, index) =>
			index % 10 === 0 ? `login case ${index}` : `case ${index}`,
		);
		const harness = await call(provider, items, "shadow");
		expect(itemCalls(provider).length).toBeGreaterThan(1);
		expect(toolResult(harness).text).toContain("yes (p >= 0.8): 4");
	});

	it("is turned away when switched off", async () => {
		const provider = itemJudge();
		const harness = await call(provider, ["login redirects"], "off");
		const { text, isError } = toolResult(harness);
		expect(isError).toBe(true);
		expect(text).toContain("switched off");
		expect(itemCalls(provider)).toEqual([]);
	});
});
