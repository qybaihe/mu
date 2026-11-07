import { Type } from "typebox";
import { type Finding, type Priority, reviewTriage } from "../../../decisions/review-triage.ts";
import { say } from "../../../language.ts";
import { type Pack, type PackShared, text } from "./pack.ts";

const HEADINGS: Readonly<Record<Priority, string>> = {
	P0: "must be fixed before this change goes in",
	P1: "defects in this change",
	P2: "worth knowing: outside this change, or not certain",
	P3: "style and minor points",
};

const ORDER: readonly Priority[] = ["P0", "P1", "P2", "P3"];

/** The review prompt `/review` sends. Kept here so the command and its test read the same words. */
export function reviewPrompt(what: string): string {
	return [
		`Review ${what || "the uncommitted changes in this repository (staged and unstaged)"}.`,
		"",
		"Use the `delegate` tool with one task for the `reviewer` role. Its instructions must be self-contained: say exactly what to review (paths, the diff command to run), what this change is meant to do as far as you know, and ask for findings as `file:line` with the input or state that triggers each defect, each marked must, should or nit.",
		"",
		"When the report comes back, pass every finding to `review_triage`, unfiltered and in the reviewer's words, with one sentence on what the change is meant to do. Check each P0 and P1 against the code yourself before repeating it. Then report in the order the triage returns: P0 and P1 in full, P2 briefly, P3 as one collapsed list. Drop nothing. Do not fix anything yet.",
	].join("\n");
}

/**
 * The review pack: one tool that sorts a review's findings P0 to P3 with the
 * judge (`review.triage`), and the `/review` command, which opens the pack and
 * hands the review to the reviewer sub-agent.
 */
export function reviewPack(shared: PackShared, options: { maxFindings: number }): Pack {
	const { runtime } = shared;

	runtime.pi.registerCommand("review", {
		description: say({
			zh: "让评审子代理审查还没提交的改动（或你指定的内容），评审发现按轻重排成 P0 到 P3",
			en: "Have the reviewer subagent review uncommitted changes, or whatever you name; the judge ranks findings from P0 to P3",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			// Opening needs no program, so it does not fail; a review without the triage would still be a review.
			await shared.open("pack:review").catch(() => undefined);
			runtime.pi.sendUserMessage(reviewPrompt(args.trim()));
		},
	});

	return {
		id: "pack:review",
		title: "Review triage",
		description:
			"For a code review: sorts the findings of a reviewer by what matters, from a defect that must be fixed now to a style point.",
		tools: ["review_triage"],
		async start() {
			runtime.pi.registerTool({
				name: "review_triage",
				label: "Review triage",
				description:
					"Sort the findings of a code review P0 to P3: P0 must be fixed before the change goes in, P1 are defects in the change, P2 is worth knowing, P3 is style. Pass every finding, in the reviewer's words; none is dropped.",
				parameters: Type.Object({
					change: Type.String({ description: "What the change under review is meant to do, in one sentence" }),
					findings: Type.Array(
						Type.Object({
							text: Type.String({ description: "The finding in the reviewer's words" }),
							where: Type.Optional(Type.String({ description: "file:line, when known" })),
							severity: Type.Optional(
								Type.Union([Type.Literal("must"), Type.Literal("should"), Type.Literal("nit")], {
									description: "What the reviewer called it",
								}),
							),
						}),
					),
				}),
				execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
					runtime.touch(ctx);
					const findings: Finding[] = params.findings.slice(0, options.maxFindings);
					const decision = await runtime.engine.decide(
						reviewTriage,
						{ change: params.change, findings },
						{ signal },
					);
					const priorities = decision.outcome.priorities;
					const byJudge = decision.source === "judge";
					const lines: string[] = [];
					for (const priority of ORDER) {
						const members = findings
							.map((finding, index) => ({ finding, index }))
							.filter(({ index }) => priorities[index] === priority);
						if (members.length === 0) continue;
						const collapsed = priority === "P3";
						lines.push(`${priority} (${members.length})${collapsed ? ", collapsed" : ""}: ${HEADINGS[priority]}`);
						for (const { finding, index } of members) {
							const where = finding.where ? `${finding.where}  ` : "";
							const said =
								collapsed && finding.text.length > 140 ? `${finding.text.slice(0, 140)}...` : finding.text;
							lines.push(`  #${index + 1} ${where}${said}${finding.severity ? ` [${finding.severity}]` : ""}`);
						}
					}
					const cut = params.findings.length - findings.length;
					if (cut > 0) {
						lines.push(
							`${cut} more finding${cut === 1 ? "" : "s"} beyond ${options.maxFindings} were not sorted: report them after these.`,
						);
					}
					lines.push(
						byJudge
							? "Sorted by the judge. Check each P0 and P1 against the code before repeating it."
							: "No judge verdict: sorted by the reviewer's own severity, one step down from the top since nobody confirmed it.",
					);
					const counts = Object.fromEntries(
						ORDER.map((priority) => [priority, priorities.filter((p) => p === priority).length]),
					);
					return { content: text(lines.join("\n")), details: { priorities, counts, byJudge } };
				},
			});
		},
	};
}
