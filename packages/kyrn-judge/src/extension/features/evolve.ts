import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { APPROVE_AT, CHECK_APPROVE_AT, LOWEST_APPROVE_AT, toolApproval } from "../../decisions/tool-approval.ts";
import { type LineSuggestion, suggestApprovalLine } from "../../evolve/calibrate.ts";
import {
	type AdaptationRow,
	type ApprovalRow,
	activeAdaptation,
	EvolveStore,
	medianGap,
	missingCommands,
	openingReads,
} from "../../evolve/store.ts";
import { say } from "../../language.ts";
import { failOpen, type KyrnRuntime, textOf } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";
import type { HarnessRoots } from "./inherit.ts";
import { isUnattended } from "./unattended.ts";

/** A run that fixed a missing program did so within this many commands, or it was another problem. */
const FIX_WITHIN_STEPS = 6;
/** A gap longer than this says the user left, not how they work: it is kept as this. */
const LONGEST_GAP_MS = 24 * 60 * 60 * 1000;

/** The program a shell said it could not find, from what it printed: zsh's wording, bash's and dash's. */
export function missingProgram(output: string): string | undefined {
	return (/command not found: ([\w.+-]+)/.exec(output) ??
		/(?:^|[\s:])([\w.+-]+): command not found/.exec(output) ??
		/: \d+: ([\w.+-]+): not found/.exec(output))?.[1];
}

/**
 * What stood in for a missing program: the command that worked is the one that failed with that one word changed
 * (`timeout 30 npm test`, then `gtimeout 30 npm test`). A command that was rewritten any further learned nothing
 * about the program, so it teaches nothing here.
 */
export function replacement(failed: string, worked: string, missing: string): string | undefined {
	const before = failed.trim().split(/\s+/);
	const after = worked.trim().split(/\s+/);
	if (before.length !== after.length) return undefined;
	let instead: string | undefined;
	for (const [index, word] of before.entries()) {
		if (word === after[index]) continue;
		if (word !== missing || (instead !== undefined && instead !== after[index])) return undefined;
		instead = after[index];
	}
	return instead && /^[\w.+-]+$/.test(instead) ? instead : undefined;
}

const duration = (ms: number): string =>
	ms < 90_000
		? `${Math.round(ms / 1000)} s`
		: ms < 5_400_000
			? `${Math.round(ms / 60_000)} min`
			: `${(ms / 3_600_000).toFixed(1)} h`;

/**
 * mu adapting to the person and the machine it works with (kyrn/docs/features/self-evolution.md). This feature keeps
 * what the others observe, in `<agent dir>/mu/evolve.jsonl`, and turns it into adaptations:
 *
 * - **The approval line of a project.** In judge mode the user is asked about a call the judge reads as needed with a
 *   probability under the line. When they allow every such call down to some probability, `/evolve` says so and
 *   `/evolve accept` lowers the line to there for this project. Marking an approval wrong (`/ledger wrong`) undoes it.
 * - **Programs missing on this machine.** A command that fails with "command not found" and works with one word
 *   changed names the stand-in; the opening snapshot tells later sessions, until the program is on the PATH.
 * - **What a project's sessions open with**, for the preload feature, and **how long the user stays away**.
 *
 * Loosening is the user's to accept, by a command they type: no verdict, no tool and no project file changes a line.
 * Tightening needs nobody: a mark undoes at once. An unattended run (`mu --print`, json mode) reads what was accepted
 * and observes nothing, as it learns no lessons.
 */
