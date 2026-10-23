import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planLaunch, planMude, wantsMude } from "../../../kyrn/bin/mu.mjs";
import { installLocalOnly, main, problems } from "../src/mude/command.ts";
import { disableMude, enableMude, judgeSetting, ROUTED_AWAY } from "../src/mude/config.ts";
import { DownloadError, downloadedBytes, downloadFiles, missingFiles, resumeFrom } from "../src/mude/download.ts";
import { MUDE_BYTES, MUDE_FILES, MUDE_REVISION, type MudeFile, mudeFileUrl } from "../src/mude/manifest.ts";
import { mudePaths } from "../src/mude/paths.ts";
import { downloadUv } from "../src/mude/python.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mu-mude-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("mude's pinned package", () => {
	it("pins every file of the MLX edition by size and sha256, the server included", () => {
		expect(MUDE_FILES).toHaveLength(31);
		expect(MUDE_BYTES).toBe(1_782_006_237);
		const weights = MUDE_FILES.find((file) => file.path === "mlx-q8.safetensors");
		expect(weights).toEqual({
			path: "mlx-q8.safetensors",
			size: 1_756_751_774,
			sha256: "9757238f601c7b2eea997069add5856ba5ed8370786bfffae0b9ac550c33f697",
		});
		for (const name of [
			"d3_server_mac.py",
			"d3_server.py",
			"readout.safetensors",
			"LICENSE",
			"NOTICE",
			"LICENSES/Apache-2.0.txt",
		]) {
			expect(MUDE_FILES.map((file) => file.path)).toContain(name);
		}
		for (const file of MUDE_FILES) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("downloads from the pinned revision of the public repository", () => {
		expect(mudeFileUrl("LICENSES/Apache-2.0.txt")).toBe(
			`https://huggingface.co/qybaihe/mude-1.0-mlx-8bit/resolve/${MUDE_REVISION}/LICENSES/Apache-2.0.txt`,
		);
		expect(mudeFileUrl("config.json", "http://127.0.0.1:9/")).toBe(
			`http://127.0.0.1:9/qybaihe/mude-1.0-mlx-8bit/resolve/${MUDE_REVISION}/config.json`,
		);
	});
});

