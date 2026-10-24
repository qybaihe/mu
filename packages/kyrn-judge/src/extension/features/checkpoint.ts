import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AgentEndEvent,
	ExtensionCommandContext,
	ExtensionContext,
	SessionShutdownEvent,
	ToolExecutionEndEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { GitMissing, type GitRun, GitUnusable, spawnGit } from "../../checkpoint/git.ts";
import { isCheckCommand, isMutatingCall } from "../../checkpoint/mutating.ts";
import {
	applyRestore,
	BUILT_IN_IGNORES,
	collectGarbage,
	diff,
	hasCommit,
	isWithin,
	openStore,
	planRestore,
	prune,
	type RestorePlan,
	type RestoreResult,
	releaseLocks,
	type ScanLimits,
	SnapshotTooLarge,
	type Store,
	scan,
	snapshot,
	sweepProjects,
} from "../../checkpoint/store.ts";
import { turnRewind } from "../../decisions/turn-rewind.ts";
import type { Coded } from "../../language.ts";
import { say } from "../../language.ts";
import { muHome } from "../../naming.ts";
import { askWithin, clip, failOpen, type KyrnRuntime, textOf, within } from "../runtime.ts";
import { describeCall } from "./admission.ts";
import type { HarnessRoots } from "./inherit.ts";
import { isUnattended } from "./unattended.ts";

export const CHECKPOINT_ENTRY = "kyrn.checkpoint";
export const REWOUND_ENTRY = "kyrn.rewound";
export const REWIND_MESSAGE = "kyrn.rewind";

export type RewindScope = "both" | "files" | "conversation";

/** One per user turn that went on to change files. Lives in the session, so it follows the session tree. */
export type CheckpointEntry = {
	id: number;
	turn: number;
	commit: string;
	/** The user message the turn started with: where the conversation goes back to. */
	entryId?: string;
	label: string;
	at: number;
};

/** A rewind that happened. `undo` is the snapshot taken right before it, which is what `/rewind undo` restores. */
export type RewoundEntry = {
	to: number | "undo";
	undo?: string;
	fromLeaf?: string | null;
	scope: RewindScope;
	by: "user" | "judge";
	at: number;
};

export interface CheckpointDeps {
	/** How git is run. Tests pass a stand-in for a machine without git. */
	run?: GitRun;
}

interface TurnTrack {
	n: number;
	checkpoint?: CheckpointEntry;
	snapshotFailed: boolean;
	troubles: number;
	failures: Map<string, number>;
	trigger?: string;
	/** The same as a code: `same_command_failed` {times, command} or `monitor_trouble` {times, kind, detail}. */
	triggerCode?: Coded;
	asked: number;
	proposed: boolean;
	steps: string[];
	edits: number;
	/** A call that can change files ran in this turn: where a checkpoint is taken, or would be in an attended run. */
	changed: boolean;
	lastCheckFailed?: boolean;
}

interface PendingRewind {
	token: string;
	checkpoint: CheckpointEntry;
	lesson: string;
	undo?: string;
	fromLeaf: string | null;
	at: number;
}

const SCOPES: Record<string, RewindScope> = {
	"Files and conversation": "both",
	"Files only": "files",
	"Conversation only": "conversation",
};
const MAX_LISTED = 12;

const newTurn = (n: number): TurnTrack => ({
	n,
	snapshotFailed: false,
	troubles: 0,
	failures: new Map(),
	asked: 0,
	proposed: false,
	steps: [],
	edits: 0,
	changed: false,
});

const listed = (paths: readonly string[]): string =>
	paths.length <= MAX_LISTED
		? paths.join(", ")
		: `${paths.slice(0, MAX_LISTED).join(", ")} and ${paths.length - MAX_LISTED} more`;

/** What a rewind would undo, in words. Relative paths and counts only. */
export function describePlan(plan: RestorePlan): string {
	const lines = [
		plan.restore.length > 0 ? `put back ${plan.restore.length} changed: ${listed(plan.restore)}` : "",
		plan.remove.length > 0 ? `remove ${plan.remove.length} created since: ${listed(plan.remove)}` : "",
		plan.bringBack.length > 0 ? `bring back ${plan.bringBack.length} deleted since: ${listed(plan.bringBack)}` : "",
		plan.leftAlone.length > 0
			? `leave alone ${plan.leftAlone.length}: ${listed(plan.leftAlone.map((entry) => `${entry.path} (${entry.why})`))}`
			: "",
	].filter(Boolean);
	return lines.length > 0 ? lines.join("\n") : "no files differ from the checkpoint";
}

const describeResult = (result: RestoreResult): string =>
	`${result.restored.length} put back, ${result.removed.length} removed, ${result.broughtBack.length} brought back${
		result.leftAlone.length > 0
			? `, ${result.leftAlone.length} left alone (${listed(result.leftAlone.map((entry) => entry.path))})`
			: ""
	}`;

/**
 * Why a session goes without checkpoints. The folder alone says `home_folder` (the user's home, or a folder
 * that holds it) and `mu_folder`; the first snapshot says the size ones, and stops before it writes anything.
 * The machine's git says the rest: none at all, one held back until the Xcode license is accepted, or a Mac
 * without the developer tools, whose git is a stub that only offers to install them (`../../checkpoint/git.ts`).
 */
