import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { localModelStart, planLaunch, wantedModel } from "../../../kyrn/bin/mu.mjs";
import { type Context, enable, jsonOut, MUDE_PACKAGE } from "../src/mude/command.ts";
import { currentTiers, enableMude } from "../src/mude/config.ts";
import { downloadFiles, missingFiles } from "../src/mude/download.ts";
import { MUDE_REPO, type MudeFile } from "../src/mude/manifest.ts";
import {
	findRecord,
	keyVariable,
	listRecords,
	type ModelRecord,
	modelId,
	modelPaths,
	parseModelRef,
	resolveModel,
	writeRecord,
} from "../src/mude/models.ts";
import { modelContext, modelMain, packageOf } from "../src/mude/models-command.ts";
import { mudePaths } from "../src/mude/paths.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const gitSha1 = (text: string) =>
	createHash("sha1")
		.update(`blob ${Buffer.byteLength(text)}\0${text}`)
		.digest("hex");
const SHA = "0123456789abcdef0123456789abcdef01234567";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mu-models-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("naming a decision model on Hugging Face", () => {
	it("takes owner/name, a revision, and links to the model, a branch or a file", () => {
		expect(parseModelRef("owner/model")).toEqual({ repo: "owner/model", revision: undefined });
		expect(parseModelRef(" owner/model@v2 ")).toEqual({ repo: "owner/model", revision: "v2" });
		expect(parseModelRef("https://huggingface.co/owner/model")).toEqual({ repo: "owner/model", revision: undefined });
		expect(parseModelRef("huggingface.co/owner/model/tree/dev")).toEqual({ repo: "owner/model", revision: "dev" });
		expect(parseModelRef("https://hf.co/owner/model/blob/main/config.json")).toEqual({
			repo: "owner/model",
			revision: "main",
		});
		expect(parseModelRef("https://huggingface.co/owner/model?library=mlx")).toEqual({
			repo: "owner/model",
			revision: undefined,
		});
	});

	it("refuses what isn't a model: datasets, Spaces, other sites, a bare name", () => {
		expect(() => parseModelRef("https://huggingface.co/datasets/owner/data")).toThrow("dataset, not a model");
		expect(() => parseModelRef("https://huggingface.co/spaces/owner/app")).toThrow("Space, not a model");
		expect(() => parseModelRef("https://github.com/owner/model")).toThrow("isn't a Hugging Face link");
		expect(() => parseModelRef("model")).toThrow("give its link or owner/name");
		expect(() => parseModelRef("owner/model/extra")).toThrow("give its link or owner/name");
		expect(() => parseModelRef("https://huggingface.co/owner")).toThrow("doesn't name a model");
	});

	it("gives a model a short name that means nothing else in mu.json", () => {
		expect(modelId("owner/Fast-Judge", new Set())).toBe("fast-judge");
		expect(modelId("owner/fast-judge", new Set(["fast-judge"]))).toBe("owner-fast-judge");
		expect(modelId("owner/fast-judge", new Set(["fast-judge", "owner-fast-judge"]))).toBe("owner-fast-judge-2");
		// Names a built-in judge has, or that mu.json reads another way, go to owner-name.
		expect(modelId("acme/mude", new Set())).toBe("acme-mude");
		expect(modelId("acme/jev-small", new Set())).toBe("acme-jev-small");
		expect(modelId("acme/off", new Set())).toBe("acme-off");
		expect(keyVariable("acme-jev.small")).toBe("MU_JUDGE_ACME_JEV_SMALL_KEY");
	});
});

/** A Hugging Face API for `repo`: its commit, and its files in pages of `pageSize`. */
function fakeHub(
	repo: string,
	entries: Record<string, unknown>[],
	options: { pageSize?: number; status?: number } = {},
) {
	const asked: { url: string; auth?: string }[] = [];
	const pageSize = options.pageSize ?? entries.length;
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		asked.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
		if (options.status) return new Response("{}", { status: options.status });
		if (url.includes(`/api/models/${repo}/revision/`)) return Response.json({ sha: SHA });
		const tree = `/api/models/${repo}/tree/${SHA}`;
		if (url.includes(tree)) {
			const page = Number(new URL(url).searchParams.get("page") ?? "0");
			const slice = entries.slice(page * pageSize, (page + 1) * pageSize);
			const more = (page + 1) * pageSize < entries.length;
			const next = `https://huggingface.co${tree}?recursive=true&page=${page + 1}`;
			return Response.json(slice, { headers: more ? { Link: `<${next}>; rel="next"` } : {} });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetcher, asked };
}

