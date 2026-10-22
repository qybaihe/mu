import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness } from "../../coding-agent/test/suite/harness.ts";
import { actionSpace, runBrowserTask } from "../src/browser/agent.ts";
import { CdpConnection } from "../src/browser/cdp.ts";
import { findChrome, type LaunchedChrome, launchChrome } from "../src/browser/chrome.ts";
import { BrowserSession, type PageAction } from "../src/browser/session.ts";
import { CascadeJudge } from "../src/cascade.ts";
import { parseConfig } from "../src/config.ts";
import { DecisionEngine } from "../src/decision.ts";
import { type BrowserStepInput, browserStep } from "../src/decisions/browser-step.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { Judge } from "../src/judge.ts";
import { codeOf } from "../src/language.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";
import { attended } from "./attended.ts";

const ACTIONS: PageAction[] = [
	{ id: "e1", kind: "fill", node: 1, role: "textbox", label: "Search products", value: "" },
	{ id: "e2", kind: "click", node: 1, role: "textbox", label: "Open Search products", value: "" },
	{
		id: "e3",
		kind: "select",
		node: 2,
		role: "combobox",
		label: "Sort by → Cheapest",
		value: "cheap",
		current_value: "Newest",
	},
	{
		id: "e4",
		kind: "select",
		node: 2,
		role: "combobox",
		label: "Sort by → Newest",
		value: "new",
		current_value: "Newest",
	},
	{ id: "e5", kind: "click", node: 3, role: "button", label: "Search", value: "" },
	{ id: "wait", kind: "wait", label: "Wait for the page to update" },
	{ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
];

function choose(choice: string, probability = 0.97): Answer {
	return { type: "choice", choice, probabilities: { [choice]: probability } };
}

function stepInput(): BrowserStepInput {
	const space = actionSpace(ACTIONS);
	return {
		goal: "Search for red shoes",
		page: { url: "http://shop.test/", title: "Shop", text: "Shop" },
		elements: space.elements,
		targets: space.targets,
		controls: space.controls,
		recentActions: [],
	};
}

describe("actionSpace", () => {
	it("gives each element one index and each operation its own target table", () => {
		const space = actionSpace(ACTIONS);

		expect(space.elements.map((element) => [element.index, element.label, element.operations])).toEqual([
			["1", "Search products", ["TYPE_TEXT", "CLICK"]],
			["2", "Sort by", ["SELECT"]],
			["3", "Search", ["CLICK"]],
		]);
		expect(Object.keys(space.targets.CLICK ?? {})).toEqual(["1", "3"]);
		expect(Object.keys(space.targets.SELECT ?? {})).toEqual(["2:1", "2:2"]);
		expect(space.controls).toEqual({ WAIT: "Wait for the page to update", SCROLL_DOWN: "Scroll down" });
		expect(space.actionFor.get("SELECT:2:2")?.value).toBe("new");
		expect(space.actionFor.get("SCROLL_DOWN")?.kind).toBe("scroll");
	});
});

describe("browser.step", () => {
	it("asks for the operation and one target per available operation in a single request", async () => {
		const provider = new MockJudgeProvider(() => ({ operation: choose("TYPE_TEXT"), type_text_target: choose("1") }));
		const engine = new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "active" });

		const decision = await engine.decide(browserStep, stepInput());

		expect(provider.calls).toHaveLength(1);
		const { questions } = provider.calls[0];
		expect(Object.keys(questions).sort()).toEqual(["click_target", "operation", "select_target", "type_text_target"]);
		const operation = questions.operation;
		expect(operation.type === "choice" && Object.keys(operation.criteria)).toEqual([
			"TYPE_TEXT",
			"CLICK",
			"SELECT",
			"WAIT",
			"SCROLL_DOWN",
			"DONE",
			"other",
		]);
		expect(decision.outcome).toEqual({ operation: "TYPE_TEXT", target: "1", probability: 0.97 });
	});

	it("reads only the target head that matches the chosen operation", async () => {
		const provider = new MockJudgeProvider(() => ({
			operation: choose("CLICK"),
			click_target: choose("3", 0.9),
			type_text_target: choose("1"),
		}));
		const engine = new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "active" });

		expect((await engine.decide(browserStep, stepInput())).outcome).toEqual({
			operation: "CLICK",
			target: "3",
			probability: 0.9,
		});
	});

	it("maps 'other' to BLOCKED and controls to themselves", async () => {
		const blocked = new DecisionEngine({
			judge: new Judge({ provider: new MockJudgeProvider(() => ({ operation: choose("other") })) }),
			defaultMode: "active",
		});
		const waiting = new DecisionEngine({
			judge: new Judge({ provider: new MockJudgeProvider(() => ({ operation: choose("WAIT", 0.8) })) }),
			defaultMode: "active",
		});

		expect((await blocked.decide(browserStep, stepInput())).outcome.operation).toBe("BLOCKED");
		expect((await waiting.decide(browserStep, stepInput())).outcome).toEqual({
			operation: "WAIT",
			target: null,
			probability: 0.8,
		});
	});

	it("abstains when no tier is trusted to relate a goal to a page", async () => {
		const small = new MockJudgeProvider(() => ({ operation: choose("CLICK"), click_target: choose("3") }), "laya");
		const cascade = new CascadeJudge([
			{ judge: new Judge({ provider: small }), profile: { capabilities: { relate: false } } },
		]);
		const engine = new DecisionEngine({ judge: cascade, defaultMode: "active" });

		const decision = await engine.decide(browserStep, stepInput());

		expect(small.calls).toHaveLength(0);
		expect(decision.judged).toBeUndefined();
		expect(decision.outcome.operation).toBe("BLOCKED");
	});

	it("records a step taken in shadow mode as the judge's: the judge is the actor whatever the mode", async () => {
		const provider = new MockJudgeProvider(() => ({ operation: choose("CLICK"), click_target: choose("3") }));
		const ledger = new MemoryLedger();
		const engine = new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "shadow", ledger });

		const decision = await engine.decide(browserStep, stepInput());

		expect(decision).toMatchObject({ source: "judge", outcome: { operation: "CLICK", target: "3" } });
		expect(ledger.records[0]).toMatchObject({ mode: "shadow", source: "judge", outcome: { operation: "CLICK" } });
	});

	it("browse tool: refuses a goal up front when the judge for browser.step cannot relate a goal to a page", async () => {
		const provider = new MockJudgeProvider(() => ({}));
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					config: parseConfig({
						routes: { "browser.step": ["laya"] },
						features: attended({ memory: false, permissions: { mode: "full" }, browser: { enabled: true } }),
					}),
				}),
			],
		});
		let seen = "";
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("browse", { url: "https://developer.mozilla.org", goal: "Search for WeakMap" })],
				{ stopReason: "toolUse" },
			),
			(context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("The browser needs another judge.");
			},
		]);
		try {
			await harness.session.prompt("Look up WeakMap on MDN.");
		} finally {
			harness.cleanup();
		}

		// Before any step, and before a browser is started: not "blocked at step 1" after a wasted look.
		expect(seen).toContain("the judge for browser.step (local:laya) is not trusted to relate a goal to a page");
		expect(seen).toContain("/mu route browser.step");
		expect(provider.calls.filter((call) => "operation" in call.questions)).toHaveLength(0);
	});
});

