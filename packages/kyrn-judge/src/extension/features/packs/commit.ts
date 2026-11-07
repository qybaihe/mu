import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GitUnusableReason } from "../../../checkpoint/git.ts";
import { say } from "../../../language.ts";
import {
	type ApplyOutcome,
	applyPlan,
	type Change,
	type CommitPlan,
	describePlan,
	PLAN_SYSTEM,
	parsePlanReply,
	planRequest,
	readChange,
	rulePlan,
	validatePlan,
} from "../../../packs/commit.ts";
import { installHint } from "../../../packs/exec.ts";
import { gitOver, repoState } from "../../../packs/git.ts";
import type { LlmCompletion } from "../../../providers/llm.ts";
import type { KyrnRuntime } from "../../runtime.ts";
import type { PackShared } from "./pack.ts";

const TITLE = "mu /commit";

/** What /commit tells the user when git cannot run on this Mac: only they can change that. */
const CANNOT_RUN: Readonly<Record<GitUnusableReason, { zh: string; en: string }>> = {
	developer_tools_missing: {
		zh: "/commit 用不了：这台 Mac 没有安装 git 所需的命令行开发者工具。用 xcode-select --install 安装后再试。",
		en: "/commit can't run: git needs the command line developer tools, which aren't installed on this Mac. Install them with xcode-select --install, then try again.",
	},
	xcode_license: {
		zh: "/commit 用不了：这台 Mac 还没有同意 Xcode 许可协议，git 无法运行。在终端里用 sudo xcodebuild -license 同意后再试。",
		en: "/commit can't run: git can't run on this Mac until you accept the Xcode license. Run sudo xcodebuild -license in Terminal to accept it, then try again.",
	},
};

/**
 * `/commit [what to keep in mind]`: the uncommitted change, split into commits
 * a reviewer can read one at a time. A model proposes the groups and the
 * messages, the user reads the plan and says yes, and only then are the
 * commits made: all of them, or none. Nothing is ever pushed. Where there is
 * nobody to ask, the plan is shown and nothing is committed.
 */
export function registerCommit(shared: PackShared, options: { maxPlanChars: number }): void {
	const { runtime } = shared;
	runtime.pi.registerCommand("commit", {
		description: say({
			zh: "把还没提交的改动拆成几个提交：先给你看计划，你同意才提交，从不推送",
			en: "Split uncommitted changes into commits: shows the plan, commits only when you approve and never pushes",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const git = gitOver(shared.run);
			const repo = await repoState(git, ctx.cwd);
			if (!repo.ok) {
				const why =
					repo.reason === "unusable"
						? say(CANNOT_RUN[repo.unusable])
						: repo.reason === "no-git"
							? installHint("git", shared.platform)
							: say({
									zh: `这里不是 git 仓库：${repo.message}`,
									en: `This isn't a git repository: ${repo.message}`,
								});
				ctx.ui.notify(why, "warning");
				return;
			}
			if (repo.inProgress) {
				ctx.ui.notify(
					say({
						zh: `有一个 ${repo.inProgress} 正在进行。先完成或放弃它：现在提交会打乱它。`,
						en: `A ${repo.inProgress} is in progress. Finish or abort it first; new commits now would interfere with it.`,
					}),
					"warning",
				);
				return;
			}
			const change = await readChange(git, repo.root, repo.head);
			if (change.units.length === 0) {
				const some = `${change.untracked.slice(0, 5).join(", ")}${change.untracked.length > 5 ? ", ..." : ""}`;
				ctx.ui.notify(
					change.untracked.length > 0
						? say({
								zh: `没有可提交的：只有 git 没在跟踪的文件（${some}）。把该进去的 \`git add\` 上，再运行 /commit。`,
								en: `Nothing to commit: there are only untracked files (${some}). \`git add\` the ones you want, then run /commit again.`,
							})
						: say({
								zh: "没有可提交的：工作区和 HEAD 一样。",
								en: "Nothing to commit: the working tree matches HEAD.",
							}),
					"info",
				);
				return;
			}

			const { plan, note } = await propose(runtime, ctx, change, args.trim() || undefined, options.maxPlanChars);
			const shown = `${describePlan(change, plan)}${note ? `\n\n${note}` : ""}`;
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`${shown}\n\n${say({
						zh: "没有提交：/commit 提交前要先问你，而这里没有人可问。",
						en: "Nothing committed: /commit asks before committing, and there's no one to ask here.",
					})}`,
					"info",
				);
				return;
			}
			const count = plan.commits.length;
			const agreed = await ctx.ui.confirm(
				TITLE,
				`${shown}\n\n${say({
					zh: `${count === 1 ? "做这个提交" : `做这 ${count} 个提交`}？不会推送。`,
					en: `Make ${count === 1 ? "this commit" : `these ${count} commits`}? Nothing will be pushed.`,
				})}`,
			);
			if (!agreed) {
				ctx.ui.notify(say({ zh: "什么都没有提交。", en: "Nothing was committed." }), "info");
				return;
			}
			const outcome = await applyPlan(git, repo, change, plan, ctx.signal);
			ctx.ui.notify(report(outcome), outcome.status === "done" ? "info" : "warning");
		},
	});
}

