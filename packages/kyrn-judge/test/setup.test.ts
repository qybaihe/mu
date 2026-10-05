import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultModelPerProvider, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnvFile } from "../../../kyrn/bin/mu.mjs";
import {
	type CheckResult,
	checkKey,
	checkRequest,
	classifyAnswer,
	classifyFailure,
	explainProblem,
	listedModels,
	type Problem,
	safeMessage,
} from "../src/setup/check.ts";
import { envFileValue, readEnvEntries, setEnvValue } from "../src/setup/env-file.ts";
import {
	Backups,
	backupStamp,
	judgeConfigPath,
	readJsonFile,
	withModel,
	withProvider,
	writeFileAtomic,
} from "../src/setup/files.ts";
import { article, setupLanguage } from "../src/setup/language.ts";
import { piAccess } from "../src/setup/pi-access.ts";
import {
	chatModels,
	cleanKey,
	namedModel,
	SETUP_SERVICES,
	type SetupApi,
	type SetupService,
	serviceById,
	servicesForKey,
	tableModel,
} from "../src/setup/services.ts";
import {
	jevKeyAt,
	type PiAccess,
	type Prompter,
	parseSetupArgs,
	providerIdFor,
	runSetup,
	SETUP_DECLINED_FILE,
	SETUP_EXIT,
	setupUsage,
} from "../src/setup/wizard.ts";

/**
 * `mu setup` without a network, a real key or a model call: the keys here are made-up strings of the right shape,
 * every request goes to a fake fetch, and every file lands in a temporary home. What the tests hold on to above all:
 * a key goes to its own service only, and never into anything printed or into an address.
 */

const windows = process.platform === "win32";
const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "mu-setup-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Made-up keys, each of one vendor's shape. None of them was ever issued. */
const KEYS = {
	hex32: `sk-${"0123456789abcdef".repeat(2)}`,
	kimi: `sk-${"Ab1".repeat(16)}`,
	siliconflow: `sk-${"abcdefgh".repeat(6)}`,
	glm: `${"0123456789abcdef".repeat(2)}.AbCdEfGh12345678`,
	openrouter: `sk-or-v1-${"0".repeat(64)}`,
	openaiProject: `sk-proj-${"A".repeat(40)}`,
	openaiLegacy: `sk-${"A".repeat(20)}T3BlbkFJ${"B".repeat(20)}`,
	anthropic: `sk-ant-api03-${"x".repeat(40)}`,
	google: `AIza${"S".repeat(35)}`,
	xai: `xai-${"z".repeat(40)}`,
	unknown: "made-up-key-of-no-known-shape-1234",
	jev: "ts-made-up-jev-key-5678",
};

const ids = (services: readonly SetupService[]) => services.map((service) => service.id);

