import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describePatchReview, type PatchReviewInput, swarmPatch } from "../../decisions/swarm-patch.ts";
import {
	applyPatch,
	describeRecord,
	fileSection,
	type PatchRecord,
	PatchStore,
	patchPreview,
	readPatch,
	statLines,
} from "../../swarm/patches.ts";
import type { BeeRunner, BeeTask } from "../../swarm/run.ts";
import {
	checkRepo,
	collectPatch,
	createWorktree,
	describeSummary,
	type GitRun,
	type Marker,
	markerPath,
	type PatchFile,
	type Repo,
	removeWorktree,
	runGit,
	sweepStaleWorktrees,
	writeMarker,
} from "../../swarm/worktree.ts";
import type { AgentDefinition } from "../agents.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";

export type IsolationMode = "none" | "worktree";

/** What an isolated sub-agent needs to know about where it runs. `cwd` and `trusted` are read by the runner. */
export interface Placement {
	/** Where the sub-agent works. Undefined means the parent's working directory. */
	cwd?: string;
	/** The parent's project trust, handed on: a temp checkout of a trusted project is that project. */
	trusted?: boolean;
}

export interface IsolationOptions {
	/** `worktree`: roles that edit files get an isolated checkout. `none`: nobody does. */
	isolation: string;
	carryUncommitted: boolean;
	patchPreviewLines: number;
}

/** A role that can change files: every tool, or an allowlist with edit or write in it. */
export function editsFiles(agent: Pick<AgentDefinition, "tools"> | undefined): boolean {
	return !agent?.tools || agent.tools.some((tool) => tool === "edit" || tool === "write");
}

/** What came of one task's isolation, for the text the parent model reads. */
export interface IsolationOutcome {
	isolated: boolean;
	/** Why it was not isolated although it should have been, or what was left behind when carrying over. */
	notes: string[];
	patch?: PatchRecord;
	preview?: string;
	/** The judge's view of the patch, when it had one to give. */
	review?: string;
}

const stores = new WeakMap<KyrnRuntime, PatchStore>();

/** The patches of this session, for `/swarm`. */
export function patchesOf(runtime: KyrnRuntime): PatchRecord[] {
	return stores.get(runtime)?.list() ?? [];
}

function changeOf(file: PatchFile): string {
	if (file.binary) return `${file.status}, binary`;
	return `${file.status} +${file.insertions} -${file.deletions}`;
}

/**
 * Worktree isolation for the `delegate` tool: decides who gets a checkout,
 * wraps the runner so a sub-agent starts inside it, and turns what it changed
 * into a stored patch. Nothing is brought back automatically: that is what
 * `apply_patch_from` is for.
 */
export class Isolation {
	readonly store = new PatchStore();
	private readonly runtime: KyrnRuntime;
	private readonly options: IsolationOptions;
	private readonly git: GitRun;
	private readonly area: string;
	/** Checkouts that exist right now, so that a shutdown in the middle of a run can take them down. */
	private readonly live = new Map<string, Marker>();

	constructor(runtime: KyrnRuntime, options: IsolationOptions, git: GitRun = runGit, area: string = tmpdir()) {
		this.runtime = runtime;
		this.options = options;
		this.git = git;
		this.area = area;
		stores.set(runtime, this.store);
	}

	/** The mode each task gets before looking at the repository: what was asked for, else what the role implies. */
	wanted(asked: string | undefined, agent: AgentDefinition | undefined): IsolationMode {
		if (asked === "none" || asked === "worktree") return asked;
		return this.options.isolation !== "none" && editsFiles(agent) ? "worktree" : "none";
	}

	/** Whether a checkout can be made from `cwd`, checked once per delegate call. */
	async repo(cwd: string): Promise<{ repo?: Repo; problem?: string }> {
		if (this.options.isolation === "none") return { problem: "isolation is switched off in mu.json" };
		const check = await checkRepo(this.git, cwd);
		return check.ok ? { repo: check.repo } : { problem: check.message };
	}