/**
 * The model's grouping, checked unit by unit. A plan that misses or repeats a
 * unit goes back once with what was wrong; after that, or without a model, one
 * commit per file.
 */
async function propose(
	runtime: KyrnRuntime,
	ctx: ExtensionCommandContext,
	change: Change,
	hint: string | undefined,
	maxChars: number,
): Promise<{ plan: CommitPlan; note?: string }> {
	const model = ctx.model;
	const complete: LlmCompletion | undefined =
		runtime.writer() ?? (model ? runtime.llm(`${model.provider}/${model.id}`, { thinking: "off" }) : undefined);
	const byRule = (why: string) => ({
		plan: rulePlan(change),
		note: say({ zh: `${why}：改为每个文件一个提交。`, en: `${why}; using one commit per file instead.` }),
	});
	if (!complete) return byRule(say({ zh: "没有模型来提议怎么拆", en: "No model is available to propose a split" }));

	const request = planRequest(change, hint, maxChars);
	let user = request;
	let problem = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		let reply: string;
		try {
			reply = (await complete({ system: PLAN_SYSTEM, user, signal: ctx.signal })).text;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return byRule(
				say({ zh: `模型没有给出提议（${message}）`, en: `The model didn't propose a split (${message})` }),
			);
		}
		const parsed = parsePlanReply(reply);
		const problems = parsed.ok ? validatePlan(parsed.plan, change.units) : [parsed.problem];
		if (parsed.ok && problems.length === 0) return { plan: parsed.plan };
		problem = problems.slice(0, 3).join("; ");
		user = `${request}\n\nYOUR LAST REPLY:\n${reply.slice(0, 4000)}\n\nIT CANNOT BE USED: ${problems.join("; ")}. Reply again with every unit in exactly one commit.`;
	}
	return byRule(say({ zh: `模型的提议用不了（${problem}）`, en: `The model's proposal wasn't usable (${problem})` }));
}

function report(outcome: ApplyOutcome): string {
	if (outcome.status === "done") {
		const count = outcome.commits.length;
		return [
			say({ zh: `做了 ${count} 个提交：`, en: `Made ${count} commit${count === 1 ? "" : "s"}:` }),
			...outcome.commits.map((commit) => `  ${commit.sha.slice(0, 9)}  ${commit.subject}`),
			say({ zh: "没有推送。", en: "Nothing was pushed." }),
		].join("\n");
	}
	const undone = outcome.undone.length;
	return [
		say({ zh: `停在 ${outcome.step}：${outcome.reason}`, en: `Stopped at ${outcome.step}: ${outcome.reason}` }),
		say({
			zh: `计划里的都没有留下：HEAD 和 index 都和原来一样${undone > 0 ? `（停下前做的 ${undone} 个提交只在 reflog 里）` : ""}。工作区没有动过。`,
			en: `None of the plan was kept: HEAD and the index are unchanged${undone > 0 ? ` (the ${undone} commit${undone === 1 ? "" : "s"} made before the stop ${undone === 1 ? "is" : "are"} only in the reflog)` : ""}. The working tree wasn't touched.`,
		}),
	].join("\n");
}