describe("the services table", () => {
	it("names the service a key belongs to by its shape, and several when the shape fits several", () => {
		expect(ids(servicesForKey(KEYS.hex32))).toEqual(["deepseek", "qwen"]);
		expect(ids(servicesForKey(KEYS.kimi))).toEqual(["kimi"]);
		expect(ids(servicesForKey(KEYS.siliconflow))).toEqual(["siliconflow"]);
		expect(ids(servicesForKey(KEYS.glm))).toEqual(["glm", "glm-coding"]);
		expect(ids(servicesForKey(KEYS.openrouter))).toEqual(["openrouter"]);
		expect(ids(servicesForKey(KEYS.openaiProject))).toEqual(["openai"]);
		// An old OpenAI key is 48 letters and digits like Kimi's; its T3BlbkFJ tells them apart.
		expect(ids(servicesForKey(KEYS.openaiLegacy))).toEqual(["openai"]);
		expect(ids(servicesForKey(KEYS.anthropic))).toEqual(["anthropic"]);
		expect(ids(servicesForKey(KEYS.google))).toEqual(["google"]);
		expect(ids(servicesForKey(KEYS.xai))).toEqual(["xai"]);
		expect(servicesForKey(KEYS.unknown)).toEqual([]);
		expect(servicesForKey("")).toEqual([]);
		// Pasted with the quotes and spaces of a .env line.
		expect(cleanKey(`  "${KEYS.kimi}"\n`)).toBe(KEYS.kimi);
		expect(ids(servicesForKey(` '${KEYS.xai}' `))).toEqual(["xai"]);
	});

	it("starts on the first model it names that the service lists, the newest for a name*", () => {
		const service = (id: string) => serviceById(id) as SetupService;
		expect(tableModel(service("deepseek"), ["deepseek-chat", "deepseek-v4-pro"])).toBe("deepseek-v4-pro");
		expect(tableModel(service("deepseek"), ["deepseek-reasoner", "deepseek-chat"])).toBe("deepseek-chat");
		expect(tableModel(service("qwen"), ["qwen-plus", "qwen3-max", "qwen-turbo"])).toBe("qwen3-max");
		// The higher version wins, and between equal versions the plainer id.
		expect(tableModel(service("glm"), ["glm-4.5", "glm-4.6-air", "glm-4.6", "glm-4"])).toBe("glm-4.6");
		expect(
			tableModel(service("siliconflow"), [
				"Pro/deepseek-ai/DeepSeek-V3.2",
				"deepseek-ai/DeepSeek-V3",
				"deepseek-ai/DeepSeek-V3.2",
				"moonshotai/Kimi-K2-Instruct",
			]),
		).toBe("deepseek-ai/DeepSeek-V3.2");
		expect(tableModel(service("siliconflow"), ["moonshotai/Kimi-K2-Instruct", "Qwen/Qwen3-Coder-480B"])).toBe(
			"moonshotai/Kimi-K2-Instruct",
		);
		expect(tableModel(service("stepfun"), ["step-1-8k", "step-2-16k", "step-1v-8k"])).toBe("step-2-16k");
		// None named: the person picks, from what a coding agent can talk to.
		expect(tableModel(service("ollama"), ["nomic-embed-text:latest", "qwen2.5-coder:7b"])).toBeUndefined();
		expect(chatModels(["nomic-embed-text:latest", "qwen2.5-coder:7b", "whisper-1"])).toEqual(["qwen2.5-coder:7b"]);
		expect(chatModels(["text-embedding-3-small"])).toEqual(["text-embedding-3-small"]);
		// A service that lists nothing starts on the model it names.
		expect(namedModel(service("openrouter"))).toBe("moonshotai/kimi-k2.6");
		expect(namedModel(service("glm"))).toBeUndefined();
		expect(namedModel(service("glm-coding"))).toBe("glm-5.3");
	});

	it("agrees with pi: its providers, where each is reached, and the model pi starts each on", async () => {
		const dir = temp();
		const runtime = await ModelRuntime.create({
			authPath: join(dir, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(dir, "models-store.json"),
			refreshOnCreate: false,
		});
		const pi = piAccess(runtime, dir);
		const preferred: Readonly<Record<string, string>> = defaultModelPerProvider;
		for (const service of SETUP_SERVICES) {
			expect(service.providers.length, service.id).toBe(service.baseUrls.length);
			for (const [index, provider] of service.providers.entries()) {
				if (!service.builtIn) {
					// A provider of mu's never lays itself over one of pi's.
					expect(pi.providerExists(provider), `${service.id}: ${provider} is pi's`).toBe(false);
					continue;
				}
				// The key is checked where pi sends the service's API.
				expect(pi.baseUrl(provider, service.api), service.id).toBe(service.baseUrls[index]);
				// The model the table names first is the one pi starts the provider on, over that API at that address.
				expect(namedModel(service), service.id).toBe(preferred[provider]);
				const start = runtime.getModels(provider).find((model) => model.id === namedModel(service));
				expect(start?.api, service.id).toBe(service.api);
				expect(start?.baseUrl, service.id).toBe(service.baseUrls[index]);
			}
		}
		// OpenRouter speaks two APIs at two addresses; the check goes to the one its start model is on.
		expect(pi.baseUrl("openrouter", "anthropic-messages")).toBe("https://openrouter.ai/api");
		// Qwen's compat is what pi's own catalog says of Alibaba's compatible mode.
		const alibaba = runtime.getModels("qwen-token-plan-cn")[0].compat as Record<string, unknown>;
		const qwen = serviceById("qwen") as SetupService;
		for (const [name, value] of Object.entries(qwen.compat ?? {})) expect(alibaba[name], name).toBe(value);
	});
});

describe("the check", () => {
	it("asks each kind of service the way it expects, with the key in a header only", () => {
		const key = KEYS.hex32;
		expect(checkRequest("openai-models", "https://api.deepseek.com/", key)).toEqual({
			url: "https://api.deepseek.com/models",
			headers: { accept: "application/json", authorization: `Bearer ${key}` },
		});
		expect(checkRequest("anthropic-models", "https://api.anthropic.com", KEYS.anthropic)).toEqual({
			url: "https://api.anthropic.com/v1/models?limit=1000",
			headers: { accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": KEYS.anthropic },
		});
		// A Claude subscription token goes as pi sends it.
		const token = `sk-ant-oat01-${"t".repeat(40)}`;
		expect(checkRequest("anthropic-models", "https://api.anthropic.com", token).headers).toMatchObject({
			authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		});
		expect(checkRequest("google-models", "https://generativelanguage.googleapis.com/v1beta", KEYS.google)).toEqual({
			url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
			headers: { accept: "application/json", "x-goog-api-key": KEYS.google },
		});
		expect(checkRequest("openrouter-key", "https://openrouter.ai/api/v1", KEYS.openrouter)).toEqual({
			url: "https://openrouter.ai/api/v1/key",
			headers: { accept: "application/json", authorization: `Bearer ${KEYS.openrouter}` },
		});
		expect(checkRequest("openai-models", "http://localhost:11434/v1", undefined).headers).toEqual({
			accept: "application/json",
		});
		for (const kind of ["openai-models", "anthropic-models", "google-models", "openrouter-key"] as const) {
			expect(checkRequest(kind, "https://example.test/v1", key).url).not.toContain(key);
		}
	});

	it("reads the model list of each API", () => {
		expect(listedModels("openai-models", { data: [{ id: "a" }, { id: "b" }, { id: "a" }] })).toEqual(["a", "b"]);
		expect(
			listedModels("google-models", {
				models: [
					{ name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: ["generateContent"] },
					{ name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
				],
			}),
		).toEqual(["gemini-3.1-pro-preview"]);
		expect(listedModels("anthropic-models", { data: [{ id: "claude-opus-4-8", type: "model" }] })).toEqual([
			"claude-opus-4-8",
		]);
		// Ollama's own /api/tags shape, and a plain list of names.
		expect(listedModels("openai-models", { models: [{ name: "qwen2.5-coder:7b" }] })).toEqual(["qwen2.5-coder:7b"]);
		expect(listedModels("openai-models", { data: ["x", "y"] })).toEqual(["x", "y"]);
		expect(listedModels("openai-models", { object: "list" })).toBeUndefined();
		expect(listedModels("openai-models", { data: [] })).toEqual([]);
	});

	/** One check against a fake answer. */
	async function check(respond: () => Response | Error): Promise<CheckResult> {
		return checkKey({
			kind: "openai-models",
			baseUrl: "https://api.example.test/v1",
			key: KEYS.hex32,
			timeoutMs: 1000,
			fetch: (async () => {
				const answer = respond();
				if (answer instanceof Error) throw answer;
				return answer;
			}) as typeof fetch,
		});
	}
	const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
	const failure = (code: string) => () => Object.assign(new TypeError("fetch failed"), { cause: { code } });

	it("turns each failure into what a person can do about it, in both languages, without the key", async () => {
		const cases: [string, () => Response | Error, RegExp, RegExp][] = [
			[
				"key",
				json(401, { error: { message: `Incorrect API key provided: ${KEYS.hex32}` } }),
				/does not accept this key/,
				/不接受这个密钥/,
			],
			["balance", json(402, { error: { message: "Insufficient Balance" } }), /no balance or quota/, /余额或额度/],
			[
				"balance",
				json(429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } }),
				/no balance or quota/,
				/余额或额度/,
			],
			["rate", json(429, { error: { message: "Rate limit reached" } }), /too many requests/, /太频繁/],
			["region", json(403, { error: { code: "unsupported_country_region_territory" } }), /region/, /地区/],
			[
				"key",
				json(400, { error: { message: "API key not valid. Please pass a valid API key." } }),
				/does not accept/,
				/不接受/,
			],
			["refused", json(403, { error: { message: "Forbidden" } }), /refused this key/, /拒绝了这个密钥/],
			[
				"permission",
				json(403, { error: { message: "Missing scopes: api.model.read" } }),
				/may not read the list/,
				/没有读取模型列表/,
			],
			["address", json(404, { error: "not found" }), /HTTP 404/, /HTTP 404/],
			["server", json(503, { error: "overloaded" }), /error of its own/, /出错/],
			[
				"response",
				() => new Response("<html>hello</html>", { status: 200 }),
				/not with a list of models/,
				/不是模型列表/,
			],
			["dns", failure("ENOTFOUND"), /Could not find api\.example\.test/, /找不到/],
			["connection", failure("ECONNREFUSED"), /Could not connect/, /连不上/],
			["tls", failure("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), /secure connection/, /安全连接/],
			["timeout", failure("UND_ERR_CONNECT_TIMEOUT"), /No answer from api\.example\.test within 10 s/, /10 秒内/],
		];
		for (const [kind, respond, english, chinese] of cases) {
			const result = await check(respond);
			expect(result.ok, kind).toBe(false);
			if (result.ok) continue;
			expect(result.problem.kind, JSON.stringify(result.problem)).toBe(kind);
			const en = explainProblem(result.problem, { service: "Example" }, "en");
			const zh = explainProblem(result.problem, { service: "Example" }, "zh");
			expect(en, kind).toMatch(english);
			expect(zh, kind).toMatch(chinese);
			for (const text of [en, zh, JSON.stringify(result.problem)]) expect(text).not.toContain(KEYS.hex32);
		}
		// Where the network stops, the proxy is named, or how to set one.
		const blocked: Problem = { kind: "timeout", url: "https://api.anthropic.com/v1/models" };
		expect(explainProblem(blocked, { service: "Anthropic" }, "en")).toContain("set HTTPS_PROXY");
		expect(explainProblem(blocked, { service: "Anthropic", proxy: "HTTPS_PROXY" }, "en")).toContain(
			"went through your proxy (HTTPS_PROXY)",
		);
		// Nothing listening on this machine is a service that is not running, not the network.
		const local: Problem = { kind: "connection", url: "http://127.0.0.1:8080/v1/models" };
		expect(explainProblem(local, { service: "box" }, "en")).toBe(
			"Nothing is listening at 127.0.0.1:8080: is the service running?",
		);
		expect(explainProblem({ kind: "key", url: "" }, { service: "OpenAI" }, "en")).toContain("an OpenAI key");
	});

	it("gives up after the time it was given", async () => {
		const result = await checkKey({
			kind: "openai-models",
			baseUrl: "https://api.example.test/v1",
			key: KEYS.hex32,
			timeoutMs: 30,
			fetch: ((_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
				)) as typeof fetch,
		});
		expect(result.ok === false && result.problem.kind).toBe("timeout");
		expect(classifyFailure(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("timeout");
		expect(classifyFailure(new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" })]))).toBe(
			"connection",
		);
	});

	it("never repeats a key, nor the masked tail some services echo", () => {
		expect(safeMessage("Your api key: ****cdef is invalid", KEYS.hex32)).toBe("Your api key: … is invalid");
		expect(safeMessage(`bad key ${KEYS.hex32}`, KEYS.hex32)).not.toContain(KEYS.hex32);
		expect(safeMessage(`other key ${KEYS.anthropic}`, undefined)).not.toContain(KEYS.anthropic);
		expect(classifyAnswer(401, "")).toBe("key");
	});
});

describe("the .env", () => {
	const samples = [
		'A=1\nB=\'two words\'\nexport C="x \\"y\\" $z"\n# comment\nD=plain # trailing\n',
		'MULTI="one\ntwo"\nAFTER=3\nBROKEN="never closed\nNEXT=4\n',
		"﻿BOM=1\r\nCRLF=2\r\n",
		"A=first\nA=second\n",
	];

	it("is read exactly as the launcher reads it", () => {
		for (const text of samples) {
			expect(readEnvEntries(text).map((entry) => [entry.name, entry.value])).toEqual(parseEnvFile(text).entries);
		}
		expect(envFileValue("A=first\nA=second\n", "A")).toBe("first");
	});

	it("changes one variable and keeps every other line, its export, its line endings", () => {
		expect(setEnvValue("", "TYPESAFE_API_KEY", "k1")).toBe("TYPESAFE_API_KEY=k1\n");
		expect(setEnvValue("A=1", "TYPESAFE_API_KEY", "k1")).toBe("A=1\nTYPESAFE_API_KEY=k1\n");
		expect(
			setEnvValue("# keys\nexport TYPESAFE_API_KEY=old\nB=2\nTYPESAFE_API_KEY=older\n", "TYPESAFE_API_KEY", "new"),
		).toBe("# keys\nexport TYPESAFE_API_KEY=new\nB=2\n");
		expect(setEnvValue('﻿A=1\r\nK="a\r\nb"\r\nC=3\r\n', "K", "v")).toBe("﻿A=1\r\nK=v\r\nC=3\r\n");
		// Whatever the value, the launcher reads back exactly it.
		for (const value of ["plain", "two words", "it's", `say "hi" $HOME \`x\` 'q'`]) {
			const text = setEnvValue("A=1\n", "K", value);
			expect(parseEnvFile(text).entries).toEqual([
				["A", "1"],
				["K", value],
			]);
		}
	});
});

describe("the files", () => {
	it("copies a file once per run, before its first change, into a folder of its own", () => {
		const home = temp();
		const file = join(home, "agent", "auth.json");
		mkdirSync(join(home, "agent"));
		writeFileSync(file, '{"deepseek":{}}');
		const now = new Date(2026, 8, 27, 15, 4, 5);
		expect(backupStamp(now)).toBe("2026-09-27T15-04-05");
		const first = new Backups(home, now);
		first.save(join(home, "agent", "missing.json"));
		expect(first.path).toBeUndefined();
		first.save(file);
		writeFileSync(file, '{"changed":true}');
		first.save(file);
		expect(first.path).toBe(join(home, "backups", "2026-09-27T15-04-05"));
		expect(readFileSync(join(first.path as string, "auth.json"), "utf8")).toBe('{"deepseek":{}}');
		// A second run in the same second gets its own folder.
		const second = new Backups(home, now);
		second.save(file);
		expect(second.path).toBe(join(home, "backups", "2026-09-27T15-04-05-2"));
		if (!windows) {
			expect(statSync(join(first.path as string, "auth.json")).mode & 0o777).toBe(0o600);
			expect(statSync(first.path as string).mode & 0o777).toBe(0o700);
		}
	});

	it("reads JSON it may rewrite, and leaves alone what it cannot read", () => {
		const dir = temp();
		expect(readJsonFile(join(dir, "none.json"))).toEqual({ state: "absent" });
		writeFileSync(join(dir, "empty.json"), " \n");
		expect(readJsonFile(join(dir, "empty.json"))).toEqual({ state: "ok", value: {} });
		writeFileSync(join(dir, "comments.json"), '{\n  // pi allows comments\n  "providers": {}\n}');
		expect(readJsonFile(join(dir, "comments.json"))).toEqual({ state: "unreadable" });
		writeFileSync(join(dir, "list.json"), "[]");
		expect(readJsonFile(join(dir, "list.json"))).toEqual({ state: "unreadable" });
	});

	it("writes a new file for its owner only, and keeps an existing file's mode", () => {
		const dir = temp();
		writeFileAtomic(join(dir, "new", "models.json"), "{}\n");
		expect(readFileSync(join(dir, "new", "models.json"), "utf8")).toBe("{}\n");
		writeFileSync(join(dir, "shared.json"), "{}");
		if (!windows) chmodSync(join(dir, "shared.json"), 0o644);
		writeFileAtomic(join(dir, "shared.json"), '{"a":1}\n');
		// Nothing is left behind of the write.
		expect(readdirSync(dir).sort()).toEqual(["new", "shared.json"]);
		if (!windows) {
			expect(statSync(join(dir, "new", "models.json")).mode & 0o777).toBe(0o600);
			expect(statSync(join(dir, "shared.json")).mode & 0o777).toBe(0o644);
		}
	});

	it("adds a provider to models.json and keeps everything else in it", () => {
		const before = {
			providers: {
				mine: { baseUrl: "http://127.0.0.1:8080/v1", api: "openai-completions", models: [{ id: "x" }] },
				qwen: { name: "Tongyi", headers: { "X-Trace": "1" }, models: [{ id: "qwen-plus", contextWindow: 1000 }] },
			},
			other: true,
		};
		const after = withProvider(before, "qwen", {
			name: "Qwen",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			api: "openai-completions",
			compat: { supportsStore: false },
			models: [{ id: "qwen3-max" }, { id: "qwen-plus" }],
		});
		expect(after).toEqual({
			providers: {
				mine: before.providers.mine,
				qwen: {
					name: "Tongyi",
					headers: { "X-Trace": "1" },
					baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
					api: "openai-completions",
					compat: { supportsStore: false },
					models: [{ id: "qwen-plus", contextWindow: 1000 }, { id: "qwen3-max" }],
				},
			},
			other: true,
		});
		// Ollama's placeholder key is set once, and never over a key already there.
		const ollama = withProvider({}, "ollama", {
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			apiKey: "ollama",
			models: [{ id: "qwen2.5-coder:7b" }],
		});
		expect(providerOf(ollama, "ollama")?.apiKey).toBe("ollama");
		const kept = withProvider({ providers: { ollama: { apiKey: "$OLLAMA_KEY" } } }, "ollama", {
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			apiKey: "ollama",
			models: [],
		});
		expect(providerOf(kept, "ollama")?.apiKey).toBe("$OLLAMA_KEY");
		expect(
			withModel({ providers: { deepseek: { baseUrl: "https://relay.test" } } }, "deepseek", "deepseek-v9"),
		).toEqual({
			providers: { deepseek: { baseUrl: "https://relay.test", models: [{ id: "deepseek-v9" }] } },
		});
	});

	it("writes the judge into mu.json, or into kyrn.json on a machine that has only that one", () => {
		const has = (names: string[]) => (path: string) => names.some((name) => path.endsWith(name));
		expect(judgeConfigPath("/a", has([]))).toBe(join("/a", "mu.json"));
		expect(judgeConfigPath("/a", has(["kyrn.json"]))).toBe(join("/a", "kyrn.json"));
		expect(judgeConfigPath("/a", has(["kyrn.json", "mu.json"]))).toBe(join("/a", "mu.json"));
	});
});

/** A provider's entry in a models.json. */
function providerOf(models: Record<string, unknown> | undefined, id: string): Record<string, unknown> | undefined {
	return (models?.providers as Record<string, Record<string, unknown>> | undefined)?.[id];
}

describe("the language", () => {
	it("is Chinese when the locale is, English otherwise", () => {
		expect(setupLanguage({ LANG: "zh_CN.UTF-8" }, "en-US")).toBe("zh");
		expect(setupLanguage({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }, "zh-CN")).toBe("en");
		expect(setupLanguage({ LC_ALL: "C", LANG: "zh_TW.UTF-8" }, undefined)).toBe("zh");
		expect(setupLanguage({ MU_LANG: "en", LANG: "zh_CN.UTF-8" }, undefined)).toBe("en");
		expect(setupLanguage({}, "zh-Hans-CN")).toBe("zh");
		expect(setupLanguage({}, undefined)).toBe("en");
		expect(["DeepSeek", "OpenAI", "xAI", "GLM", "Ollama"].map(article)).toEqual([
			"a DeepSeek",
			"an OpenAI",
			"an xAI",
			"a GLM",
			"an Ollama",
		]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// The wizard, run whole
// ---------------------------------------------------------------------------------------------------------------

/** pi as the wizard sees it, with a catalogue of the providers the table names. */
class FakePi implements PiAccess {
	catalog: Record<string, { baseUrl: string; models: string[] }> = {
		deepseek: { baseUrl: "https://api.deepseek.com", models: ["deepseek-v4-pro", "deepseek-chat"] },
		"moonshotai-cn": { baseUrl: "https://api.moonshot.cn/v1", models: ["kimi-k2.6"] },
		moonshotai: { baseUrl: "https://api.moonshot.ai/v1", models: ["kimi-k2.6"] },
		"zai-coding-cn": { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", models: ["glm-5.3"] },
		openrouter: { baseUrl: "https://openrouter.ai/api/v1", models: ["moonshotai/kimi-k2.6"] },
		opencode: { baseUrl: "https://opencode.ai/zen/v1", models: ["kimi-k2.6", "claude-opus-4-8"] },
		openai: { baseUrl: "https://api.openai.com/v1", models: ["gpt-5.5"] },
		anthropic: { baseUrl: "https://api.anthropic.com", models: ["claude-opus-4-8"] },
		google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: ["gemini-3.1-pro-preview"] },
		xai: { baseUrl: "https://api.x.ai/v1", models: ["grok-4.7"] },
	};
	credentials: Record<string, "api_key" | "oauth"> = {};
	stored: { provider: string; key: string }[] = [];
	defaults: { provider: string; model: string }[] = [];
	providerExists(provider: string): boolean {
		return provider in this.catalog;
	}
	models(provider: string): readonly string[] {
		return this.catalog[provider]?.models ?? [];
	}
	baseUrl(provider: string, _api: SetupApi): string | undefined {
		return this.catalog[provider]?.baseUrl;
	}
	async credential(provider: string): Promise<"api_key" | "oauth" | undefined> {
		return this.credentials[provider];
	}
	async storeKey(provider: string, key: string): Promise<void> {
		this.stored.push({ provider, key });
	}
	async setDefaultModel(provider: string, model: string): Promise<void> {
		this.defaults.push({ provider, model });
	}
}

interface Run {
	argv?: string[];
	/** Answers to the questions, in order; running out is ctrl+d. */
	answers?: string[];
	/** What is pasted where a key is asked for. */
	secrets?: string[];
	interactive?: boolean;
	stdin?: string;
	stdinTerminal?: boolean;
	env?: Record<string, string>;
	givenKey?: string;
	language?: "zh" | "en";
	pi?: PiAccess;
	home?: string;
	/** The fake network: an answer per request. */
	respond?: (url: string, headers: Readonly<Record<string, string>>) => Response | Error;
}

/** What happened, in order: said, warned, asked (a question or a key), or sent (a request). */
interface Event {
	readonly kind: "say" | "warn" | "ask" | "secret" | "fetch";
	readonly text: string;
}

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const listing = (...models: string[]) => answer(200, { object: "list", data: models.map((id) => ({ id })) });
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

async function wizard(run: Run) {
	const home = run.home ?? temp();
	const paths = { agentDir: join(home, "agent"), home, envFile: join(home, ".env") };
	const events: Event[] = [];
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const answers = [...(run.answers ?? [])];
	const secrets = [...(run.secrets ?? [])];
	const io: Prompter = {
		say: (text) => events.push({ kind: "say", text }),
		warn: (text) => events.push({ kind: "warn", text }),
		ask: async (text) => {
			events.push({ kind: "ask", text });
			return answers.shift();
		},
		secret: async (text) => {
			events.push({ kind: "secret", text });
			return secrets.shift();
		},
	};
	const pi = run.pi ?? new FakePi();
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = { ...(init?.headers as Record<string, string>) };
		events.push({ kind: "fetch", text: url });
		calls.push({ url, headers });
		const result = (run.respond ?? (() => new Error("no network in this test")))(url, headers);
		if (result instanceof Error) throw result;
		return result;
	}) as typeof globalThis.fetch;
	const code = await runSetup(run.argv ?? [], {
		io,
		language: run.language ?? "en",
		env: { HOME: home, ...run.env },
		paths,
		pi,
		fetch,
		now: () => new Date(2026, 8, 27, 12, 0, 0),
		interactive: run.interactive ?? true,
		stdinTerminal: run.stdinTerminal ?? false,
		readStdin: async () => run.stdin ?? "",
		givenKey: run.givenKey,
		timeoutMs: 1000,
	});
	const said = events.filter((event) => event.kind === "say").map((event) => event.text);
	const warned = events.filter((event) => event.kind === "warn").map((event) => event.text);
	// Whatever happened, no key was printed, nor put into an address.
	const printed = [...said, ...warned].join("\n");
	const keys = [...(run.secrets ?? []), ...(run.stdin ?? "").split("\n"), run.givenKey ?? ""];
	for (const key of keys.filter((key) => key.length > 8)) {
		expect(printed).not.toContain(key);
		for (const call of calls) expect(call.url).not.toContain(key);
	}
	const read = (name: string) => {
		const path = name === ".env" ? paths.envFile : join(paths.agentDir, name);
		return existsSync(path) ? readFileSync(path, "utf8") : undefined;
	};
	const json = (name: string) => {
		const text = read(name);
		return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
	};
	/** Where the first event with this text is, -1 when there is none. */
	const at = (kind: Event["kind"], text: string) =>
		events.findIndex((event) => event.kind === kind && event.text.includes(text));
	return { code, events, said, warned, printed, calls, home, paths, pi, read, json, at };
}

describe("mu setup, asking in a terminal", () => {
	it("asks whose key it is when two vendors share its shape, and sends it to that one only", async () => {
		const run = await wizard({
			// Paste a key; it is Qwen's; no judge for now; no session now.
			answers: ["1", "2", "4", "n"],
			secrets: [KEYS.hex32],
			respond: (url) =>
				url.startsWith("https://dashscope.aliyuncs.com/")
					? listing("qwen-turbo", "qwen3-max", "qwen3-coder-plus", "text-embedding-v4")
					: new Error(`unexpected ${url}`),
		});
		expect(run.code).toBe(SETUP_EXIT.done);
		// The question, and its answer, came before any request.
		const question = run.at("say", "Keys of DeepSeek and Qwen look the same. Which service is this key for?");
		expect(question).toBeGreaterThan(-1);
		expect(run.at("fetch", "")).toBeGreaterThan(run.at("ask", "Choose 1-2"));
		expect(run.at("ask", "Choose 1-2")).toBeGreaterThan(question);
		expect(run.calls.map((call) => call.url)).toEqual(["https://dashscope.aliyuncs.com/compatible-mode/v1/models"]);
		expect(run.calls[0].headers.authorization).toBe(`Bearer ${KEYS.hex32}`);
		expect(run.said).toContain("Model to start with: qwen3-coder-plus");
		expect(providerOf(run.json("models.json"), "qwen")).toEqual({
			name: "Qwen",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			api: "openai-completions",
			compat: { supportsDeveloperRole: false, supportsStore: false },
			// What the service lists goes into /model, the one to start with first; an embedding model does not.
			models: [{ id: "qwen3-coder-plus" }, { id: "qwen-turbo" }, { id: "qwen3-max" }],
		});
		// The key itself is pi's to keep: never in models.json.
		expect(run.read("models.json")).not.toContain(KEYS.hex32);
		const pi = run.pi as FakePi;
		expect(pi.stored).toEqual([{ provider: "qwen", key: KEYS.hex32 }]);
		expect(pi.defaults).toEqual([{ provider: "qwen", model: "qwen3-coder-plus" }]);
		// No judge: neither mu.json nor the .env was touched.
		expect(run.read("mu.json")).toBeUndefined();
		expect(run.read(".env")).toBeUndefined();
		expect(run.said).toContain("Done. mu starts on Qwen · qwen3-coder-plus. Judge: none for now.");
	});

	it("tries a Kimi key at .cn, then at .ai, and at no other vendor", async () => {
		const run = await wizard({
			answers: ["1", "3", "n"],
			secrets: [KEYS.kimi],
			respond: (url) => {
				if (url === "https://api.moonshot.cn/v1/models") {
					return answer(401, { error: { message: "Invalid Authentication" } });
				}
				if (url === "https://api.moonshot.ai/v1/models") return listing("kimi-k2.6", "moonshot-v1-8k");
				return new Error(`unexpected ${url}`);
			},
		});
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.said).toContain("This is a Kimi key.");
		expect(run.calls.map((call) => call.url)).toEqual([
			"https://api.moonshot.cn/v1/models",
			"https://api.moonshot.ai/v1/models",
		]);
		// The address that took the key is the one kept: pi's provider there.
		expect((run.pi as FakePi).stored).toEqual([{ provider: "moonshotai", key: KEYS.kimi }]);
		expect((run.pi as FakePi).defaults).toEqual([{ provider: "moonshotai", model: "kimi-k2.6" }]);
		// pi's own provider and a model pi knows: models.json is not needed.
		expect(run.read("models.json")).toBeUndefined();
	});

	it("says what went wrong, takes another key, and starts mu when asked to", async () => {
		const good = `sk-${"fedcba9876543210".repeat(2)}`;
		const run = await wizard({
			// Paste; DeepSeek; (401) paste another; judge: the model; start mu now.
			answers: ["1", "1", "1", "3", "y"],
			secrets: [KEYS.hex32, good],
			respond: (_url, headers) =>
				headers.authorization === `Bearer ${good}`
					? listing("deepseek-chat", "deepseek-reasoner")
					: answer(401, { error: { message: "Authentication Fails, Your api key: ****cdef is invalid" } }),
		});
		expect(run.calls).toHaveLength(2);
		expect(run.said).toContain(
			"DeepSeek does not accept this key. Check that you copied all of it, and that it is a DeepSeek key.",
		);
		// A key that is refused cannot be saved unchecked.
		expect(run.printed).not.toContain("Save it without the check");
		expect(run.said).toContain("Model to start with: deepseek-chat");
		expect((run.pi as FakePi).stored).toEqual([{ provider: "deepseek", key: good }]);
		expect(run.json("mu.json")).toEqual({ tiers: ["llm:deepseek/deepseek-chat"] });
		expect(run.code).toBe(SETUP_EXIT.start);
	});

	it("keeps the Jev key where the launcher reads it, and copies what it changes first", async () => {
		const home = temp();
		mkdirSync(join(home, "agent"));
		writeFileSync(join(home, ".env"), "# mine\nOTHER=1\n");
		const mode = statSync(join(home, ".env")).mode & 0o777;
		writeFileSync(join(home, "agent", "mu.json"), JSON.stringify({ tiers: ["laya"], modes: { default: "active" } }));
		const run = await wizard({
			home,
			// The second "2": Jev with a key of one's own (the free Jev is offered first while no key is set).
			answers: ["1", "2", "n"],
			secrets: [KEYS.anthropic, KEYS.jev],
			respond: () => answer(200, { data: [{ id: "claude-opus-4-8" }, { id: "claude-sonnet-5" }] }),
		});
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.said).toContain("This is an Anthropic key.");
		expect(run.read(".env")).toBe(`# mine\nOTHER=1\nTYPESAFE_API_KEY=${KEYS.jev}\n`);
		expect(statSync(join(home, ".env")).mode & 0o777).toBe(mode);
		expect(run.json("mu.json")).toEqual({ tiers: ["jev"], modes: { default: "active" } });
		const backup = join(home, "backups", "2026-09-27T12-00-00");
		expect(readFileSync(join(backup, ".env"), "utf8")).toBe("# mine\nOTHER=1\n");
		expect(JSON.parse(readFileSync(join(backup, "mu.json"), "utf8")).tiers).toEqual(["laya"]);
		expect(run.printed).toContain(
			`The files as they were are copied to ${join("~", "backups", "2026-09-27T12-00-00")}`,
		);
		expect(run.said).toContain("Done. mu starts on Anthropic · claude-opus-4-8. Judge: Jev.");
	});

	it("does not take the model's key, nor another vendor's without a yes, as the Jev key", async () => {
		const run = await wizard({
			answers: ["1", "2", "n", "n"],
			secrets: [KEYS.anthropic, KEYS.anthropic, KEYS.openaiProject, KEYS.jev],
			respond: () => answer(200, { data: [{ id: "claude-opus-4-8" }] }),
		});
		expect(run.printed).toContain("That is the key you gave for the model.");
		expect(run.at("ask", "This looks like an OpenAI key, not a Jev key")).toBeGreaterThan(-1);
		expect(run.read(".env")).toBe(`TYPESAFE_API_KEY=${KEYS.jev}\n`);
		if (!windows) expect(statSync(run.paths.envFile).mode & 0o777).toBe(0o600);
	});

	it("points a subscription to /login inside mu, and still offers the judge", async () => {
		// Subscription; judge: not now (Jev, free Jev or nothing: there is no model to judge with); no session.
		const run = await wizard({ answers: ["3", "3", "n"] });
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.printed).toContain("start mu, type /login");
		expect(run.said).toContain("Start mu and type /login to sign in.");
		expect(run.calls).toEqual([]);
		expect(run.read("auth.json")).toBeUndefined();
	});

	it("asks which service a key of another shape is for, before sending it anywhere", async () => {
		const run = await wizard({
			// From the list: DeepSeek; the pasted key looks like Anthropic's: it is Anthropic's.
			answers: ["2", "1", "2", "4", "n"],
			secrets: [KEYS.anthropic],
			respond: (url) => (url.startsWith("https://api.anthropic.com/") ? answer(200, { data: [] }) : new Error(url)),
		});
		expect(run.printed).toContain("Keys are made at https://platform.deepseek.com/api_keys");
		expect(run.printed).toContain("This key looks like an Anthropic key, not a DeepSeek one.");
		expect(run.calls.map((call) => new URL(call.url).host)).toEqual(["api.anthropic.com"]);
		// Anthropic listed nothing: it starts on the model it names.
		expect(run.said).toContain("It works: 0 models listed.");
		expect(run.said).toContain("Model to start with: claude-opus-4-8");
	});

	it("sets up Ollama without a key, and says when it is not ready", async () => {
		const down = await wizard({ answers: ["2", "14", "3"], respond: refused });
		expect(down.said).toContain("Ollama is not ready yet (start it with `ollama serve`, pull a model).");
		expect(down.code).toBe(SETUP_EXIT.cancelled);
		expect(down.events.some((event) => event.kind === "secret")).toBe(false);
		expect(down.printed).not.toContain("Paste another key");
		const empty = await wizard({ answers: ["2", "14", "3"], respond: () => listing() });
		expect(empty.said).toContain("Ollama is not ready yet (start it with `ollama serve`, pull a model).");
		const up = await wizard({
			// From the list: Ollama; its first chat model; no judge; no session.
			answers: ["2", "14", "", "4", "n"],
			respond: () => listing("nomic-embed-text:latest", "qwen2.5-coder:7b"),
		});
		expect(up.code).toBe(SETUP_EXIT.done);
		// Nothing the table names: the person picks, a model a coding agent can talk to first.
		expect(up.said).toContain("  1) qwen2.5-coder:7b");
		expect(up.printed).not.toContain("nomic-embed-text");
		expect(providerOf(up.json("models.json"), "ollama")).toEqual({
			name: "Ollama",
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			apiKey: "ollama",
			models: [{ id: "qwen2.5-coder:7b" }],
		});
		expect(up.calls[0].headers.authorization).toBeUndefined();
		expect((up.pi as FakePi).stored).toEqual([]);
	});

	it("takes an address of one's own, asks its key after it, finds its /v1, and names it", async () => {
		const run = await wizard({
			// From the list: other; its address; OpenAI-compatible; its name; (no key); its model; no judge; no session.
			answers: ["2", "15", "http://127.0.0.1:8080", "1", "box", "", "4", "n"],
			secrets: [""],
			respond: (url) => (url === "http://127.0.0.1:8080/v1/models" ? listing("local-coder") : answer(404, "no")),
		});
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.at("secret", "Paste its API key, or press Enter")).toBeGreaterThan(run.at("ask", "base URL"));
		expect(run.calls.map((call) => call.url)).toEqual([
			"http://127.0.0.1:8080/models",
			"http://127.0.0.1:8080/v1/models",
		]);
		expect(run.said).toContain("Checking box (127.0.0.1:8080)...");
		expect(providerOf(run.json("models.json"), "box")).toEqual({
			baseUrl: "http://127.0.0.1:8080/v1",
			api: "openai-completions",
			apiKey: "none",
			models: [{ id: "local-coder" }],
		});
		expect(run.said).toContain("Done. mu starts on box · local-coder. Judge: none for now.");
	});

	it("takes a number past the list as a slip, and a typed name as a model", async () => {
		const run = await wizard({
			answers: ["2", "14", "7", "my-model", "4", "n"],
			respond: () => listing("a-coder", "b-coder"),
		});
		expect(run.said).toContain("Type a number from 1-2, or a model name.");
		expect((run.pi as FakePi).defaults).toEqual([{ provider: "ollama", model: "my-model" }]);
	});

	it("asks once on a first start, and remembers a no", async () => {
		const no = await wizard({ argv: ["--first-run"], answers: ["n"] });
		expect(no.code).toBe(SETUP_EXIT.done);
		expect(existsSync(join(no.paths.agentDir, SETUP_DECLINED_FILE))).toBe(true);
		expect(no.printed).toContain("mu will not ask again");
		const yes = await wizard({
			argv: ["--first-run"],
			answers: ["", "1", "4"],
			secrets: [KEYS.xai],
			respond: () => listing("grok-4.7", "grok-3"),
		});
		// On a first start the launcher goes on into the session: nothing more is asked.
		expect(yes.code).toBe(SETUP_EXIT.done);
		expect(yes.said).toContain("This is an xAI key.");
		expect(yes.at("ask", "Start mu now?")).toBe(-1);
		expect((yes.pi as FakePi).defaults).toEqual([{ provider: "xai", model: "grok-4.7" }]);
		expect(existsSync(join(yes.paths.agentDir, SETUP_DECLINED_FILE))).toBe(false);
	});

	it("stops at ctrl+d, and nothing is changed", async () => {
		const run = await wizard({ answers: ["1"], secrets: [] });
		expect(run.code).toBe(SETUP_EXIT.cancelled);
		expect(run.said).toContain("Stopped. Nothing was changed.");
		expect(existsSync(run.paths.agentDir)).toBe(false);
	});

	it("speaks Chinese", async () => {
		const run = await wizard({
			language: "zh",
			answers: ["1", "1", "4", "n"],
			secrets: [KEYS.hex32],
			respond: () => listing("deepseek-v4-pro"),
		});
		expect(run.printed).toContain("DeepSeek 和 Qwen 的密钥长得一样。这个密钥是哪家的？");
		expect(run.said).toContain("正在用 DeepSeek（api.deepseek.com）检查密钥……");
		expect(run.said).toContain("完成。mu 会用 DeepSeek · deepseek-v4-pro 开始工作。判定器：暂时没有。");
	});
});

describe("mu setup in a script", () => {
	const stdinRun = (argv: string[], stdin: string, rest: Partial<Run> = {}) =>
		wizard({ argv: ["--key-stdin", ...argv], stdin, interactive: false, ...rest });

	it("refuses a key whose shape two vendors share, and sends it nowhere", async () => {
		const run = await stdinRun([], `${KEYS.hex32}\n`);
		expect(run.code).toBe(SETUP_EXIT.usage);
		expect(run.warned.join("\n")).toContain(
			"keys of DeepSeek and Qwen look the same. Say which with --service deepseek or qwen",
		);
		expect(run.calls).toEqual([]);
	});

	it("sets up a named service, the judge from the second line, and asks nothing", async () => {
		const home = temp();
		writeFileSync(join(home, ".env"), "OTHER=1\n");
		const run = await stdinRun(["--service", "deepseek", "--judge", "jev"], `${KEYS.hex32}\n${KEYS.jev}\n`, {
			home,
			respond: () => listing("deepseek-v4-pro", "deepseek-chat"),
		});
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.events.filter((event) => event.kind === "ask" || event.kind === "secret")).toEqual([]);
		expect((run.pi as FakePi).stored).toEqual([{ provider: "deepseek", key: KEYS.hex32 }]);
		expect(run.read(".env")).toBe(`OTHER=1\nTYPESAFE_API_KEY=${KEYS.jev}\n`);
		expect(readFileSync(join(home, "backups", "2026-09-27T12-00-00", ".env"), "utf8")).toBe("OTHER=1\n");
		// Jev is the judge already when mu.json names none.
		expect(run.read("mu.json")).toBeUndefined();
	});

	it("makes the model the judge with --judge model", async () => {
		const run = await stdinRun(["--service", "deepseek", "--judge", "model"], `${KEYS.hex32}\n`, {
			respond: () => listing("deepseek-v4-pro"),
		});
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.json("mu.json")).toEqual({ tiers: ["llm:deepseek/deepseek-v4-pro"] });
	});

	it("fails with the reason when the check fails, and changes nothing", async () => {
		const run = await stdinRun(["--service", "openai"], `${KEYS.openaiProject}\n`, {
			respond: () =>
				answer(429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } }),
		});
		expect(run.code).toBe(SETUP_EXIT.failed);
		expect(run.warned.join("\n")).toContain("The OpenAI account has no balance or quota left.");
		expect(existsSync(run.paths.agentDir)).toBe(false);
		expect(existsSync(join(run.home, "backups"))).toBe(false);
	});

	it("never reads a key typed at a terminal as if from a pipe", async () => {
		const run = await stdinRun(["--service", "deepseek"], "", { stdinTerminal: true });
		expect(run.code).toBe(SETUP_EXIT.usage);
		expect(run.warned.join("\n")).toContain("--key-stdin reads the key from a pipe");
	});

	it("leaves a subscription sign-in alone without --yes, and replaces it with one", async () => {
		const pi = new FakePi();
		pi.credentials.anthropic = "oauth";
		const run = await stdinRun(["--service", "anthropic"], `${KEYS.anthropic}\n`, { pi });
		expect(run.code).toBe(SETUP_EXIT.failed);
		expect(run.warned.join("\n")).toContain(
			"Anthropic is signed in with a subscription. To store a key instead, add --yes",
		);
		expect(run.calls).toEqual([]);
		const yes = await stdinRun(["--service", "anthropic", "--yes"], `${KEYS.anthropic}\n`, {
			pi,
			respond: () => answer(200, { data: [{ id: "claude-opus-4-8" }] }),
		});
		expect(yes.code).toBe(SETUP_EXIT.done);
		expect(pi.stored).toEqual([{ provider: "anthropic", key: KEYS.anthropic }]);
	});

	it("never rewrites a models.json it cannot read, and says so before sending anything", async () => {
		const home = temp();
		mkdirSync(join(home, "agent"));
		writeFileSync(join(home, "agent", "models.json"), '{ // mine\n "providers": {} }');
		const run = await stdinRun(["--service", "siliconflow"], `${KEYS.siliconflow}\n`, { home });
		expect(run.code).toBe(SETUP_EXIT.failed);
		expect(run.warned.join("\n")).toContain("is not plain JSON");
		expect(run.calls).toEqual([]);
		expect(readFileSync(join(home, "agent", "models.json"), "utf8")).toBe('{ // mine\n "providers": {} }');
	});

	it("sends a key to the relay it is given, whatever its shape, and points pi's provider there", async () => {
		const run = await stdinRun(
			["--service", "anthropic", "--base-url", "https://relay.example.test/"],
			`${KEYS.kimi}\n`,
			{ respond: () => answer(200, { data: [{ id: "claude-opus-4-8" }] }) },
		);
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.warned).toEqual([]);
		expect(run.calls).toEqual([
			{
				url: "https://relay.example.test/v1/models?limit=1000",
				headers: { accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": KEYS.kimi },
			},
		]);
		expect(run.json("models.json")).toEqual({ providers: { anthropic: { baseUrl: "https://relay.example.test" } } });
	});

	it("uses the model it is told to, and adds it to pi's provider when pi does not know it", async () => {
		const run = await stdinRun(["--service", "deepseek", "--model", "deepseek-v9"], `${KEYS.hex32}\n`, {
			respond: () => listing("deepseek-chat"),
		});
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.said).toContain("Note: DeepSeek does not list deepseek-v9; it is used anyway.");
		expect(run.json("models.json")).toEqual({ providers: { deepseek: { models: [{ id: "deepseek-v9" }] } } });
		expect((run.pi as FakePi).defaults).toEqual([{ provider: "deepseek", model: "deepseek-v9" }]);
	});

	it("takes a key given on the command line from the launcher, which keeps it out of argv", async () => {
		const run = await wizard({
			givenKey: KEYS.google,
			interactive: false,
			respond: () => answer(200, { models: [] }),
		});
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.calls[0]).toEqual({
			url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
			headers: { accept: "application/json", "x-goog-api-key": KEYS.google },
		});
		expect((run.pi as FakePi).defaults).toEqual([{ provider: "google", model: "gemini-3.1-pro-preview" }]);
	});

	it("checks an OpenCode key with free Jev, whose answer a wrong key does not get, and makes Jev there the judge", async () => {
		const good = "sk-opencode-good-key-0123456789";
		const respond = (url: string, headers: Readonly<Record<string, string>>) =>
			url === "https://opencode.ai/zen/v1/systemone"
				? headers.authorization === `Bearer ${good}`
					? answer(200, { answers: { check: { type: "noul", noul: 0.9 } } })
					: answer(401, { type: "error", error: { type: "AuthError", message: "Invalid API key." } })
				: url === "https://opencode.ai/zen/v1/models"
					? listing("kimi-k2.6", "claude-opus-4-8")
					: new Error(url);
		const wrong = await stdinRun(["--service", "opencode"], "sk-opencode-wrong-key-0123456789\n", { respond });
		expect(wrong.code).toBe(SETUP_EXIT.failed);
		expect(wrong.calls.map((call) => call.url)).toEqual(["https://opencode.ai/zen/v1/systemone"]);

		const run = await stdinRun(["--service", "opencode", "--judge", "opencode"], `${good}\n`, { respond });
		expect(run.code).toBe(SETUP_EXIT.done);
		expect((run.pi as FakePi).stored).toEqual([{ provider: "opencode", key: good }]);
		expect((run.pi as FakePi).defaults).toEqual([{ provider: "opencode", model: "kimi-k2.6" }]);
		expect(run.json("mu.json")).toEqual({ tiers: ["jev-opencode"] });
		expect(run.said).toContain("Done. mu starts on OpenCode Zen · kimi-k2.6. Judge: Jev on OpenCode Zen.");

		// In a terminal, Jev on OpenCode Zen comes first once there is an OpenCode key.
		const asked = await wizard({ answers: ["2", "9", "", "", "n"], secrets: [good], respond });
		expect(asked.printed).toContain("1) Jev (recommended) on OpenCode Zen, with your OpenCode key, billed per call");
		expect(asked.json("mu.json")).toEqual({ tiers: ["jev-opencode"] });
	});

	it("makes free Jev on OpenCode Zen the judge with no key, and wants a key for the paid one", async () => {
		const free = await stdinRun(["--service", "deepseek", "--judge", "free"], `${KEYS.hex32}\n`, {
			respond: () => listing("deepseek-v4-pro"),
		});
		expect(free.code).toBe(SETUP_EXIT.done);
		// `jev`, the default, answers with the free Jev while no key is set, and with a key once one is: nothing to write.
		expect(free.read("mu.json")).toBeUndefined();
		expect(free.read(".env")).toBeUndefined();
		expect(free.said.join("\n")).toContain(
			"Judge: Jev, free on OpenCode Zen for a limited time until you add a key.",
		);

		const paid = await stdinRun(["--service", "deepseek", "--judge", "opencode"], `${KEYS.hex32}\n`, {
			respond: () => listing("deepseek-v4-pro"),
		});
		expect(paid.code).toBe(SETUP_EXIT.usage);
		expect(paid.warned.join("\n")).toContain("--judge opencode needs an OpenCode key");
		const keyed = await stdinRun(["--service", "deepseek", "--judge", "opencode"], `${KEYS.hex32}\n`, {
			env: { OPENCODE_API_KEY: "o" },
			respond: () => listing("deepseek-v4-pro"),
		});
		expect(keyed.json("mu.json")).toEqual({ tiers: ["jev-opencode"] });
	});

	it("checks an OpenRouter key where only a working key is answered", async () => {
		const run = await stdinRun([], `${KEYS.openrouter}\n`, {
			respond: (url) =>
				url === "https://openrouter.ai/api/v1/key" ? answer(200, { data: { label: "x" } }) : new Error(url),
		});
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.said).toContain("The key works.");
		expect((run.pi as FakePi).defaults).toEqual([{ provider: "openrouter", model: "moonshotai/kimi-k2.6" }]);
	});

	it("needs a terminal for its questions", async () => {
		const run = await wizard({ interactive: false });
		expect(run.code).toBe(SETUP_EXIT.usage);
		expect(run.warned.join("\n")).toContain("mu setup --service <id> --key-stdin");
	});
});

