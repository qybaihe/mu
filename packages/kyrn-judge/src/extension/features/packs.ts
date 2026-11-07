import type { BeforeAgentStartEvent, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { run } from "../../packs/exec.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";
import { CAPABILITY_ENTRY, hidesNothing } from "./catalog.ts";
import { astGrepPack } from "./packs/ast-grep.ts";
import { registerCommit } from "./packs/commit.ts";
import { conflictsPack } from "./packs/conflicts.ts";
import { debuggerPack } from "./packs/debugger.ts";
import { githubPack } from "./packs/github.ts";
import type { Pack, PackShared } from "./packs/pack.ts";
import { reviewPack } from "./packs/review.ts";

/**
 * Capability packs: installed with mu, out of the model's sight until a task
 * needs one. Each is one `judged` entry of the capability catalog, and its
 * tools are only registered when it is opened, so a closed pack costs the
 * model nothing. What a pack needs from the machine (ast-grep, git, gh, a debug adapter) is
 * looked for at that moment too: a missing program is an install hint to
 * whoever opened the pack, never an error at start-up.
 *
 * The commands a pack brings (`/review`, `/commit`) are the user's and are
 * always there. They open their pack themselves.
 */
export function registerPacks(runtime: KyrnRuntime): void {
	const options = runtime.options("packs", {
		enabled: true,
		astGrep: true,
		/** Matches `sg_search` returns unless the call asks for another number. */
		maxResults: 50,
		/** Characters of diff one tool result carries at most. */
		maxDiffChars: 12000,
		/** Empty: `ast-grep`, then `sg`, from PATH. */
		astGrepCommand: "",
		github: true,
		/** Empty: `gh` from PATH. */
		ghCommand: "",
		/** `/commit`: the uncommitted change split into commits, after the user said yes. */
		commit: true,
		/** Characters of the change the model reads to propose the split. */
		maxPlanChars: 60000,
		/** `/review`, and the triage of its findings P0 to P3. */
		review: true,
		/** Findings one triage sorts at most; the rest are reported after them, unsorted. */
		maxFindings: 40,
		/** Conflict resolution for a merge, rebase or cherry-pick that stopped. */
		conflicts: true,
		/** Lines of each side of a conflict block that conflicts_show returns. */
		maxSideLines: 80,
		maxConflictChars: 20000,
		/** A program run under a debug adapter: breakpoints, stepping, variables. */
		debugger: true,
		/** Adapters added or changed by id: `{ "<id>": { command, args, transport, extensions, launch, install } }`. */
		debugAdapters: {} as Record<string, unknown>,
		/** Frames of the call stack shown at a stop. */
		maxFrames: 20,
		/** Variables listed per scope or member list. */
		maxVariables: 50,
		/** Characters of the program's output one result carries: the tail when there is more. */
		debugOutputChars: 4000,
		/** How long a launch or a step waits for the program to stop or end before reporting it still runs. */
		debugWaitMs: 30000,
	});
	if (!options.enabled) return;
	const { pi, catalog } = runtime;

	const shared: PackShared = {
		runtime,
		run,
		platform: process.platform,
		cwd: () => runtime.ctx?.cwd ?? process.cwd(),
		open: async (id) => {
			if (!(await catalog.open(id, "user", runtime.userTurns))) return;
			const capability = catalog.get(id);
			pi.appendEntry(CAPABILITY_ENTRY, { id, by: "user", turn: runtime.userTurns });
			runtime.present("capability.opened", { id, by: "user", title: capability?.title, tools: capability?.tools });
		},
	};

	const packs: Pack[] = [];
	if (options.astGrep) {
		packs.push(
			astGrepPack(shared, {
				command: options.astGrepCommand,
				maxResults: options.maxResults,
				maxDiffChars: options.maxDiffChars,
			}),
		);
	}

	if (options.github) packs.push(githubPack(shared, { command: options.ghCommand }));
	if (options.commit) registerCommit(shared, { maxPlanChars: options.maxPlanChars });
	if (options.review) packs.push(reviewPack(shared, { maxFindings: options.maxFindings }));
	if (options.conflicts) {
		packs.push(conflictsPack(shared, { maxSideLines: options.maxSideLines, maxChars: options.maxConflictChars }));
	}
	if (options.debugger) {
		packs.push(
			debuggerPack(shared, {
				adapters: options.debugAdapters,
				maxFrames: options.maxFrames,
				maxVariables: options.maxVariables,
				outputChars: options.debugOutputChars,
				stopTimeoutMs: options.debugWaitMs,
			}),
		);
	}

	const starting = new Map<string, Promise<void>>();
	const start = (pack: Pack): Promise<void> => {
		let pending = starting.get(pack.id);
		if (!pending) {
			pending = pack.start();
			starting.set(pack.id, pending);
			// A program that is not installed today may be tomorrow: the next opening looks again.
			pending.catch(() => starting.delete(pack.id));
		}
		return pending;
	};

	for (const pack of packs) {
		catalog.register({
			id: pack.id,
			kind: "pack",
			title: pack.title,
			description: pack.description,
			tools: pack.tools,
			exposure: "judged",
			activate: () => start(pack),
		});
	}

	// With no catalog nothing is hidden and nobody opens anything: the tools have to be there from the start. A pack
	// whose program is missing simply stays out. With capability disclosure off, the catalog still hides them.
	const startAllWhenNothingIsHidden = async (ctx: ExtensionContext): Promise<undefined> => {
		runtime.touch(ctx);
		if (hidesNothing(runtime)) {
			await Promise.allSettled(packs.map(start));
		}
		return undefined;
	};
	// A skill travels with its pack from the start: hidden or not, the skill disclosure decision covers it.
	const skills = packs.flatMap((pack) => pack.skills ?? []);
	pi.on(
		"resources_discover",
		failOpen(() => (skills.length > 0 ? { skillPaths: skills } : undefined)),
	);

	pi.on(
		"session_start",
		failOpen<SessionStartEvent, undefined>((_event, ctx) => startAllWhenNothingIsHidden(ctx)),
	);
	pi.on(
		"before_agent_start",
		failOpen<BeforeAgentStartEvent, undefined>((_event, ctx) => startAllWhenNothingIsHidden(ctx)),
	);
}