describe("downloading mude", () => {
	const contents: Record<string, string> = { "a.txt": "alpha ".repeat(5000), "sub/b.bin": "bravo ".repeat(9000) };
	const files: MudeFile[] = Object.entries(contents).map(([path, text]) => ({
		path,
		size: text.length,
		sha256: sha(text),
	}));
	let server: Server;
	let base: string;
	const requests: { path: string; range?: string; auth?: string }[] = [];
	let status = 200;
	/** Each response sends this many bytes of the file and then drops the connection. */
	let cutAfter: number | undefined;
	/** Each response sends this many bytes and then sends nothing more, holding the connection open. */
	let holdAfter: number | undefined;

	beforeEach(async () => {
		requests.length = 0;
		status = 200;
		cutAfter = undefined;
		holdAfter = undefined;
		server = createServer((request, response) => {
			const path = decodeURIComponent((request.url ?? "").slice(1));
			requests.push({ path, range: request.headers.range, auth: request.headers.authorization });
			const text = contents[path];
			if (status !== 200 || text === undefined) {
				response.writeHead(status === 200 ? 404 : status).end();
				return;
			}
			const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
			const from = range ? Number(range[1]) : 0;
			response.writeHead(range ? 206 : 200, { "content-length": text.length - from });
			const rest = text.slice(from);
			if (cutAfter !== undefined && rest.length > cutAfter) {
				// Closed a moment after the bytes, as a dropped connection is: what is read before it ends is not lost.
				response.write(rest.slice(0, cutAfter), () => setTimeout(() => response.socket?.end(), 50));
			} else if (holdAfter !== undefined && rest.length > holdAfter) {
				response.write(rest.slice(0, holdAfter));
			} else {
				response.end(rest);
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	});
	afterEach(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});

	const options = (extra: Partial<Parameters<typeof downloadFiles>[0]> = {}) => ({
		dir,
		files,
		url: (path: string) => `${base}/${path}`,
		sleep: async () => {},
		...extra,
	});

	it("downloads every file, checks it, and leaves a checked one alone the next time", async () => {
		const seen: number[] = [];
		await downloadFiles(options({ onProgress: (progress) => seen.push(progress.done) }));
		expect(readFileSync(join(dir, "sub/b.bin"), "utf8")).toBe(contents["sub/b.bin"]);
		expect(seen.at(-1)).toBe(files[0].size + files[1].size);
		expect(missingFiles(dir, files)).toEqual([]);
		requests.length = 0;
		await downloadFiles(options());
		expect(requests).toEqual([]);
	});

	it("goes on from the bytes an interrupted download left on the disk", async () => {
		writeFileSync(join(dir, "a.txt.part"), contents["a.txt"].slice(0, 5000));
		writeFileSync(join(dir, "a.txt.part.saved"), "4096\n");
		await downloadFiles(options({ files: [files[0]], checkpointBytes: 1024 }));
		expect(requests[0]).toMatchObject({ path: "a.txt", range: "bytes=4096-" });
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe(contents["a.txt"]);
		expect(existsSync(join(dir, "a.txt.part"))).toBe(false);
		expect(existsSync(join(dir, "a.txt.part.saved"))).toBe(false);
	});

	it("writes again the end of a part that a power cut may have left unwritten", async () => {
		// Up to the checkpoint the bytes are the file's; after it, what the disk had (zeros) when the power went.
		writeFileSync(join(dir, "a.txt.part"), `${contents["a.txt"].slice(0, 4096)}${"\0".repeat(3000)}`);
		writeFileSync(join(dir, "a.txt.part.saved"), "4096\n");
		await downloadFiles(options({ files: [files[0]], checkpointBytes: 1024 }));
		expect(requests).toHaveLength(1);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe(contents["a.txt"]);
		// A part without a checkpoint (an older mu's) loses its last checkpointBytes the same way.
		rmSync(join(dir, "a.txt"));
		rmSync(join(dir, ".mu-verified.json"));
		writeFileSync(join(dir, "a.txt.part"), contents["a.txt"].slice(0, 5000));
		expect(resumeFrom(join(dir, "a.txt.part"), files[0].size, 1024)).toBe(5000 - 1024);
		requests.length = 0;
		await downloadFiles(options({ files: [files[0]], checkpointBytes: 1024 }));
		expect(requests[0].range).toBe(`bytes=${5000 - 1024}-`);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe(contents["a.txt"]);
	});

	it("downloads a file from the start once more when what it went on from was wrong", async () => {
		writeFileSync(join(dir, "a.txt.part"), "x".repeat(4096));
		writeFileSync(join(dir, "a.txt.part.saved"), "4096\n");
		await downloadFiles(options({ files: [files[0]], checkpointBytes: 1024 }));
		expect(requests.map((request) => request.range)).toEqual(["bytes=4096-", undefined]);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe(contents["a.txt"]);
	});

	it("keeps trying while the connection keeps dropping, as long as each try gets some of the file", async () => {
		cutAfter = 7000;
		const waits: number[] = [];
		await downloadFiles(
			options({ files: [files[1]], attempts: 2, sleep: async (ms) => void waits.push(ms), checkpointBytes: 1024 }),
		);
		// 54,000 bytes at 7,000 a try: eight tries, each going on from where the one before stopped.
		expect(requests).toHaveLength(8);
		expect(requests[1].range).toBe("bytes=7000-");
		expect(waits.every((ms) => ms === 2000)).toBe(true);
		expect(readFileSync(join(dir, "sub/b.bin"), "utf8")).toBe(contents["sub/b.bin"]);
	});

	it("gives up after tries in a row that get nothing, waiting longer each time", async () => {
		status = 503;
		const waits: number[] = [];
		const failed = downloadFiles(options({ files: [files[0]], sleep: async (ms) => void waits.push(ms) }));
		await expect(failed).rejects.toMatchObject({ kind: "network" });
		expect(requests).toHaveLength(8);
		expect(waits).toEqual([2000, 5000, 10_000, 20_000, 30_000, 30_000, 30_000]);
	});

	it("stops when asked, keeping what it got on the disk for the next install", async () => {
		holdAfter = 3000;
		const stop = new AbortController();
		const failed = downloadFiles(
			options({
				files: [files[0]],
				signal: stop.signal,
				onProgress: (progress) => {
					if (progress.done >= 3000) stop.abort();
				},
			}),
		);
		await expect(failed).rejects.toMatchObject({ kind: "aborted" });
		expect(readFileSync(join(dir, "a.txt.part.saved"), "utf8").trim()).toBe("3000");
		expect(resumeFrom(join(dir, "a.txt.part"), files[0].size)).toBe(3000);
		holdAfter = undefined;
		requests.length = 0;
		await downloadFiles(options({ files: [files[0]] }));
		expect(requests[0].range).toBe("bytes=3000-");
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe(contents["a.txt"]);
	});

	it("stops at once when asked while it waits to try again", async () => {
		status = 503;
		const stop = new AbortController();
		const started = Date.now();
		// The real waits: after the first try fails, 2 s before the next. The stop comes during it.
		const failed = downloadFiles(options({ files: [files[0]], signal: stop.signal, sleep: undefined }));
		setTimeout(() => stop.abort(), 200);
		await expect(failed).rejects.toMatchObject({ kind: "aborted" });
		expect(Date.now() - started).toBeLessThan(1500);
		expect(requests).toHaveLength(1);
	});

	it("gives up at once when the disk is full, instead of trying again and blaming the connection", async () => {
		const waits: number[] = [];
		let calls = 0;
		// A write the disk refuses fails inside the same try as a dropped connection does; here the stream carries it.
		const full = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
		const failed = downloadFiles(
			options({
				files: [files[0]],
				sleep: async (ms) => void waits.push(ms),
				fetch: async () => {
					calls++;
					return new Response(new ReadableStream({ start: (controller) => controller.error(full) }));
				},
			}),
		);
		await expect(failed).rejects.toThrow(/^The disk is full: a\.txt could not be written/);
		expect(calls).toBe(1);
		expect(waits).toEqual([]);
	});

	it("refuses a file that does not match its pinned sha256, and removes it", async () => {
		const wrong = [{ ...files[0], sha256: sha("something else") }];
		await expect(downloadFiles(options({ files: wrong }))).rejects.toMatchObject({ kind: "integrity" });
		expect(existsSync(join(dir, "a.txt"))).toBe(false);
		expect(existsSync(join(dir, "a.txt.part"))).toBe(false);
	});

	it("says when Hugging Face refuses the files, and sends a token only when there is one", async () => {
		status = 401;
		const failed = downloadFiles(options({ token: "hf_secret" }));
		await expect(failed).rejects.toBeInstanceOf(DownloadError);
		await expect(failed).rejects.toMatchObject({ kind: "access" });
		expect(requests[0].auth).toBe("Bearer hf_secret");
		status = 200;
		requests.length = 0;
		await downloadFiles(options());
		expect(requests.every((request) => request.auth === undefined)).toBe(true);
	});

	it("checks a whole file that is already there instead of downloading it again", async () => {
		mkdirSync(join(dir, "sub"), { recursive: true });
		writeFileSync(join(dir, "sub/b.bin"), contents["sub/b.bin"]);
		await downloadFiles(options({ files: [files[1]] }));
		expect(requests).toEqual([]);
	});

	it("counts what an interrupted download left, so a stopped install can be told from a fresh one", async () => {
		expect(downloadedBytes(dir, files)).toBe(0);
		writeFileSync(join(dir, "a.txt.part"), contents["a.txt"].slice(0, 1234));
		expect(downloadedBytes(dir, files)).toBe(1234);
		// A part longer than the file counts as the file, no more.
		mkdirSync(join(dir, "sub"), { recursive: true });
		writeFileSync(join(dir, "sub/b.bin.part"), `${contents["sub/b.bin"]}extra`);
		expect(downloadedBytes(dir, files)).toBe(1234 + files[1].size);
		rmSync(join(dir, "sub/b.bin.part"));
		await downloadFiles(options());
		expect(downloadedBytes(dir, files)).toBe(files[0].size + files[1].size);
	});
});

describe("uv for mude's Python environment", () => {
	// A request that gets no answer until it is given up on.
	const hanging: typeof fetch = (_input, init) =>
		new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));

	it("gives up on a download of uv that gets no answer, and on a stop, instead of holding the install", async () => {
		const paths = mudePaths(join(dir, "home"));
		const started = Date.now();
		await expect(downloadUv(paths, { fetch: hanging, timeoutMs: 100 })).rejects.toThrow(
			"uv could not be downloaded from GitHub (no answer in 0.1 s): run mu judge mude install again",
		);
		expect(Date.now() - started).toBeLessThan(2000);
		const stop = new AbortController();
		const stopped = downloadUv(paths, { fetch: hanging, signal: stop.signal });
		stop.abort();
		await expect(stopped).rejects.toThrow(/^uv could not be downloaded from GitHub/);
	});
});