describe("mu setup's words", () => {
	it("explains why a script gives the key on stdin", () => {
		expect(setupUsage("en")).toContain("a key on the command line stays in your shell's history");
		expect(setupUsage("zh")).toContain("写在命令行上的密钥会留在 shell 的历史记录里");
		expect(parseSetupArgs(["a", "b"])).toEqual({ error: { zh: "只能给一个密钥", en: "give one key at most" } });
		expect(parseSetupArgs(["--service", "nope"])).toMatchObject({ error: { en: expect.stringContaining("nope") } });
		expect(parseSetupArgs(["--service=kimi", "--judge", "model", "-y"])).toMatchObject({
			service: "kimi",
			judge: "model",
			yes: true,
		});
	});

	it("prints its help and its services without asking anything", async () => {
		const help = await wizard({ argv: ["--help"], interactive: false });
		expect(help.code).toBe(SETUP_EXIT.done);
		expect(help.printed).toContain("--key-stdin");
		const list = await wizard({ argv: ["--list"], interactive: false });
		expect(list.printed).toContain("  glm-coding   GLM Coding Plan");
		expect(list.printed).toContain("  other        Another OpenAI- or Anthropic-compatible service");
		const wrong = await wizard({ argv: ["--nope"], interactive: false });
		expect(wrong.code).toBe(SETUP_EXIT.usage);
		expect(wrong.warned[0]).toBe("mu setup: unknown option --nope");
	});

	it("names a provider of one's own after its address", () => {
		expect(providerIdFor("https://api.example.com/v1")).toBe("example");
		expect(providerIdFor("http://localhost:1234/v1")).toBe("local-1234");
		expect(providerIdFor("http://127.0.0.1:8080")).toBe("local-8080");
		expect(providerIdFor("https://llm.corp.example.org")).toBe("example");
	});

	it("knows where a Jev key is set already", () => {
		expect(jevKeyAt({ TYPESAFE_API_KEY: "a" }, undefined)).toEqual({ name: "TYPESAFE_API_KEY", where: "env" });
		expect(jevKeyAt({}, "TYPESAFE_API_KEY=b\n")).toEqual({ name: "TYPESAFE_API_KEY", where: "file" });
		// An empty variable in the environment switches the file's key off, as the launcher does.
		expect(jevKeyAt({ TYPESAFE_API_KEY: "" }, "TYPESAFE_API_KEY=b\n")).toBeUndefined();
		expect(jevKeyAt({}, "AI_GATEWAY_API_KEY=c\n")).toEqual({ name: "AI_GATEWAY_API_KEY", where: "file" });
	});
});

