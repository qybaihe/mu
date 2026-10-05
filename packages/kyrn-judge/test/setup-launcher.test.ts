import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	dependenciesInstalled,
	MODEL_KEY_VARIABLES,
	mcpAddDefaults,
	planFirstRun,
	planSetup,
	SETUP_DECLINED_FILE,
	SETUP_EXIT_CANCELLED,
	SETUP_EXIT_START,
	SETUP_VALUE_FLAGS,
	usage,
} from "../../../kyrn/bin/mu.mjs";
import {
	SETUP_EXIT,
	SETUP_DECLINED_FILE as WIZARD_DECLINED_FILE,
	SETUP_VALUE_FLAGS as WIZARD_VALUE_FLAGS,
} from "../src/setup/wizard.ts";
import { MU, removeHome, runScriptAsync } from "./fixtures/launcher.ts";

/**
 * `mu setup` in the launcher (kyrn/bin/mu.mjs): how the wizard is started in a checkout and in the npm package, on
 * Windows and elsewhere, with a key on the command line kept out of the child's argv; and when a first `mu` asks to
 * set up a model. The decisions are called with an in-memory file system; one run goes through the real launcher,
 * against a server of the test's own.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeHome(dir);
});

/** A file system that is a list of paths: files carry text; folders are listed apart. */
function disk(files: Record<string, string>, folders: string[] = []) {
	return {
		exists: (path: string) => path in files || folders.includes(path),
		isDir: (path: string) => folders.includes(path),
		readFile: (path: string) => {
			if (!(path in files)) throw new Error(`ENOENT ${path}`);
			return files[path];
		},
	};
}

const KEY = `sk-${"0123456789abcdef".repeat(2)}`;

const POSIX_ROOT = "/home/bai/KYRN";
const posixInstalled = {
	[`${POSIX_ROOT}/node_modules/undici/package.json`]: "{}",
	[`${POSIX_ROOT}/packages/coding-agent/src/experimental/source-resolver.ts`]: "",
};
const POSIX_NATIVE = [
	"--disable-warning=ExperimentalWarning",
	"--import",
	`file://${POSIX_ROOT}/kyrn/bin/compile-cache.mjs`,
	"--import",
	`file://${POSIX_ROOT}/packages/coding-agent/src/experimental/source-resolver.ts`,
];
const POSIX_ENTRY = `${POSIX_ROOT}/packages/kyrn-judge/src/setup/main.ts`;

const WIN_PACKAGE = "C:\\Users\\bai\\AppData\\Roaming\\npm\\node_modules\\mu-agent";
const WIN_HOME = "C:\\Users\\bai";
const winPackage = {
	[`${WIN_PACKAGE}\\dist\\bundle\\cli.js`]: "",
	[`${WIN_PACKAGE}\\judge\\dist\\kyrn-judge.js`]: "",
};

const setupArgs = { env: {}, home: "/home/bai", execPath: "/usr/bin/node" };

