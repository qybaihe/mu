import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionContext,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { say } from "../../language.ts";
import { muEnv } from "../../naming.ts";
import { NEBIUS_SANDBOX_API, SandboxClient, type Sleep } from "../../sandbox/client.ts";
import { type SandboxOperations, sandboxOperations } from "../../sandbox/operations.ts";
import { applyPatchLocally, formatDiffstat } from "../../sandbox/project.ts";
import { SandboxSession, type SandboxSessionOptions, type SandboxStatus } from "../../sandbox/session.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

const STATUS_KEY = "kyrn.sandbox";
/** `MU_SANDBOX` values that keep the sandbox off, whatever mu.json says. Any other value turns it on. */
const OFF: ReadonlySet<string> = new Set(["off", "0", "false", "no", "local"]);
const MISSING_KEY =
	"The Nebius sandbox is on (features.sandbox in mu.json, or MU_SANDBOX) but NEBIUS_API_KEY and NEBIUS_PROJECT_ID are not both set. Nothing ran, here or in the sandbox.";

export interface SandboxDeps {
	readonly fetch?: typeof fetch;
	/** Where NEBIUS_API_KEY, NEBIUS_PROJECT_ID and MU_SANDBOX are read. Default: process.env. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly sleep?: Sleep;
	readonly pack?: SandboxSessionOptions["pack"];
}

/** What the model is told, among the bash tool's guidelines in the system prompt. */
function guidelines(workdir: string): string[] {
	return [
		`bash, read, write and edit act on a Nebius Token Factory sandbox, a VM holding a copy of the project at ${workdir}, not on this machine. Relative paths and paths under the working directory mean the same paths under ${workdir}.`,
		"Each bash call runs in a fresh sandbox VM that starts from the files the previous call left: files persist, background processes, servers and shell state do not. Start a server and talk to it in the same call.",
		`${workdir} is a git repository whose first commit is the copy of the project; the project's own git history is not there. The user brings your changes back to this machine with /sandbox pull.`,
	];
}

function describeStatus(status: SandboxStatus, image: string): string {
	const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	const lines = [`Nebius sandbox: ${status.state}`, `  project      ${status.root}`];
	lines.push(`  base image   ${status.baseImage ?? image}`);
	if (status.seedImage && status.seeded) {
		const source = status.seeded.fromGit ? "git ls-files" : "folder walk";
		lines.push(
			`  seed image   ${status.seedImage} (${status.seeded.files} files, ${mb(status.seeded.bytes)}, ${source})`,
		);
	}
	if (status.head) lines.push(`  head image   ${status.head}`);
	lines.push(`  operations   ${status.operations} (cost ${status.cost.toFixed(4)}, as the API reports it)`);
	if (status.staged > 0) lines.push(`  staged       ${status.staged} file(s), put in place by the next command`);
	lines.push(
		"base" in status.pull
			? `  pull         diffs against ${status.pull.base}`
			: `  pull         ${status.pull.problem}`,
	);
	if (status.lastError) lines.push(`  last error   ${status.lastError}`);
	return lines.join("\n");
}

/** Operations that fail with `error`: with the sandbox on and no key, nothing may fall back to this machine. */
function failing(error: Error): SandboxOperations {
	const fail = async (): Promise<never> => {
		throw error;
	};
	return {
		bash: { exec: fail },
		read: { readFile: fail, access: fail },
		write: { writeFile: fail, mkdir: fail },
		edit: { readFile: fail, writeFile: fail, access: fail },
	};
}

/**
 * bash, read, write and edit in a Nebius Token Factory sandbox instead of on this machine, for agents
 * that write, run and test code there. Off by default: `features.sandbox` in mu.json, or MU_SANDBOX=nebius.
 *
 * The project is copied in once (`git ls-files -co --exclude-standard`, or the folder without .git and
 * node_modules), then every command starts from the image the previous one left. Writes are uploaded
 * and put in place by the next command; reads look at those first, then at the latest image, without a
 * VM. Nothing comes back to this machine until the user runs `/sandbox pull` and agrees to the diff.
 */
export function registerSandbox(runtime: KyrnRuntime, deps: SandboxDeps = {}): void {
	const options = runtime.options("sandbox", {
		enabled: false,
		/** An image UUID, `tag:<name>`, or `docker://<reference>` imported on first use. Needs bash and tar; git for pulls. */
		image: "tag:ubuntu:latest",
		baseUrl: NEBIUS_SANDBOX_API,
		workdir: "/workspace",
		shell: "/bin/bash",
		/** Seconds a command may run when the model sets no timeout. */
		timeoutS: 600,
		seedTimeoutS: 900,
		maxSeedMB: 100,
		/** Bytes of stdout and of stderr kept per command, at most 10 MiB. */
		outputBytes: 1_048_576,
	});
	const env = deps.env ?? process.env;
	const switched = muEnv("SANDBOX", env)?.trim().toLowerCase();
	if (!(switched ? !OFF.has(switched) : options.enabled)) return;
	const { pi } = runtime;
	let connection: { session: SandboxSession; client: SandboxClient } | undefined;

	/** One sandbox per mu process, seeded from the folder of the first tool call. */
	const connect = (cwd: string): { session: SandboxSession; client: SandboxClient } => {
		if (connection) return connection;
		const apiKey = env.NEBIUS_API_KEY?.trim();
		const project = env.NEBIUS_PROJECT_ID?.trim();
		if (!apiKey || !project) throw new Error(MISSING_KEY);
		const client = new SandboxClient({
			apiKey,
			project,
			baseUrl: options.baseUrl,
			fetch: deps.fetch,
			sleep: deps.sleep,
		});
		const session = new SandboxSession({
			client,
			root: cwd,
			image: options.image,
			workdir: options.workdir,
			shell: options.shell,
			seedTimeoutS: options.seedTimeoutS,
			maxSeedBytes: options.maxSeedMB * 1024 * 1024,
			outputBytes: Math.min(options.outputBytes, 10 * 1024 * 1024),
			pack: deps.pack,
		});
		connection = { session, client };
		return connection;
	};
	const operationsFor = (cwd: string): SandboxOperations => {
		try {
			return sandboxOperations(connect(cwd).session, { defaultTimeoutS: options.timeoutS });
		} catch (error) {
			return failing(error instanceof Error ? error : new Error(String(error)));
		}
	};
	const showStatus = (ctx: ExtensionContext, text: string | undefined): void => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	};