describe("mu setup with pi's own files", () => {
	async function realPi(home: string) {
		const agentDir = join(home, "agent");
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			modelsStorePath: join(agentDir, "models-store.json"),
			refreshOnCreate: false,
		});
		return { runtime, pi: piAccess(runtime, agentDir) };
	}

	it("stores a key the way /login does, and the default model beside every other setting", async () => {
		const home = temp();
		mkdirSync(join(home, "agent"));
		writeFileSync(
			join(home, "agent", "settings.json"),
			JSON.stringify({ theme: "dark", defaultThinkingLevel: "high" }),
		);
		const { runtime, pi } = await realPi(home);
		const run = await wizard({
			home,
			pi,
			argv: ["--service", "deepseek", "--key-stdin"],
			stdin: `${KEYS.hex32}\n`,
			interactive: false,
			respond: () => listing("deepseek-v4-pro", "deepseek-chat"),
		});
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.json("auth.json")).toEqual({ deepseek: { type: "api_key", key: KEYS.hex32 } });
		if (!windows) expect(statSync(join(home, "agent", "auth.json")).mode & 0o777).toBe(0o600);
		expect(run.json("settings.json")).toEqual({
			theme: "dark",
			defaultThinkingLevel: "high",
			defaultProvider: "deepseek",
			defaultModel: "deepseek-v4-pro",
		});
		expect(await pi.credential("deepseek")).toBe("api_key");
		expect(runtime.getModels("deepseek").some((model) => model.id === "deepseek-v4-pro")).toBe(true);
	});

	it("gives a provider of mu's its key in auth.json, where pi finds it", async () => {
		const home = temp();
		const { pi } = await realPi(home);
		const run = await wizard({
			home,
			pi,
			argv: ["--service", "stepfun", "--key-stdin"],
			stdin: "made-up-stepfun-key-0001\n",
			interactive: false,
			respond: () => listing("step-1-8k", "step-2-16k"),
		});
		expect(run.code).toBe(SETUP_EXIT.done);
		expect(run.json("auth.json")).toEqual({ stepfun: { type: "api_key", key: "made-up-stepfun-key-0001" } });
		expect(run.read("models.json")).not.toContain("made-up-stepfun-key-0001");
		// A new process of pi reads what was written: the provider, its models, and a usable key for them.
		const after = await realPi(home);
		await after.runtime.refresh({ allowNetwork: false });
		const available = await after.runtime.getAvailable("stepfun");
		expect(available.map((model) => model.id)).toEqual(["step-2-16k", "step-1-8k"]);
	});

	it("leaves a settings.json pi cannot read as it is", async () => {
		const home = temp();
		mkdirSync(join(home, "agent"));
		writeFileSync(join(home, "agent", "settings.json"), "{ not json");
		const { pi } = await realPi(home);
		await expect(pi.setDefaultModel("deepseek", "deepseek-chat")).rejects.toThrow("settings.json cannot be read");
		expect(readFileSync(join(home, "agent", "settings.json"), "utf8")).toBe("{ not json");
	});
});
