import { rmSync } from "node:fs";
import {
	type Context,
	enableCommand,
	humanOut,
	install,
	jsonOut,
	MUDE_PACKAGE,
	type MudeStatus,
	main as mudeMain,
	type Out,
	type Package,
	problems,
	requireInstalled,
	start,
	status,
} from "./command.ts";
import { disableLocal, MUDE, mudeInTiers, readState } from "./config.ts";
import { DownloadError, huggingFaceToken } from "./download.ts";
import { MUDE_REPO } from "./manifest.ts";
import {
	findRecord,
	listRecords,
	localJudgeOf,
	type ModelRecord,
	modelId,
	modelPaths,
	parseModelRef,
	resolveModel,
	SERVER_FILE,
	writeRecord,
} from "./models.ts";
import { mudePaths } from "./paths.ts";
import { stopServer } from "./server.ts";

/**
 * `mu judge model`: decision models from Hugging Face besides mude 1.0, downloaded, set up and run the way
 * `mu judge mude` runs mude (models.ts says which repositories mu can run), and switching the judge between them and
 * mude. The desktop app runs the same commands with --json.
 */

const USAGE = `mu judge model: decision models from Hugging Face, run on this Mac like mude 1.0

  mu judge model add <link or owner/name>[@revision] [--local-only]
                              download it, set it up, start it and make it the judge; run it again to resume
  mu judge model list         mude 1.0 and the models added here
  mu judge model use <name> [--local-only | --with-fallback]
                              make it the judge (mude for mude 1.0)
  mu judge model start | stop | status | disable <name>
  mu judge model remove <name>
                              stop it, take it out of the judge order and delete it

mu runs a repository packaged like mude 1.0's MLX edition, with its own ${SERVER_FILE}. Add --json for one JSON object per line.
`;

/** How `mu judge model` names, runs and resumes an added model. */
export function packageOf(record: ModelRecord): Package {
	const command = (what: string) => (what === "install" ? "add" : what === "enable" ? "use" : what);
	return {
		label: record.id,
		repo: record.repo,
		revision: record.revision,
		files: record.files,
		bytes: record.bytes,
		judge: localJudgeOf(record.id),
		served: record.id,
		install: `mu judge model add ${record.id}`,
		again: (what) => `mu judge model ${command(what)} ${record.id}`,
	};
}

/** `ctx` (mude's, as contextFromEnv makes it) for an added model: its own folder, key and server, mude's Python. */
export function modelContext(ctx: Context, record: ModelRecord): Context {
	return { ...ctx, paths: modelPaths(ctx.files.home, record), pkg: packageOf(record) };
}

export interface ModelSummary {
	/** Its name in the judge order and in these commands. */
	readonly name: string;
	readonly label: string;
	readonly repo: string;
	readonly revision: string;
	readonly bytes: number;
	readonly builtIn: boolean;
	readonly installed: boolean;
	readonly downloadedBytes: number;
	readonly running: boolean;
	readonly ready: boolean;
	/** It is the judge: first in the judge order. */
	readonly enabled: boolean;
	readonly localOnly: boolean;
}

function summary(pkg: Package, state: MudeStatus, builtIn: boolean): ModelSummary {
	return {
		name: pkg.judge.name,
		label: pkg.label,
		repo: pkg.repo,
		revision: pkg.revision,
		bytes: pkg.bytes,
		builtIn,
		installed: state.installed && state.pythonReady,
		downloadedBytes: state.downloadedBytes,
		running: state.running,
		ready: state.ready,
		enabled: state.enabled,
		localOnly: state.localOnly,
	};
}

/** mude 1.0, then every model added here. */
export async function listModels(ctx: Context): Promise<ModelSummary[]> {
	const mude = { ...ctx, paths: mudePaths(ctx.files.home), pkg: undefined };
	const models = [summary(MUDE_PACKAGE, await status(mude), true)];
	for (const record of listRecords(ctx.files.home)) {
		const each = modelContext(ctx, record);
		models.push(summary(packageOf(record), await status(each), false));
	}
	return models;
}

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

