import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createMcpExtension, type ExtensionUIContext, loadMcpConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { allocateServerNames, sanitizeName } from "../src/mcp/names.ts";
import { definitionHash, McpStore } from "../src/mcp/store.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const SECRET = "sk-test-SECRET-value-0123456789";
const yes: Answer = { type: "boolean", probability: 0.97 };
const no: Answer = { type: "boolean", probability: 0.02 };

const harnesses: Harness[] = [];
const roots: string[] = [];
afterEach(async () => {
	while (harnesses.length > 0) {
		const harness = harnesses.pop();
		// What a real shutdown does: the servers this session started go with it.
		await harness?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness?.cleanup();
	}
	while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function home(files: Record<string, string> = {}): { home: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "mu-mcp-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return { home: root, agentDir: join(root, ".mu", "agent") };
}

const fake = (...args: string[]) => ({ command: process.execPath, args: [FAKE_SERVER, ...args] });

function readTool(): AgentTool {
	return {
		name: "read",
		label: "read",
		description: "read",
		parameters: Type.Object({ path: Type.String() }),
		execute: async (_id, params) => ({
			content: [{ type: "text", text: `contents of ${(params as { path: string }).path}` }],
			details: {},
		}),
	};
}

interface Started {
	harness: Harness;
	events: KyrnPresentationEvent[];
	notices: string[];
	confirms: string[];
}

async function start(options: {
	roots?: { home: string; agentDir: string };
	servers?: Record<string, unknown>;
	responder?: MockResponder;
	mode?: DecisionMode;
	only?: FeatureName[];
	features?: Record<string, unknown>;
	confirm?: boolean;
	projectFiles?: Record<string, string>;
	bind?: boolean;
}): Promise<Started> {
	const events: KyrnPresentationEvent[] = [];
	const notices: string[] = [];
	const confirms: string[] = [];
	const agentDir = options.roots?.agentDir;
	const harness = await createHarness({
		tools: [readTool()],
		extensionFactories: [
			// pi's MCP client, as it is built in: it connects what mu registers, and its own mcp.json.
			createMcpExtension({
				loadConfig: (ctx) =>
					agentDir
						? loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: false })
						: { servers: [], errors: [] },
				logPath: join(tmpdir(), `mu-mcp-test-${process.pid}.log`),
			}),
			createKyrnJudgeExtension({
				provider: new MockJudgeProvider(options.responder ?? (() => ({}))),
				mode: options.mode ?? "active",
				config: parseConfig({
					features: { memory: false, ...options.features },
					mcp: options.servers ? { servers: options.servers } : undefined,
				}),
				only: options.only ?? ["preflight", "catalog", "mcp"],
				roots: options.roots,
				onPresentation: (event) => events.push(event),
			}),
		],
	});
	harnesses.push(harness);
	for (const [path, content] of Object.entries(options.projectFiles ?? {})) {
		mkdirSync(dirname(join(harness.tempDir, path)), { recursive: true });
		writeFileSync(join(harness.tempDir, path), content);
	}
	// pi copies the UI context with a spread, so every method an extension may call has to be an own property.
	const ui = {
		notify: (message: string) => notices.push(message),
		confirm: async (_title: string, message: string) => {
			confirms.push(message);
			return options.confirm ?? false;
		},
		setStatus: () => undefined,
	} as unknown as ExtensionUIContext;
	if (options.bind !== false) await harness.session.bindExtensions({ uiContext: ui, mode: "tui" });
	return { harness, events, notices, confirms };
}

const active = (harness: Harness) => harness.session.getActiveToolNames();
const mcpTools = (harness: Harness) => active(harness).filter((name) => name.startsWith("mcp__"));
const toolResults = (harness: Harness) =>
	harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => JSON.stringify(message));
const kinds = (events: readonly KyrnPresentationEvent[], kind: string) =>
	events.filter((event) => event.kind === kind).map((event) => event.payload as Record<string, unknown>);
/** Answers the disclosure questions in catalog order. */
const disclose =
	(...answers: Answer[]): MockResponder =>
	(request) =>
		Object.fromEntries(
			Object.keys(request.questions)
				.filter((id) => id.startsWith("capability_"))
				.map((id, index) => [id, answers[index] ?? no]),
		);