describe("looking a model up on Hugging Face", () => {
	const server = { type: "file", path: "d3_server_mac.py", size: 10, oid: gitSha1("print(1)\n") };
	const weights = {
		type: "file",
		path: "weights/model.safetensors",
		size: 4000,
		oid: "f".repeat(40),
		lfs: { oid: "a".repeat(64), size: 4000 },
	};

	it("pins the commit and every file, sha256 for LFS files and the git hash for the others, over every page", async () => {
		const hub = fakeHub("owner/model", [server, { type: "directory", path: "weights" }, weights], { pageSize: 2 });
		const resolved = await resolveModel({ repo: "owner/model" }, { fetch: hub.fetcher, token: "hf_secret" });
		expect(resolved.revision).toBe(SHA);
		expect(resolved.files).toEqual([
			{ path: "d3_server_mac.py", size: 10, gitSha1: gitSha1("print(1)\n") },
			{ path: "weights/model.safetensors", size: 4000, sha256: "a".repeat(64) },
		]);
		expect(hub.asked.map((request) => request.url)).toEqual([
			"https://huggingface.co/api/models/owner/model/revision/main",
			`https://huggingface.co/api/models/owner/model/tree/${SHA}?recursive=true`,
			`https://huggingface.co/api/models/owner/model/tree/${SHA}?recursive=true&page=1`,
		]);
		expect(hub.asked.every((request) => request.auth === "Bearer hf_secret")).toBe(true);
	});

	it("refuses a repository mu can't run, and says why Hugging Face won't show one", async () => {
		// Each refusal has a kind the desktop app says in its own words.
		await expect(
			resolveModel({ repo: "owner/llm" }, { fetch: fakeHub("owner/llm", [weights]).fetcher }),
		).rejects.toMatchObject({
			kind: "notRunnable",
		});
		await expect(
			resolveModel({ repo: "owner/x" }, { fetch: fakeHub("owner/x", [], { status: 403 }).fetcher }),
		).rejects.toMatchObject({ kind: "access" });
		const offline = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		await expect(resolveModel({ repo: "owner/x" }, { fetch: offline })).rejects.toMatchObject({ kind: "network" });
		expect(() => parseModelRef("model")).toThrow(expect.objectContaining({ kind: "usage" }));
		const plain = fakeHub("owner/llm", [weights]);
		await expect(resolveModel({ repo: "owner/llm" }, { fetch: plain.fetcher })).rejects.toThrow(
			"has no d3_server_mac.py",
		);
		const gated = fakeHub("owner/gated", [], { status: 401 });
		// Without a token a 401 may just as well be a typo: Hugging Face answers so for a model that doesn't exist.
		await expect(resolveModel({ repo: "owner/gated" }, { fetch: gated.fetcher })).rejects.toThrow(
			"Couldn't open owner/gated on Hugging Face (401): it doesn't exist, or it's private or gated. Check the name",
		);
		await expect(resolveModel({ repo: "owner/gated" }, { fetch: gated.fetcher, token: "hf_test" })).rejects.toThrow(
			"owner/gated is private or gated on Hugging Face (401)",
		);
		const missing = fakeHub("owner/none", [], { status: 404 });
		await expect(resolveModel({ repo: "owner/none", revision: "v9" }, { fetch: missing.fetcher })).rejects.toThrow(
			"Hugging Face has no model owner/none at v9",
		);
	});
});

describe("downloading a model's small files by their git hash", () => {
	const text = "print('server')\n".repeat(50);
	let server: Server;
	let base: string;
	let body = text;
	beforeAll(async () => {
		server = createServer((_request, response) => response.end(body));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	});
	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

	it("keeps a file whose git hash matches and refuses one that changed", async () => {
		const files: MudeFile[] = [{ path: "d3_server_mac.py", size: text.length, gitSha1: gitSha1(text) }];
		const target = join(dir, "model");
		await downloadFiles({ dir: target, files, url: (path) => `${base}/${path}` });
		expect(readFileSync(join(target, "d3_server_mac.py"), "utf8")).toBe(text);
		expect(missingFiles(target, files)).toEqual([]);

		body = text.replace("server", "SERVER");
		const changed: MudeFile[] = [{ path: "other.py", size: body.length, gitSha1: gitSha1(text) }];
		await expect(downloadFiles({ dir: target, files: changed, url: (path) => `${base}/${path}` })).rejects.toThrow(
			"does not match its pinned git hash",
		);
		expect(existsSync(join(target, "other.py"))).toBe(false);
		body = text;
	});
});