export function registerEvolve(runtime: KyrnRuntime, roots?: HarnessRoots): void {
	const options = runtime.options("evolve", {
		enabled: true,
		/** Answers a band of approval questions has to hold before a lower line is suggested. */
		minAnswers: 12,
		/** No suggested line goes below this. The decision itself takes none below `LOWEST_APPROVE_AT`. */
		floor: LOWEST_APPROVE_AT,
		/** An answer that waited at least this long counts as read; half of `minAnswers` have to be. */
		consideredMs: 1500,
		/** Learn which programs are missing here from a command that failed and worked with one word changed. */
		commands: true,
		/** Observe in a `mu --print` or json run too. */
		unattended: false,
	});
	// A subagent's calls are its parent's task: what they show is learned in the parent, if at all.
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;
	const store = new EvolveStore(roots ? join(roots.agentDir, "mu", "evolve.jsonl") : undefined);
	const now = () => new Date().toISOString();
	const learns = (ctx: ExtensionContext | undefined): boolean => options.unattended || !isUnattended(ctx);
	const floor = Math.max(LOWEST_APPROVE_AT, options.floor);

	/** The accepted line of each project asked about in this session; another session's change shows in the next. */
	const lines = new Map<string, number | undefined>();
	const lineOf = (cwd: string): number | undefined => {
		if (!lines.has(cwd)) lines.set(cwd, activeAdaptation(store.rows(), "approval-line", cwd)?.value);
		return lines.get(cwd);
	};
	const suggest = (cwd: string): LineSuggestion | undefined =>
		suggestApprovalLine(
			store.rows().filter((row): row is ApprovalRow => row.type === "approval" && row.cwd === cwd),
			lineOf(cwd) ?? APPROVE_AT,
			{
				line: APPROVE_AT,
				checkLine: CHECK_APPROVE_AT,
				floor,
				minAnswers: options.minAnswers,
				consideredMs: options.consideredMs,
			},
		);
	const undo = (adaptation: AdaptationRow): void => {
		store.append({ ...adaptation, status: "undone", at: now() });
		lines.set(adaptation.cwd, undefined);
	};

	runtime.evolve = {
		approvalLine: lineOf,
		approvalAnswered: (answer) => {
			if (learns(runtime.ctx)) store.append({ type: "approval", at: now(), ...answer });
		},
		opened: (cwd, paths) => {
			if (paths.length > 0 && learns(runtime.ctx)) store.append({ type: "opening", cwd, at: now(), paths });
		},
		openingReads: (cwd) => openingReads(store.rows(), cwd).map((read) => read.path),
		missingCommands: () => missingCommands(store.rows()),
		markedWrong: (specId, cwd) => {
			if (specId !== toolApproval.id) return undefined;
			const accepted = activeAdaptation(store.rows(), "approval-line", cwd);
			if (!accepted) return undefined;
			undo(accepted);
			return say({
				zh: `这个项目的审批线已退回内置的 ${APPROVE_AT.toFixed(2)}（原先接受的是 ${accepted.value.toFixed(2)}）。`,
				en: `The approval line of this project is back at the built-in ${APPROVE_AT.toFixed(2)} (it was ${accepted.value.toFixed(2)}).`,
			});
		},
	};

	pi.on(
		"session_start",
		failOpen(() => {
			lines.clear();
			return undefined;
		}),
	);

	// A program that was not found, and the command that then worked with one word changed.
	let step = 0;
	let notFound: { missing: string; command: string; step: number } | undefined;
	pi.on(
		"tool_result",
		failOpen((event, ctx) => {
			if (!options.commands || !isShellTool(event.toolName) || !learns(ctx)) return undefined;
			const command = String((event.input as { command?: unknown }).command ?? "");
			step++;
			if (event.isError) {
				const missing = missingProgram(textOf(event.content));
				if (missing && command.split(/\s+/).includes(missing)) notFound = { missing, command, step };
				return undefined;
			}
			const failed = notFound;
			if (!failed || step - failed.step > FIX_WITHIN_STEPS) return undefined;
			const instead = replacement(failed.command, command, failed.missing);
			if (!instead) return undefined;
			notFound = undefined;
			const known = missingCommands(store.rows()).find((fact) => fact.missing === failed.missing);
			if (known?.instead !== instead) store.append({ type: "command", at: now(), missing: failed.missing, instead });
			return undefined;
		}),
	);

	// How long the user stays away after a run ends: what a cache is kept warm for, or not.
	let endedAt: number | undefined;
	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>((event) => {
			const last = [...event.messages].reverse().find((message) => message.role === "assistant") as
				| { stopReason?: string }
				| undefined;
			// Cut short by the user or by an error: they are still here, and the next message says nothing about a gap.
			endedAt = !last || last.stopReason === "aborted" || last.stopReason === "error" ? undefined : Date.now();
			return undefined;
		}),
	);
	pi.on(
		"input",
		failOpen((event, ctx) => {
			if (event.source === "extension" || event.streamingBehavior || !event.text.trim()) return undefined;
			const ended = endedAt;
			endedAt = undefined;
			if (ended !== undefined && learns(ctx)) {
				store.append({ type: "gap", cwd: ctx.cwd, at: now(), gapMs: Math.min(LONGEST_GAP_MS, Date.now() - ended) });
			}
			return undefined;
		}),
	);

	const report = (cwd: string): string => {
		const rows = store.rows();
		const said: string[] = [];
		const accepted = activeAdaptation(rows, "approval-line", cwd);
		const answers = rows.filter((row) => row.type === "approval" && row.cwd === cwd).length;
		said.push(
			accepted
				? say({
						zh: `审批线：${accepted.value.toFixed(2)}（你接受的，原为 ${accepted.evidence.from.toFixed(2)}；/evolve undo ${accepted.id.slice(0, 8)} 撤销）`,
						en: `Approval line: ${accepted.value.toFixed(2)} (you accepted it; it was ${accepted.evidence.from.toFixed(2)}; /evolve undo ${accepted.id.slice(0, 8)} takes it back)`,
					})
				: say({
						zh: `审批线：${APPROVE_AT.toFixed(2)}（内置）`,
						en: `Approval line: ${APPROVE_AT.toFixed(2)} (built in)`,
					}),
		);
		const suggestion = suggest(cwd);
		said.push(
			suggestion
				? say({
						zh: `  判定器给到 ${suggestion.line.toFixed(2)} 至 ${suggestion.from.toFixed(2)} 之间的 ${suggestion.allowed} 次调用，你全都允许了（其中 ${suggestion.considered} 次是看过才点的）。/evolve accept 把这个项目的审批线降到 ${suggestion.line.toFixed(2)}：这类调用以后不再问你。`,
						en: `  You allowed all ${suggestion.allowed} calls the judge put between ${suggestion.line.toFixed(2)} and ${suggestion.from.toFixed(2)} (${suggestion.considered} of them after reading the question). /evolve accept lowers this project's line to ${suggestion.line.toFixed(2)}: mu stops asking about such calls.`,
					})
				: say({
						zh: `  还没有可以建议的更低的线：这个项目里你回答过 ${answers} 次，一个区间里要有 ${options.minAnswers} 次且全是允许。`,
						en: `  No lower line to suggest yet: ${answers} answered here so far, and a band needs ${options.minAnswers}, all of them allowed.`,
					}),
		);
		const standing = runtime.standingRules?.(cwd) ?? [];
		if (standing.length > 0) {
			said.push(
				say({
					zh: "常驻规则（改动前逐条把关；/forget <id> 去掉）：",
					en: "Standing rules (checked before a change; /forget <id> removes one):",
				}),
				...standing.map((rule) => `  ${rule.id.slice(0, 8)} · ${rule.text}`),
			);
		}
		const missing = missingCommands(rows);
		if (missing.length > 0) {
			said.push(
				say({ zh: "这台机器上没有的程序：", en: "Programs missing on this machine:" }),
				...missing.map((fact) =>
					say({
						zh: `  ${fact.missing}（${fact.instead} 顶替过）`,
						en: `  ${fact.missing} (${fact.instead} worked in its place)`,
					}),
				),
			);
		}
		const reads = openingReads(rows, cwd).slice(0, 6);
		if (reads.length > 0) {
			said.push(
				say({ zh: "这个项目的会话开场最常读的文件：", en: "Files this project's sessions most often open with:" }),
				`  ${reads.map((read) => `${read.path} (${read.count})`).join(", ")}`,
			);
		}
		const gap = medianGap(rows, cwd);
		if (gap !== undefined) {
			said.push(
				say({
					zh: `一轮结束后，你通常过 ${duration(gap)} 回来（中位数）。`,
					en: `After a run ends, you're usually back in ${duration(gap)} (median).`,
				}),
			);
		}
		return said.join("\n");
	};

	pi.registerCommand("evolve", {
		description: say({
			zh: "mu 在这个项目和这台机器上学到了什么、建议什么：/evolve；/evolve accept 接受建议的审批线；/evolve undo <id> 撤销",
			en: "Show what mu has learned about this project and this machine, and what it suggests: /evolve; /evolve accept takes the suggested approval line; /evolve undo <id> takes one back",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const [word = "", id = ""] = args.trim().split(/\s+/);
			if (word === "accept") {
				const suggestion = suggest(ctx.cwd);
				if (!suggestion) {
					ctx.ui.notify(
						say({
							zh: "现在没有可接受的建议。/evolve 看已经观察到什么。",
							en: "Nothing to accept yet. /evolve shows what has been seen so far.",
						}),
						"info",
					);
					return;
				}
				// One line per project: the one in force until now is undone, so the listing shows what holds.
				const previous = activeAdaptation(store.rows(), "approval-line", ctx.cwd);
				if (previous) undo(previous);
				const adaptation: AdaptationRow = {
					type: "adaptation",
					id: randomUUID(),
					kind: "approval-line",
					cwd: ctx.cwd,
					value: suggestion.line,
					evidence: { allowed: suggestion.allowed, considered: suggestion.considered, from: suggestion.from },
					at: now(),
					status: "active",
				};
				store.append(adaptation);
				lines.set(ctx.cwd, adaptation.value);
				ctx.ui.notify(
					say({
						zh: `这个项目的审批线现在是 ${adaptation.value.toFixed(2)}。/evolve undo ${adaptation.id.slice(0, 8)} 撤销；把一次放行标成判错（/ledger wrong）也会撤销。`,
						en: `This project's approval line is now ${adaptation.value.toFixed(2)}. /evolve undo ${adaptation.id.slice(0, 8)} takes it back, and so does marking an approval wrong (/ledger wrong).`,
					}),
					"info",
				);
				return;
			}
			if (word === "undo") {
				const accepted = activeAdaptation(store.rows(), "approval-line", ctx.cwd);
				if (!accepted || (id && !accepted.id.startsWith(id.toLowerCase()))) {
					ctx.ui.notify(
						say({
							zh: "这个项目没有这样一条可撤销的适配。/evolve 列出现有的。",
							en: "No such adaptation in this project. /evolve lists what there is.",
						}),
						"warning",
					);
					return;
				}
				undo(accepted);
				ctx.ui.notify(
					say({
						zh: `已撤销：审批线回到内置的 ${APPROVE_AT.toFixed(2)}。`,
						en: `Taken back: the approval line is the built-in ${APPROVE_AT.toFixed(2)} again.`,
					}),
					"info",
				);
				return;
			}
			ctx.ui.notify(report(ctx.cwd), "info");
		},
	});
}