	/**
	 * A runner that gives the tasks in `isolated` their own checkout under `runDir`. Everything else runs as
	 * before. `outcomes` fills up as sub-agents end, whichever way they end.
	 */
	wrap<Assignment extends Placement>(
		runner: BeeRunner<Assignment>,
		context: { repo: Repo; cwd: string; runDir: string; trusted: boolean; isolated: ReadonlyMap<BeeTask, number> },
		outcomes: Map<BeeTask, IsolationOutcome>,
	): BeeRunner<Assignment> {
		return async (task, assignment, signal, env, observer) => {
			const index = context.isolated.get(task);
			if (index === undefined) return runner(task, assignment, signal, env, observer);
			const outcome: IsolationOutcome = { isolated: false, notes: [] };
			outcomes.set(task, outcome);

			const dir = join(context.runDir, `w${index}`);
			const marker: Marker = {
				repoRoot: context.repo.root,
				dir,
				branch: `mu/agent-${basename(context.runDir).replace(/^kyrn-swarm-/, "")}-${index}`,
				pid: process.pid,
				createdAt: Date.now(),
			};
			// The marker first: a checkout without one could never be told from somebody else's.
			const made = await writeMarker(marker)
				.then(() =>
					createWorktree(this.git, {
						repo: context.repo,
						dir,
						branch: marker.branch,
						carry: this.options.carryUncommitted,
						signal,
					}),
				)
				.catch((error: unknown) => ({ ok: false as const, message: String(error) }));
			if (!made.ok) {
				outcome.notes.push(`Not isolated (${made.message}): it worked in place, in your working tree.`);
				return runner(task, assignment, signal, env, observer);
			}
			const { worktree, carried } = made;
			this.live.set(dir, marker);
			outcome.isolated = true;
			if (carried.skipped.length > 0) {
				outcome.notes.push(
					`Untracked files it did not get (too large or unreadable): ${clip(carried.skipped.join(", "), 300)}`,
				);
			}
			this.runtime.present("swarm.worktree.created", {
				task: task.title,
				branch: marker.branch,
				dir: `${basename(context.runDir)}/w${index}`,
				carried: { tracked: carried.tracked, untracked: carried.untracked },
			});

			// Instructions are written by a model that knows the real paths. Here they must mean the copy.
			const instructions = `${rebase(task.instructions, context, worktree.dir)}\n\nYou work in an isolated copy of the repository (${worktree.dir}). Use paths relative to your working directory and never touch ${context.repo.root}. Do not commit or push: when you finish, your changes are collected as a patch.`;
			try {
				return await runner(
					{ ...task, instructions },
					{ ...assignment, cwd: worktree.cwd, trusted: context.trusted },
					signal,
					env,
					observer,
				);
			} finally {
				// Stopped, crashed or done: what it changed is kept, and the checkout goes.
				const collected = await collectPatch(this.git, worktree).catch((error: unknown) => ({
					ok: false as const,
					message: String(error),
				}));
				if (!collected.ok) outcome.notes.push(`Its changes could not be collected: ${collected.message}`);
				else if (collected.summary.files.length > 0) {
					outcome.patch = this.store.save(join(context.runDir, "patches"), collected.patch, {
						task: task.title,
						role: (assignment as { agent?: { name?: string } }).agent?.name,
						repoRoot: context.repo.root,
						summary: collected.summary,
					});
					outcome.preview = patchPreview(collected.patch, collected.summary.files, this.options.patchPreviewLines);
					this.runtime.present("swarm.patch.ready", this.patchPayload(outcome.patch));
				}
				await this.takeDown(marker, task.title);
			}
		};
	}

	private patchPayload(record: PatchRecord) {
		return {
			id: record.id,
			task: record.task,
			status: record.status,
			files: record.summary.files.length,
			insertions: record.summary.insertions,
			deletions: record.summary.deletions,
			// Paths relative to the repository and counts. Never content.
			paths: record.summary.files.slice(0, 50).map((file) => file.path),
		};
	}

	private async takeDown(marker: Marker, task?: string): Promise<void> {
		// Released first: if the removal fails half way (a file held open on Windows), any later sweep may finish it.
		await writeMarker({ ...marker, released: true }).catch(() => undefined);
		const problems = await removeWorktree(this.git, marker).catch((error: unknown) => [String(error)]);
		this.live.delete(marker.dir);
		if (problems.length === 0) await removeMarker(marker);
		this.runtime.present("swarm.worktree.removed", { task, branch: marker.branch, clean: problems.length === 0 });
	}