describe("decision models beside mude", () => {
	const record: ModelRecord = {
		id: "fast-judge",
		repo: "owner/fast-judge",
		revision: SHA,
		files: [{ path: "d3_server_mac.py", size: 9, sha256: sha256("print(1)\n") }],
		bytes: 9,
	};
	const context = (): Context => {
		const home = join(dir, "home");
		mkdirSync(join(home, "agent"), { recursive: true });
		return {
			paths: mudePaths(home),
			files: { agentDir: join(home, "agent"), home, envFile: join(home, ".env"), now: new Date(2026, 9, 24) },
			lockFile: join(dir, "lock.txt"),
			env: {},
		};
	};
	const run = async (argv: string[], ctx: Context, options = {}) => {
		let text = "";
		const code = await modelMain(
			argv,
			ctx,
			(chunk) => {
				text += chunk;
			},
			false,
			options,
		);
		return { code, text, lines: text.trim().split("\n").filter(Boolean) };
	};
	const config = (ctx: Context) => JSON.parse(readFileSync(join(ctx.files.agentDir, "mu.json"), "utf8"));

	it("keeps each model in its own folder, with mude's Python environment", () => {
		const home = join(dir, "home");
		const paths = modelPaths(home, record);
		expect(paths.root).toBe(join(home, "local-judge", "models", "fast-judge"));
		expect(paths.model).toBe(join(paths.root, "model", SHA));
		expect(paths.venv).toBe(mudePaths(home).venv);
		expect(paths.python).toBe(mudePaths(home).python);
		writeRecord(home, record);
		expect(listRecords(home)).toEqual([record]);
		expect(findRecord(home, "FAST-JUDGE")).toEqual(record);
		expect(findRecord(home, "Owner/Fast-Judge")).toEqual(record);
		expect(findRecord(home, "other")).toBeUndefined();
		const pkg = packageOf(record);
		expect(pkg.install).toBe("mu judge model add fast-judge");
		expect(pkg.again("enable")).toBe("mu judge model use fast-judge");
		expect(pkg.again("start")).toBe("mu judge model start fast-judge");
		expect(MUDE_PACKAGE.again("enable")).toBe("mu judge mude enable");
	});

	it("takes the place of mude as the judge, and mude takes it back", async () => {
		const ctx = context();
		const mude = mudePaths(ctx.files.home);
		mkdirSync(mude.root, { recursive: true });
		enableMude(mude, ctx.files, { port: 8790, key: "mude-key", localOnly: false });
		writeRecord(ctx.files.home, record);
		const out = jsonOut(() => {});

		await enable(modelContext(ctx, record), out, 8791, false);
		expect(currentTiers(ctx.files)).toEqual(["fast-judge", "jev"]);
		const written = config(ctx);
		expect(written.judges["fast-judge"]).toEqual({
			type: "typesafe",
			baseUrl: "http://127.0.0.1:8791/v1/systemone",
			model: "fast-judge",
			apiKeyEnv: "MU_JUDGE_FAST_JUDGE_KEY",
			timeoutMs: 4000,
		});
		expect(written.routes).toEqual({ "tool.description": ["jev"], "tool.injection": ["jev"] });
		expect(readFileSync(ctx.files.envFile, "utf8")).toMatch(/^MU_JUDGE_FAST_JUDGE_KEY=[0-9a-f]{64}$/m);

		await enable(ctx, out, 8790, true);
		expect(currentTiers(ctx.files)).toEqual(["mude"]);
	});

	it("lists mude and the models added, which one is the judge, and switches between them", async () => {
		const ctx = context();
		writeRecord(ctx.files.home, record);
		await enable(
			modelContext(ctx, record),
			jsonOut(() => {}),
			8791,
			false,
		);
		const listed = await run(["list", "--json"], ctx);
		expect(listed.code).toBe(0);
		const { models } = JSON.parse(listed.lines[0] ?? "{}");
		expect(models.map((model: { name: string }) => model.name)).toEqual(["mude", "fast-judge"]);
		expect(models[0]).toMatchObject({ builtIn: true, repo: MUDE_REPO, enabled: false, installed: false });
		expect(models[1]).toMatchObject({ builtIn: false, repo: "owner/fast-judge", enabled: true, downloadedBytes: 0 });

		const human = await run(["list"], ctx);
		expect(human.text).toContain("fast-judge  owner/fast-judge @ 0123456 · 0.0 GB · not downloaded · the judge");

		const status = await run(["status", "fast-judge", "--json"], ctx);
		expect(JSON.parse(status.lines[0] ?? "{}")).toMatchObject({
			type: "status",
			name: "fast-judge",
			model: `owner/fast-judge@${SHA}`,
			enabled: true,
		});
	});

	it("takes a removed model out of the judge order and deletes its folder", async () => {
		const ctx = context();
		writeRecord(ctx.files.home, record);
		await enable(
			modelContext(ctx, record),
			jsonOut(() => {}),
			8791,
			true,
		);
		expect(currentTiers(ctx.files)).toEqual(["fast-judge"]);
		const removed = await run(["remove", "fast-judge"], ctx);
		expect(removed.code).toBe(0);
		expect(removed.text).toContain("fast-judge is no longer the judge: jev again.");
		expect(currentTiers(ctx.files)).toEqual(["jev"]);
		expect(config(ctx).judges?.["fast-judge"]).toBeUndefined();
		expect(existsSync(modelPaths(ctx.files.home, record).root)).toBe(false);
		expect(listRecords(ctx.files.home)).toEqual([]);
	});

	it("says what to do about a name it doesn't know, a missing name and an unknown option", async () => {
		const ctx = context();
		const unknown = await run(["use", "nothing"], ctx);
		expect(unknown.code).toBe(1);
		expect(unknown.text).toContain("No decision model nothing here");
		const missing = await run(["add", "--json"], ctx);
		expect(missing.code).toBe(2);
		expect(JSON.parse(missing.lines[0] ?? "{}")).toMatchObject({ type: "error", kind: "usage" });
		const option = await run(["add", "owner/model", "--fast"], ctx);
		expect(option.code).toBe(2);
		expect(option.text).toContain("Unknown option for mu judge model add: --fast");
		// mude 1.0 by its name or its link is mude's own command.
		const mude = await run(["status", "https://huggingface.co/qybaihe/mude-1.0-mlx-8bit/tree/main", "--json"], ctx);
		expect(JSON.parse(mude.lines[0] ?? "{}")).toMatchObject({ type: "status", name: "mude" });
		const help = await run(["help"], ctx);
		expect(help.text).toContain("mu judge model add <link or owner/name>[@revision]");
	});

	// A Mac with Apple silicon runs a model; elsewhere add stops before asking Hugging Face anything.
	it.runIf(process.platform !== "darwin")("refuses to add a model where none can run", async () => {
		const hub = fakeHub("owner/model", []);
		const added = await run(["add", "owner/model"], context(), { fetch: hub.fetcher });
		expect(added.code).toBe(1);
		expect(added.text).toContain("Decision models can't run on this machine");
		expect(hub.asked).toEqual([]);
	});
});