describe("mude in mu.json", () => {
	const setup = (config?: Record<string, unknown>) => {
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		if (config) writeFileSync(join(agentDir, "mu.json"), JSON.stringify(config));
		const paths = mudePaths(join(dir, "home"));
		mkdirSync(paths.root, { recursive: true });
		const files = {
			agentDir,
			home: join(dir, "home"),
			envFile: join(dir, "home", ".env"),
			now: new Date(2026, 9, 23),
		};
		const read = () => JSON.parse(readFileSync(join(agentDir, "mu.json"), "utf8"));
		return { paths, files, read };
	};

	it("puts mude first with the judges from before behind it, and sends the two checks it is not trusted with to them", () => {
		const { paths, files, read } = setup({ tiers: ["jev"], routes: { "browser.step": ["llm-a"] } });
		expect(enableMude(paths, files, { port: 8790, key: "k1", localOnly: false })).toEqual(["mude", "jev"]);
		const config = read();
		expect(config.tiers).toEqual(["mude", "jev"]);
		expect(config.judges).toBeUndefined();
		expect(config.routes).toEqual({
			"browser.step": ["llm-a"],
			"tool.description": ["jev"],
			"tool.injection": ["jev"],
		});
		expect(ROUTED_AWAY).toEqual(["tool.description", "tool.injection"]);
		expect(readFileSync(files.envFile, "utf8")).toContain("MU_JUDGE_MUDE_KEY=k1");
		expect(judgeSetting(files)).toEqual({ enabled: true, localOnly: false, fallback: ["jev"] });
	});

	it("uses mude alone when asked, and goes back to the judges from before on disable", () => {
		const { paths, files, read } = setup({ tiers: ["laya", "jev"], routes: { "tool.injection": ["clef"] } });
		enableMude(paths, files, { port: 8790, key: "k", localOnly: true });
		// A route someone set by hand stays as it is.
		expect(read()).toMatchObject({ tiers: ["mude"], routes: { "tool.injection": ["clef"] } });
		expect(judgeSetting(files)).toEqual({ enabled: true, localOnly: true, fallback: [] });
		enableMude(paths, files, { port: 8790, key: "k", localOnly: false });
		expect(read()).toMatchObject({
			tiers: ["mude", "laya", "jev"],
			routes: { "tool.injection": ["clef"], "tool.description": ["laya", "jev"] },
		});
		expect(disableMude(paths, files)).toEqual(["laya", "jev"]);
		expect(read()).toEqual({ tiers: ["laya", "jev"], routes: { "tool.injection": ["clef"] } });
	});

	it("turns a judge that was off on, and off again when mude is disabled", () => {
		const { paths, files, read } = setup({ modes: { default: "off" } });
		enableMude(paths, files, { port: 8790, key: "k", localOnly: false });
		expect(read().modes).toBeUndefined();
		disableMude(paths, files);
		expect(read()).toEqual({ tiers: ["jev"], modes: { default: "off" } });
	});

	it("names the server's address only when it is not on the usual port", () => {
		const { paths, files, read } = setup();
		enableMude(paths, files, { port: 49152, key: "k", localOnly: false });
		expect(read().judges.mude).toMatchObject({
			type: "typesafe",
			baseUrl: "http://127.0.0.1:49152/v1/systemone",
			apiKeyEnv: "MU_JUDGE_MUDE_KEY",
		});
		enableMude(paths, files, { port: 8790, key: "k", localOnly: false });
		expect(read().judges).toBeUndefined();
		enableMude(paths, files, { port: 49153, key: "k", localOnly: false });
		disableMude(paths, files, { removeEntry: true });
		expect(read()).toEqual({ tiers: ["jev"] });
	});

	it("leaves a mu.json that is not plain JSON alone", () => {
		const { paths, files } = setup();
		writeFileSync(join(files.agentDir, "mu.json"), "{ // a comment\n}");
		expect(() => enableMude(paths, files, { port: 8790, key: "k", localOnly: false })).toThrow("not plain JSON");
		expect(judgeSetting(files).unreadable).toBe(true);
	});
});

