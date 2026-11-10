import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { APPROVE_AT, CHECK_APPROVE_AT, LOWEST_APPROVE_AT, toolApproval } from "../../decisions/tool-approval.ts";
import { type LineSuggestion, suggestApprovalLine } from "../../evolve/calibrate.ts";
import {
	type AdaptationRow,
	type ApprovalRow,
	activeAdaptation,
	activeAdaptations,
	attention,
	EvolveStore,
	grantSuggestions,
	medianGap,
	missingCommands,
	openingReads,
	type RunCounts,
} from "../../evolve/store.ts";
import { say } from "../../language.ts";
import { MODE_TEXT } from "../../permissions/modes.ts";
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

const NOTHING_TAKEN: RunCounts = {
	permissions: 0,
	permissionsSame: 0,
	questions: 0,
	questionsSame: 0,
	unanswered: 0,
	messages: 0,
};

/** A count with its noun: "1 run", "3 runs". */
const counted = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

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
 * - **Commands allowed in a project.** When the user's latest answers about a command were all "allow for this
 *   session", `/evolve` says so, and `/evolve accept <command>` keeps it allowed in the project, in the permission mode
 *   it was accepted in. It covers what a grant for the session covers: not a call a rule flags, nor one that touches
 *   mu's settings. `/evolve undo <id>` takes it back.
 * - **Programs missing on this machine.** A command that fails with "command not found" and works with one word
 *   changed names the stand-in; the opening snapshot tells later sessions, until the program is on the PATH.
 * - **What a project's sessions open with**, for the preload feature, and **how long the user stays away**.
 * - **What a run takes of the user.** For each run a message of theirs starts: the permission questions and the
 *   questions of ask_user they dealt with, how many of those changed nothing (they allowed the call, they took the
 *   option the model had put first), the messages they sent into the run, and whether they stopped it. `/evolve` adds
 *   them up. Nothing adapts to these counts yet: they are what asking less would be measured by.
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
		/** "Allow for this session" answers in a row a command has to have before a standing grant is suggested. */
		minGrants: 3,
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
	/** The standing grants of each project asked about in this session, as `<mode> <key>`; as with `lines`. */
	const standing = new Map<string, Set<string>>();
	const grantsOf = (cwd: string): Set<string> => {
		let known = standing.get(cwd);
		if (!known) {
			known = new Set(activeAdaptations(store.rows(), "grant", cwd).map((grant) => `${grant.mode} ${grant.key}`));
			standing.set(cwd, known);
		}
		return known;
	};
	const least = Math.max(1, Math.floor(Number(options.minGrants) || 0));
	/** What could be granted for good in the permission mode this session is in. None with the permission gate off. */
	const grantable = (cwd: string) => {
		const mode = runtime.permissionMode?.();
		return mode ? grantSuggestions(store.rows(), cwd, mode, least) : [];
	};
	const undo = (adaptation: AdaptationRow): void => {
		store.append({ ...adaptation, status: "undone", at: now() });
		if (adaptation.kind === "grant") standing.delete(adaptation.cwd);
		else lines.set(adaptation.cwd, undefined);
	};

	/** What the run that is going has taken of the user so far, and what was asked of them since the last one settled. */
	let taken = NOTHING_TAKEN;
	/** A message of the user's started the run that is going: it is one to keep a row for. */
	let started = false;

	runtime.evolve = {
		approvalLine: lineOf,
		asked: (kind, ended) => {
			if (!learns(runtime.ctx)) return;
			if (ended === "unanswered") taken = { ...taken, unanswered: taken.unanswered + 1 };
			else if (kind === "permission") {
				taken = {
					...taken,
					permissions: taken.permissions + 1,
					permissionsSame: taken.permissionsSame + (ended === "same" ? 1 : 0),
				};
			} else {
				taken = {
					...taken,
					questions: taken.questions + 1,
					questionsSame: taken.questionsSame + (ended === "same" ? 1 : 0),
				};
			}
		},
		approvalAnswered: (answer) => {
			if (learns(runtime.ctx)) store.append({ type: "approval", at: now(), ...answer });
		},
		grantAnswered: (answer) => {
			if (learns(runtime.ctx)) store.append({ type: "grant", at: now(), ...answer });
		},
		granted: (cwd, key, mode) => grantsOf(cwd).has(`${mode} ${key}`),
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
			standing.clear();
			taken = NOTHING_TAKEN;
			started = false;
			return undefined;
		}),
	);

	pi.on(
		"before_agent_start",
		failOpen((event) => {
			if (event.messageType === "user") started = true;
			return undefined;
		}),
	);
	pi.on(
		"agent_settled",
		failOpen((event, ctx) => {
			// A run the harness cut itself goes on in the one it starts next (features/ttsr.ts, features/watchdog.ts), and
			// one mu started (an answer given with /approve) belongs with the next run of the user's.
			if (!started || runtime.harnessAbort) return undefined;
			started = false;
			const counts = taken;
			taken = NOTHING_TAKEN;
			if (learns(ctx)) store.append({ type: "run", cwd: ctx.cwd, at: now(), ...counts, stopped: event.aborted });
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
			if (event.source === "extension" || !event.text.trim()) return undefined;
			if (event.streamingBehavior) {
				// Written into a run that is going: the user stepped in.
				if (learns(ctx)) taken = { ...taken, messages: taken.messages + 1 };
				return undefined;
			}
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
		const granted = activeAdaptations(rows, "grant", cwd);
		if (granted.length > 0) {
			said.push(
				say({
					zh: "这个项目里不再询问的命令（你接受的；/evolve undo <id> 撤销）：",
					en: "Commands that run in this project without asking (you accepted them; /evolve undo <id> takes one back):",
				}),
				...granted.map((grant) => `  ${grant.id.slice(0, 8)} · ${grant.label} (${say(MODE_TEXT[grant.mode])})`),
			);
		}
		const suggested = grantable(cwd);
		if (suggested.length > 0) {
			said.push(
				say({
					zh: "你每次对话都允许的命令：",
					en: "Commands you keep allowing for the session here:",
				}),
			);
		}
		for (const grant of suggested) {
			said.push(
				say({
					zh: `  ${grant.label}：你连续 ${grant.sessions} 次都选了“这次对话都允许”。/evolve accept ${grant.label} 让它在这个项目里一直允许，mu 不再问。`,
					en: `  ${grant.label}: you allowed it for the session ${counted(grant.sessions, "time")} in a row. /evolve accept ${grant.label} keeps it allowed in this project, and mu stops asking.`,
				}),
			);
		}
		const rules = runtime.standingRules?.(cwd) ?? [];
		if (rules.length > 0) {
			said.push(
				say({
					zh: "常驻规则（改动前逐条把关；/forget <id> 去掉）：",
					en: "Standing rules (checked before a change; /forget <id> removes one):",
				}),
				...rules.map((rule) => `  ${rule.id.slice(0, 8)} · ${rule.text}`),
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
		const sum = attention(rows, cwd);
		if (sum) {
			const asked = sum.permissions + sum.questions;
			said.push(
				say({
					zh: `最近 ${sum.runs} 轮运行占用了你多少注意力：`,
					en: `What the last ${counted(sum.runs, "run")} here took of you:`,
				}),
				say({
					zh: `  ${sum.quiet} 轮完全没找你。`,
					en: `  ${sum.quiet} needed nothing from you.`,
				}),
			);
			if (asked > 0) {
				said.push(
					say({
						zh: `  mu 问了你 ${asked} 次：${sum.permissions} 次授权，${sum.questions} 次模型提问。`,
						en: `  mu asked you ${counted(asked, "time")}: ${counted(sum.permissions, "permission question")}, ${counted(sum.questions, "question")} from the model.`,
					}),
				);
			}
			if (sum.messages > 0) {
				said.push(
					say({
						zh: `  运行途中你发了 ${sum.messages} 条消息。`,
						en: `  You wrote into a run ${counted(sum.messages, "time")}.`,
					}),
				);
			}
			if (sum.stopped > 0) {
				said.push(
					say({
						zh: `  你叫停了 ${sum.stopped} 轮。`,
						en: `  You stopped ${counted(sum.stopped, "run")}.`,
					}),
				);
			}
			if (sum.permissions > 0) {
				said.push(
					say({
						zh: `  授权：${sum.permissions} 次里有 ${sum.permissionsSame} 次问了也没改变结果（你允许了）。`,
						en: `  Permission questions: ${sum.permissionsSame} of ${sum.permissions} changed nothing (you allowed the call).`,
					}),
				);
			}
			if (sum.questions > 0) {
				said.push(
					say({
						zh: `  模型提问：${sum.questions} 次里有 ${sum.questionsSame} 次问了也没改变结果（你选了它排在第一的选项，或跳过了）。`,
						en: `  Questions from the model: ${sum.questionsSame} of ${sum.questions} changed nothing (you picked the option it had put first, or skipped the question).`,
					}),
				);
			}
			if (sum.unanswered > 0) {
				said.push(
					say({
						zh: `  ${sum.unanswered} 次提问没等到回答，运行照常继续。`,
						en: `  ${counted(sum.unanswered, "question")} got no answer in time, and the run went on.`,
					}),
				);
			}
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
			const [word = "", ...rest] = args.trim().split(/\s+/);
			const named = rest.join(" ");
			if (word === "accept" && named) {
				const grant = grantable(ctx.cwd).find((each) => each.label === named);
				if (!grant) {
					ctx.ui.notify(
						say({
							zh: `这里没有关于「${named}」的建议。/evolve 列出现有的。`,
							en: `No suggestion for "${named}" here. /evolve lists what there is.`,
						}),
						"warning",
					);
					return;
				}
				const adaptation: AdaptationRow = {
					type: "adaptation",
					id: randomUUID(),
					...grant,
					kind: "grant",
					cwd: ctx.cwd,
					at: now(),
					status: "active",
				};
				store.append(adaptation);
				standing.delete(ctx.cwd);
				ctx.ui.notify(
					say({
						zh: `${grant.label} 在这个项目里不再询问（${MODE_TEXT[grant.mode].zh}下）。被规则标成危险的命令、动到 mu 自己设置的命令照旧会问。/evolve undo ${adaptation.id.slice(0, 8)} 撤销。`,
						en: `${grant.label} now runs in this project without asking, in ${MODE_TEXT[grant.mode].en}. A command a rule flags as risky, or one that touches mu's own settings, still asks. /evolve undo ${adaptation.id.slice(0, 8)} takes it back.`,
					}),
					"info",
				);
				return;
			}
			if (word === "accept") {
				const suggestion = suggest(ctx.cwd);
				if (!suggestion) {
					const commands = grantable(ctx.cwd);
					ctx.ui.notify(
						commands.length > 0
							? say({
									zh: `要接受哪条命令，写上它：/evolve accept ${commands[0].label}`,
									en: `Name the command to accept: /evolve accept ${commands[0].label}`,
								})
							: say({
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
				const id = named.toLowerCase();
				const rows = store.rows();
				const line = activeAdaptation(rows, "approval-line", ctx.cwd);
				// Without an id: the approval line, the one adaptation a project has one of.
				const accepted = id
					? [...(line ? [line] : []), ...activeAdaptations(rows, "grant", ctx.cwd)].find((each) =>
							each.id.startsWith(id),
						)
					: line;
				if (!accepted) {
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
					accepted.kind === "grant"
						? say({
								zh: `已撤销：${accepted.label} 在这个项目里重新要问你。`,
								en: `Taken back: mu asks about ${accepted.label} in this project again.`,
							})
						: say({
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