describe("the launcher and added models", () => {
	const agent = "/Users/bai/.mu/agent";
	const recordFile = "/Users/bai/.mu/local-judge/models/fast-judge/model.json";
	const disk = (files: Record<string, string>) => ({
		exists: (path: string) => path in files,
		isDir: () => true,
		readFile: (path: string) => {
			if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return files[path];
		},
	});

	it("starts the server of the added model the configuration names, and only one it knows", () => {
		const asks = (text: string, env = {}, extra: Record<string, string> = { [recordFile]: "{}" }) => {
			const fs = disk({ [`${agent}/mu.json`]: text, ...extra });
			const options = { env, agentDir: agent, muDir: "/Users/bai/.mu", platform: "darwin" as const, ...fs };
			return { model: wantedModel(options), start: localModelStart(options) };
		};
		expect(asks('{"tiers":["fast-judge","jev"]}')).toEqual({
			model: "fast-judge",
			start: ["model", "start", "fast-judge", "--no-wait"],
		});
		expect(asks('{"tiers":["jev"],"routes":{"turn.continue":["fast-judge"]}}').model).toBe("fast-judge");
		expect(asks('{"tiers":["fast-judge","jev"]}', {}, {}).model).toBeUndefined();
		expect(asks('{"tiers":["jev"]}', { MU_JUDGE: "fast-judge,jev" }).model).toBe("fast-judge");
		expect(
			asks('{"tiers":["../x","jev"]}', {}, { "/Users/bai/.mu/local-judge/models/../x/model.json": "{}" }).model,
		).toBeUndefined();
		// mude first: its own start.
		expect(asks('{"tiers":["mude","fast-judge"]}').start).toEqual(["start", "--no-wait"]);

		const pkg = "/opt/homebrew/lib/node_modules/mu-agent";
		const plan = planLaunch({
			platform: "darwin",
			env: {},
			argv: [],
			root: pkg,
			home: "/Users/bai",
			execPath: "/usr/bin/node",
			fs: disk({
				[`${agent}/mu.json`]: '{"tiers":["fast-judge","jev"]}',
				[recordFile]: "{}",
				[`${pkg}/dist/bundle/cli.js`]: "",
				[`${pkg}/judge/mu/index.js`]: "",
				[`${pkg}/judge/dist/mude.js`]: "",
			}),
		});
		if (plan.error !== undefined) throw new Error(plan.error);
		expect(plan.startMude).toMatchObject({
			args: [`${pkg}/judge/dist/mude.js`, "model", "start", "fast-judge", "--no-wait"],
		});
	});
});