describe("mu judge mude", () => {
	it("says why mude can't run on a machine", () => {
		expect(problems({ platform: "linux" })).toEqual(["it needs a Mac with Apple silicon (an M1 or newer)"]);
		expect(problems({ platform: "darwin", arm64: false, darwinMajor: 24, memoryBytes: 16 * 1024 ** 3 })).toEqual([
			"it needs Apple silicon (an M1 or newer); this Mac has an Intel processor",
		]);
		expect(problems({ platform: "darwin", arm64: true, darwinMajor: 22, memoryBytes: 4 * 1024 ** 3 })).toEqual([
			"it needs macOS 14 or later",
			"it needs 8 GB of memory or more (it uses about 4 GB); this Mac has 4 GB",
		]);
		expect(problems({ platform: "darwin", arm64: true, darwinMajor: 23, memoryBytes: 8 * 1024 ** 3 })).toEqual([]);
	});

	const context = () => {
		const home = join(dir, "home");
		return {
			paths: mudePaths(home),
			files: { agentDir: join(home, "agent"), home, envFile: join(home, ".env") },
			lockFile: join(dir, "lock.txt"),
			env: {},
		};
	};

	it("reports what is installed and enabled as one JSON object, and refuses unknown options", async () => {
		let text = "";
		expect(
			await main(["status", "--json"], context(), (chunk) => {
				text += chunk;
			}),
		).toBe(0);
		const status = JSON.parse(text.trim());
		expect(status).toMatchObject({
			type: "status",
			installed: false,
			downloadedBytes: 0,
			pythonReady: false,
			running: false,
			enabled: false,
		});
		text = "";
		expect(
			await main(["enable", "--fast"], context(), (chunk) => {
				text += chunk;
			}),
		).toBe(2);
		expect(text).toContain("Unknown option");
	});

	it("reports how much of the model an install stopped part way left", async () => {
		const ctx = context();
		mkdirSync(ctx.paths.model, { recursive: true });
		writeFileSync(join(ctx.paths.model, "mlx-q8.safetensors.part"), Buffer.alloc(5000));
		writeFileSync(join(ctx.paths.model, "config.json"), Buffer.alloc(100));
		let text = "";
		expect(
			await main(["status", "--json"], ctx, (chunk) => {
				text += chunk;
			}),
		).toBe(0);
		expect(JSON.parse(text.trim())).toMatchObject({ installed: false, downloadedBytes: 5100 });
	});

	it("goes on with an install the way the one that stopped was asked, local only included", () => {
		const ctx = context();
		expect(installLocalOnly(ctx, [])).toBe(false);
		mkdirSync(ctx.paths.root, { recursive: true });
		writeFileSync(ctx.paths.install, `${JSON.stringify({ localOnly: true })}\n`);
		expect(installLocalOnly(ctx, [])).toBe(true);
		expect(installLocalOnly(ctx, ["--with-fallback"])).toBe(false);
		writeFileSync(ctx.paths.install, "not json");
		expect(installLocalOnly(ctx, [])).toBe(false);
		expect(installLocalOnly(ctx, ["--local-only"])).toBe(true);
	});

	it("disables nothing when mude was not the judge", async () => {
		let text = "";
		expect(
			await main(["disable"], context(), (chunk) => {
				text += chunk;
			}),
		).toBe(0);
		expect(text).toContain("mude 1.0 was not the judge");
		expect(existsSync(join(dir, "home", "agent", "mu.json"))).toBe(false);
	});
});