describe("MCP servers in the capability catalog", () => {
	it("keeps a server hidden and not running until the model opens it, then serves its tools through pi", async () => {
		const startsFile = join(home().home, "starts");
		const { harness, events } = await start({ servers: { files: fake("--starts-file", startsFile) } });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find_capability", { query: "files" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("find_capability", { open: "mcp:files" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("mcp__files__echo", { message: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("mcp__files__fail", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		expect(mcpTools(harness)).toEqual([]);
		expect(existsSync(startsFile)).toBe(false);
		await harness.session.prompt("Echo hello through the files server.");

		const results = toolResults(harness);
		expect(results[0]).toContain("mcp:files");
		expect(results[0]).toContain("has not run on this machine yet");
		// The answer to "open" names the tools the server turned out to have, in pi's spelling.
		expect(results[1]).toContain("mcp__files__echo");
		expect(results[2]).toContain("untrusted data from the MCP server");
		expect(results[2]).toContain("echo: hello");
		expect(JSON.parse(results[3]).isError).toBe(true);
		expect(results[3]).toContain("the upstream API said no");
		expect(mcpTools(harness)).toEqual(expect.arrayContaining(["mcp__files__echo", "mcp__files__fail"]));
		expect(readFileSync(startsFile, "utf8").trim().split("\n")).toHaveLength(1);
		expect(kinds(events, "mcp.started")).toEqual([
			expect.objectContaining({ id: "mcp:files", tools: expect.arrayContaining(["mcp__files__echo"]) }),
		]);
	});

	it("opens what the judge is sure the task needs, using the tools remembered from last time", async () => {
		const dirs = home();
		const definition = fake();
		// A first session learns the tools. The cache is what lets the judge read more than a name later.
		const first = await start({ roots: dirs, servers: { files: definition }, only: ["catalog", "mcp"] });
		first.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find_capability", { open: "mcp:files" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await first.harness.session.prompt("Open it.");
		const cache = readFileSync(join(dirs.agentDir, "mu", "mcp-cache.json"), "utf8");
		expect(cache).toContain("Echo a message back");
		expect(cache).not.toContain(FAKE_SERVER);

		const asked: string[] = [];
		const second = await start({
			roots: dirs,
			servers: { files: definition },
			responder: (request) => {
				for (const question of Object.values(request.questions)) asked.push(String(question.instructions));
				return disclose(yes)(request);
			},
		});
		second.harness.setResponses([fauxAssistantMessage("On it.")]);
		await second.harness.session.prompt("Echo something.");

		expect(asked.join("\n")).toContain('Tools of the "files" MCP server: echo, fail, picture');
		expect(mcpTools(second.harness)).toContain("mcp__files__echo");
	});

	it("leaves a server that does not start hidden, says why in words, and keeps its secrets", async () => {
		const { harness, events } = await start({
			servers: { broken: { ...fake("--crash-on-start", "--leak-env", "TOKEN"), env: { TOKEN: SECRET } } },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find_capability", { open: "mcp:broken" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("find_capability", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("It is down."),
		]);
		await harness.session.prompt("Use the broken server.");

		const results = toolResults(harness);
		expect(results[0]).toContain("could not be started");
		expect(results[0]).toContain("cannot open database");
		// Still hidden, and still there to be found.
		expect(results[1]).toContain("mcp:broken");
		expect(kinds(events, "mcp.failed")).toEqual([
			expect.objectContaining({ code: "start_failed", reason: expect.stringContaining("cannot open database") }),
		]);
		// The server printed its token on the way down. It must not travel any further.
		expect(JSON.stringify([results, events, harness.sessionManager.getEntries()])).not.toContain(SECRET);
	});

	it("gives up on a server that does not answer, and stops its process", async () => {
		const startsFile = join(home().home, "starts");
		const { harness, events } = await start({
			servers: { stuck: fake("--hang-on-start", "--starts-file", startsFile) },
			features: { mcp: { startTimeoutMs: 1000 } },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find_capability", { open: "mcp:stuck" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Stuck."),
		]);
		await harness.session.prompt("Use it.");
		expect(toolResults(harness)[0]).toContain("did not answer within 1 s");
		expect(kinds(events, "mcp.failed")).toEqual([expect.objectContaining({ id: "mcp:stuck", code: "timeout" })]);
		expect(mcpTools(harness)).toEqual([]);
		// Not left running until its initialize request times out (on Windows it would also hold the folder).
		const pid = Number(readFileSync(startsFile, "utf8").trim());
		const running = () => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		await vi.waitFor(() => expect(running()).toBe(false), { timeout: 10_000, interval: 100 });
	});

	it("starts a server without mu's environment, which holds model keys", async () => {
		process.env.MU_MCP_TEST_MODEL_KEY = SECRET;
		try {
			const { harness, events } = await start({
				servers: { nosy: fake("--crash-on-start", "--leak-env", "MU_MCP_TEST_MODEL_KEY") },
			});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("find_capability", { open: "mcp:nosy" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("ok"),
			]);
			await harness.session.prompt("Open it.");
			// The server printed what it found under that name: nothing.
			expect(kinds(events, "mcp.failed")[0]?.reason).toContain("starting with token undefined");
		} finally {
			delete process.env.MU_MCP_TEST_MODEL_KEY;
		}
	});

	it("passes values literally: pi reads neither a variable nor a command into them", async () => {
		process.env.MU_MCP_TEST_VALUE = "!a$b";
		// mu's own placeholder, as Claude Code writes it.
		const placeholder = ["$", "{MU_MCP_TEST_VALUE}"].join("");
		try {
			const { harness, events } = await start({
				servers: {
					quoted: { ...fake("--crash-on-start", "--leak-env", "TOKEN"), env: { TOKEN: placeholder } },
				},
			});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("find_capability", { open: "mcp:quoted" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("ok"),
			]);
			await harness.session.prompt("Open it.");
			expect(kinds(events, "mcp.failed")[0]?.reason).toContain("starting with token !a$b");
		} finally {
			delete process.env.MU_MCP_TEST_VALUE;
		}
	});

	it("follows a server that drops and comes back with the next call, and one whose tools change", async () => {
		const startsFile = join(home().home, "starts");
		const { harness, events } = await start({
			servers: { flaky: { ...fake("--starts-file", startsFile, "--leak-env", "TOKEN"), env: { TOKEN: SECRET } } },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find_capability", { open: "mcp:flaky" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("mcp__flaky__crash", {})], { stopReason: "toolUse" }),
			async () => {
				await vi.waitFor(() => expect(kinds(events, "mcp.failed")).toHaveLength(1));
				return fauxAssistantMessage([fauxToolCall("mcp__flaky__echo", { message: "back" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage([fauxToolCall("mcp__flaky__grow", {})], { stopReason: "toolUse" }),
			async () => {
				// The server's announcement and the new listing take a moment; a real model takes far longer to answer.
				await vi.waitFor(() => expect(active(harness)).toContain("mcp__flaky__late"));
				return fauxAssistantMessage([fauxToolCall("mcp__flaky__echo", { message: "meanwhile" })], {
					stopReason: "toolUse",
				});
			},
			// A tool that came during a request is declared with the next one.
			fauxAssistantMessage([fauxToolCall("mcp__flaky__late", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Crash it, then go on.");

		const results = toolResults(harness);
		expect(results[2]).toContain("echo: back");
		expect(results[5]).toContain("late but here");
		expect(readFileSync(startsFile, "utf8").trim().split("\n")).toHaveLength(2);
		expect(kinds(events, "mcp.failed")).toEqual([
			expect.objectContaining({ id: "mcp:flaky", code: "disconnected", willRestart: true }),
		]);
		expect(kinds(events, "mcp.started")).toHaveLength(2);
		expect(kinds(events, "mcp.tools_changed")).toEqual([
			expect.objectContaining({ tools: expect.arrayContaining(["mcp__flaky__late"]) }),
		]);
		expect(JSON.stringify([results, events])).not.toContain(SECRET);
	});

	it("starts a pinned server with the session, and every server when nothing is hidden", async () => {
		const pinned = await start({ servers: { pinned: { ...fake(), exposure: "always" }, other: fake() } });
		pinned.harness.setResponses([fauxAssistantMessage("hi")]);
		await pinned.harness.session.prompt("Hello.");
		expect(mcpTools(pinned.harness)).toContain("mcp__pinned__echo");
		expect(mcpTools(pinned.harness)).not.toContain("mcp__other__echo");

		const open = await start({ servers: { one: fake(), two: fake() }, mode: "off" });
		open.harness.setResponses([fauxAssistantMessage("hi")]);
		await open.harness.session.prompt("Hello.");
		expect(mcpTools(open.harness)).toEqual(expect.arrayContaining(["mcp__one__echo", "mcp__two__echo"]));

		const shadow = await start({ servers: { one: fake() }, mode: "shadow", responder: disclose(yes) });
		shadow.harness.setResponses([fauxAssistantMessage("hi")]);
		await shadow.harness.session.prompt("Echo.");
		expect(mcpTools(shadow.harness)).toEqual([]);
		expect(active(shadow.harness)).toContain("find_capability");
	});

	it("leaves a server of pi's own mcp.json to pi", async () => {
		const dirs = home();
		mkdirSync(dirs.agentDir, { recursive: true });
		writeFileSync(
			join(dirs.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { files: { ...fake(), exposure: "direct" } } }),
		);
		const { harness } = await start({ roots: dirs, servers: { files: fake(), "files.other": fake() } });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find_capability", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await harness.session.prompt("List.");
		const listing = toolResults(harness)[0];
		// mu's "files" yields; the other one keeps a name of its own.
		expect(listing).not.toContain("mcp:files ");
		expect(listing).toContain("mcp:files_other");
		expect(mcpTools(harness)).toContain("mcp__files__echo");
	});

	it("reads no home folder and registers nothing when the feature is switched off", async () => {
		const off = await start({ servers: { files: fake() }, features: { mcp: false } });
		off.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find_capability", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("x"),
		]);
		await off.harness.session.prompt("List.");
		expect(toolResults(off.harness)[0]).toContain("No hidden capabilities match");
	});
});

describe("servers a project defines", () => {
	const projectFile = {
		".mcp.json": JSON.stringify({ mcpServers: { db: { ...fake(), env: { DB_PASSWORD: SECRET } } } }),
	};
	const openDb = (harness: Harness) =>
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find_capability", { open: "mcp:db" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);

	it("asks before the first start, shows what would run but no secret, and remembers the answer", async () => {
		const dirs = home();
		const asked = await start({ roots: dirs, projectFiles: projectFile, confirm: true, bind: false });
		await asked.harness.session.bindExtensions({
			uiContext: {
				notify: () => undefined,
				setStatus: () => undefined,
				confirm: async (_title: string, message: string) => {
					asked.confirms.push(message);
					return true;
				},
			} as unknown as ExtensionUIContext,
			mode: "tui",
		});
		openDb(asked.harness);
		await asked.harness.session.prompt("Query the database.");

		expect(asked.confirms).toHaveLength(1);
		expect(asked.confirms[0]).toContain(FAKE_SERVER);
		expect(asked.confirms[0]).toContain("DB_PASSWORD");
		expect(asked.confirms[0]).not.toContain(SECRET);
		expect(mcpTools(asked.harness)).toContain("mcp__db__echo");
		const approvals = readFileSync(join(dirs.agentDir, "mu", "mcp-approvals.json"), "utf8");
		expect(approvals).not.toContain(SECRET);
		expect(approvals).not.toContain(FAKE_SERVER);
	});

	it("does not start it when the user says no, or when there is nobody to ask", async () => {
		const refused = await start({ roots: home(), projectFiles: projectFile, confirm: false, bind: false });
		await refused.harness.session.bindExtensions({
			uiContext: {
				notify: () => undefined,
				setStatus: () => undefined,
				confirm: async () => false,
			} as unknown as ExtensionUIContext,
			mode: "tui",
		});
		openDb(refused.harness);
		await refused.harness.session.prompt("Query the database.");
		expect(toolResults(refused.harness)[0]).toContain("you did not allow");
		expect(mcpTools(refused.harness)).toEqual([]);

		// Print mode: no dialog can be shown, so the answer is no, with the way out spelled out.
		const headless = await start({ roots: home(), projectFiles: projectFile, bind: false });
		openDb(headless.harness);
		await headless.harness.session.prompt("Query the database.");
		expect(toolResults(headless.harness)[0]).toContain("has not been approved");
		expect(mcpTools(headless.harness)).toEqual([]);
	});

	it("binds an approval to the exact definition", () => {
		const dirs = home();
		const store = new McpStore(join(dirs.agentDir, "mu"));
		const server = {
			name: "db",
			transport: { type: "stdio" as const, command: "db-mcp", args: ["--ro"], env: { K: "v" } },
			source: "/p/.mcp.json",
			tool: "claude" as const,
			scope: "project" as const,
			exposure: "judged" as const,
		};
		expect(store.isApproved("/p", server)).toBe(false);
		store.approve("/p", server);
		expect(new McpStore(join(dirs.agentDir, "mu")).isApproved("/p", server)).toBe(true);
		expect(store.isApproved("/elsewhere", server)).toBe(false);
		const changed = { ...server, transport: { ...server.transport, args: ["--rw"] } };
		expect(store.isApproved("/p", changed)).toBe(false);
		expect(definitionHash(changed)).not.toBe(definitionHash(server));
	});
});

describe("inherited rules and skills in a session", () => {
	it("puts always-on rules into the prompt, hands a glob rule over once, and says once what it inherited", async () => {
		const dirs = home({
			".claude/CLAUDE.md": "Always answer in Chinese.",
			".codex/skills/charts/SKILL.md": "---\nname: charts\ndescription: Draw charts\n---\nSteps.",
			".cursor/mcp.json": JSON.stringify({
				mcpServers: { figma: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: SECRET } } },
			}),
		});
		const { harness, events, notices } = await start({
			roots: dirs,
			only: ["preflight", "catalog", "inherit", "mcp"],
			projectFiles: {
				".cursor/rules/api.mdc":
					"---\ndescription: API conventions\nglobs: src/api/**/*.ts\n---\nValidate every input with zod.",
				".cursor/rules/style.mdc": "---\nalwaysApply: true\n---\nUse tabs.",
				".cursor/rules/deploy.mdc": "---\ndescription: How to deploy\n---\nRun the script.",
			},
			bind: false,
		});
		await harness.session.bindExtensions({
			uiContext: {
				notify: (message: string) => notices.push(message),
				setStatus: () => undefined,
			} as unknown as ExtensionUIContext,
			mode: "tui",
		});
		let prompt = "";
		harness.setResponses([
			(context) => {
				prompt = JSON.stringify(context.messages);
				return fauxAssistantMessage(
					[fauxToolCall("read", { path: "src/api/user.ts" }), fauxToolCall("read", { path: "README.md" })],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage([fauxToolCall("read", { path: "src/api/order.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Look at the API.");

		expect(prompt).toContain("Always answer in Chinese.");
		expect(prompt).toContain("Use tabs.");
		expect(prompt).toContain("How to deploy");
		expect(prompt).not.toContain("Validate every input with zod.");
		const results = toolResults(harness);
		expect(results[0]).toContain("Validate every input with zod.");
		expect(results[0]).toContain(".cursor/rules/api.mdc");
		expect(results[1]).not.toContain("zod");
		expect(results[2]).not.toContain("zod");
		expect(events.filter((event) => event.kind === "inherit.rule")).toHaveLength(1);

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("Inherited 4 rules, 1 skill and 1 MCP server from Claude Code, Cursor and Codex.");
		expect(existsSync(join(dirs.agentDir, "mu", "inherit.json"))).toBe(true);
		// The test harness's resource loader ignores extension resources, so the handler is asked directly.
		const discovered = await harness.session.extensionRunner.emitResourcesDiscover(harness.tempDir, "startup");
		expect(discovered.skillPaths.map((entry) => entry.path)).toEqual([join(dirs.home, ".codex", "skills", "charts")]);
		expect(JSON.stringify([events, notices, harness.sessionManager.getEntries()])).not.toContain(SECRET);

		// A second session on the same machine stays quiet.
		const again = await start({ roots: dirs, only: ["inherit"], bind: false });
		await again.harness.session.bindExtensions({
			uiContext: {
				notify: (message: string) => again.notices.push(message),
				setStatus: () => undefined,
			} as unknown as ExtensionUIContext,
			mode: "tui",
		});
		expect(again.notices).toEqual([]);
	});
});

describe("server names pi accepts", () => {
	it("makes names safe and unique, and never takes one of pi's own", () => {
		expect(sanitizeName("my server/v2")).toBe("my_server_v2");
		expect(sanitizeName("数据库")).toBe("x");
		expect([...allocateServerNames(["my.server", "my server", "My-Server", "数据库", "另一个"]).values()]).toEqual([
			"my_server",
			"my_server_2",
			"My-Server_3",
			"x",
			"x_2",
		]);
		// pi treats `-` and `_` as one: "files-a" is taken by "files_a" in mcp.json.
		expect([...allocateServerNames(["files-a", "github"], ["files_a"]).values()]).toEqual(["files-a_2", "github"]);
	});
});