	/** Asks the judge about every patch of one delegate call, and writes what it said into the outcomes. */
	async review(outcomes: ReadonlyMap<BeeTask, IsolationOutcome>, signal?: AbortSignal): Promise<void> {
		const judged = [...outcomes].filter(([, outcome]) => outcome.patch);
		if (judged.length === 0) return;
		const inputs: PatchReviewInput[] = judged.map(([task, outcome]) => ({
			task: clip(`${task.title}: ${task.instructions}`, 800),
			files: (outcome.patch?.summary.files ?? []).map((file) => ({ path: file.path, change: changeOf(file) })),
		}));
		const decisions = await this.runtime.engine.decideMany(swarmPatch, inputs, { signal });
		judged.forEach(([, outcome], at) => {
			// Shadow records the verdict and says nothing, like every other decision.
			if (decisions[at].source !== "judge") return;
			outcome.review = describePatchReview(decisions[at].outcome, inputs[at].files.length);
		});
	}

	/** What the parent model reads under a task's report. */
	describe(outcome: IsolationOutcome | undefined): string {
		if (!outcome) return "";
		const lines = [...outcome.notes];
		const patch = outcome.patch;
		if (patch) {
			lines.push(
				`Patch ${patch.id}: ${describeSummary(patch.summary)}. It is NOT in your working tree yet.`,
				...statLines(patch.summary, 20),
			);
			if (outcome.review) lines.push(`Scope check by the judge: ${outcome.review}`);
			if (outcome.preview) lines.push("It begins:", outcome.preview);
			lines.push(
				`Look at it with apply_patch_from({ id: "${patch.id}", action: "diff", file: "<path>" }), bring it in with apply_patch_from({ id: "${patch.id}" }).`,
			);
		} else if (outcome.isolated) {
			lines.push("It worked in an isolated copy and changed no files: there is no patch.");
		}
		return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
	}

	/** Once per session: what dead sessions left behind. Never in the way of the session starting. */
	async sweep(): Promise<void> {
		await sweepStaleWorktrees(this.git, { area: this.area }).catch(() => []);
	}

	/** The session is going away in the middle of a run. */
	async shutdown(): Promise<void> {
		for (const marker of [...this.live.values()]) await this.takeDown(marker).catch(() => undefined);
	}

