import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { heldByLicense, stubProblem } from "../../checkpoint/git.ts";
import { type GitFacts, listFolder, machineFacts, parseStatus, renderSnapshot } from "../../evolve/snapshot.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";

/** The custom message the snapshot is given as. One per conversation. */
export const SNAPSHOT_MESSAGE = "kyrn.snapshot";

/** Changed files the snapshot names; more are counted, not listed. */
const CHANGED_SHOWN = 12;
/** A file or folder name is the project's text, not mu's: none gets more room than a name needs. */
const NAME_CHARS = 80;

/**
 * The opening snapshot: what the folder holds, where git stands and what the machine is, given to the model with the
 * first message of a conversation. A run otherwise spends its first steps finding this out (`ls`, `git status`, a
 * command that is not there on this system), in an empty folder as in a full one.
 *
 * It is a message beside the user's, not part of the system prompt: the prompt's prefix stays what it was for every
 * conversation, so the provider's cache of it holds. Nothing is run but git, and nothing is asked of a judge.
 *
 * What it names is the project's own text (file names, a branch name), so the snapshot says it is a snapshot and not
 * the user speaking, and a commit message, which can be any length and say anything, is left out.
 */
export function registerSnapshot(runtime: KyrnRuntime): void {
	const options = runtime.options("snapshot", {
		enabled: true,
		/** Entries of the folder that are listed. A folder with more is cut, and the snapshot says so. */
		maxEntries: 60,
		/** Say the branch and the changed files. */
		git: true,
		/** Say the system, the shell, the package manager and where commands written for Linux go wrong here. */
		machine: true,
		/** How long git gets to answer. A repository slower than this is left out of the snapshot. */
		waitMs: 1500,
	});
	// A subagent starts from its parent's brief, which says where to look.
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;
	let given = false;
	let stub: ReturnType<typeof stubProblem> | undefined;

	const gitFacts = async (ctx: ExtensionContext): Promise<GitFacts | "none" | undefined> => {
		// A Mac's git stub without the developer tools is never started: each start opens their install dialog.
		stub ??= stubProblem("git", process.env.PATH);
		if (await stub) return undefined;
		try {
			const status = await pi.exec("git", ["status", "--porcelain=v1", "--branch"], {
				cwd: ctx.cwd,
				signal: ctx.signal,
				timeout: options.waitMs,
			});
			if (status.killed || heldByLicense(status.code, () => `${status.stderr}\n${status.stdout}`)) return undefined;
			if (status.code !== 0) return /not a git repository/i.test(status.stderr) ? "none" : undefined;
			const facts = parseStatus(status.stdout, CHANGED_SHOWN);
			return {
				...facts,
				...(facts.branch ? { branch: clip(facts.branch, NAME_CHARS) } : {}),
				changed: facts.changed.map((path) => clip(path, NAME_CHARS)),
			};
		} catch {
			// No git on this machine, or it could not start: the snapshot goes without its line.
			return undefined;
		}
	};

	pi.on(
		"session_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			// A conversation that is opened again has its snapshot already, as old as the conversation.
			given = ctx.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom_message" && entry.customType === SNAPSHOT_MESSAGE);
			return undefined;
		}),
	);

	pi.on(
		"before_agent_start",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			if (given || event.messageType !== "user") return undefined;
			given = true;
			const listed = listFolder(ctx.cwd, options.maxEntries);
			const listing = listed && { ...listed, shown: listed.shown.map((name) => clip(name, NAME_CHARS)) };
			const git = options.git ? await gitFacts(ctx) : undefined;
			const machine = options.machine ? machineFacts(ctx.cwd, runtime.evolve?.missingCommands() ?? []) : undefined;
			if (!listing && !git && !machine) return undefined;
			return {
				message: {
					customType: SNAPSHOT_MESSAGE,
					content: renderSnapshot({ cwd: ctx.cwd, listing, git, machine }),
					display: false,
				},
			};
		}),
	);
}
