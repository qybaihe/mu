import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_TIMEOUT_MS, checkKey, explainProblem, type Problem } from "./check.ts";
import { envFileValue } from "./env-file.ts";
import {
	Backups,
	existingProvider,
	judgeConfigPath,
	readJsonFile,
	readTextFile,
	type SetupPaths,
	tiersOf,
	withModel,
	withProvider,
	withTiers,
	writeEnvValue,
	writeJsonFile,
} from "./files.ts";
import type { SetupLanguage, Text } from "./language.ts";
import {
	chatModels,
	checkKindOf,
	cleanKey,
	namedModel,
	SETUP_SERVICES,
	type SetupApi,
	type SetupService,
	serviceById,
	servicesForKey,
	tableModel,
} from "./services.ts";

/**
 * `mu setup`, the first thing a newcomer runs: which service a key belongs to, one request that shows the key works,
 * the model to start with, the judge, and then the files, each copied before it changes. pi's own files go through pi
 * (PiAccess: auth.json, settings.json); models.json, mu.json and the .env are written here. main.ts connects this to the
 * terminal and to pi; everything comes in as a parameter, so that the tests can run it whole.
 */

/** The marker a "no" to the first-start question leaves in the agent folder; kyrn/bin/mu.mjs looks for the same name. */
export const SETUP_DECLINED_FILE = "setup-declined";

/** Exit codes. `start`: done, and the person wants a session now, which the launcher then starts (kyrn/bin/mu.mjs). */
export const SETUP_EXIT = { done: 0, failed: 1, usage: 2, start: 3, cancelled: 130 } as const;

/** Options that take a value. The launcher keeps the same list: whatever else stands alone on the command line is a key. */
export const SETUP_VALUE_FLAGS: readonly string[] = [
	"--service",
	"--model",
	"--base-url",
	"--api",
	"--name",
	"--judge",
];

const SETUP_FLAGS: Readonly<Record<string, string>> = {
	"-h": "help",
	"--help": "help",
	help: "help",
	"--list": "list",
	"--first-run": "firstRun",
	"-y": "yes",
	"--yes": "yes",
	"--key-stdin": "keyStdin",
};

/** Where the `jev` judge finds its key, in the order it looks (registry.ts). */
const JEV_KEY_NAMES = ["TYPESAFE_API_KEY", "MU_JUDGE_OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY"] as const;
const JEV_TIERS = new Set(["jev", "jev-direct", "jev-openrouter", "jev-gateway"]);
const JEV_PAGE = "https://typesafe.ai";
/** Services whose keys carry the vendor's own mark: a key of theirs pasted as the Jev key is a mistake. */
const BRANDED = new Set(["openai", "anthropic", "openrouter", "google", "xai"]);

const OTHER: Text = {
	zh: "其他 OpenAI 或 Anthropic 兼容的服务",
	en: "Another OpenAI- or Anthropic-compatible service",
};
/** A local service that does not answer, or lists no model, is not ready yet; a key has nothing to do with it. */
const NOT_READY: Text = {
	zh: "Ollama 还没准备好（用 `ollama serve` 启动它，再拉取一个模型）。",
	en: "Ollama is not ready yet (start it with `ollama serve`, pull a model).",
};

type Env = Readonly<Record<string, string | undefined>>;

/** The terminal, as the wizard uses it. `ask` and `secret` give undefined when the input ended or was cancelled. */
export interface Prompter {
	say(text: string): void;
	/** A problem, for stderr. */
	warn(text: string): void;
	ask(question: string): Promise<string | undefined>;
	/** What is typed is not shown. */
	secret(question: string): Promise<string | undefined>;
}

/** What of pi the wizard uses (pi-access.ts). */
export interface PiAccess {
	/** Whether pi has a provider by this id: one of its own, or one from models.json. */
	providerExists(provider: string): boolean;
	/** pi's models of a provider. */
	models(provider: string): readonly string[];
	/** Where pi sends a provider's requests, models.json's address included. */
	baseUrl(provider: string): string | undefined;
	/** How auth.json holds a credential for this provider, if it does. */
	credential(provider: string): Promise<"api_key" | "oauth" | undefined>;
	/** Stores the key as an api_key credential in auth.json, the way /login does (models.json is read again first). */
	storeKey(provider: string, key: string): Promise<void>;
	/** settings.json's defaultProvider and defaultModel; every other setting stays. */
	setDefaultModel(provider: string, model: string): Promise<void>;
}

export interface SetupDeps {
	readonly io: Prompter;
	readonly language: SetupLanguage;
	/** The environment as the launcher handed it over: the real one, without the .env's additions. */
	readonly env: Env;
	readonly paths: SetupPaths;
	readonly pi: PiAccess;
	readonly fetch: typeof fetch;
	readonly now: () => Date;
	/** stdin and stdout are both terminals: questions can be asked. */
	readonly interactive: boolean;
	/** stdin is a terminal: --key-stdin would have the key typed where it shows. */
	readonly stdinTerminal: boolean;
	/** All of stdin, for --key-stdin. */
	readonly readStdin: () => Promise<string>;
	/** A key from the command line, which the launcher hands over in MU_SETUP_KEY rather than in the child's argv. */
	readonly givenKey?: string;
	/** Where the proxy for the check came from, when there is one ("HTTPS_PROXY", "settings.json"). */
	readonly proxy?: string;
	readonly timeoutMs?: number;
}

export interface SetupArgs {
	readonly help: boolean;
	readonly list: boolean;
	readonly firstRun: boolean;
	readonly yes: boolean;
	readonly keyStdin: boolean;
	readonly service?: string;
	readonly model?: string;
	readonly baseUrl?: string;
	readonly api?: "openai" | "anthropic";
	readonly name?: string;
	readonly judge?: "jev" | "model" | "none";
	/** What is not an option: a key, when the entry is started without the launcher. */
	readonly words: readonly string[];
}

