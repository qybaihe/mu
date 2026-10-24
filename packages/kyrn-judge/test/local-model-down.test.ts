import { createServer } from "node:net";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { BUILT_IN_JUDGES, parseConfig } from "../src/config.ts";
import { inputPreflight } from "../src/decisions/input-preflight.ts";
import { createJudgeFetch } from "../src/extension/judge-fetch.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { localJudgeOf } from "../src/mude/models.ts";
import { buildJudge } from "../src/registry.ts";
import type { Questions } from "../src/types.ts";
import { attended } from "./attended.ts";

/**
 * mude 1.0, or a decision model added from Hugging Face, installed but with its server not up: the launcher starts it
 * in the background and nothing waits for it, and its server listens only once the model is loaded. Until then its
 * address on 127.0.0.1 refuses the connection, and the judges behind it answer.
 */

/** A port on 127.0.0.1 nothing listens on, as a model's port is while its server is starting. */
function deadPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen({ port: 0, host: "127.0.0.1" }, () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

const questions = {
	edit: { type: "boolean", instructions: "Does `state` ask for a change to a file?" },
} satisfies Questions;

/** mude's built-in entry and an added model's, both on a port with no server behind it. */
async function downJudges() {
	const port = await deadPort();
	return {
		mude: { ...BUILT_IN_JUDGES.mude, baseUrl: `http://127.0.0.1:${port}/v1/systemone` },
		"fast-judge": localJudgeOf("fast-judge").entry(port),
	};
}

const KEYS = { MU_JUDGE_MUDE_KEY: "fixture-mude-key", MU_JUDGE_FAST_JUDGE_KEY: "fixture-model-key" };

describe("a decision model on this machine that is installed but not running", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is refused at once, and the judge behind it answers well within its timeout", async () => {
		const config = parseConfig({ tiers: ["mude", "fast-judge", "mock"], judges: await downJudges() });
		const http = createJudgeFetch();
		try {
			const built = buildJudge(config, { env: KEYS, fetch: http.fetch });
			expect(built.problems).toEqual([]);
			const startedAt = performance.now();
			const result = await built.judge.evaluate({ state: "Fix the typo in README.", questions });
			const elapsed = performance.now() - startedAt;
			expect(result.tiers?.map((tier) => tier.error)).toEqual(["unreachable", "unreachable", undefined]);
			expect(result.answers.edit.judge).toBe("mock");
			// mude's timeout is 4 s; a refused connection is not waited out.
			expect(elapsed).toBeLessThan(1000);
		} finally {
			await http.close();
		}
	});

	it("holds up neither the start of a session nor its first reply", async () => {
		const saved = { ...process.env };
		Object.assign(process.env, KEYS);
		try {
			const config = parseConfig({
				tiers: ["mude", "mock"],
				judges: await downJudges(),
				features: attended(),
			});
			const startedAt = performance.now();
			const harness = await createHarness({
				extensionFactories: [createKyrnJudgeExtension({ mode: "active", config })],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("It reads the config file.")]);
			await harness.session.prompt("what does loadConfig do?");
			const elapsed = performance.now() - startedAt;

			// Preflight waits up to 3 s for its verdict; mude's refusal sent the question on to the next judge at once.
			expect(elapsed).toBeLessThan(2500);
			const records = harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === "kyrn.decision" ? [entry.data as LedgerRecord] : [],
				);
			const preflight = records.find((record) => record.specId === inputPreflight.id);
			// mude said nothing (refused), and the judge behind it answered: no timeout, no outage.
			expect(preflight?.tiers?.map((tier) => tier.error)).toEqual(["unreachable", undefined]);
			expect(preflight?.reason ?? "").not.toMatch(/^error:|timeout/);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			for (const name of Object.keys(KEYS)) {
				if (saved[name] === undefined) delete process.env[name];
				else process.env[name] = saved[name];
			}
		}
	});
});