describe("the launcher and mude", () => {
	const disk = (files: Record<string, string>) => ({
		exists: (path: string) => path in files,
		isDir: () => false,
		readFile: (path: string) => {
			if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return files[path];
		},
	});

	it("runs the checkout's TypeScript or the package's build, and tells it where mu keeps things", () => {
		const root = "/home/bai/mu";
		const source = `${root}/packages/kyrn-judge/src/mude/cli.ts`;
		const plan = planMude({
			platform: "darwin",
			env: {},
			argv: ["install"],
			root,
			home: "/Users/bai",
			execPath: "/usr/bin/node",
			fs: disk({ [source]: "" }),
		});
		if (plan.error !== undefined) throw new Error(plan.error);
		expect(plan.args).toEqual(["--disable-warning=ExperimentalWarning", source, "install"]);
		expect(plan.env).toMatchObject({
			MU_AGENT_DIR: "/Users/bai/.mu/agent",
			MU_MUDE_HOME: "/Users/bai/.mu",
			MU_MUDE_ENV_FILE: `${root}/.env`,
			MU_MUDE_LOCK: `${root}/kyrn/local-judge/mude-requirements.lock.txt`,
		});
		const pkg = "/opt/homebrew/lib/node_modules/mu-agent";
		const installed = { [`${pkg}/dist/bundle/cli.js`]: "", [`${pkg}/judge/mu/index.js`]: "" };
		const built = planMude({
			platform: "darwin",
			env: {},
			argv: ["status"],
			root: pkg,
			home: "/Users/bai",
			execPath: "/usr/bin/node",
			fs: disk({ ...installed, [`${pkg}/judge/dist/mude.js`]: "" }),
		});
		expect(built).toMatchObject({
			args: [`${pkg}/judge/dist/mude.js`, "status"],
			env: { MU_MUDE_ENV_FILE: "/Users/bai/.mu/.env" },
		});
		expect(
			planMude({
				platform: "darwin",
				env: {},
				argv: [],
				root: pkg,
				home: "/Users/bai",
				execPath: "node",
				fs: disk(installed),
			}).error,
		).toContain("npm i -g mu-agent");
	});

	it("starts mude's server before a session on a Mac when the configuration names it", () => {
		const agent = "/Users/bai/.mu/agent";
		const asks = (text: string, env = {}) =>
			wantsMude({
				env,
				agentDir: agent,
				platform: "darwin",
				readFile: disk({ [`${agent}/mu.json`]: text }).readFile,
			});
		expect(asks('{"tiers":["mude","jev"]}')).toBe(true);
		expect(asks('{"tiers":["jev"],"routes":{"turn.continue":["mude"]}}')).toBe(true);
		expect(asks('{"tiers":["jev"],"judges":{"mude":{}}}')).toBe(false);
		expect(asks("{ broken")).toBe(false);
		expect(asks('{"tiers":["jev"]}', { MU_JUDGE: "mude,jev" })).toBe(true);

		const pkg = "/opt/homebrew/lib/node_modules/mu-agent";
		const files = {
			[`${agent}/mu.json`]: '{"tiers":["mude","jev"]}',
			[`${pkg}/dist/bundle/cli.js`]: "",
			[`${pkg}/judge/mu/index.js`]: "",
			[`${pkg}/judge/dist/mude.js`]: "",
		};
		const launch = (platform: "darwin" | "linux") =>
			planLaunch({
				platform,
				env: {},
				argv: [],
				root: pkg,
				home: "/Users/bai",
				execPath: "/usr/bin/node",
				fs: { ...disk(files), isDir: () => true },
			});
		const mac = launch("darwin");
		if (mac.error !== undefined) throw new Error(mac.error);
		expect(mac.startMude).toMatchObject({
			command: "/usr/bin/node",
			args: [`${pkg}/judge/dist/mude.js`, "start", "--no-wait"],
		});
		const linux = launch("linux");
		expect(linux.error === undefined && linux.startMude).toBeUndefined();
	});
});