	registerTool(): void {
		const { runtime, store, git } = this;
		const say = (text: string, details: Record<string, unknown> = {}) => ({
			content: [{ type: "text" as const, text }],
			details,
		});
		runtime.pi.registerTool({
			name: "apply_patch_from",
			label: "Apply patch",
			description:
				'Bring the patch of an isolated subagent into the working tree with git apply --3way: all of it or, on a conflict, none of it. Nothing is staged or committed. Look first with action "stat" (files) or "diff" (one file).',
			parameters: Type.Object({
				id: Type.String({ description: "Patch id from a delegate result, e.g. p-3f9a2c" }),
				action: Type.Optional(
					Type.Union([Type.Literal("apply"), Type.Literal("stat"), Type.Literal("diff")], {
						description: "Default: apply",
					}),
				),
				file: Type.Optional(Type.String({ description: "For diff: a path from the patch" })),
				conflicts: Type.Optional(
					Type.Union([Type.Literal("abort"), Type.Literal("markers")], {
						description:
							"abort (default): change nothing on a conflict. markers: apply what merges, leave conflict markers in the rest",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				runtime.touch(ctx);
				const record = store.get(params.id);
				if (!record) {
					const known = store.list().map(describeRecord);
					return say(
						known.length > 0
							? `No patch has the id "${params.id}". Patches of this session:\n${known.join("\n")}`
							: `No patch has the id "${params.id}": no isolated subagent has handed one back in this session.`,
					);
				}
				const action = params.action ?? "apply";
				if (action === "stat")
					return say(`${describeRecord(record)}\n${statLines(record.summary, 200).join("\n")}`);
				const patch = readPatch(record);
				if (!patch)
					return say(`The file of patch ${record.id} is gone (${record.path}). It cannot be shown or applied.`);
				if (action === "diff") {
					const file = record.summary.files.find((entry) => entry.path === params.file);
					if (!file) {
						return say(`Name one file of the patch in "file":\n${statLines(record.summary, 200).join("\n")}`);
					}
					return say(clip20k(fileSection(patch, file) ?? `No section for ${file.path} in the patch.`));
				}

				const check = await checkRepo(git, ctx.cwd);
				if (!check.ok) return say(`Patch ${record.id} was not applied: ${check.message}. It is kept.`);
				if (check.repo.root !== record.repoRoot) {
					return say(
						`Patch ${record.id} was made in ${record.repoRoot}, not in this repository. It was not applied.`,
					);
				}
				const result = await applyPatch(git, {
					repoRoot: record.repoRoot,
					patchPath: record.path,
					files: record.summary.files,
					onConflict: params.conflicts ?? "abort",
					scratchDir: join(dirname(record.path), "scratch"),
					signal,
				});
				const details = { id: record.id, result };
				if (result.status === "applied" || result.status === "applied-with-conflicts") {
					store.setStatus(record.id, result.status);
					// An applied patch is an edit like any other: whoever checks "done" claims has to know about it.
					for (const file of record.summary.files) runtime.turn.editedFiles.add(file.path);
					runtime.turn.ranCommandAfterLastEdit = false;
				}
				runtime.present("swarm.patch.applied", {
					id: record.id,
					status: result.status,
					files: record.summary.files.length,
					conflicted:
						result.status === "conflicts"
							? result.files
							: result.status === "applied-with-conflicts"
								? result.conflicted
								: [],
				});
				switch (result.status) {
					case "applied":
						return say(
							`Applied patch ${record.id} to the working tree: ${describeSummary(record.summary)}. Nothing was staged or committed.`,
							details,
						);
					case "already-applied":
						return say(`Patch ${record.id} is already in the working tree. Nothing was changed.`, details);
					case "conflicts":
						return say(
							`Patch ${record.id} was NOT applied, and nothing was changed: these files were changed on both sides in the same places:\n${result.files.map((file) => `- ${file}`).join("\n")}\nThe patch is kept. Either make those changes by hand (action "diff" shows them), or call again with conflicts: "markers" to apply the rest and get conflict markers in these files.`,
							details,
						);
					case "applied-with-conflicts":
						return say(
							`Applied patch ${record.id} with conflicts. These files now hold conflict markers (<<<<<<< ours / >>>>>>> theirs) that you must resolve:\n${result.conflicted.map((file) => `- ${file}`).join("\n")}\nApplied cleanly: ${result.clean.join(", ") || "nothing else"}. Nothing was staged or committed.`,
							details,
						);
					default:
						return say(
							`Patch ${record.id} does not apply, and nothing was changed:\n${result.reasons.map((reason) => `- ${reason}`).join("\n")}\nThe patch is kept.`,
							details,
						);
				}
			},
		});

		runtime.pi.on(
			"session_start",
			failOpen<SessionStartEvent, undefined>(() => {
				// Not awaited: removing what a dead session left behind must not hold up this one's start.
				void this.sweep();
				return undefined;
			}),
		);
		runtime.pi.on(
			"session_shutdown",
			failOpen<SessionShutdownEvent, undefined>(async () => {
				await this.shutdown();
				return undefined;
			}),
		);
	}
}

/**
 * Points absolute paths into the repository at the checkout instead. The repository is known by two
 * spellings when a symlink is involved: git's resolved one, and the one the parent session runs under.
 */
export function rebase(instructions: string, parent: { repo: Repo; cwd: string }, dir: string): string {
	const prefix = parent.repo.prefix.replace(/[\\/]$/, "");
	// git writes the prefix with forward slashes, and on Windows the working directory has backslashes: compared as
	// they are, `packages/app` never ended `C:\repo\packages\app`, and a path into packages\app lost that part.
	const nested = prefix && parent.cwd.replaceAll("\\", "/").endsWith(`/${prefix}`);
	const asSpelled = nested ? parent.cwd.slice(0, -prefix.length - 1) : parent.cwd;
	// The longer spelling first: one may be the beginning of the other (/var and /private/var).
	const roots = [...new Set([parent.repo.root, asSpelled])].sort((a, b) => b.length - a.length);
	return roots.reduce((text, root) => (root ? text.split(root).join(dir) : text), instructions);
}

async function removeMarker(marker: Marker): Promise<void> {
	await rm(markerPath(marker.dir), { force: true }).catch(() => undefined);
}

/** One file's diff can be a whole generated file; the model asked to look, not to drown. */
function clip20k(text: string): string {
	return text.length <= 20_000 ? text : `${text.slice(0, 20_000)}\n… (${text.length - 20_000} more characters)`;
}