export type CheckpointsOff =
	| "git_missing"
	| "xcode_license"
	| "developer_tools_missing"
	| "home_folder"
	| "mu_folder"
	| "too_many_files"
	| "too_many_bytes"
	| "too_slow";

/** The reasons that lie with the machine's git rather than the folder: no command can open the snapshots then. */
const GIT_CANNOT_RUN: ReadonlySet<CheckpointsOff> = new Set([
	"git_missing",
	"xcode_license",
	"developer_tools_missing",
]);

/** The one line that tells the user, in their language, and what it names for a client that translates. */
export function offNotice(
	code: CheckpointsOff,
	limits: { readonly maxFiles: number; readonly maxTotalMb: number; readonly timeoutMs: number },
): { line: string; params: Record<string, number> } {
	const start = { zh: "在项目文件夹里启动 mu 就有检查点", en: "Start mu in a project folder to use checkpoints" };
	const seconds = Math.round(limits.timeoutMs / 1000);
	switch (code) {
		case "git_missing":
			return {
				line: say({
					zh: "mu：检查点已关闭，因为这台电脑上找不到 git。装好 Git 后，新开一个会话就有检查点。",
					en: "mu: checkpoints are off because git wasn't found on this computer. Install Git, then start a new session.",
				}),
				params: {},
			};
		case "xcode_license":
			return {
				line: say({
					zh: "mu：检查点已关闭，因为这台 Mac 还没有同意 Xcode 许可协议，git 无法运行。在终端里用 sudo xcodebuild -license 同意后，新开一个会话就有检查点。",
					en: "mu: checkpoints are off because git can't run on this Mac until you accept the Xcode license. Run sudo xcodebuild -license in Terminal to accept it, then start a new session.",
				}),
				params: {},
			};
		case "developer_tools_missing":
			return {
				line: say({
					zh: "mu：检查点已关闭，因为这台 Mac 没有安装 git 所需的命令行开发者工具。用 xcode-select --install 安装后，新开一个会话就有检查点。",
					en: "mu: checkpoints are off because git needs the command line developer tools, which aren't installed on this Mac. Install them with xcode-select --install, then start a new session.",
				}),
				params: {},
			};
		case "home_folder":
			return {
				line: say({
					zh: `mu：本次会话不拍检查点，因为这个文件夹是你的主目录，或者包含它。${start.zh}。`,
					en: `mu: checkpoints are off for this session because this folder is, or contains, your home folder. ${start.en}.`,
				}),
				params: {},
			};
		case "mu_folder":
			return {
				line: say({
					zh: "mu：本次会话不拍检查点，因为这个文件夹在 mu 自己的目录里。",
					en: "mu: checkpoints are off for this session because this folder is inside mu's own folder.",
				}),
				params: {},
			};
		case "too_many_files":
			return {
				line: say({
					zh: `mu：本次会话不拍检查点，因为这个文件夹要拍的文件超过 ${limits.maxFiles} 个。${start.zh}，或者调高 features.checkpoint.maxFiles。`,
					en: `mu: checkpoints are off for this session because this folder has more than ${limits.maxFiles} files to snapshot. ${start.en}, or raise features.checkpoint.maxFiles.`,
				}),
				params: { limit: limits.maxFiles },
			};
		case "too_many_bytes":
			return {
				line: say({
					zh: `mu：本次会话不拍检查点，因为这个文件夹要拍的文件加起来超过 ${limits.maxTotalMb} MB。${start.zh}，或者调高 features.checkpoint.maxTotalMb。`,
					en: `mu: checkpoints are off for this session because this folder has more than ${limits.maxTotalMb} MB of files to snapshot. ${start.en}, or raise features.checkpoint.maxTotalMb.`,
				}),
				params: { limitMb: limits.maxTotalMb },
			};
		case "too_slow":
			return {
				line: say({
					zh: `mu：本次会话不拍检查点，因为列出这个文件夹里要拍的文件用了超过 ${seconds} 秒。${start.zh}。`,
					en: `mu: checkpoints are off for this session because listing this folder's files took more than ${seconds} s. ${start.en}.`,
				}),
				params: { seconds },
			};
	}
}

const WRITER_PROMPT = `You write a note for a coding agent about an attempt that was abandoned and undone.
Reply with exactly two short lines of plain text and nothing else:
Tried: <what the attempt did>
Abandoned because: <why it did not work>`;

/**
 * Checkpoints of the working tree, and a rewind the judge helps decide.
 *
 * Before the first tool call of a user turn that can change files, the working tree is snapshotted into
 * the project's shadow repository (`../../checkpoint/store.ts`) and noted as a `kyrn.checkpoint` entry.
 * `/rewind` puts the files back and moves the conversation to before that turn with pi's own tree
 * navigation, leaving one `kyrn.rewind` message about what was abandoned. When the monitor sees the agent
 * go in circles, `turn.rewind` asks the judge whether this is a dead end; a confident yes PROPOSES the
 * rewind to the user. Nothing here rewinds on its own, and any failure leaves pi's plain behaviour.
 *
 * A session goes without checkpoints, and says so once in one line, where a snapshot would copy what is
 * no project: the home folder (or one that holds it), mu's own folders, or a first snapshot past
 * `maxFiles` / `maxTotalMb`. Copying only the files a turn touches is no way out: a checkpoint is taken
 * before the turn's first change, when nobody knows which files the turn will change (a shell command
 * names none), and a rewind would then claim to restore a state it never saw.
 *
 * An unattended run (`mu --print`, json mode; see `unattended.ts`) takes no checkpoint: nobody there can
 * confirm a rewind or type `/rewind`, so no file is ever put back, and the snapshot before the first change
 * and the scan after every one were only work for nothing. A dead end is still asked about there, and the
 * model is told to step back, as it always was without a UI. `unattended: true` takes them again.
 */
