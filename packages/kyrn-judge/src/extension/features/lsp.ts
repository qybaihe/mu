import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	type AgentEndEvent,
	CONFIG_DIR_NAME,
	type ExtensionContext,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { diagnosticsDelivery } from "../../decisions/diagnostics-delivery.ts";
import { say } from "../../language.ts";
import { formatReport, lineMap, type ReportItem } from "../../lsp/diagnostics.ts";
import { LspManager } from "../../lsp/manager.ts";
import { mergeServers, type ServerSpec } from "../../lsp/servers.ts";
import { DiagnosticsTracker, type Tracked } from "../../lsp/tracker.ts";
import { clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";

export const DIAGNOSTICS_MESSAGE = "kyrn.diagnostics";
/** A project names its own servers here, next to pi's project settings. */
export const PROJECT_SERVERS_FILE = "lsp.json";

/**
 * May a server that the repository names be started? pi reports a project as
 * trusted when it found nothing that needs trust, and a lone `lsp.json` is
 * nothing pi knows about. So pi's word only counts when it actually had to
 * ask; otherwise a saved decision for this folder (`/trust`) is required.
 */
export function projectServersTrusted(
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	agentDir: string,
): boolean {
	if (!ctx.isProjectTrusted()) return false;
	if (hasTrustRequiringProjectResources(ctx.cwd)) return true;
	try {
		return new ProjectTrustStore(agentDir).get(ctx.cwd) === true;
	} catch {
		return false;
	}
}

function weight(item: Tracked): number {
	return item.path.length + item.diagnostic.message.length + 24;
}

/**
 * Diagnostics from the language servers already installed on this machine,
 * narrowed to what the agent's own edits introduced, and told when it helps:
 *
 * - before an edit the file is opened with its current text, so the server's
 *   word on that text is the baseline; nothing waits for the server here;
 * - after the edit the new text goes to the server, and for at most `settleMs`
 *   the tool result waits for what is new;
 * - `diagnostics.delivery` decides between now (appended to that tool result),
 *   when the model pauses, and never (style noise);
 * - whatever was decided, errors that are still there when the model stops are
 *   delivered once, so "done" is never said over a build this turn broke.
 *
 * Nothing is installed and nothing starts until a matching file is edited. With
 * no server on PATH the feature does nothing at all.
 */
export function registerLsp(runtime: KyrnRuntime): void {
	const options = runtime.options("lsp", {
		enabled: true,
		/** Use the table of well-known servers (looked up on PATH, never installed). */
		builtin: true,
		/** Add, override or remove (`false`) servers: `{ "<id>": { command, args, extensions, rootMarkers } }`. */
		servers: {} as Record<string, unknown>,
		editTools: ["edit", "write"],
		/** Sub-agents of a swarm or hive start no servers of their own unless this is set: five bees, five rust-analyzers. */
		subAgents: false,
		settleMs: 1500,
		turnEndSettleMs: 3000,
		quietMs: 250,
		baselineMs: 5000,
		maxItems: 10,
		maxServers: 4,
		maxFileBytes: 2_000_000,
		waitMs: 4000,
	});
	if (!options.enabled || (process.env.KYRN_SWARM_DEPTH && !options.subAgents)) return;
	const { pi } = runtime;

	runtime.catalog.register({
		id: "lsp:diagnostics",
		kind: "lsp",
		title: "Language server diagnostics",
		description:
			"Errors and warnings that an edit newly introduced, from the language servers installed on this machine, told when the judge finds the moment right.",
		tools: [],
		exposure: "always",
	});

	const tracker = new DiagnosticsTracker();
	const manager = new LspManager({
		quietMs: options.quietMs,
		baselineMs: options.baselineMs,
		maxServers: options.maxServers,
		onTextChange: (path, oldText, newText) => tracker.remap(path, lineMap(oldText, newText)),
	});
	/** Edits in flight: tool call id to the file it changes. */
	const calls = new Map<string, string>();
	let edited = new Set<string>();
	let recentEdits: string[] = [];
	let toldAtTurnEnd = false;
	let table:
		| { trusted: boolean; cwd: string; servers: ServerSpec[]; problems: string[]; ignoredProjectFile: boolean }
		| undefined;

	const servers = (ctx: ExtensionContext, refresh = false) => {
		if (table && table.cwd === ctx.cwd && !refresh) return table;
		let project: unknown;
		try {
			const file = join(ctx.cwd, CONFIG_DIR_NAME, PROJECT_SERVERS_FILE);
			project = (JSON.parse(readFileSync(file, "utf8")) as { servers?: unknown }).servers;
		} catch {
			project = undefined;
		}
		// The trust store is only consulted for a project that names servers at all.
		const trusted = project !== undefined && projectServersTrusted(ctx, getAgentDir());
		const merged = mergeServers(
			[
				{ origin: "user", servers: options.servers },
				// An untrusted project's file is not even merged: it could also switch a trusted server's command.
				...(trusted && project !== undefined ? [{ origin: "project" as const, servers: project }] : []),
			],
			options.builtin ? undefined : [],
		);
		table = { trusted, cwd: ctx.cwd, ...merged, ignoredProjectFile: project !== undefined && !trusted };
		for (const spec of manager.detect(table.servers)) {
			if (!spec.chosen) continue;
			runtime.catalog.register({
				id: `lsp:${spec.spec.id}`,
				kind: "lsp",
				title: spec.spec.id,
				description: `Language server for ${spec.spec.extensions.join(" ")} files. Starts on the first edit of one.`,
				tools: [],
				exposure: "always",
			});
		}
		return table;
	};

	/** The file's text, `undefined` when it does not exist, `false` when it is nothing to show a language server. */
	const read = (path: string): string | undefined | false => {
		try {
			if (statSync(path).size > options.maxFileBytes) return false;
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	};

	const local = (ctx: ExtensionContext, path: string) => relative(ctx.cwd, path) || path;
	const present = (
		kind: "delivered" | "held" | "dropped",
		items: readonly Tracked[],
		ctx: ExtensionContext,
		extra: object,
	) => {
		if (items.length === 0) return;
		runtime.present(`diagnostics.${kind}`, {
			errors: items.filter((item) => item.diagnostic.severity === 1).length,
			warnings: items.filter((item) => item.diagnostic.severity === 2).length,
			files: [...new Set(items.map((item) => local(ctx, item.path)))],
			...extra,
		});
	};
	const withhold = (items: readonly Tracked[]) => {
		for (const item of items) runtime.savings.diagnosticsWithheldChars += weight(item);
	};
	const asReport = (items: readonly Tracked[]): ReportItem[] =>
		items.map((item) => ({
			path: item.path,
			diagnostic: item.diagnostic,
			elsewhere: item.elsewhere,
			unchecked: !item.checked,
		}));

	/** Takes in what the servers call new, and lets go of what they no longer report. */
	const collect = () => {
		for (const { path, diagnostics } of manager.fresh()) tracker.add(path, diagnostics, !edited.has(path));
		for (const path of new Set(tracker.all().map((item) => item.path))) {
			const now = manager.current(path);
			if (now) withhold(tracker.revalidate(path, now));
		}
	};

	const newTurn = () => {
		tracker.reset();
		calls.clear();
		edited = new Set();
		recentEdits = [];
		toldAtTurnEnd = false;
	};

	pi.on(
		"session_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			newTurn();
			servers(ctx);
			return undefined;
		}),
	);

	pi.on(
		"input",
		failOpen((event) => {
			if (event.source !== "extension" && !event.streamingBehavior) newTurn();
			return undefined;
		}),
	);

	pi.on(
		"message_end",
		failOpen((event) => {
			const message = event.message as { role?: unknown; content?: unknown };
			if (message.role !== "assistant") return undefined;
			const text = textOf(message.content);
			if (text.trim()) runtime.lastAssistantText = text;
			return undefined;
		}),
	);

	pi.on(
		"tool_call",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			if (!options.editTools.includes(event.toolName)) return undefined;
			const raw = (event.input as { path?: unknown }).path;
			if (typeof raw !== "string" || !raw.trim()) return undefined;
			const named = raw.startsWith("@") ? raw.slice(1) : raw;
			const file = resolve(
				ctx.cwd,
				named === "~" || named.startsWith("~/") ? join(homedir(), named.slice(1)) : named,
			);
			const { servers: specs, trusted } = servers(ctx);
			const serving = manager.serving(file, specs, trusted);
			if (serving.length === 0) return undefined;
			const text = read(file);
			if (text === false) return undefined;
			// Whatever became new since the last look is taken in before this edit makes it part of the baseline.
			for (const entry of manager.beforeEdit(file, text, serving, ctx.cwd)) {
				tracker.add(entry.path, entry.diagnostics, !edited.has(entry.path));
			}
			calls.set(event.toolCallId, file);
			return undefined;
		}),
	);

	pi.on(
		"tool_result",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			const file = calls.get(event.toolCallId);
			if (!file) return undefined;
			calls.delete(event.toolCallId);
			const text = read(file);
			manager.afterEdit(file, text === false ? undefined : text);
			if (text === undefined) tracker.forget(file);
			if (event.isError) return undefined;
			edited.add(file);
			recentEdits = [...recentEdits, file].slice(-3);

			await manager.waitSettled(options.settleMs, [file]);
			collect();
			const unjudged = tracker.withStatus("unjudged");
			if (unjudged.length === 0) return undefined;

			const errors = unjudged.filter((item) => item.diagnostic.severity === 1);
			const warnings = unjudged.filter((item) => item.diagnostic.severity === 2);
			const brief = (items: readonly Tracked[]) =>
				items
					.slice(0, 6)
					.map((item) =>
						clip(
							`${local(ctx, item.path)}:${item.diagnostic.line + 1} ${item.diagnostic.code ?? ""} ${item.diagnostic.message}`,
							160,
						),
					);
			const input = {
				newErrors: brief(errors),
				newWarnings: brief(warnings),
				errorCount: errors.length,
				warningCount: warnings.length,
				elsewhereCount: unjudged.filter((item) => item.elsewhere).length,
				inEditedFileCount: unjudged.filter((item) => item.path === file).length,
				statedIntent: clip(runtime.lastAssistantText, 400),
				editedFile: local(ctx, file),
				filesEditedThisTurn: edited.size,
				sameFileEditedRepeatedly: recentEdits.filter((path) => path === file).length >= 2,
			};
			const judged = () => runtime.engine.decide(diagnosticsDelivery, input, { signal: ctx.signal });
			// Shadow records what it would have delivered; only an active verdict is worth holding the result for.
			let decision: Awaited<ReturnType<typeof judged>> | undefined;
			if (runtime.mode(diagnosticsDelivery.id) !== "active") {
				void runtime.engine.decide(diagnosticsDelivery, input).catch(() => {});
			} else {
				decision = await Promise.race([
					judged(),
					new Promise<undefined>((done) => setTimeout(() => done(undefined), options.waitMs)),
				]);
			}
			// No verdict to act on (judge down, shadow, off, too slow): errors wait for the end of the turn, warnings are not told.
			const outcome =
				decision?.source === "judge" ? decision.outcome : ({ errors: "hold", warnings: "drop" } as const);
			const by = decision?.source === "judge" ? "judge" : "rule";

			const now = [...(outcome.errors === "now" ? errors : []), ...(outcome.warnings === "now" ? warnings : [])];
			const held = [...(outcome.errors === "hold" ? errors : []), ...(outcome.warnings === "hold" ? warnings : [])];
			const dropped = outcome.warnings === "drop" ? warnings : [];
			tracker.mark(held, "held");
			tracker.mark(dropped, "dropped");
			withhold(dropped);
			present("held", held, ctx, { by });
			present("dropped", dropped, ctx, { by });
			if (now.length === 0) return undefined;

			const report = formatReport(asReport(now), { cwd: ctx.cwd, max: options.maxItems });
			tracker.mark(now, "delivered");
			runtime.savings.diagnosticsWithheldChars += report.omitted * 80;
			present("delivered", now, ctx, { by, when: "edit", omitted: report.omitted });
			return { content: [...event.content, { type: "text" as const, text: report.text }] };
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>(async (event, ctx) => {
			runtime.touch(ctx);
			if (toldAtTurnEnd || (edited.size === 0 && tracker.all().length === 0)) return undefined;
			const last = [...event.messages].reverse().find((message) => message.role === "assistant");
			// The user stopped the run, or the model call failed: starting another turn is not ours to decide.
			const stopReason = (last as { stopReason?: unknown } | undefined)?.stopReason;
			if (stopReason === "aborted" || stopReason === "error") return undefined;

			// A shell command may have fixed (or changed) what an edit broke: the servers get the files as they are now.
			manager.syncFromDisk((path) => {
				const text = read(path);
				return text === false ? undefined : text;
			});
			await manager.waitSettled(options.turnEndSettleMs);
			collect();

			// The rule that needs no judge: errors this turn introduced and that are still there are told once,
			// whatever was decided about them earlier. Warnings are told only when the judge asked to hold them.
			const errors = tracker.all().filter((item) => item.diagnostic.severity === 1);
			const warnings = tracker.withStatus("held").filter((item) => item.diagnostic.severity === 2);
			const unheard = tracker.withStatus("unjudged").filter((item) => item.diagnostic.severity === 2);
			tracker.mark(unheard, "dropped");
			withhold(unheard);
			present("dropped", unheard, ctx, { by: "rule" });
			const items = [...errors, ...warnings];
			if (items.length === 0) return undefined;

			toldAtTurnEnd = true;
			const report = formatReport(asReport(items), { cwd: ctx.cwd, max: options.maxItems });
			tracker.mark(items, "delivered");
			runtime.savings.diagnosticsWithheldChars += report.omitted * 80;
			present("delivered", items, ctx, { by: "rule", when: "turn_end", omitted: report.omitted });
			if (errors.length > 0) {
				runtime.nudgedEnds.add(event);
				pi.sendMessage(
					{
						customType: DIAGNOSTICS_MESSAGE,
						content: `Your edits in this turn introduced errors that are still there. Fix them, or say plainly why they are acceptable, before calling the work done.\n${report.text}`,
						display: true,
					},
					{ triggerTurn: true },
				);
			} else {
				// Warnings alone are not worth another model turn: they ride along with the user's next message.
				pi.sendMessage(
					{ customType: DIAGNOSTICS_MESSAGE, content: report.text, display: true },
					{ deliverAs: "nextTurn" },
				);
			}
			return undefined;
		}),
	);

	pi.on(
		"session_shutdown",
		failOpen<SessionShutdownEvent, undefined>(async () => {
			await manager.stopAll();
			return undefined;
		}),
	);

	pi.registerCommand("lsp", {
		description: say({
			zh: "语言服务器：装了哪些、哪些在运行、最近一次出错",
			en: "Language servers: which are installed, which are running, and the last error",
		}),
		handler: async (_args, ctx) => {
			runtime.touch(ctx);
			const known = servers(ctx, true);
			const lines = manager.status(known.servers, known.trusted).flatMap((server) => {
				const where =
					server.use === "missing"
						? "not installed"
						: server.use === "untrusted"
							? `${server.executable} · named by this project, which is not trusted: not started`
							: server.use === "alternative"
								? `${server.executable} · installed, another server handles these files`
								: server.executable;
				return [
					`${server.use === "used" ? "ok  " : "--  "}${server.id.padEnd(28)} ${server.extensions.join(" ")} · ${where}${
						server.origin === "built-in" ? "" : ` (${server.origin})`
					}`,
					...server.running.map(
						(run) =>
							`      ${run.state} in ${run.root} · ${run.documents} open · started ${run.starts}x${
								run.lastError ? ` · last error: ${run.lastError}` : ""
							}`,
					),
				];
			});
			if (known.ignoredProjectFile) {
				lines.push(
					`${join(CONFIG_DIR_NAME, PROJECT_SERVERS_FILE)} names servers for this project. It is ignored until the project is trusted (/trust).`,
				);
			}
			for (const problem of known.problems) lines.push(`problem: ${problem}`);
			const pending = tracker.all().length;
			lines.push(
				`${pending} new diagnostic${pending === 1 ? "" : "s"} tracked this turn · kept out of the context so far: ${runtime.savings.diagnosticsWithheldChars} chars`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