describe("mu setup, as the launcher starts it", () => {
	it("runs the wizard's sources in a checkout, with a key from the command line in the environment only", () => {
		const plan = planSetup({
			...setupArgs,
			platform: "linux",
			env: { PATH: "/usr/bin", LANG: "zh_CN.UTF-8", UNSET: undefined },
			argv: ["--service", "deepseek", KEY, "--judge", "none"],
			root: POSIX_ROOT,
			fs: disk(posixInstalled),
		});
		if (plan.error !== undefined) throw new Error(plan.error);
		expect(plan.command).toBe("/usr/bin/node");
		expect(plan.args).toEqual([...POSIX_NATIVE, POSIX_ENTRY, "--service", "deepseek", "--judge", "none"]);
		// Every process on the machine can read another's argv; the key goes in the environment, which only the
		// process and its owner can.
		expect(plan.args.join(" ")).not.toContain(KEY);
		expect(plan.keyGiven).toBe(true);
		expect(plan.strategy).toBe("spawn");
		expect(plan.agentDir).toBe("/home/bai/.mu/agent");
		expect(plan.env).toEqual({
			PATH: "/usr/bin",
			LANG: "zh_CN.UTF-8",
			MU_SETUP_KEY: KEY,
			MU_AGENT_DIR: "/home/bai/.mu/agent",
			MU_CODING_AGENT_DIR: "/home/bai/.mu/agent",
			KYRN_CODING_AGENT_DIR: "/home/bai/.mu/agent",
			PI_CODING_AGENT_DIR: "/home/bai/.mu/agent",
			MU_SETUP_HOME: "/home/bai/.mu",
			// A checkout's session reads the .env at its root: the Jev key goes there.
			MU_SETUP_ENV_FILE: `${POSIX_ROOT}/.env`,
		});
	});

	it("passes its options and words through, and refuses a second key", () => {
		const plan = (argv: string[]) =>
			planSetup({ ...setupArgs, platform: "linux", argv, root: POSIX_ROOT, fs: disk(posixInstalled) });
		const help = plan(["help"]);
		expect(help.error === undefined && help.args.slice(-1)).toEqual(["help"]);
		const joined = plan(["--service=kimi", "--key-stdin", "--model", "kimi-k2.6"]);
		expect(joined.error === undefined && joined.args.slice(POSIX_NATIVE.length + 1)).toEqual([
			"--service=kimi",
			"--key-stdin",
			"--model",
			"kimi-k2.6",
		]);
		expect(joined.error === undefined && joined.keyGiven).toBe(false);
		expect(joined.error === undefined && "MU_SETUP_KEY" in joined.env).toBe(false);
		// The word after --model is its value, not a key.
		const named = plan(["--model", "deepseek-chat", KEY]);
		expect(named.error === undefined && named.env.MU_SETUP_KEY).toBe(KEY);
		expect(plan([KEY, "another"])).toEqual({ error: "mu setup takes one key at most (mu setup --help)", code: 2 });
	});

	it("runs the package's built wizard on Windows, and the .env of mu's home", () => {
		const built = `${WIN_PACKAGE}\\judge\\dist\\setup.js`;
		const plan = planSetup({
			platform: "win32",
			env: { Path: "C:\\Windows" },
			argv: [KEY],
			root: WIN_PACKAGE,
			home: WIN_HOME,
			execPath: "C:\\Program Files\\nodejs\\node.exe",
			fs: disk({ ...winPackage, [built]: "" }),
		});
		if (plan.error !== undefined) throw new Error(plan.error);
		expect(plan.args).toEqual([built]);
		expect(plan.env).toMatchObject({
			MU_SETUP_KEY: KEY,
			MU_AGENT_DIR: "C:\\Users\\bai\\.mu\\agent",
			MU_SETUP_HOME: "C:\\Users\\bai\\.mu",
			MU_SETUP_ENV_FILE: "C:\\Users\\bai\\.mu\\.env",
		});
		// A package built before mu setup says to update, instead of passing `setup` to pi as a message.
		const old = planSetup({
			platform: "win32",
			env: {},
			argv: [],
			root: WIN_PACKAGE,
			home: WIN_HOME,
			execPath: "node.exe",
			fs: disk(winPackage),
		});
		expect(old.error).toContain("npm i -g mu-agent");
	});

	it("says so where Node does not strip types, and follows the agent folder and old homes", () => {
		const unstripped = planSetup({
			...setupArgs,
			platform: "linux",
			argv: [],
			root: POSIX_ROOT,
			stripsTypes: false,
			fs: disk(posixInstalled),
		});
		expect(unstripped.error).toContain("does not strip types");
		const moved = planSetup({
			...setupArgs,
			platform: "linux",
			env: { MU_AGENT_DIR: "/srv/mu-agent" },
			argv: [],
			root: POSIX_ROOT,
			fs: disk(posixInstalled),
		});
		expect(moved.error === undefined && moved.env.PI_CODING_AGENT_DIR).toBe("/srv/mu-agent");
		const legacy = planSetup({
			...setupArgs,
			platform: "linux",
			argv: [],
			root: POSIX_ROOT,
			fs: disk(posixInstalled, ["/home/bai/.kyrn"]),
		});
		expect(legacy.error === undefined && legacy.env.MU_SETUP_HOME).toBe("/home/bai/.kyrn");
		const bare = planSetup({ ...setupArgs, platform: "linux", argv: [], root: POSIX_ROOT, fs: disk({}) });
		expect(bare.error).toContain("npm ci --ignore-scripts");
	});

	it("keeps the same names and codes as the wizard, and is in mu's usage", () => {
		expect(SETUP_DECLINED_FILE).toBe(WIZARD_DECLINED_FILE);
		expect(SETUP_EXIT_START).toBe(SETUP_EXIT.start);
		expect(SETUP_EXIT_CANCELLED).toBe(SETUP_EXIT.cancelled);
		expect([...SETUP_VALUE_FLAGS]).toEqual([...WIZARD_VALUE_FLAGS]);
		expect(usage("linux")).toContain("mu setup                 connect a model");
	});
});