export function registerCheckpoint(
	runtime: KyrnRuntime,
	roots: HarnessRoots | undefined,
	deps: CheckpointDeps = {},
): void {
	const options = runtime.options("checkpoint", {
		enabled: true,
		/** Where the shadow repositories live. Default: `<agent dir>/mu/checkpoints`. */
		dir: "",
		/** Snapshots kept per project, */
		keep: 50,
		/** and for how long. */
		maxAgeDays: 14,
		/** Larger files stay out of snapshots and are never touched by a rewind. */
		maxFileMb: 5,
		/**
		 * A snapshot that would take in more files than this, or more MB in all, is not taken, and the session
		 * goes without checkpoints: such a folder is no project, and copying it would cost minutes and disk.
		 */
		maxFiles: 5000,
		maxTotalMb: 200,
		/** gitignore-style patterns on top of the project's own and the built-in list. */
		ignore: [] as string[],
		timeoutMs: 30_000,
		/** Ask the judge whether a run that goes in circles is a dead end, and propose going back. */
		propose: true,
		/** How long a proposal waits for an answer before the run carries on. 0 waits forever. */
		confirmSeconds: 120,
		/**
		 * How long the end of a turn waits for `turn.rewind`'s verdict; a later one changes nothing. On Terminal-Bench
		 * 2.1 every verdict came in 0.2-1.6 s.
		 */
		rewindWaitMs: 3000,
		/** Take checkpoints in a `mu --print` or json run too, for a session resumed later in the terminal. */
		unattended: false,
	});
	// A sub-agent works inside its parent's turn: the parent's checkpoint before `delegate` covers what it changes.
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const baseDir = options.dir || (roots ? join(roots.agentDir, "mu", "checkpoints") : "");
	// No home to keep snapshots in (an embedder that injected its own setup): the feature stays out of the way.
	if (!baseDir) return;
	const { pi } = runtime;
	const home = (): string => roots?.home ?? homedir();
	/** mu's own folders hold the snapshots, the sessions and the credentials: never in a snapshot, and no place to take one. */
	const muFolders = (): string[] => [baseDir, muHome(home()), ...(roots ? [roots.agentDir] : [])];
	const limits: ScanLimits = { maxFiles: options.maxFiles, maxBytes: options.maxTotalMb * 1024 * 1024 };

	/** Why no snapshot of this folder may be taken at all: it holds everything the user has, or it is mu's own. */
	const placeOff = (cwd: string): CheckpointsOff | undefined => {
		if (isWithin(cwd, home())) return "home_folder";
		return muFolders().some((folder) => isWithin(folder, cwd)) ? "mu_folder" : undefined;
	};

	let store: Store | undefined;
	/** Set when checkpoints are off for the rest of the session, with the line that said why. */
	let off: { code: CheckpointsOff; line: string } | undefined;
	let turn = newTurn(0);
	let pending: PendingRewind | undefined;
	/** The tree right after the agent's last action. What differs from it later was changed by somebody else. */
	let lastAgentTree: string | undefined;
	/** The scan after the agent's latest change, queued or running: the run ends once it has. */
	let rescan: Promise<void> | undefined;
	const calls = new Map<string, { name: string; input: Record<string, unknown>; mutating: boolean }>();
	let chain: Promise<unknown> = Promise.resolve();
	let busy = 0;

	/** One shadow command at a time: they share an index. */
	const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
		busy++;
		const next = chain.then(work, work).finally(() => busy--);
		chain = next.catch(() => {});
		return next;
	};

	/** Checkpoints stop for the rest of the session, and the user hears why once, in one line. */
	const switchOff = (ctx: ExtensionContext, code: CheckpointsOff): void => {
		if (off) return;
		const notice = offNotice(code, options);
		off = { code, line: notice.line };
		if (ctx.hasUI) ctx.ui.notify(notice.line, "warning");
		runtime.present("checkpoint.off", { code, params: notice.params, message: notice.line });
	};

	/** What keeps a command from opening the snapshots at all, as the line to say. */
	const refusal = (cwd: string): string | undefined => {
		if (off && GIT_CANNOT_RUN.has(off.code)) return off.line;
		const place = placeOff(cwd);
		return place ? offNotice(place, options).line : undefined;
	};

	const giveUp = (ctx: ExtensionContext, error: unknown): void => {
		if (off) return;
		if (error instanceof GitMissing) switchOff(ctx, "git_missing");
		// Every later turn would fail the same way, and say so again in English.
		else if (error instanceof GitUnusable) switchOff(ctx, error.reason);
		else if (error instanceof SnapshotTooLarge) {
			const codes = { files: "too_many_files", bytes: "too_many_bytes", slow: "too_slow" } as const;
			switchOff(ctx, codes[error.reason]);
		} else if (!turn.snapshotFailed) {
			turn.snapshotFailed = true;
			const reason = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`mu: no checkpoint for this turn (${clip(reason, 200)}).`, "warning");
		}
	};

	const open = async (ctx: ExtensionContext): Promise<Store> => {
		if (store) return store;
		const opened = await openStore({
			baseDir,
			root: ctx.cwd,
			run: deps.run ?? spawnGit("git", options.timeoutMs),
			maxFileBytes: options.maxFileMb * 1024 * 1024,
			ignore: [...BUILT_IN_IGNORES, ...options.ignore],
			ownFolders: muFolders(),
		});
		store = opened;
		// Old snapshots go when a project is first used in a session; their objects follow in the background.
		const dropped = await prune(opened, { keep: options.keep, maxAgeDays: options.maxAgeDays }).catch(() => 0);
		if (dropped > 0) void exclusive(() => collectGarbage(opened)).catch(() => {});
		return opened;
	};

	const checkpointsOn = (ctx: ExtensionContext): CheckpointEntry[] =>
		ctx.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY ? [entry.data as CheckpointEntry] : [],
			)
			.filter((entry) => typeof entry?.id === "number" && typeof entry.commit === "string");

	const nextId = (ctx: ExtensionContext): number =>
		1 +
		Math.max(
			0,
			...ctx.sessionManager
				.getEntries()
				.map((entry) =>
					entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY
						? Number((entry.data as CheckpointEntry | undefined)?.id) || 0
						: 0,
				),
		);

	/** The latest user message on the branch: the turn's request, which is where the conversation goes back to. */
	const turnStart = (ctx: ExtensionContext): { entryId?: string; label: string } => {
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message" || (entry.message as { role?: unknown }).role !== "user") continue;
			return { entryId: entry.id, label: clip(textOf((entry.message as { content?: unknown }).content), 60) };
		}
		return { label: "" };
	};

	const takeCheckpoint = async (ctx: ExtensionContext): Promise<void> => {
		const opened = await open(ctx);
		const id = nextId(ctx);
		const taken = await snapshot(opened, `${ctx.sessionManager.getSessionId()}/${id}`, limits);
		const entry: CheckpointEntry = { id, turn: turn.n, commit: taken.commit, at: Date.now(), ...turnStart(ctx) };
		turn.checkpoint = entry;
		lastAgentTree = taken.tree;
		pi.appendEntry<CheckpointEntry>(CHECKPOINT_ENTRY, entry);
		runtime.present("checkpoint.taken", { id, turn: turn.n, label: entry.label });
	};

	pi.on(
		"session_start",
		failOpen(() => {
			// A home folder snapshotted by an older mu is never used again: its copy goes now, not in two weeks.
			sweepProjects(baseDir, options.maxAgeDays, Date.now(), (root) => placeOff(root) !== undefined);
			return undefined;
		}),
	);

	pi.on(
		"input",
		failOpen((event) => {
			if (event.source === "extension" || event.streamingBehavior || !event.text.trim()) return undefined;
			turn = newTurn(turn.n + 1);
			pending = undefined;
			return undefined;
		}),
	);

	pi.on(
		"tool_call",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			// Between the user's yes and the moment the conversation has moved, nothing may change a file again.
			// Bounded, so a rewind that never completes cannot block tools for good.
			if (pending && Date.now() - pending.at < 60_000) {
				return {
					block: true,
					reason: "mu is going back to the checkpoint; this attempt has ended.",
					terminate: true,
				};
			}
			pending = undefined;
			const mutating = isMutatingCall(event.toolName, event.input);
			calls.set(event.toolCallId, { name: event.toolName, input: event.input, mutating });
			if (mutating) turn.changed = true;
			if (!mutating || off || turn.checkpoint || turn.snapshotFailed) return undefined;
			// No snapshot, and so no scan after the call either: `tool_execution_end` scans only behind a checkpoint.
			if (!options.unattended && isUnattended(ctx)) return undefined;
			const place = placeOff(ctx.cwd);
			if (place) {
				switchOff(ctx, place);
				return undefined;
			}
			// Before the first call that can change a file, and only then: a turn that reads costs nothing.
			await exclusive(() => takeCheckpoint(ctx)).catch((error) => giveUp(ctx, error));
			return undefined;
		}),
	);

	pi.on(
		"tool_execution_end",
		failOpen<ToolExecutionEndEvent, undefined>(async (event) => {
			const call = calls.get(event.toolCallId);
			calls.delete(event.toolCallId);
			if (!call) return undefined;
			const step = `${describeCall(call.name, call.input)} -> ${event.isError ? "error" : "ok"}`;
			turn.steps = [...turn.steps.slice(-11), step];
			if (call.name === "edit" || call.name === "write") turn.edits++;
			const command = call.name === "bash" ? String(call.input.command ?? "") : "";
			if (command && isCheckCommand(command)) turn.lastCheckFailed = event.isError;
			if (command && event.isError) {
				const failures = (turn.failures.get(command) ?? 0) + 1;
				turn.failures.set(command, failures);
				if (failures === 3) {
					turn.trigger = `the same failing command ran 3 times: ${clip(command, 120)}`;
					turn.triggerCode = { code: "same_command_failed", params: { times: 3, command: clip(command, 120) } };
				}
			}
			// Only a rewind reads this tree, to tell the user's edits from the agent's, and it queues behind the scan
			// on `exclusive`: the next call need not wait for it (about 0.2 s per change in a container).
			if (call.mutating && store && turn.checkpoint) {
				const opened = store;
				rescan = exclusive(async () => {
					lastAgentTree = await scan(opened, limits).then(
						(scanned) => scanned.tree,
						() => undefined,
					);
				});
			}
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>(async () => {
			// The run ends with the tree after its last change known, so an edit made from then on reads as the user's.
			// Bounded, like shutdown: a `git gc` queued ahead must not hold the prompt back.
			if (rescan) await within(rescan, 3000);
			return undefined;
		}),
	);

	runtime.onTrouble((kind, detail) => {
		turn.troubles++;
		if (turn.troubles >= 2 && turn.trigger === undefined) {
			turn.trigger = `the monitor spoke up ${turn.troubles} times in this turn (${kind}: ${clip(detail, 120)})`;
			turn.triggerCode = {
				code: "monitor_trouble",
				params: { times: turn.troubles, kind, detail: clip(detail, 120) },
			};
		}
	});

	/** Files a rewind would change that somebody changed after the agent's last action: probably the user, by hand. */
	const handEdited = async (opened: Store, plan: RestorePlan, nowTree: string): Promise<string[]> => {
		const planned = new Set([...plan.restore, ...plan.remove, ...plan.bringBack]);
		// Without a record of the agent's last action nobody can tell, so every file counts as possibly the user's.
		if (!lastAgentTree) return [...planned];
		const since = await diff(opened, lastAgentTree, nowTree).catch(() => undefined);
		return since ? since.map((change) => change.path).filter((path) => planned.has(path)) : [...planned];
	};

	const preview = async (ctx: ExtensionContext, checkpoint: CheckpointEntry) => {
		const opened = await open(ctx);
		const now = await scan(opened);
		const plan = await planRestore(opened, checkpoint.commit, now.tree);
		return { opened, plan, byHand: await handEdited(opened, plan, now.tree) };
	};

	/** Asks about files changed by hand. Returns the ones to keep, or undefined when the user called the rewind off. */
	const askAboutHandEdits = async (
		ctx: ExtensionContext,
		byHand: readonly string[],
	): Promise<Set<string> | undefined> => {
		if (byHand.length === 0) return new Set();
		const choice = await ctx.ui.select(
			`mu: ${byHand.length} of these files changed after the agent's last action, probably edited by you: ${listed(byHand)}`,
			["Keep those files as they are", "Rewind them too (a snapshot taken now can bring them back)", "Cancel"],
		);
		if (choice?.startsWith("Keep")) return new Set(byHand);
		return choice?.startsWith("Rewind") ? new Set() : undefined;
	};

	/** Snapshots the present first, so the rewind can itself be undone, then puts the files back. */
	const restoreFiles = async (
		ctx: ExtensionContext,
		opened: Store,
		plan: RestorePlan,
		keep: ReadonlySet<string>,
	): Promise<{ undo: string; result: RestoreResult }> => {
		const undo = await snapshot(opened, `${ctx.sessionManager.getSessionId()}/undo-${Date.now()}`);
		const result = await applyRestore(opened, plan, keep);
		lastAgentTree = (await scan(opened)).tree;
		return { undo: undo.commit, result };
	};

	const lessonFor = async (checkpoint: CheckpointEntry, reason: string, files: readonly string[]): Promise<string> => {
		let body = `Abandoned because: ${reason}`;
		const writer = runtime.writer();
		if (writer && turn.steps.length > 0) {
			const timeout = new Promise<undefined>((resolve) => {
				setTimeout(() => resolve(undefined), 8000).unref?.();
			});
			const reply = await Promise.race([
				writer({
					system: WRITER_PROMPT,
					user: `Goal: ${runtime.taskFrame()?.goal ?? checkpoint.label}\nWhy it was stopped: ${reason}\nFiles it changed: ${listed(files)}\nIts last steps:\n${turn.steps.join("\n")}`,
				}).catch(() => undefined),
				timeout,
			]);
			const lines = (reply?.text ?? "")
				.split("\n")
				.filter((line) => /^(Tried|Abandoned because):/.test(line.trim()));
			if (lines.length > 0)
				body = clip(lines.join("\n"), 600).replace(" Abandoned because:", "\nAbandoned because:");
		}
		return [
			`mu went back to checkpoint #${checkpoint.id}, to before "${checkpoint.label}". An attempt made after it was abandoned and its file changes were undone.`,
			body,
			files.length > 0 ? `Files it had changed: ${listed(files)}` : "",
			"Take a different approach.",
		]
			.filter(Boolean)
			.join("\n");
	};

	/** pi's own tree navigation. True when the leaf really moved to before the turn's request. */
	const moveConversation = async (
		ctx: ExtensionCommandContext,
		entryId: string,
		clearEditor = false,
	): Promise<boolean> => {
		const target = ctx.sessionManager.getEntry(entryId);
		if (!target) return false;
		const typed = ctx.hasUI ? ctx.ui.getEditorText() : "";
		const result = await ctx.navigateTree(entryId, { summarize: false });
		// pi lands on the parent of a request (and offers its text for editing), and on any other entry itself.
		const isRequest =
			target.type === "custom_message" ||
			(target.type === "message" && (target.message as { role?: unknown }).role === "user");
		const moved = !result.cancelled && ctx.sessionManager.getLeafId() === (isRequest ? target.parentId : entryId);
		if (moved && ctx.hasUI && !typed) {
			// When the run carries on by itself, the request pi's terminal put into the empty editor would be a stray
			// draft. Otherwise it belongs there in every mode, so the user can change it and send it again.
			const request = target.type === "message" ? textOf((target.message as { content?: unknown }).content) : "";
			if (clearEditor) ctx.ui.setEditorText("");
			else if (isRequest && request && !ctx.ui.getEditorText()) ctx.ui.setEditorText(request);
		}
		return moved;
	};

	const finish = (
		ctx: ExtensionContext,
		record: RewoundEntry,
		lesson: string,
		payload: Record<string, unknown>,
	): void => {
		pi.appendEntry<RewoundEntry>(REWOUND_ENTRY, record);
		pi.sendMessage({ customType: REWIND_MESSAGE, content: lesson, display: true });
		runtime.present(record.to === "undo" ? "rewind.undone" : "rewind.done", payload);
		// The next call that can change files starts from a fresh checkpoint on the branch the conversation is on now.
		turn.checkpoint = undefined;
		turn.snapshotFailed = false;
		runtime.touch(ctx);
	};

	const counts = (result: RestoreResult | undefined) => ({
		restored: result?.restored.length ?? 0,
		removed: result?.removed.length ?? 0,
		broughtBack: result?.broughtBack.length ?? 0,
		leftAlone: result?.leftAlone.length ?? 0,
		paths: [...(result?.restored ?? []), ...(result?.removed ?? []), ...(result?.broughtBack ?? [])].slice(
			0,
			MAX_LISTED,
		),
	});

	const rewindTo = async (ctx: ExtensionCommandContext, checkpoint: CheckpointEntry, asked?: RewindScope) => {
		const { opened, plan, byHand } = await exclusive(() => preview(ctx, checkpoint));
		const title = `mu: go back to checkpoint #${checkpoint.id}, before "${checkpoint.label}"?`;
		let scope = asked;
		if (scope) {
			if (!(await ctx.ui.confirm(title, describePlan(plan)))) return ctx.ui.notify("Nothing was changed.", "info");
		} else {
			const choice = await ctx.ui.select(`${title}\n${describePlan(plan)}`, [...Object.keys(SCOPES), "Cancel"]);
			scope = choice ? SCOPES[choice] : undefined;
			if (!scope) return ctx.ui.notify("Nothing was changed.", "info");
		}
		const keep = scope === "conversation" ? new Set<string>() : await askAboutHandEdits(ctx, byHand);
		if (!keep) return ctx.ui.notify("Nothing was changed.", "info");

		const fromLeaf = ctx.sessionManager.getLeafId();
		const files = scope === "conversation" ? undefined : await exclusive(() => restoreFiles(ctx, opened, plan, keep));
		const changed = files ? [...files.result.restored, ...files.result.removed, ...files.result.broughtBack] : [];
		let moved = false;
		if (scope !== "files" && checkpoint.entryId)
			moved = await moveConversation(ctx, checkpoint.entryId).catch(() => false);
		finish(
			ctx,
			{
				to: checkpoint.id,
				undo: files?.undo,
				fromLeaf: moved ? fromLeaf : undefined,
				scope,
				by: "user",
				at: Date.now(),
			},
			await lessonFor(checkpoint, "the user went back to this checkpoint", changed),
			{ id: checkpoint.id, by: "user", scope, conversationMoved: moved, ...counts(files?.result) },
		);
		const said = [
			files
				? `Files are back at checkpoint #${checkpoint.id}: ${describeResult(files.result)}. /rewind undo reverses this.`
				: "",
			scope === "files"
				? ""
				: moved
					? "The conversation is back to before that request, which is in the editor so you can send it again."
					: // pi lets only a command move the leaf, and it refused or is not bound here: one step is left to the user.
						`mu couldn't move the conversation from here. To finish, run /tree and pick the message "${checkpoint.label}".`,
		].filter(Boolean);
		ctx.ui.notify(said.join("\n"), "info");
	};

	const undoLast = async (ctx: ExtensionCommandContext): Promise<void> => {
		const last = ctx.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === REWOUND_ENTRY ? [entry.data as RewoundEntry] : [],
			)
			.pop();
		if (!last) return ctx.ui.notify("No rewind to undo on this branch of the conversation.", "info");
		const opened = await exclusive(() => open(ctx));
		if (last.undo && !(await hasCommit(opened, last.undo)))
			return ctx.ui.notify("The snapshot taken before that rewind was pruned.", "warning");
		const fromLeaf = ctx.sessionManager.getLeafId();
		let files: { undo: string; result: RestoreResult } | undefined;
		if (last.undo) {
			const commit = last.undo;
			const plan = await exclusive(async () => planRestore(opened, commit, (await scan(opened)).tree));
			if (!(await ctx.ui.confirm("mu: undo the last rewind?", describePlan(plan))))
				return ctx.ui.notify("Nothing was changed.", "info");
			files = await exclusive(() => restoreFiles(ctx, opened, plan, new Set()));
		}
		const moved = last.fromLeaf ? await moveConversation(ctx, last.fromLeaf).catch(() => false) : false;
		pi.appendEntry<RewoundEntry>(REWOUND_ENTRY, {
			to: "undo",
			undo: files?.undo,
			fromLeaf: moved ? fromLeaf : undefined,
			scope: last.scope,
			by: "user",
			at: Date.now(),
		});
		runtime.present("rewind.undone", { conversationMoved: moved, ...counts(files?.result) });
		ctx.ui.notify(
			`The rewind was undone${files ? `: ${describeResult(files.result)}` : ""}.${last.fromLeaf && !moved ? " mu couldn't move the conversation back; use /tree." : ""}`,
			"info",
		);
	};

	/** The second half of a rewind the user agreed to mid-run: once the run has stopped, move the conversation and start over. */
	const resume = async (ctx: ExtensionCommandContext, token: string): Promise<void> => {
		const job = pending;
		if (!job || job.token !== token) return;
		await ctx.waitForIdle();
		const request = job.checkpoint.entryId ? ctx.sessionManager.getEntry(job.checkpoint.entryId) : undefined;
		const content = request?.type === "message" ? (request.message as { content?: unknown }).content : undefined;
		pending = undefined;
		const moved = job.checkpoint.entryId
			? await moveConversation(ctx, job.checkpoint.entryId, content !== undefined).catch(() => false)
			: false;
		finish(
			ctx,
			{
				to: job.checkpoint.id,
				undo: job.undo,
				fromLeaf: moved ? job.fromLeaf : undefined,
				scope: "both",
				by: "judge",
				at: Date.now(),
			},
			job.lesson,
			{ id: job.checkpoint.id, by: "judge", scope: "both", conversationMoved: moved },
		);
		// The request goes in again after the note, so the new attempt starts from the lesson and nothing else of the old one.
		if (moved && content !== undefined) pi.sendUserMessage(content as Parameters<typeof pi.sendUserMessage>[0]);
		else
			pi.sendMessage(
				{
					customType: "kyrn.steer",
					content: "The files are back at the checkpoint. Try a different approach.",
					display: true,
				},
				{ triggerTurn: true },
			);
	};

	pi.on(
		"turn_end",
		failOpen<TurnEndEvent, undefined>(async (_event, ctx) => {
			runtime.touch(ctx);
			const trigger = turn.trigger;
			const triggerCode = turn.triggerCode;
			const checkpoint = turn.checkpoint;
			// An unattended run takes no checkpoint: a turn that changed files there is asked about all the same.
			const uncheckpointed = !checkpoint && turn.changed && !options.unattended && isUnattended(ctx);
			if (
				!trigger ||
				!(checkpoint || uncheckpointed) ||
				!options.propose ||
				turn.proposed ||
				turn.asked >= 2 ||
				pending
			)
				return undefined;
			turn.trigger = undefined;
			turn.triggerCode = undefined;
			turn.asked++;
			const state = {
				goal: runtime.taskFrame()?.goal ?? checkpoint?.label ?? turnStart(ctx).label,
				recentSteps: turn.steps,
				trigger,
				editsSinceCheckpoint: turn.edits,
				lastCheckFailed: turn.lastCheckFailed,
			};
			// The run waits for this verdict, and a late one changes nothing (the fallback carries on): at most
			// `rewindWaitMs`, not the judge's own timeout (10 s hosted, 30 s for an `llm:` judge).
			const decision = await askWithin(
				(signal) =>
					runtime.engine.decide(turnRewind, state, {
						signal: ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal,
					}),
				options.rewindWaitMs,
			);
			if (decision?.source !== "judge" || decision.outcome !== "propose") return undefined;
			turn.proposed = true;
			// Nobody to ask, so nothing is undone: the model is told, and the choice of a new approach is its own.
			const stepBack = () =>
				pi.sendMessage(
					{
						customType: "kyrn.steer",
						content: `This approach looks like a dead end (${trigger}). Step back: undo what this attempt changed and try a different approach.`,
						display: true,
					},
					{ deliverAs: "steer" },
				);
			// Without a checkpoint there is no restore to plan, and nobody to show one to.
			if (!checkpoint) {
				stepBack();
				return undefined;
			}

			const { opened, plan, byHand } = await exclusive(() => preview(ctx, checkpoint));
			runtime.present("rewind.proposed", {
				id: checkpoint.id,
				trigger,
				...(triggerCode
					? { triggerCode: triggerCode.code, ...(triggerCode.params ? { triggerParams: triggerCode.params } : {}) }
					: {}),
				restore: plan.restore.length,
				remove: plan.remove.length,
				bringBack: plan.bringBack.length,
				paths: [...plan.restore, ...plan.remove, ...plan.bringBack].slice(0, MAX_LISTED),
			});
			if (!ctx.hasUI) {
				stepBack();
				return undefined;
			}
			const approved = await ctx.ui.confirm(
				`mu: this looks like a dead end. Go back to checkpoint #${checkpoint.id}, before "${checkpoint.label}"?`,
				`${trigger}\n\n${describePlan(plan)}\n\nThe agent will then start over from your request, with a note about what didn't work. /rewind undo reverses this.`,
				options.confirmSeconds > 0 ? { timeout: options.confirmSeconds * 1000 } : undefined,
			);
			const keep = approved ? await askAboutHandEdits(ctx, byHand) : undefined;
			if (!keep) return undefined;

			const fromLeaf = ctx.sessionManager.getLeafId();
			const files = await exclusive(() => restoreFiles(ctx, opened, plan, keep));
			const changed = [...files.result.restored, ...files.result.removed, ...files.result.broughtBack];
			const lesson = await lessonFor(checkpoint, `it kept failing (${trigger})`, changed);
			// A session that ends with the run (print, json) has no conversation to move: the lesson goes to the model as it is.
			if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || !checkpoint.entryId) {
				pi.appendEntry<RewoundEntry>(REWOUND_ENTRY, {
					to: checkpoint.id,
					undo: files.undo,
					scope: "files",
					by: "judge",
					at: Date.now(),
				});
				runtime.present("rewind.done", {
					id: checkpoint.id,
					by: "judge",
					scope: "files",
					conversationMoved: false,
					...counts(files.result),
				});
				pi.sendMessage({ customType: REWIND_MESSAGE, content: lesson, display: true }, { deliverAs: "steer" });
				turn.checkpoint = undefined;
				return undefined;
			}
			// Only a command may move the leaf, and only once the run has stopped: stop it, and let the command finish the job.
			pending = { token: randomUUID(), checkpoint, lesson, undo: files.undo, fromLeaf, at: Date.now() };
			ctx.abort();
			pi.sendUserMessage(`/rewind --resume ${pending.token}`, { expandPromptTemplates: true });
			return undefined;
		}),
	);

	pi.registerCommand("checkpoints", {
		description: say({
			zh: "这次对话的检查点：第几回合、什么时间、之后改了哪些文件",
			en: "List the checkpoints so far: turn, time and the files changed since each",
		}),
		handler: async (_args, ctx) => {
			runtime.touch(ctx);
			const entries = checkpointsOn(ctx).reverse();
			const refused = refusal(ctx.cwd);
			if (entries.length === 0 || refused) {
				return ctx.ui.notify(
					refused ?? off?.line ?? "No checkpoints yet. mu takes one before the first file change in each turn.",
					"info",
				);
			}
			try {
				const opened = await exclusive(() => open(ctx));
				const now = await exclusive(() => scan(opened));
				const rows: string[] = [];
				for (const entry of entries.slice(0, 20)) {
					const changed = (await hasCommit(opened, entry.commit))
						? `${(await diff(opened, entry.commit, now.tree)).length} files changed since`
						: "pruned";
					rows.push(
						`#${entry.id}  turn ${entry.turn}  ${new Date(entry.at).toLocaleTimeString()}  ${changed}  "${entry.label}"`,
					);
				}
				ctx.ui.notify(
					`${rows.join("\n")}\n/rewind [#] goes back to one; /rewind undo reverses the last rewind.`,
					"info",
				);
			} catch (error) {
				giveUp(ctx, error);
			}
		},
	});

	pi.registerCommand("rewind", {
		description: say({
			zh: "回到一个检查点：/rewind [序号] [both|files|conversation]，/rewind undo 撤销回退；both 文件和对话都退，files 只退文件，conversation 只退对话",
			en: "Go back to a checkpoint: /rewind [#] [both|files|conversation]; /rewind undo reverses the last rewind",
		}),
		getArgumentCompletions: (prefix) => {
			const matches = ["undo", "files", "conversation", "both"].filter((value) => value.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const words = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (words[0] === "--resume") return await resume(ctx, words[1] ?? "");
				if (!ctx.isIdle())
					return ctx.ui.notify("The agent is still working. Stop it first (esc), then rewind.", "warning");
				const refused = refusal(ctx.cwd);
				if (refused) return ctx.ui.notify(refused, "warning");
				if (!ctx.hasUI)
					return ctx.ui.notify("A rewind needs confirmation, and this mode can't ask for it.", "warning");
				if (words[0] === "undo") return await undoLast(ctx);
				const entries = checkpointsOn(ctx);
				const wanted = words.find((word) => /^#?\d+$/.test(word))?.replace("#", "");
				const checkpoint = wanted
					? entries.find((entry) => entry.id === Number(wanted))
					: entries[entries.length - 1];
				if (!checkpoint)
					return ctx.ui.notify(
						wanted
							? `No checkpoint #${wanted} on this branch. /checkpoints lists them.`
							: (off?.line ?? "No checkpoints yet."),
						"info",
					);
				if (!(await hasCommit(await exclusive(() => open(ctx)), checkpoint.commit))) {
					return ctx.ui.notify(`The snapshot for checkpoint #${checkpoint.id} was pruned.`, "warning");
				}
				const scope = words.find(
					(word): word is RewindScope => word === "both" || word === "files" || word === "conversation",
				);
				await rewindTo(ctx, checkpoint, scope);
			} catch (error) {
				pending = undefined;
				giveUp(ctx, error);
				if (!(error instanceof GitMissing || error instanceof GitUnusable))
					ctx.ui.notify(
						`Couldn't rewind: ${clip(error instanceof Error ? error.message : String(error), 300)}`,
						"error",
					);
			}
		},
	});

	pi.on(
		"session_shutdown",
		failOpen<SessionShutdownEvent, undefined>(async () => {
			// Nothing of ours may stay locked: wait for a running command, briefly, then clear what it may have left.
			const wasBusy = busy > 0;
			await Promise.race([
				chain,
				new Promise((resolve) => {
					setTimeout(resolve, 3000).unref?.();
				}),
			]);
			if (store) releaseLocks(store, wasBusy && busy > 0 ? 0 : 120_000);
			return undefined;
		}),
	);
}
