import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planLaunch, planMude, wantsMude } from "../../../kyrn/bin/mu.mjs";
import { main, problems } from "../src/mude/command.ts";
import { disableMude, enableMude, judgeSetting, ROUTED_AWAY } from "../src/mude/config.ts";
import { DownloadError, downloadFiles, missingFiles } from "../src/mude/download.ts";
import { MUDE_BYTES, MUDE_FILES, MUDE_REVISION, type MudeFile, mudeFileUrl } from "../src/mude/manifest.ts";
import { mudePaths } from "../src/mude/paths.ts";

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
		expect(MUDE_BYTES).toBe(1_782_005_734);
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
			`https://huggingface.co/qybaihe/mude-2b-mlx-8bit/resolve/${MUDE_REVISION}/LICENSES/Apache-2.0.txt`,
		);
		expect(mudeFileUrl("config.json", "http://127.0.0.1:9/")).toBe(
			`http://127.0.0.1:9/qybaihe/mude-2b-mlx-8bit/resolve/${MUDE_REVISION}/config.json`,
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

	beforeEach(async () => {
		requests.length = 0;
		status = 200;
		server = createServer((request, response) => {
			const path = decodeURIComponent((request.url ?? "").slice(1));
			requests.push({ path, range: request.headers.range, auth: request.headers.authorization });
			const text = contents[path];
			if (status !== 200 || text === undefined) {
				response.writeHead(status === 200 ? 404 : status).end();
				return;
			}
			const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
			if (range) {
				const from = Number(range[1]);
				response.writeHead(206, { "content-length": text.length - from }).end(text.slice(from));
			} else {
				response.writeHead(200, { "content-length": text.length }).end(text);
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	});
	afterEach(async () => {
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

	it("goes on from the bytes an interrupted download left", async () => {
		writeFileSync(join(dir, "a.txt.part"), contents["a.txt"].slice(0, 1234));
		await downloadFiles(options({ files: [files[0]] }));
		expect(requests[0]).toMatchObject({ path: "a.txt", range: "bytes=1234-" });
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe(contents["a.txt"]);
		expect(existsSync(join(dir, "a.txt.part"))).toBe(false);
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