const PAGE = `<!doctype html><html><head><title>Shop search</title></head><body>
<h1>Shop</h1>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Results for: ' + document.getElementById('q').value;">
<label for="q">Search products</label><input id="q" name="q" type="text">
<button type="submit">Search</button>
</form>
<input type="password" aria-label="Password">
<p id="out"></p>
<button onclick="document.getElementById('out').textContent = 'account deleted'">Delete account</button>
<button>Decoration</button>
</body></html>`;

/** A web component: its controls live in an open shadow root, out of reach of querySelectorAll and elementFromPoint. */
const COMPONENT_PAGE = `<!doctype html><html><head><title>Components</title></head><body>
<a href="#before">Before</a>
<news-signup></news-signup>
<a href="#after">After</a>
<script>
customElements.define('news-signup', class extends HTMLElement {
	connectedCallback() {
		const root = this.attachShadow({ mode: 'open' });
		root.innerHTML = '<h2>Newsletter</h2><label for="m">Email address</label><input id="m" type="email">' +
			'<button aria-label="Subscribe to news">Go</button><p id="said"></p>';
		root.querySelector('button').addEventListener('click', () => {
			root.getElementById('said').textContent = 'Subscribed ' + root.getElementById('m').value;
		});
	}
});
</script>
</body></html>`;

interface ObservedState {
	page: { text: string };
	elements: { index: string; label: string; value?: string }[];
}

function indexOf(request: JudgeRequest, label: string): string {
	const state = request.state as unknown as ObservedState;
	return state.elements.find((element) => element.label === label)?.index ?? "none";
}