function describeList(models: readonly ModelSummary[]): string {
	const width = Math.max(...models.map((model) => model.name.length));
	const lines = models.map((model) => {
		const state = model.installed
			? model.ready
				? "running"
				: model.running
					? "starting"
					: "installed"
			: model.downloadedBytes > 0
				? `${gb(model.downloadedBytes)} of ${gb(model.bytes)} GB downloaded`
				: model.builtIn
					? "not installed"
					: "not downloaded";
		const judge = model.enabled ? (model.localOnly ? " · the judge, on its own" : " · the judge") : "";
		return `${model.name.padEnd(width)}  ${model.repo} @ ${model.revision.slice(0, 7)} · ${gb(model.bytes)} GB · ${state}${judge}`;
	});
	return `${lines.join("\n")}\n`;
}

/** mude 1.0, by its name, its repository or a link to it (at any revision: mu runs the one it pins). */
function isMude(name: string): boolean {
	if (name.toLowerCase() === MUDE) return true;
	try {
		return parseModelRef(name).repo.toLowerCase() === MUDE_REPO.toLowerCase();
	} catch {
		return false;
	}
}

export interface ModelOptions {
	/** Asks Hugging Face which commit and files a model has (tests pass their own). */
	readonly fetch?: typeof fetch;
}

/**
 * Looks the model `name` up on Hugging Face and records it, or finds the one recorded already: its id or repository
 * goes on with that one, at the commit it was pinned at. A revision or a link asks Hugging Face again.
 */
async function addRecord(ctx: Context, name: string, out: Out, options: ModelOptions): Promise<ModelRecord> {
	const home = ctx.files.home;
	const known = findRecord(home, name);
	if (known) return known;
	const ref = parseModelRef(name);
	const existing = findRecord(home, ref.repo);
	if (existing && ref.revision === undefined) return existing;
	out.step("resolve", `Looking up ${ref.repo}${ref.revision ? ` at ${ref.revision}` : ""} on Hugging Face`);
	const resolved = await resolveModel(ref, {
		endpoint: ctx.env.HF_ENDPOINT || undefined,
		token: huggingFaceToken(ctx.env),
		fetch: options.fetch,
	});
	const id = existing?.id ?? modelId(ref.repo, new Set(listRecords(home).map((record) => record.id)));
	if (existing && existing.revision !== resolved.revision) {
		// Another commit of a model added before: its files replace the old ones.
		rmSync(modelPaths(home, existing).model, { recursive: true, force: true });
	}
	const record: ModelRecord = {
		id,
		repo: ref.repo,
		revision: resolved.revision,
		files: resolved.files,
		bytes: resolved.files.reduce((sum, file) => sum + file.size, 0),
	};
	writeRecord(home, record);
	return record;
}