export function parseSetupArgs(argv: readonly string[]): SetupArgs | { readonly error: Text } {
	const values = new Map<string, string>();
	const flags = new Set<string>();
	const words: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const flag = equals > 0 ? arg.slice(0, equals) : arg;
		if (SETUP_VALUE_FLAGS.includes(flag)) {
			const value = equals > 0 ? arg.slice(equals + 1) : argv[++index];
			if (value === undefined || value === "" || (equals < 0 && value.startsWith("-"))) {
				return { error: { zh: `${flag} 后面要跟一个值`, en: `${flag} needs a value` } };
			}
			values.set(flag, value);
		} else if (SETUP_FLAGS[arg]) flags.add(SETUP_FLAGS[arg]);
		else if (arg.startsWith("-") && arg.length > 1) {
			return { error: { zh: `不认识的选项 ${arg}`, en: `unknown option ${arg}` } };
		} else words.push(arg);
	}
	const api = values.get("--api");
	if (api !== undefined && api !== "openai" && api !== "anthropic") {
		return { error: { zh: "--api 只能是 openai 或 anthropic", en: "--api is openai or anthropic" } };
	}
	const judge = values.get("--judge");
	if (judge !== undefined && judge !== "jev" && judge !== "model" && judge !== "none") {
		return { error: { zh: "--judge 只能是 jev、model 或 none", en: "--judge is jev, model or none" } };
	}
	const service = values.get("--service");
	if (service !== undefined && !serviceById(service)) {
		return {
			error: {
				zh: `没有叫 ${service} 的服务（mu setup --list 列出全部）`,
				en: `there is no service called ${service} (mu setup --list shows them)`,
			},
		};
	}
	if (words.length > 1) return { error: { zh: "只能给一个密钥", en: "give one key at most" } };
	return {
		help: flags.has("help"),
		list: flags.has("list"),
		firstRun: flags.has("firstRun"),
		yes: flags.has("yes"),
		keyStdin: flags.has("keyStdin"),
		service,
		model: values.get("--model"),
		baseUrl: values.get("--base-url"),
		api,
		name: values.get("--name"),
		judge,
		words,
	};
}

export function setupUsage(language: SetupLanguage): string {
	if (language === "zh") {
		return [
			"mu setup：给 mu 接上一个干活的模型，再选一个判定器。",
			"",
			"  mu setup                 在终端里一步一步问",
			"  mu setup <密钥>          从一个 API 密钥开始：mu 按密钥的样子认出它属于哪个服务",
			"  mu setup --service <id> --key-stdin [--model <id>] [--base-url <地址>] [--judge jev|model|none] [--yes]",
			"                           给脚本用：密钥从标准输入读取",
			"  mu setup --list          mu 认识的服务和它们的 id",
			"",
			"为什么脚本要从标准输入给密钥：写在命令行上的密钥会留在 shell 的历史记录里，",
			"这台电脑上能列出进程的程序也都看得到它。mu setup <密钥> 只是为了上手快；能在提示里粘贴就粘贴。",
			"",
			"  --judge jev     Jev 密钥（TypeSafe）写在标准输入的第二行；已经设置了 TYPESAFE_API_KEY 就不用",
			"  --judge model   用刚设置的模型当判定器（更慢，每次判断都花 token）",
			"  --judge none    不改判定器；不写 --judge 时也不改",
			"  --api, --name   服务 other 的接口（openai 或 anthropic）和它在 mu 里的名字",
			"  --yes           不提问；替换已有的设置（订阅登录、同名服务的地址、Jev 密钥）",
			"",
			"会改动的文件：~/.mu/agent 里的 auth.json（密钥）、models.json、settings.json、mu.json，",
			"以及 mu 读取的 .env（Jev 密钥）。每个文件改动前都会先复制到 ~/.mu/backups/<时间>/。",
		].join("\n");
	}
	return [
		"mu setup: connect a model for mu to work with, and choose its judge.",
		"",
		"  mu setup                 asks step by step, in a terminal",
		"  mu setup <key>           starts from an API key: mu tells by its shape which service it belongs to",
		"  mu setup --service <id> --key-stdin [--model <id>] [--base-url <url>] [--judge jev|model|none] [--yes]",
		"                           for scripts: the key is read from stdin",
		"  mu setup --list          the services mu knows, with their ids",
		"",
		"Why stdin for scripts: a key on the command line stays in your shell's history, and every program on this",
		"computer that lists processes can read it. `mu setup <key>` is there for a quick start; paste the key at the",
		"prompt when you can.",
		"",
		"  --judge jev     the Jev key (TypeSafe) is the second line of stdin, unless TYPESAFE_API_KEY is set already",
		"  --judge model   the model just set up answers as the judge (slower, and every decision costs tokens)",
		"  --judge none    leaves the judge as it is, as leaving out --judge does",
		"  --api, --name   for the service `other`: its API (openai or anthropic) and its name in mu",
		"  --yes           no questions; replaces what is set up already (a subscription sign-in, a provider's",
		"                  address, the Jev key)",
		"",
		"Files: auth.json (keys), models.json, settings.json and mu.json in ~/.mu/agent, and the .env mu reads",
		"(the Jev key). Each is copied to ~/.mu/backups/<time>/ before it changes.",
	].join("\n");
}

/** A service as the lists show it: its name, and for `other` what it stands for. */
function label(service: SetupService, language: SetupLanguage): string {
	return service.id === "other" ? OTHER[language] : service.name;
}

export function serviceList(language: SetupLanguage): string {
	const width = Math.max(...SETUP_SERVICES.map((service) => service.id.length));
	return SETUP_SERVICES.map((service) => `  ${service.id.padEnd(width)}  ${label(service, language)}`).join("\n");
}

/** A provider id for an address of one's own: a plain word that pi and the /model picker take as it is. */
export function providerIdFor(baseUrl: string): string {
	let host: string;
	try {
		host = new URL(baseUrl).host.toLowerCase();
	} catch {
		return "custom";
	}
	const [name, port] = host.split(/:(?=\d+$)/);
	if (name === "localhost" || /^\d+(\.\d+){3}$/.test(name) || name.startsWith("[")) {
		return port ? `local-${port}` : "local";
	}
	const parts = name.split(".").filter((part) => part !== "api" && part !== "www");
	const main = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? "");
	return main.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** A path under the home folder written the way a person types it. */