	const bash = createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false });
	pi.registerTool({
		...bash,
		description: `${bash.description} It runs in a Nebius sandbox VM (the project is at ${options.workdir}); each call starts from the files the last one left, with no processes or shell state kept.`,
		promptSnippet: "Execute bash commands in the Nebius sandbox",
		promptGuidelines: guidelines(options.workdir),
		async execute(id, params, signal, onUpdate, ctx) {
			runtime.touch(ctx);
			const tool = createBashToolDefinition(ctx.cwd, {
				operations: operationsFor(ctx.cwd).bash,
				exposeSessionEnvironment: false,
			});
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});
	const read = createReadToolDefinition(process.cwd());
	pi.registerTool({
		...read,
		async execute(id, params, signal, onUpdate, ctx) {
			runtime.touch(ctx);
			return createReadToolDefinition(ctx.cwd, { operations: operationsFor(ctx.cwd).read }).execute(
				id,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	});
	const write = createWriteToolDefinition(process.cwd());
	pi.registerTool({
		...write,
		async execute(id, params, signal, onUpdate, ctx) {
			runtime.touch(ctx);
			return createWriteToolDefinition(ctx.cwd, { operations: operationsFor(ctx.cwd).write }).execute(
				id,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	});
	// The edit tool's own matching, diff and line-ending handling, reading and writing the sandbox.
	const edit = createEditToolDefinition(process.cwd());
	pi.registerTool({
		...edit,
		async execute(id, params, signal, onUpdate, ctx) {
			runtime.touch(ctx);
			return createEditToolDefinition(ctx.cwd, { operations: operationsFor(ctx.cwd).edit }).execute(
				id,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	// The user's own `!command` runs where the agent's do.
	pi.on("user_bash", (event) => ({ operations: operationsFor(event.cwd).bash }));

	// Seeding takes a while (an upload and a VM); it starts with the session instead of with the first command.
	pi.on(
		"session_start",
		failOpen<SessionStartEvent, undefined>((_event, ctx) => {
			runtime.touch(ctx);
			let session: SandboxSession;
			try {
				session = connect(ctx.cwd).session;
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				showStatus(ctx, "sandbox: no key");
				return undefined;
			}
			if (session.status().state === "ready") return undefined;
			showStatus(ctx, "sandbox: seeding");
			session.ready().then(
				() => showStatus(ctx, "sandbox: ready"),
				(error: unknown) => {
					showStatus(ctx, "sandbox: failed");
					if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				},
			);
			return undefined;
		}),
	);

	pi.registerCommand("sandbox", {
		description: say({
			zh: "Nebius 沙箱：/sandbox status 查看状态，/sandbox pull 查看并带回沙箱里的改动，/sandbox whoami 查看密钥权限",
			en: "Nebius sandbox: /sandbox status, /sandbox pull (review and bring its changes here), /sandbox whoami",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const verb = args.trim().split(/\s+/)[0] || "status";
			let current: { session: SandboxSession; client: SandboxClient };
			try {
				current = connect(ctx.cwd);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const { session, client } = current;
			try {
				if (verb === "status") {
					ctx.ui.notify(describeStatus(session.status(), options.image), "info");
				} else if (verb === "whoami") {
					const who = await client.whoami();
					const granted = Object.entries(who.permissions)
						.map(([name, ok]) => `${name} ${ok ? "yes" : "no"}`)
						.join(", ");
					const limits = Object.entries(who.limits ?? {})
						.map(([name, value]) => `${name} ${value}`)
						.join(", ");
					ctx.ui.notify(
						`Token ${who.token_uuid}\n  permissions  ${granted}\n  limits       ${limits || "none listed"}`,
						"info",
					);
				} else if (verb === "pull") {
					ctx.ui.notify("Diffing the sandbox against the last pull…", "info");
					let outcome = "Nothing was applied.";
					let applied = false;
					const plan = await session.pull(async (found) => {
						const stat = formatDiffstat(found.stats);
						const agreed = await ctx.ui.confirm(
							"mu: apply the sandbox's changes here?",
							`${stat}\n\nApply this to ${session.root}? Nothing is staged or committed.`,
						);
						if (!agreed) return false;
						const result = await applyPatchLocally(session.root, found.patch);
						if (!result.ok) {
							outcome = `The sandbox's changes do not apply here, so no file was changed:\n${result.reason}`;
							return false;
						}
						applied = true;
						outcome = `Applied the sandbox's changes:\n${stat}`;
						return true;
					});
					if (plan.patch.length === 0) outcome = "Nothing changed in the sandbox since the last pull.";
					ctx.ui.notify(outcome, applied || plan.patch.length === 0 ? "info" : "warning");
				} else {
					ctx.ui.notify("Usage: /sandbox [status | pull | whoami]", "warning");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