export async function modelMain(
	argv: readonly string[],
	ctx: Context,
	write: (text: string) => void,
	tty = false,
	options: ModelOptions = {},
): Promise<number> {
	const json = argv.includes("--json");
	const args = argv.filter((arg) => arg !== "--json");
	let out = json ? jsonOut(write) : humanOut(write, tty);
	const command = args[0] ?? "list";
	const names = args.slice(1).filter((arg) => !arg.startsWith("--"));
	const flags = args.slice(1).filter((arg) => arg.startsWith("--"));
	try {
		if (command === "help" || command === "--help" || command === "-h") {
			write(USAGE);
			return 0;
		}
		const unknown = flags.find((flag) => !["--local-only", "--with-fallback", "--no-wait"].includes(flag));
		if (unknown) {
			out.error(`Unknown option for mu judge model ${command}: ${unknown} (mu judge model help)`, "usage");
			return 2;
		}
		if (command === "list") {
			const models = await listModels(ctx);
			if (json) write(`${JSON.stringify({ type: "models", models })}\n`);
			else write(describeList(models));
			return 0;
		}
		if (!["add", "use", "start", "stop", "status", "disable", "remove"].includes(command)) {
			out.error(`Unknown command: mu judge model ${command}\n\n${USAGE}`, "usage");
			return 2;
		}
		const name = names[0];
		if (!name || names.length > 1) {
			out.error(
				`Name one model: mu judge model ${command} <${command === "add" ? "link or owner/name" : "name"}>`,
				"usage",
			);
			return 2;
		}
		// mude 1.0 itself, by its name or its repository: `mu judge mude` does that.
		if (isMude(name)) {
			const as = { add: "install", use: "enable", remove: "uninstall" }[command] ?? command;
			return mudeMain([as, ...flags, ...(json ? ["--json"] : [])], ctx, write, tty);
		}
		const home = ctx.files.home;
		const unsupported = problems();
		if (command === "add") {
			if (unsupported.length > 0) {
				out.error(`Decision models can't run on this machine: ${unsupported.join("; ")}.`, "unsupported");
				return 1;
			}
			const record = await addRecord(ctx, name, out, options);
			const each = modelContext(ctx, record);
			if (json)
				write(
					`${JSON.stringify({ type: "model", name: record.id, repo: record.repo, revision: record.revision, bytes: record.bytes })}\n`,
				);
			else out = humanOut(write, tty, each.pkg);
			out.step(
				"model",
				`${record.repo} @ ${record.revision.slice(0, 7)} (${gb(record.bytes)} GB) is the decision model ${record.id}. It runs its own server code (${SERVER_FILE}) on this Mac: add only models you trust.`,
			);
			await install(each, out, flags, mudePaths(home));
			out.status(await status(each));
			return 0;
		}
		const record = findRecord(home, name);
		if (!record) {
			out.error(
				`No decision model ${name} here (mu judge model list). Add it: mu judge model add <link or owner/name>`,
				"usage",
			);
			return 1;
		}
		const each = modelContext(ctx, record);
		const pkg = packageOf(record);
		if (!json) out = humanOut(write, tty, pkg);
		if (unsupported.length > 0 && (command === "use" || command === "start")) {
			out.error(`${record.id} can't run on this machine: ${unsupported.join("; ")}.`, "unsupported");
			return 1;
		}
		switch (command) {
			case "use":
				await enableCommand(each, out, flags);
				break;
			case "start":
				requireInstalled(each);
				await start(each, out, "start", !flags.includes("--no-wait"));
				break;
			case "stop": {
				const stopped = await stopServer(each.paths);
				out.step(
					"stop",
					stopped ? `The ${record.id} server is stopped.` : `The ${record.id} server was not running.`,
				);
				break;
			}
			case "disable": {
				const was = mudeInTiers(ctx.files, record.id);
				const tiers = was ? disableLocal(pkg.judge, each.paths, ctx.files) : [];
				const stopped = await stopServer(each.paths);
				out.step(
					"disable",
					was
						? `${record.id} is no longer the judge: ${tiers.join(" > ")} again${stopped ? ", and its server is stopped" : ""}.`
						: `${record.id} was not the judge${stopped ? "; its server is stopped" : ""}.`,
				);
				break;
			}
			case "remove": {
				if (mudeInTiers(ctx.files, record.id) || readState(each.paths)?.wroteEntry) {
					const tiers = disableLocal(pkg.judge, each.paths, ctx.files, { removeEntry: true });
					out.step("disable", `${record.id} is no longer the judge: ${tiers.join(" > ")} again.`);
				}
				await stopServer(each.paths);
				rmSync(each.paths.root, { recursive: true, force: true });
				out.step("remove", `Deleted ${each.paths.root}: the model and its key.`);
				return 0;
			}
		}
		out.status(await status(each));
		return 0;
	} catch (error) {
		const kind = error instanceof DownloadError ? error.kind : undefined;
		out.error(error instanceof Error ? error.message : String(error), kind);
		return 1;
	}
}