function tilde(path: string, env: Env): string {
	const home = env.HOME || env.USERPROFILE;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Where a Jev key is set already. The real environment wins over the .env, also with an empty value. */
export function jevKeyAt(
	env: Env,
	envFileText: string | undefined,
): { name: string; where: "env" | "file" } | undefined {
	for (const name of JEV_KEY_NAMES) {
		if (name in env) {
			if (env[name]) return { name, where: "env" };
			continue;
		}
		if (envFileText !== undefined && envFileValue(envFileText, name)) return { name, where: "file" };
	}
	return undefined;
}

/** One address a service is reached at, and pi's provider there. */
interface Reach {
	readonly provider: string;
	readonly builtIn: boolean;
	readonly baseUrl: string;
	readonly api: SetupApi;
}

interface Target {
	readonly service: SetupService;
	readonly reach: Reach;
	readonly key?: string;
	/** What the service listed; undefined when its check lists nothing, or the check was skipped. */
	readonly listed?: readonly string[];
}

type JudgeChoice =
	| { readonly kind: "keep" }
	| { readonly kind: "jev"; readonly key: string }
	| { readonly kind: "model" }
	| { readonly kind: "none" };

interface Choice<T> {
	readonly label: string;
	readonly value: T;
}

/** Ends the run where it is: a cancelled question, or a script that cannot go on (the reason is out already). */
class Stop extends Error {
	readonly code: number;
	constructor(code: number) {
		super(`mu setup stopped (${code})`);
		this.code = code;
	}
}

class Setup {
	private readonly args: SetupArgs;
	private readonly deps: SetupDeps;
	private readonly io: Prompter;
	private readonly language: SetupLanguage;
	/** No questions: a script, or --yes. */
	private readonly scripted: boolean;
	/** The second line of stdin, for --judge jev. */
	private jevFromStdin: string | undefined;
	/** The key given for the model: a Jev key is never the same one. */
	private modelKey: string | undefined;

	constructor(args: SetupArgs, deps: SetupDeps) {
		this.args = args;
		this.deps = deps;
		this.io = deps.io;
		this.language = deps.language;
		this.scripted = args.keyStdin || args.yes || !deps.interactive;
	}

	async run(): Promise<number> {
		try {
			return await this.steps();
		} catch (error) {
			if (error instanceof Stop) return error.code;
			throw error;
		}
	}

	private t(text: Text): string {
		return text[this.language];
	}

	private name(service: SetupService): string {
		return label(service, this.language);
	}

	private names(services: readonly SetupService[]): string {
		return services.map((service) => this.name(service)).join(this.language === "zh" ? " 和 " : " and ");
	}

	private path(path: string): string {
		return tilde(path, this.deps.env);
	}

	private cancelled(): Stop {
		this.io.say(this.t({ zh: "已停止，什么都没有改。", en: "Stopped. Nothing was changed." }));
		return new Stop(SETUP_EXIT.cancelled);
	}

	/** A run that cannot go on, with the reason on stderr. */
	private fail(text: Text, code: number = SETUP_EXIT.failed): Stop {
		this.io.warn(`mu setup: ${this.t(text)}`);
		return new Stop(code);
	}

	private async ask(question: string): Promise<string> {
		const answer = await this.io.ask(question);
		if (answer === undefined) throw this.cancelled();
		return answer.trim();
	}

	/** A key, typed where it does not show; asked again while it is empty. */
	private async secret(question: string, allowEmpty = false): Promise<string> {
		for (;;) {
			const answer = await this.io.secret(question);
			if (answer === undefined) throw this.cancelled();
			const key = cleanKey(answer);
			if (key || allowEmpty) return key;
		}
	}

	private pasteKey(): Promise<string> {
		return this.secret(
			this.t({ zh: "粘贴 API 密钥（不会显示出来）：", en: "Paste the API key (it is not shown): " }),
		);
	}

	private async choose<T>(question: string, choices: readonly Choice<T>[]): Promise<T> {
		this.io.say(question);
		for (const [index, choice] of choices.entries()) this.io.say(`  ${index + 1}) ${choice.label}`);
		const range = `1-${choices.length}`;
		for (;;) {
			const answer = await this.ask(this.t({ zh: `请选择 ${range} [1]：`, en: `Choose ${range} [1]: ` }));
			if (answer === "") return choices[0].value;
			const number = Number(answer);
			if (Number.isInteger(number) && number >= 1 && number <= choices.length) return choices[number - 1].value;
			this.io.say(this.t({ zh: `请输入 ${range} 之间的数字。`, en: `Type a number from ${range}.` }));
		}
	}

	private async confirm(question: string, yes: boolean): Promise<boolean> {
		for (;;) {
			const answer = (await this.ask(question)).toLowerCase();
			if (answer === "") return yes;
			if (["y", "yes", "是", "好", "要"].includes(answer)) return true;
			if (["n", "no", "否", "不", "不要"].includes(answer)) return false;
		}
	}

	private async steps(): Promise<number> {
		const { args, deps } = this;
		if (args.firstRun && !(await this.firstStart())) return SETUP_EXIT.done;
		let key = deps.givenKey ?? args.words[0];
		if (args.keyStdin) {
			if (deps.stdinTerminal) {
				throw this.fail(
					{
						zh: "--key-stdin 从管道读密钥。在终端里请直接运行 mu setup，在提示里粘贴密钥（不会显示）。",
						en: "--key-stdin reads the key from a pipe. In a terminal, run mu setup and paste the key at its prompt (it is not shown).",
					},
					SETUP_EXIT.usage,
				);
			}
			const [modelKey, jevKey] = (await deps.readStdin())
				.split(/\r?\n/)
				.map((line) => cleanKey(line))
				.filter(Boolean);
			key = modelKey;
			this.jevFromStdin = jevKey;
		}
		if (this.scripted && key === undefined && args.service === undefined) {
			throw this.fail(
				deps.interactive
					? { zh: "没有密钥，也没有 --service", en: "no key and no --service were given" }
					: {
							zh: "问题要在终端里回答。脚本里用：mu setup --service <id> --key-stdin（见 mu setup --help）",
							en: "its questions need a terminal. For a script: mu setup --service <id> --key-stdin (see mu setup --help)",
						},
				SETUP_EXIT.usage,
			);
		}
		if (!args.firstRun) {
			this.io.say(
				this.t({
					zh: "mu setup：给 mu 接上一个干活的模型，再选一个判定器。",
					en: "mu setup: connect a model for mu to work with, and choose its judge.",
				}),
			);
		}
		const start = await this.start(key === undefined ? undefined : cleanKey(key));
		if (start === "subscription") {
			const code = await this.write(undefined, undefined, await this.judge(undefined));
			return code === SETUP_EXIT.done ? this.offerSession() : code;
		}
		const target = await this.checked(start.service, start.key);
		this.modelKey = target.key;
		const model = await this.model(target);
		await this.conflicts(target);
		const judge = await this.judge({ provider: target.reach.provider, model });
		const code = await this.write(target, model, judge);
		return code === SETUP_EXIT.done ? this.offerSession() : code;
	}

	/** The launcher's question on a first start. A no is remembered: the question is never asked again. */
	private async firstStart(): Promise<boolean> {
		const yes = await this.confirm(
			this.t({
				zh: "mu 还没有可用的模型。现在设置一个吗？[Y/n] ",
				en: "mu has no model to work with yet. Set one up now? [Y/n] ",
			}),
			true,
		);
		if (yes) return true;
		try {
			mkdirSync(this.deps.paths.agentDir, { recursive: true });
			writeFileSync(
				join(this.deps.paths.agentDir, SETUP_DECLINED_FILE),
				"mu asked on its first start whether to set up a model, and the answer was no.\nDelete this file to be asked again; run mu setup any time.\n",
			);
		} catch {
			// Then the question comes again next time, which does no harm.
		}
		this.io.say(
			this.t({
				zh: "好的，以后不再问了。需要时运行 mu setup，或在 mu 里输入 /login。",
				en: "OK, mu will not ask again. Run mu setup when you want, or type /login inside mu.",
			}),
		);
		return false;
	}

	// -----------------------------------------------------------------------------------------------------------
	// Steps 1 and 2: how a model is reached, and which service a key belongs to
	// -----------------------------------------------------------------------------------------------------------

	private async start(key: string | undefined): Promise<"subscription" | { service: SetupService; key?: string }> {
		const named = this.args.service === undefined ? undefined : serviceById(this.args.service);
		if (named) return this.keyFor(named, key);
		if (key !== undefined) return { service: await this.serviceOf(key), key };
		const route = await this.choose(this.t({ zh: "mu 用什么方式连接模型？", en: "How should mu reach a model?" }), [
			{
				label: this.t({
					zh: "粘贴 API 密钥（mu 会认出它属于哪个服务）",
					en: "Paste an API key (mu tells which service it belongs to)",
				}),
				value: "key",
			},
			{ label: this.t({ zh: "从列表里选一个服务", en: "Choose a service from the list" }), value: "list" },
			{
				label: this.t({
					zh: "用订阅账号登录：ChatGPT、Claude、Grok 或 Google",
					en: "Sign in with a subscription: ChatGPT, Claude, Grok or Google",
				}),
				value: "subscription",
			},
		] as const);
		if (route === "subscription") {
			// pi's /login already does every sign-in: the browser, device codes, a pasted redirect. mu leaves it to pi.
			const auth = this.path(join(this.deps.paths.agentDir, "auth.json"));
			this.io.say(
				this.t({
					zh: `订阅账号在 mu 里面登录：启动 mu，输入 /login，选 ChatGPT（OpenAI Codex）、Claude、Grok 或 Google，按提示在浏览器里完成。登录信息保存在 ${auth}。`,
					en: `A subscription signs in inside mu: start mu, type /login, choose ChatGPT (OpenAI Codex), Claude, Grok or Google, and finish in the browser. The sign-in is kept in ${auth}.`,
				}),
			);
			return "subscription";
		}
		if (route === "list") return this.keyFor(await this.pickService(SETUP_SERVICES), undefined);
		const pasted = await this.pasteKey();
		return { service: await this.serviceOf(pasted), key: pasted };
	}

	private pickService(services: readonly SetupService[], question?: string): Promise<SetupService> {
		return this.choose(
			question ?? this.t({ zh: "选哪个服务？", en: "Which service?" }),
			services.map((service) => ({ label: this.name(service), value: service })),
		);
	}

	/**
	 * The service a key belongs to, by its shape. When the shape fits several, or none, the person says which: a key is
	 * never tried on one vendor after another.
	 */
	private async serviceOf(key: string): Promise<SetupService> {
		const matches = servicesForKey(key);
		if (matches.length === 1) {
			this.io.say(
				this.t({ zh: `这是 ${this.name(matches[0])} 的密钥。`, en: `This is a ${this.name(matches[0])} key.` }),
			);
			return matches[0];
		}
		if (this.scripted) {
			throw this.fail(
				matches.length > 1
					? {
							zh: `${this.names(matches)} 的密钥长得一样。用 --service 说明是哪家：${matches.map((service) => service.id).join(" 或 ")}`,
							en: `keys of ${this.names(matches)} look the same. Say which with --service ${matches.map((service) => service.id).join(" or ")}`,
						}
					: {
							zh: "认不出这个密钥属于哪个服务。用 --service <id> 说明（mu setup --list 列出全部）",
							en: "this key's shape names no service mu knows. Say which with --service <id> (mu setup --list)",
						},
				SETUP_EXIT.usage,
			);
		}
		if (matches.length > 1) {
			return this.pickService(
				matches,
				this.t({
					zh: `${this.names(matches)} 的密钥长得一样。这个密钥是哪家的？mu 只把密钥发给它所属的服务。`,
					en: `Keys of ${this.names(matches)} look the same. Which service is this key for? mu sends a key only to the service it belongs to.`,
				}),
			);
		}
		return this.pickService(
			SETUP_SERVICES.filter((service) => !service.keyless),
			this.t({
				zh: "mu 认不出这个密钥。它是哪个服务的？",
				en: "mu does not recognise this key. Which service is it for?",
			}),
		);
	}

	/** The key for a service that was named: asked for when there is none yet, and held against the service's shapes. */
	private async keyFor(
		service: SetupService,
		given: string | undefined,
	): Promise<{ service: SetupService; key?: string }> {
		if (service.keyless) return { service };
		let key = given;
		if (key === undefined && !this.scripted) {
			if (service.keyPage) {
				this.io.say(
					this.t({ zh: `密钥在这里创建：${service.keyPage}`, en: `Keys are made at ${service.keyPage}` }),
				);
			}
			key = service.keyOptional
				? await this.secret(
						this.t({
							zh: "粘贴它的 API 密钥；不需要密钥就直接回车（不会显示）：",
							en: "Paste its API key, or press Enter if it takes none (not shown): ",
						}),
						true,
					)
				: await this.pasteKey();
		}
		if (!key) {
			if (service.keyOptional) return { service };
			throw this.fail(
				{ zh: `${this.name(service)} 需要一个 API 密钥`, en: `${this.name(service)} needs an API key` },
				SETUP_EXIT.usage,
			);
		}
		const matches = servicesForKey(key);
		if (matches.length === 0 || matches.includes(service)) return { service, key };
		// The key looks like another service's: the person says where it goes, before it goes anywhere.
		if (this.scripted) {
			this.io.warn(
				this.t({
					zh: `注意：这个密钥看起来是 ${this.names(matches)} 的；按 --service 发给 ${this.name(service)}。`,
					en: `Note: this key looks like a ${this.names(matches)} key; it goes to ${this.name(service)}, as --service says.`,
				}),
			);
			return { service, key };
		}
		const chosen = await this.pickService(
			[service, ...matches],
			this.t({
				zh: `这个密钥看起来是 ${this.names(matches)} 的，不像 ${this.name(service)} 的。它是哪家的？`,
				en: `This key looks like a ${this.names(matches)} key, not a ${this.name(service)} one. Which service is it for?`,
			}),
		);
		return { service: chosen, key };
	}

	// -----------------------------------------------------------------------------------------------------------
	// Step 3: one request to the service
	// -----------------------------------------------------------------------------------------------------------

	/** The addresses to try, in order: the service's own (where pi has them), or the one typed for `other`. */
	private async reaches(service: SetupService): Promise<Reach[]> {
		const { args, deps } = this;
		if (service.id !== "other") {
			const own = service.baseUrls.map((baseUrl, index) => ({
				provider: service.providers[index],
				builtIn: service.builtIn,
				// pi's own address, with a models.json override: the key goes where pi will send it anyway.
				baseUrl: (service.builtIn && deps.pi.baseUrl(service.providers[index])) || baseUrl,
				api: service.api,
			}));
			return args.baseUrl ? [{ ...own[0], baseUrl: args.baseUrl.replace(/\/+$/, "") }] : own;
		}
		let baseUrl = args.baseUrl;
		if (!baseUrl) {
			if (this.scripted) {
				throw this.fail(
					{ zh: "服务 other 需要 --base-url", en: "--service other needs --base-url" },
					SETUP_EXIT.usage,
				);
			}
			for (;;) {
				baseUrl = await this.ask(
					this.t({
						zh: "服务的地址（base URL），例如 https://api.example.com/v1：",
						en: "The service's address (base URL), e.g. https://api.example.com/v1: ",
					}),
				);
				if (/^https?:\/\/[^\s/]+/i.test(baseUrl)) break;
				this.io.say(
					this.t({ zh: "地址以 http:// 或 https:// 开头。", en: "The address starts with http:// or https://." }),
				);
			}
		}
		const api =
			args.api === "anthropic"
				? "anthropic-messages"
				: args.api === "openai" || this.scripted
					? "openai-completions"
					: await this.choose(this.t({ zh: "它用哪种接口？", en: "Which API does it speak?" }), [
							{
								label: this.t({
									zh: "OpenAI 兼容（chat completions）",
									en: "OpenAI-compatible (chat completions)",
								}),
								value: "openai-completions" as const,
							},
							{
								label: this.t({ zh: "Anthropic 兼容（messages）", en: "Anthropic-compatible (messages)" }),
								value: "anthropic-messages" as const,
							},
						]);
		let base = baseUrl.replace(/\/+$/, "");
		// pi's Anthropic client adds /v1 to the address itself.
		if (api === "anthropic-messages") base = base.replace(/\/v1$/, "");
		let provider = args.name ?? providerIdFor(base);
		// A name of pi's own would lay this address over that provider: a new name, unless models.json has it from before.
		if (!args.name && deps.pi.providerExists(provider) && !this.inModelsFile(provider))
			provider = `${provider}-custom`;
		if (!args.name && !this.scripted) {
			const typed = await this.ask(
				this.t({
					zh: `给它起个简短的名字（字母、数字、-）[${provider}]：`,
					en: `A short name for it in mu (letters, digits, -) [${provider}]: `,
				}),
			);
			if (typed) provider = typed.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
		}
		return [{ provider, builtIn: false, baseUrl: base, api }];
	}

	private inModelsFile(provider: string): boolean {
		const models = readJsonFile(join(this.deps.paths.agentDir, "models.json"));
		return models.state === "ok" && existingProvider(models.value, provider) !== undefined;
	}

	/** A failure as the person can act on it: a local service that is silent is not ready yet, whatever the key. */
	private explain(service: SetupService, problem: Problem): string {
		if (service.keyless && ["connection", "timeout", "dns"].includes(problem.kind)) return this.t(NOT_READY);
		return explainProblem(
			problem,
			{ service: this.name(service), proxy: this.deps.proxy, timeoutMs: this.deps.timeoutMs },
			this.language,
		);
	}

	/** The key, checked: asked again, retried, or taken unchecked until the person has one that works, or stops. */
	private async checked(service: SetupService, firstKey: string | undefined): Promise<Target> {
		let key = firstKey;
		const reaches = await this.reaches(service);
		// A provider of mu's lives in models.json, which is never rewritten when it cannot be read: said before anything is sent.
		if (!reaches[0].builtIn || this.args.baseUrl) this.modelsFileWritable();
		await this.oauthConflict(service, reaches);
		for (;;) {
			const result = await this.tryReaches(service, reaches, key);
			if (result.ok) return { service, reach: result.reach, key, listed: result.listed };
			const said = this.explain(service, result.problem);
			if (this.scripted) throw this.fail({ zh: said, en: said });
			this.io.say(said);
			type Next = "key" | "again" | "unchecked" | "stop";
			const choices: Choice<Next>[] = [];
			if (!service.keyless)
				choices.push({ label: this.t({ zh: "换一个密钥", en: "Paste another key" }), value: "key" });
			choices.push({ label: this.t({ zh: "再试一次", en: "Try again" }), value: "again" });
			if (result.problem.kind !== "key") {
				choices.push({
					label: this.t({ zh: "不检查了，照样保存", en: "Save it without the check" }),
					value: "unchecked",
				});
			}
			choices.push({
				label: this.t({ zh: "到此为止（什么都不改）", en: "Stop here (nothing is changed)" }),
				value: "stop",
			});
			const next = await this.choose(this.t({ zh: "接下来怎么办？", en: "What now?" }), choices);
			if (next === "stop") throw this.cancelled();
			if (next === "unchecked") return { service, reach: reaches[0], key };
			if (next === "key") key = await this.pasteKey();
		}
	}

	/** Each address of the service in turn: Kimi's .cn, then .ai; an address of one's own, then with /v1 added. */
	private async tryReaches(
		service: SetupService,
		reaches: readonly Reach[],
		key: string | undefined,
	): Promise<{ ok: true; reach: Reach; listed?: readonly string[] } | { ok: false; problem: Problem }> {
		let first: Problem | undefined;
		const candidates = [...reaches];
		for (let index = 0; index < candidates.length; index++) {
			const reach = candidates[index];
			const where = `${this.name(service)}（${hostOf(reach.baseUrl)}）`;
			this.io.say(
				key
					? this.t({
							zh: `正在用 ${where}检查密钥……`,
							en: `Checking the key with ${this.name(service)} (${hostOf(reach.baseUrl)})...`,
						})
					: this.t({
							zh: `正在检查 ${where}……`,
							en: `Checking ${this.name(service)} (${hostOf(reach.baseUrl)})...`,
						}),
			);
			const result = await checkKey({
				kind: checkKindOf(service, reach.api),
				baseUrl: reach.baseUrl,
				key,
				fetch: this.deps.fetch,
				timeoutMs: this.deps.timeoutMs ?? CHECK_TIMEOUT_MS,
			});
			if (result.ok) {
				const count = result.models?.length;
				this.io.say(
					count === undefined
						? this.t({ zh: "密钥可以用。", en: "The key works." })
						: this.t({ zh: `可以用：列出了 ${count} 个模型。`, en: `It works: ${count} models listed.` }),
				);
				return { ok: true, reach, listed: result.models };
			}
			if (result.problem.kind === "permission") {
				// The key was accepted; it only may not read the list.
				this.io.say(this.explain(service, result.problem));
				return { ok: true, reach };
			}
			first ??= result.problem;
			// Servers that speak OpenAI's API keep it under /v1, which a typed address may leave out.
			if (
				service.id === "other" &&
				result.problem.kind === "address" &&
				reach.api === "openai-completions" &&
				!reach.baseUrl.endsWith("/v1") &&
				index === candidates.length - 1
			) {
				candidates.push({ ...reach, baseUrl: `${reach.baseUrl}/v1` });
			}
		}
		return { ok: false, problem: first ?? { kind: "other", url: reaches[0]?.baseUrl ?? "" } };
	}

	/** A subscription sign-in is replaced by a key only with a yes. */
	private async oauthConflict(service: SetupService, reaches: readonly Reach[]): Promise<void> {
		for (const reach of reaches) {
			if ((await this.deps.pi.credential(reach.provider)) !== "oauth") continue;
			if (this.args.yes) return;
			if (this.scripted) {
				throw this.fail({
					zh: `${this.name(service)} 已经用订阅账号登录了。要改存密钥，加上 --yes`,
					en: `${this.name(service)} is signed in with a subscription. To store a key instead, add --yes`,
				});
			}
			const replace = await this.confirm(
				this.t({
					zh: `你已经用订阅账号登录了 ${this.name(service)}。改用这个密钥吗？登录会被替换（留有备份）。[y/N] `,
					en: `You are signed in to ${this.name(service)} with a subscription. Use this key instead? The sign-in is replaced (a copy is kept). [y/N] `,
				}),
				false,
			);
			if (!replace) throw this.cancelled();
			return;
		}
	}

	private modelsFileWritable(): void {
		const path = join(this.deps.paths.agentDir, "models.json");
		if (readJsonFile(path).state !== "unreadable") return;
		throw this.fail({
			zh: `${this.path(path)} 不是纯 JSON（也许有注释或写错了），mu setup 不改写它。先修好它，或手动把服务加进去。`,
			en: `${this.path(path)} is not plain JSON (it may have comments, or a typo), and mu setup does not rewrite it. Fix it, or add the service by hand.`,
		});
	}

	// -----------------------------------------------------------------------------------------------------------
	// Step 4: the model to start with
	// -----------------------------------------------------------------------------------------------------------

	private async model(target: Target): Promise<string> {
		const { service, listed } = target;
		if (this.args.model) {
			if (listed && listed.length > 0 && !listed.includes(this.args.model)) {
				this.io.say(
					this.t({
						zh: `注意：${this.name(service)} 没有列出 ${this.args.model}，照样使用。`,
						en: `Note: ${this.name(service)} does not list ${this.args.model}; it is used anyway.`,
					}),
				);
			}
			return this.args.model;
		}
		const startWith = this.t({ zh: "先用这个模型：", en: "Model to start with: " });
		// The table's choice when the service lists it; a service that lists nothing starts on the model it names.
		const chosen = listed && listed.length > 0 ? tableModel(service, listed) : namedModel(service);
		if (chosen) {
			this.io.say(`${startWith}${chosen}`);
			return chosen;
		}
		const options = chatModels(listed ?? []);
		if (options.length === 0) {
			const none = service.keyless
				? NOT_READY
				: {
						zh: `${this.name(service)} 没有列出模型。`,
						en: `${this.name(service)} lists no models.`,
					};
			if (this.scripted) {
				throw this.fail({ zh: `${none.zh}可以用 --model 指定一个。`, en: `${none.en} Name one with --model.` });
			}
			this.io.say(this.t(none));
			for (;;) {
				const typed = await this.ask(this.t({ zh: "要用的模型名：", en: "The name of the model to use: " }));
				if (typed) return typed;
			}
		}
		if (this.scripted) {
			this.io.say(`${startWith}${options[0]}`);
			return options[0];
		}
		const shown = options.slice(0, 20);
		this.io.say(this.t({ zh: "mu 先用哪个模型？", en: "Which model should mu start with?" }));
		for (const [index, id] of shown.entries()) this.io.say(`  ${index + 1}) ${id}`);
		if (options.length > shown.length) {
			const more = options.length - shown.length;
			this.io.say(
				this.t({
					zh: `  （还有 ${more} 个，输入名字也可以）`,
					en: `  (${more} more: type a name to use one of them)`,
				}),
			);
		}
		const answer = await this.ask(
			this.t({
				zh: `请选择 1-${shown.length}，或输入模型名 [1]：`,
				en: `Choose 1-${shown.length}, or type a model name [1]: `,
			}),
		);
		const number = Number(answer);
		if (answer === "") return shown[0];
		if (Number.isInteger(number) && number >= 1 && number <= shown.length) return shown[number - 1];
		return answer;
	}

	/** A provider models.json has at another address is moved only with a yes. */
	private async conflicts(target: Target): Promise<void> {
		if (target.reach.builtIn && !this.args.baseUrl) return;
		const models = readJsonFile(join(this.deps.paths.agentDir, "models.json"));
		if (models.state !== "ok") return;
		const current = existingProvider(models.value, target.reach.provider)?.baseUrl;
		const old = typeof current === "string" ? current.replace(/\/+$/, "") : undefined;
		if (!old || old === target.reach.baseUrl || this.args.yes) return;
		if (this.scripted) {
			throw this.fail({
				zh: `models.json 里的 ${target.reach.provider} 指向 ${old}。要改成 ${target.reach.baseUrl}，加上 --yes`,
				en: `models.json has ${target.reach.provider} at ${old}. To point it at ${target.reach.baseUrl}, add --yes`,
			});
		}
		const move = await this.confirm(
			this.t({
				zh: `models.json 里已经有 ${target.reach.provider}，地址是 ${old}。改成 ${target.reach.baseUrl} 吗？[y/N] `,
				en: `models.json already has ${target.reach.provider}, at ${old}. Point it at ${target.reach.baseUrl}? [y/N] `,
			}),
			false,
		);
		if (!move) throw this.cancelled();
	}

	// -----------------------------------------------------------------------------------------------------------
	// Step 5: the judge
	// -----------------------------------------------------------------------------------------------------------

	private async judge(model: { provider: string; model: string } | undefined): Promise<JudgeChoice | undefined> {
		const { env, paths } = this.deps;
		const envText = readTextFile(paths.envFile);
		const existing = jevKeyAt(env, envText);
		if (this.scripted) return this.scriptedJudge(model, envText, existing !== undefined);
		const where = existing
			? existing.where === "env"
				? this.t({ zh: `环境变量 ${existing.name}`, en: `${existing.name} in your environment` })
				: this.t({
						zh: `${this.path(paths.envFile)} 里的 ${existing.name}`,
						en: `${existing.name} in ${this.path(paths.envFile)}`,
					})
			: undefined;
		const choices: Choice<"keep" | "jev" | "model" | "none">[] = [];
		if (where) {
			choices.push({
				label: this.t({
					zh: `Jev（推荐），用已经设置的密钥（${where}）`,
					en: `Jev (recommended), with the key already set (${where})`,
				}),
				value: "keep",
			});
		}
		choices.push({
			label: where
				? this.t({ zh: "Jev，换一个新密钥", en: "Jev, with a new key" })
				: this.t({
						zh: `Jev（推荐）：又快又准，按次计费。密钥在 TypeSafe 申请：${JEV_PAGE}`,
						en: `Jev (recommended): fast and accurate, billed per call. Get a key from TypeSafe: ${JEV_PAGE}`,
					}),
			value: "jev",
		});
		if (model) {
			choices.push({
				label: this.t({
					zh: `刚设置的模型（${model.provider}/${model.model}）：更慢，而且每次判断都要花 token`,
					en: `The model you just set up (${model.provider}/${model.model}): slower, and every decision costs tokens`,
				}),
				value: "model",
			});
		}
		choices.push({
			label: this.t({
				zh: "暂时不要：mu 就像 pi 一样工作，没有判定器回答",
				en: "Not now: mu then works like pi, with no judge answering",
			}),
			value: "none",
		});
		const picked = await this.choose(
			this.t({
				zh: "mu 工作时要做很多小判断：这条消息该怎么处理、这一步会不会违反你定的规则……判定器负责回答。选哪个判定器？",
				en: "mu makes many small decisions as it works: how to take a message, whether a step breaks your rules. A judge answers them. Which judge?",
			}),
			choices,
		);
		if (picked === "jev") return { kind: "jev", key: await this.jevKey() };
		return { kind: picked };
	}

	private scriptedJudge(
		model: { provider: string; model: string } | undefined,
		envText: string | undefined,
		keySet: boolean,
	): JudgeChoice | undefined {
		switch (this.args.judge) {
			case "jev": {
				const key = this.jevFromStdin;
				if (!key) {
					if (keySet) return { kind: "keep" };
					throw this.fail(
						{
							zh: "--judge jev 需要 Jev 密钥：写在标准输入的第二行，或先设置 TYPESAFE_API_KEY",
							en: "--judge jev needs a Jev key: the second line of stdin, or TYPESAFE_API_KEY set beforehand",
						},
						SETUP_EXIT.usage,
					);
				}
				if (key === this.modelKey) {
					throw this.fail(
						{ zh: "Jev 密钥和模型的密钥是同一个", en: "the Jev key is the same as the model's key" },
						SETUP_EXIT.usage,
					);
				}
				const current = envText === undefined ? undefined : envFileValue(envText, "TYPESAFE_API_KEY");
				if (current && current !== key && !this.args.yes) {
					throw this.fail({
						zh: `${this.path(this.deps.paths.envFile)} 里已经有 TYPESAFE_API_KEY。要替换它，加上 --yes`,
						en: `${this.path(this.deps.paths.envFile)} has a TYPESAFE_API_KEY already. To replace it, add --yes`,
					});
				}
				return { kind: "jev", key };
			}
			case "model":
				return model ? { kind: "model" } : undefined;
			default:
				// --judge none, or no --judge: a script changes only what it names.
				return undefined;
		}
	}

	private async jevKey(): Promise<string> {
		for (;;) {
			const key = await this.secret(
				this.t({
					zh: "粘贴 Jev 密钥（TYPESAFE_API_KEY，不会显示）：",
					en: "Paste the Jev key (TYPESAFE_API_KEY, not shown): ",
				}),
			);
			if (key === this.modelKey) {
				this.io.say(
					this.t({
						zh: `这是刚才给模型的密钥。Jev 的密钥在 TypeSafe 申请：${JEV_PAGE}`,
						en: `That is the key you gave for the model. A Jev key comes from TypeSafe: ${JEV_PAGE}`,
					}),
				);
				continue;
			}
			const branded = servicesForKey(key).find((service) => BRANDED.has(service.id));
			if (!branded) return key;
			const anyway = await this.confirm(
				this.t({
					zh: `这看起来是 ${this.name(branded)} 的密钥，不是 Jev 的，它会被发给 TypeSafe。仍然使用吗？[y/N] `,
					en: `This looks like a ${this.name(branded)} key, not a Jev key, and it would be sent to TypeSafe. Use it anyway? [y/N] `,
				}),
				false,
			);
			if (anyway) return key;
		}
	}

	// -----------------------------------------------------------------------------------------------------------
	// Step 6: the files
	// -----------------------------------------------------------------------------------------------------------

	private async write(
		target: Target | undefined,
		model: string | undefined,
		judge: JudgeChoice | undefined,
	): Promise<number> {
		const { deps } = this;
		const { agentDir } = deps.paths;
		const backups = new Backups(deps.paths.home, deps.now());
		const saved: string[] = [];
		const notes: string[] = [];
		const modelsPath = join(agentDir, "models.json");
		const authPath = join(agentDir, "auth.json");
		const settingsPath = join(agentDir, "settings.json");
		try {
			if (target && model) {
				const { service, reach, key } = target;
				const provider = reach.provider;
				const custom = !reach.builtIn;
				const moved = reach.builtIn && this.args.baseUrl !== undefined;
				const unknownModel = reach.builtIn && !deps.pi.models(provider).includes(model);
				if (custom || moved || unknownModel) {
					const file = readJsonFile(modelsPath);
					if (file.state === "unreadable") this.modelsFileWritable();
					let next = file.state === "ok" ? file.value : {};
					if (custom) {
						next = withProvider(next, provider, {
							name: service.id === "other" ? undefined : service.name,
							baseUrl: reach.baseUrl,
							api: reach.api,
							// pi counts a provider without a key as unusable: a keyless service gets a placeholder, never a real key.
							apiKey: service.keyless ? "ollama" : key ? undefined : "none",
							compat: service.compat,
							// What the service lists goes into /model, the one to start with first.
							models: [model, ...chatModels(target.listed ?? []).filter((id) => id !== model)].map((id) => ({
								id,
							})),
						});
					} else {
						if (moved) {
							const providers = existingProviders(next);
							next = {
								...next,
								providers: { ...providers, [provider]: { ...providers[provider], baseUrl: reach.baseUrl } },
							};
						}
						if (unknownModel) next = withModel(next, provider, model);
					}
					backups.save(modelsPath);
					writeJsonFile(modelsPath, next);
					saved.push(
						this.savedLine(
							modelsPath,
							custom || moved
								? this.t({ zh: `${provider}：${reach.baseUrl}`, en: `${provider} at ${reach.baseUrl}` })
								: this.t({ zh: `给 ${provider} 加上 ${model}`, en: `${model} added to ${provider}` }),
						),
					);
				}
				if (key) {
					backups.save(authPath);
					await deps.pi.storeKey(provider, key);
					saved.push(
						this.savedLine(
							authPath,
							this.t({ zh: `${this.name(service)} 的密钥`, en: `the ${this.name(service)} key` }),
						),
					);
				}
				backups.save(settingsPath);
				try {
					await deps.pi.setDefaultModel(provider, model);
					saved.push(
						this.savedLine(
							settingsPath,
							this.t({ zh: `默认模型 ${provider}/${model}`, en: `start on ${provider}/${model}` }),
						),
					);
				} catch {
					notes.push(
						this.t({
							zh: `${this.path(settingsPath)} 读不了，默认模型没有保存。在 mu 里用 /model 选它。`,
							en: `${this.path(settingsPath)} could not be read, so the default model was not saved. Choose it inside mu with /model.`,
						}),
					);
				}
			}
			if (judge && judge.kind !== "none") this.writeJudge(judge, target, model, backups, saved, notes);
		} catch (error) {
			if (error instanceof Stop) throw error;
			// pi's messages name files and providers, never a key; the keys are taken out all the same.
			let reason = error instanceof Error ? error.message : String(error);
			for (const secret of [target?.key, judge?.kind === "jev" ? judge.key : undefined]) {
				if (secret) reason = reason.replaceAll(secret, "…");
			}
			this.io.warn(this.t({ zh: `mu setup：保存时出错：${reason}`, en: `mu setup: saving failed: ${reason}` }));
			if (saved.length > 0) {
				this.io.warn(this.t({ zh: "出错前已经保存的：", en: "Saved before that:" }));
				for (const entry of saved) this.io.warn(entry);
			}
			if (backups.path) {
				this.io.warn(
					this.t({
						zh: `原来的文件在 ${this.path(backups.path)}`,
						en: `The earlier versions are in ${this.path(backups.path)}`,
					}),
				);
			}
			return SETUP_EXIT.failed;
		}
		if (saved.length > 0) {
			this.io.say(this.t({ zh: "已保存：", en: "Saved:" }));
			for (const entry of saved) this.io.say(entry);
		}
		if (backups.path) {
			this.io.say(
				this.t({
					zh: `改动前的文件已复制到 ${this.path(backups.path)}`,
					en: `The files as they were are copied to ${this.path(backups.path)}`,
				}),
			);
		}
		for (const note of notes) this.io.say(note);
		this.summary(target, model, judge);
		return SETUP_EXIT.done;
	}

	private savedLine(path: string, what: string): string {
		return `  ${this.path(path).padEnd(30)} ${what}`;
	}

	private writeJudge(
		judge: Exclude<JudgeChoice, { kind: "none" }>,
		target: Target | undefined,
		model: string | undefined,
		backups: Backups,
		saved: string[],
		notes: string[],
	): void {
		const { env, paths } = this.deps;
		const configPath = judgeConfigPath(paths.agentDir);
		const config = readJsonFile(configPath);
		const current = config.state === "ok" ? config.value : undefined;
		let tiers: string[] | undefined;
		if (judge.kind === "model") {
			if (target && model) tiers = [`llm:${target.reach.provider}/${model}`];
		} else if (!tiersOf(current).some((tier) => JEV_TIERS.has(tier))) tiers = ["jev"];
		if (tiers && config.state === "unreadable") {
			notes.push(
				this.t({
					zh: `${this.path(configPath)} 不是纯 JSON，没有改它。请手动加上 "tiers": ${JSON.stringify(tiers)}`,
					en: `${this.path(configPath)} is not plain JSON and was left as it is. Add "tiers": ${JSON.stringify(tiers)} by hand.`,
				}),
			);
		} else if (tiers) {
			backups.save(configPath);
			writeJsonFile(configPath, withTiers(current ?? {}, tiers));
			saved.push(
				this.savedLine(configPath, this.t({ zh: `判定器 ${tiers.join(", ")}`, en: `judge: ${tiers.join(", ")}` })),
			);
		}
		if (judge.kind === "jev") {
			backups.save(paths.envFile);
			writeEnvValue(paths.envFile, "TYPESAFE_API_KEY", judge.key);
			saved.push(
				this.savedLine(
					paths.envFile,
					this.t({ zh: "TYPESAFE_API_KEY（Jev 密钥）", en: "TYPESAFE_API_KEY (the Jev key)" }),
				),
			);
			if ("TYPESAFE_API_KEY" in env) {
				notes.push(
					this.t({
						zh: `注意：环境变量里也有 TYPESAFE_API_KEY，它比 ${this.path(paths.envFile)} 优先。到设置它的地方（例如 ~/.zshrc）改掉或删掉。`,
						en: `Note: TYPESAFE_API_KEY is also set in your environment, and it wins over ${this.path(paths.envFile)}. Change or remove it where it is set (~/.zshrc, for example).`,
					}),
				);
			}
		}
		const override = env.MU_JUDGE || env.KYRN_JUDGE;
		if (override) {
			notes.push(
				this.t({
					zh: `注意：环境变量 MU_JUDGE=${override} 比 mu.json 优先，由它决定判定器。`,
					en: `Note: MU_JUDGE=${override} is set in your environment; it decides the judge over mu.json.`,
				}),
			);
		}
	}

	private summary(target: Target | undefined, model: string | undefined, judge: JudgeChoice | undefined): void {
		const done =
			target && model
				? this.t({
						zh: `完成。mu 会用 ${this.name(target.service)} · ${model} 开始工作。`,
						en: `Done. mu starts on ${this.name(target.service)} · ${model}.`,
					})
				: this.t({ zh: "完成。", en: "Done." });
		const judged =
			judge === undefined
				? ""
				: judge.kind === "model"
					? this.t({ zh: "判定器：同一个模型。", en: " Judge: the same model." })
					: judge.kind === "none"
						? this.t({ zh: "判定器：暂时没有。", en: " Judge: none for now." })
						: this.t({ zh: "判定器：Jev。", en: " Judge: Jev." });
		this.io.say("");
		this.io.say(`${done}${judged}`);
		this.io.say(
			target
				? this.t({
						zh: "在 mu 里用 /model 换模型；随时可以再运行 mu setup。",
						en: "Switch models inside mu with /model; run mu setup again any time.",
					})
				: this.t({ zh: "启动 mu 后输入 /login 登录。", en: "Start mu and type /login to sign in." }),
		);
	}

	/** On its own, a finished setup offers a session; on a first start the launcher goes on into one anyway. */
	private async offerSession(): Promise<number> {
		if (this.args.firstRun || this.scripted) return SETUP_EXIT.done;
		const start = await this.confirm(this.t({ zh: "现在启动 mu 吗？[Y/n] ", en: "Start mu now? [Y/n] " }), true);
		return start ? SETUP_EXIT.start : SETUP_EXIT.done;
	}
}

function existingProviders(models: Record<string, unknown>): Record<string, Record<string, unknown>> {
	const providers = models.providers;
	return typeof providers === "object" && providers !== null && !Array.isArray(providers)
		? (providers as Record<string, Record<string, unknown>>)
		: {};
}

export async function runSetup(argv: readonly string[], deps: SetupDeps): Promise<number> {
	const parsed = parseSetupArgs(argv);
	if ("error" in parsed) {
		deps.io.warn(`mu setup: ${parsed.error[deps.language]}`);
		deps.io.warn(setupUsage(deps.language));
		return SETUP_EXIT.usage;
	}
	if (parsed.help) {
		deps.io.say(setupUsage(deps.language));
		return SETUP_EXIT.done;
	}
	if (parsed.list) {
		deps.io.say(serviceList(deps.language));
		return SETUP_EXIT.done;
	}
	return new Setup(parsed, deps).run();
}