describe("the first start", () => {
	const agentDir = "/home/bai/.mu/agent";
	const first = (overrides: Partial<Parameters<typeof planFirstRun>[0]> = {}, files: Record<string, string> = {}) =>
		planFirstRun({
			platform: "linux",
			env: {},
			argv: [],
			interactive: true,
			agentDir,
			fs: disk(files),
			...overrides,
		});

	it("asks a person at a terminal whose mu has nothing to work with", () => {
		expect(first()).toBe(true);
		expect(first({ argv: ["-c"] })).toBe(true);
		expect(first({ argv: ["fix the tests"] })).toBe(true);
		// Files that are there but say nothing.
		expect(
			first(
				{},
				{
					[`${agentDir}/auth.json`]: "{}",
					[`${agentDir}/models.json`]: '{"providers":{}}',
					[`${agentDir}/settings.json`]: '{"theme":"dark"}',
				},
			),
		).toBe(true);
		expect(first({}, { [`${agentDir}/auth.json`]: "" })).toBe(true);
		// The Jev key, an AWS profile or Google's default credentials give no model of their own.
		expect(first({ env: { TYPESAFE_API_KEY: "x", AWS_PROFILE: "work", GOOGLE_APPLICATION_CREDENTIALS: "/a" } })).toBe(
			true,
		);
		expect(first({ envText: "TYPESAFE_API_KEY=x\nDEEPSEEK_API_KEY=\n" })).toBe(true);
		expect(first({ env: { MU_NO_SETUP: "0" } })).toBe(true);
	});

	it("never asks a script, a command, or a run that names its model", () => {
		expect(first({ interactive: false })).toBe(false);
		for (const argv of [
			["-p", "hi"],
			["--print"],
			["--mode", "rpc"],
			["--mode=json"],
			["--model", "x"],
			["--provider=y"],
			["--version"],
			["--help"],
			["config"],
			["install", "npm:x"],
			["mcp", "list"],
			["--list-models"],
		]) {
			expect(first({ argv }), argv.join(" ")).toBe(false);
		}
	});

	it("makes a server added with mu mcp add deferred, unless the command says otherwise", () => {
		expect(mcpAddDefaults(["mcp", "add", "docs", "--url", "https://x/mcp"])).toEqual([
			"mcp",
			"add",
			"--exposure",
			"deferred",
			"docs",
			"--url",
			"https://x/mcp",
		]);
		const own = ["mcp", "add", "-l", "fs", "--exposure", "direct", "--", "npx", "fs"];
		expect(mcpAddDefaults(own)).toBe(own);
		// After `--`, or after the server's command, `--exposure` belongs to that command.
		expect(mcpAddDefaults(["mcp", "add", "fs", "--", "srv", "--exposure", "x"]).slice(2, 4)).toEqual([
			"--exposure",
			"deferred",
		]);
		expect(mcpAddDefaults(["mcp", "add", "fs", "srv", "--exposure", "x"]).slice(2, 4)).toEqual([
			"--exposure",
			"deferred",
		]);
		// A value that looks like an option is still a value.
		expect(mcpAddDefaults(["mcp", "add", "fs", "--description", "--exposure", "--url", "u"]).slice(2, 4)).toEqual([
			"--exposure",
			"deferred",
		]);
		for (const argv of [["mcp", "list"], ["fix", "add"], []]) expect(mcpAddDefaults(argv)).toBe(argv);
	});

	it("never asks again after a no, or when it is turned off", () => {
		expect(first({}, { [`${agentDir}/${SETUP_DECLINED_FILE}`]: "" })).toBe(false);
		expect(first({ env: { MU_NO_SETUP: "1" } })).toBe(false);
		expect(first({ env: { KYRN_NO_SETUP: "yes" } })).toBe(false);
	});

	it("never asks when something gives mu a model, or when a file cannot be read", () => {
		expect(first({}, { [`${agentDir}/auth.json`]: '{"deepseek":{"type":"api_key","key":"k"}}' })).toBe(false);
		expect(first({}, { [`${agentDir}/models.json`]: '{"providers":{"ollama":{}}}' })).toBe(false);
		expect(first({}, { [`${agentDir}/settings.json`]: '{"defaultProvider":"anthropic"}' })).toBe(false);
		expect(first({}, { [`${agentDir}/auth.json`]: "{ broken" })).toBe(false);
		expect(first({}, { [`${agentDir}/models.json`]: "// comments\n{}" })).toBe(false);
		expect(first({ env: { OPENAI_API_KEY: "k" } })).toBe(false);
		expect(first({ env: { AWS_BEARER_TOKEN_BEDROCK: "k" } })).toBe(false);
		expect(first({ envText: "export MOONSHOT_API_KEY='k'\n" })).toBe(false);
	});

	it("reads Windows paths on Windows", () => {
		const winAgent = "C:\\Users\\bai\\.mu\\agent";
		const files = { [`${winAgent}\\auth.json`]: '{"openai":{}}' };
		expect(
			planFirstRun({ platform: "win32", env: {}, argv: [], interactive: true, agentDir: winAgent, fs: disk(files) }),
		).toBe(false);
		expect(
			planFirstRun({ platform: "win32", env: {}, argv: [], interactive: true, agentDir: winAgent, fs: disk({}) }),
		).toBe(true);
	});

	it("knows every variable that gives pi a model key (packages/ai/src/env-api-keys.ts)", () => {
		const source = readFileSync(join(repo, "packages/ai/src/env-api-keys.ts"), "utf8");
		const lookup = source.slice(
			source.indexOf("function getApiKeyEnvVars"),
			source.indexOf("export function findEnvKeys"),
		);
		// Federation's organization, service account, workspace and token file go with its rule id, which mu counts.
		const federationParts = [
			"ANTHROPIC_ORGANIZATION_ID",
			"ANTHROPIC_SERVICE_ACCOUNT_ID",
			"ANTHROPIC_WORKSPACE_ID",
			"ANTHROPIC_IDENTITY_TOKEN_FILE",
		];
		const constants = [...source.matchAll(/export const ANTHROPIC_\w+_ENV = "(\w+)"/g)]
			.map((match) => match[1])
			.filter((name) => !federationParts.includes(name));
		const named = [...lookup.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((match) => match[1]);
		const pi = new Set([...constants, ...named]);
		// The Jev key is TypeSafe's classifier key: pi's typesafe provider has no chat model.
		pi.delete("TYPESAFE_API_KEY");
		// Bedrock's own key; its other sources (profiles, IAM keys) are there on many machines for other work.
		pi.add("AWS_BEARER_TOKEN_BEDROCK");
		expect([...MODEL_KEY_VARIABLES].sort()).toEqual([...pi].sort());
	});
});

describe("mu setup, run for real on this machine", () => {
	const runnable = dependenciesInstalled({ root: repo, platform: process.platform, exists: existsSync });

	it.skipIf(!runnable)(
		"sets up a service of one's own from a key on the command line, against a server of the test's own",
		async () => {
			const home = mkdtempSync(join(tmpdir(), "mu-setup-run-"));
			dirs.push(home);
			const key = "made-up-relay-key-0001";
			const seen: { url: string; authorization: string | undefined }[] = [];
			const server = createServer((request, response) => {
				seen.push({ url: request.url ?? "", authorization: request.headers.authorization });
				if (request.url === "/v1/models") {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ object: "list", data: [{ id: "relay-coder" }] }));
					return;
				}
				response.writeHead(404);
				response.end("not here");
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const { port } = server.address() as AddressInfo;
			try {
				const env = {
					HOME: home,
					LANG: "en_US.UTF-8",
					// No catalogue from the network, and no proxy between the wizard and this server.
					PI_OFFLINE: "1",
					NO_PROXY: "127.0.0.1,localhost",
					no_proxy: "127.0.0.1,localhost",
				};
				const help = await runScriptAsync(MU, ["setup", "--help"], env);
				expect(help.code).toBe(0);
				expect(help.out).toContain("--key-stdin");

				const run = await runScriptAsync(
					MU,
					["setup", key, "--service", "other", "--base-url", `http://127.0.0.1:${port}`],
					env,
					{ timeout: 90_000 },
				);
				expect(run.err).toBe("");
				expect(run.code).toBe(0);
				expect(run.out).toContain("Model to start with: relay-coder");
				expect(`${run.out}${run.err}`).not.toContain(key);
				// The address as typed, then with /v1: the key went to this server only, in its header.
				expect(seen).toEqual([
					{ url: "/models", authorization: `Bearer ${key}` },
					{ url: "/v1/models", authorization: `Bearer ${key}` },
				]);
				const agent = join(home, ".mu", "agent");
				const provider = `local-${port}`;
				expect(JSON.parse(readFileSync(join(agent, "auth.json"), "utf8"))).toEqual({
					[provider]: { type: "api_key", key },
				});
				expect(JSON.parse(readFileSync(join(agent, "models.json"), "utf8"))).toEqual({
					providers: {
						[provider]: {
							baseUrl: `http://127.0.0.1:${port}/v1`,
							api: "openai-completions",
							models: [{ id: "relay-coder" }],
						},
					},
				});
				expect(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"))).toMatchObject({
					defaultProvider: provider,
					defaultModel: "relay-coder",
				});
				// pi's store locks are all given back.
				expect(existsSync(join(agent, "auth.json.lock"))).toBe(false);
			} finally {
				server.close();
			}
		},
		120_000,
	);
});