describe.skipIf(!findChrome())("runBrowserTask (real Chrome, local fixture)", () => {
	let server: Server;
	let url = "";
	let chrome: LaunchedChrome;
	let cdp: CdpConnection;
	let profileDir = "";

	beforeAll(async () => {
		server = createServer((request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(request.url === "/components" ? COMPONENT_PAGE : PAGE);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
		// A throwaway profile: the test never touches ~/.mu/browser-profile, let alone a personal one.
		// A loaded CI runner can keep Chrome past the 15 s port deadline while the other test files run; a fresh
		// profile gets two more tries before that counts as a failure.
		for (let attempt = 1; ; attempt++) {
			profileDir = mkdtempSync(join(tmpdir(), "kyrn-browser-test-"));
			try {
				chrome = await launchChrome({ profileDir });
				break;
			} catch (error) {
				// The next try gets a fresh folder. One still held on Windows (Chrome's helper processes outlive it for a
				// moment) is left behind rather than failing the run in place of the error it came from.
				try {
					rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
				} catch {}
				if (attempt === 3 || codeOf(error)?.code !== "devtools_port_timeout") throw error;
			}
		}
		cdp = await CdpConnection.connect(chrome.endpoint);
	}, 60_000);

	afterAll(async () => {
		cdp?.close();
		chrome?.process?.kill();
		await new Promise((resolve) => server.close(resolve));
		rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("never offers password fields to the judge", async () => {
		const session = await BrowserSession.open(cdp, url);
		const page = await session.observe();
		await session.close();

		expect(page.actions.map((action) => action.label)).not.toContain("Password");
		expect(page.actions.filter((action) => action.kind === "fill").map((action) => action.label)).toEqual([
			"Search products",
		]);
	});

	it("sees and operates controls inside open shadow roots", async () => {
		const session = await BrowserSession.open(cdp, `${url}components`);
		const page = await session.observe();
		const field = page.actions.find((action) => action.kind === "fill");
		const button = page.actions.find((action) => action.kind === "click" && action.label === "Subscribe to news");

		expect(field?.label).toBe("Email address");
		expect(page.text).toContain("Newsletter");
		// Reading order: the shadow tree sits where its host is, between the two light-DOM links.
		expect(page.actions.filter((action) => action.kind === "click").map((action) => action.label)).toEqual([
			"Before",
			"Open Email address",
			"Subscribe to news",
			"After",
		]);

		if (!field || !button) throw new Error("shadow controls were not observed");
		await session.act(field, page, "a@example.test");
		const filled = await session.observe();
		const again = filled.actions.find((action) => action.kind === "click" && action.label === "Subscribe to news");
		if (!again) throw new Error("button disappeared");
		await session.act(again, filled);
		const done = await session.observe();
		await session.close();

		expect(done.text).toContain("Subscribed a@example.test");
	}, 30_000);

	it("types, submits and stops when the goal is visibly met", async () => {
		const provider = new MockJudgeProvider((request): Record<string, Answer> => {
			const state = request.state as unknown as ObservedState;
			if (state.page.text.includes("Results for: red shoes")) return { operation: choose("DONE") };
			const field = state.elements.find((element) => element.label === "Search products");
			if (field && !field.value) return { operation: choose("TYPE_TEXT"), type_text_target: choose(field.index) };
			return { operation: choose("CLICK"), click_target: choose(indexOf(request, "Search")) };
		});
		const ledger = new MemoryLedger();
		// Shadow mode on purpose: in the browser the judge is the actor, so its verdict still drives the loop.
		const engine = new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "shadow", ledger });
		const session = await BrowserSession.open(cdp, url);

		const result = await runBrowserTask({
			session,
			engine,
			goal: "Search the shop for red shoes",
			writeText: async (context) => (context.field.label === "Search products" ? "red shoes" : undefined),
		});
		await session.close();

		expect(result.status).toBe("done");
		expect(result.code).toBe("done");
		expect(result.history.map((entry) => [entry.kind, entry.action, entry.text, entry.page_changed])).toEqual([
			["fill", "Search products", "red shoes", true],
			["click", "Search", undefined, true],
		]);
		expect(result.page.text).toContain("Results for: red shoes");
		expect(result.decisions).toBe(3);
		expect(ledger.records.map((record) => record.specId)).toEqual(["browser.step", "browser.step", "browser.step"]);
	}, 30_000);

	it("stops before an irreversible-looking click unless someone says yes", async () => {
		const provider = new MockJudgeProvider((request): Record<string, Answer> => {
			const state = request.state as unknown as ObservedState;
			if (state.page.text.includes("account deleted")) return { operation: choose("DONE") };
			return { operation: choose("CLICK"), click_target: choose(indexOf(request, "Delete account")) };
		});
		const engine = new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "active" });
		const asked: string[] = [];

		const refused = await BrowserSession.open(cdp, url);
		const stopped = await runBrowserTask({
			session: refused,
			engine,
			goal: "Delete my account",
			writeText: async () => undefined,
		});
		await refused.close();

		const allowed = await BrowserSession.open(cdp, url);
		const confirmed = await runBrowserTask({
			session: allowed,
			engine,
			goal: "Delete my account",
			writeText: async () => undefined,
			confirm: async (label) => {
				asked.push(label);
				return true;
			},
		});
		await allowed.close();

		expect(stopped.status).toBe("needs_confirmation");
		expect(stopped).toMatchObject({ code: "not_confirmed", params: { label: "Delete account" } });
		expect(stopped.history).toEqual([]);
		expect(stopped.page.text).not.toContain("account deleted");
		expect(asked).toEqual(["Delete account"]);
		expect(confirmed.status).toBe("done");
		expect(confirmed.page.text).toContain("account deleted");
	}, 30_000);

	it("gives up after three actions that change nothing", async () => {
		const provider = new MockJudgeProvider(
			(request): Record<string, Answer> => ({
				operation: choose("CLICK"),
				click_target: choose(indexOf(request, "Decoration")),
			}),
		);
		const engine = new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "active" });
		const session = await BrowserSession.open(cdp, url);

		const result = await runBrowserTask({ session, engine, goal: "Find the sale", writeText: async () => undefined });
		await session.close();

		expect(result.status).toBe("blocked");
		expect(result.history).toHaveLength(3);
		expect(result.reason).toContain("changed nothing");
		expect(result).toMatchObject({ code: "stuck", params: { actions: 3 } });
	}, 30_000);

	it("browse tool: the main model states the goal once and gets the final page back", async () => {
		const provider = new MockJudgeProvider((request): Record<string, Answer> => {
			if (!("operation" in request.questions)) return {};
			const state = request.state as unknown as ObservedState;
			if (state.page.text.includes("Results for: red shoes")) return { operation: choose("DONE") };
			const field = state.elements.find((element) => element.label === "Search products");
			if (field && !field.value) return { operation: choose("TYPE_TEXT"), type_text_target: choose(field.index) };
			return { operation: choose("CLICK"), click_target: choose(indexOf(request, "Search")) };
		});
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					// The same throwaway profile, so the tool attaches to the browser this suite already started.
					config: parseConfig({
						features: attended({
							memory: false,
							permissions: { mode: "full" },
							browser: { enabled: true, profileDir },
						}),
					}),
				}),
			],
		});
		let seen = "";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("browse", { url, goal: "Search the shop for red shoes" })], {
				stopReason: "toolUse",
			}),
			// The typed value comes from a text model, here the session's own, in the middle of the tool call.
			fauxAssistantMessage('{"text": "red shoes"}'),
			(context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("The shop lists results for red shoes.");
			},
		]);

		try {
			await harness.session.prompt("Look up red shoes in the shop.");
		} finally {
			harness.cleanup();
		}

		expect(seen).toContain("status: done");
		expect(seen).toContain("Results for: red shoes");
		expect(seen).toContain("untrusted data");
		expect(provider.calls.filter((call) => "operation" in call.questions)).toHaveLength(3);
	}, 30_000);

	it("browse tool: a page the running browser will not open is not called a failed launch, and its tab is closed", async () => {
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(),
					mode: "active",
					config: parseConfig({
						features: attended({
							memory: false,
							permissions: { mode: "full" },
							browser: { enabled: true, profileDir },
						}),
					}),
					onPresentation: (event) => events.push(event),
				}),
			],
		});
		const tabs = async () =>
			((await cdp.send("Target.getTargets")) as { targetInfos: { type: string }[] }).targetInfos.filter(
				(target) => target.type === "page",
			).length;
		const before = await tabs();
		harness.setResponses([
			// Passes the http(s) check, and Chrome refuses to navigate to it.
			fauxAssistantMessage([fauxToolCall("browse", { url: "https://" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("It would not open."),
		]);
		try {
			await harness.session.prompt("Open the page.");
		} finally {
			harness.cleanup();
		}
		const runs = events.filter((event) => event.kind === "browser.run").map((event) => event.payload);
		expect(runs).toEqual([
			{ state: "failed", url: "https://", code: "open_failed", reason: expect.any(String), embedded: false },
		]);
		expect(await tabs()).toBe(before);
	}, 30_000);
});
