import { ABSTAIN, defineDecision } from "../decision.ts";
import { pickChoice, threeZone, type Verdict } from "../policy.ts";

/**
 * Input preflight: one batched judge call per user message, before the main
 * model runs. Output is free and questions are answered in parallel, so the
 * whole triage costs about one small request.
 *
 * It decides the "gear" for the turn, which sets the hints the main model is given and, where the user turned that on,
 * the thinking level.
 *
 * Every question here is read off the message. Up to version 4 one was a forecast: "Would notes from past sessions in
 * this project help?", asked without the notes, and a sure no kept the turn from its lessons. `memory.recall` asks
 * the same thing with each lesson in front of it, at the same moment, so the forecast saved no judge call and could
 * only drop a lesson that the question which read it had found to apply. It is gone, and recall answers for itself.
 *
 * Wording rules, measured with kyrn/spikes/judge-bench on a small local judge
 * (see kyrn/docs/03-local-judge.md): one short concrete predicate per question,
 * state fields named in backticks, no enumerations ("created, edited, or
 * deleted") and no compound conditions. On 31 labelled messages the long form
 * of `needs_files_changed` scored 42% and the short form 74%, same model, same
 * state. Bump `version` whenever a question or the state layout changes.
 */

export type TaskFrame = {
	readonly goal: string;
	readonly constraints?: readonly string[];
	readonly currentSubgoal?: string;
};

export type PreflightInput = {
	readonly userMessage: string;
	/** Short digests of the most recent turns, oldest first. */
	readonly recentTurns: readonly string[];
	readonly taskFrame?: TaskFrame;
	/** What the agent is doing right now, when the message arrives mid-run. */
	readonly currentAction?: string;
	/** True once this session has used a tool: from then on a terse message is more likely steering than chat. */
	readonly sessionHasWork?: boolean;
};

export type TurnType =
	| "chat"
	| "chat_question"
	| "quick_lookup"
	| "single_edit"
	| "multi_step_task"
	| "research"
	| "design_discussion";

export type Gear = "chat" | "light" | "standard" | "heavy";

export type PreflightOutcome = {
	readonly turnType: TurnType | "unknown";
	readonly gear: Gear;
	readonly sideQuestion: Verdict;
	readonly needsClarification: Verdict;
	readonly needsFilesChanged: Verdict;
	readonly swarmWorthy: Verdict;
	readonly planFirst: Verdict;
	/** Zero-based rubric positions; see the score questions for the levels. */
	readonly complexity: { readonly task: number; readonly reasoning: number; readonly tools: number };
};

const UNKNOWN_OUTCOME: PreflightOutcome = {
	turnType: "unknown",
	gear: "standard",
	sideQuestion: "unsure",
	needsClarification: "unsure",
	needsFilesChanged: "unsure",
	swarmWorthy: "unsure",
	planFirst: "unsure",
	complexity: { task: 1.5, reasoning: 1.5, tools: 1.5 },
};

const SOCIAL =
	/^\s*(hi|hello|hey|yo|thanks|thank you|thx|ok|okay|good (morning|evening|night)|bye|你好|您好|嗨|哈喽|在吗|早上好|晚上好|晚安|谢谢|多谢|辛苦了|好的|再见|拜拜)[\s!！。.,，~～?？]*$/i;

/** Anything that smells of code, a workspace or engineering work, in English or Chinese. */
const TECHNICAL =
	/[`{}<>=;$\\]|[\w-]+\.[a-z]{1,5}\b|[\w.-]*\/[\w.-]+|\b\w+_\w+|\b(code|file|folder|directory|function|method|class|variable|module|package|library|framework|bug|error|exception|crash|stack|trace|log|test|build|compile|lint|deploy|release|commit|branch|merge|rebase|diff|repo|repository|git|npm|pip|yarn|docker|api|endpoint|server|client|database|sql|query|schema|script|config|cli|terminal|shell|regex|json|yaml|http|url|refactor|implement|debug|fix|rename|install|dependency|import|type|interface|async|thread|memory leak|cache|token|prompt|model|agent|skill|tool|browser|browse|delegate)s?\b|代码|文件|目录|函数|方法|变量|模块|依赖|报错|错误|异常|崩溃|日志|测试|编译|构建|部署|发布|提交|分支|合并|仓库|接口|服务|数据库|脚本|配置|终端|命令|重构|实现|调试|修复|改名|重命名|安装|缓存|项目|架构|这里|这个|上面|刚才|继续|再试|运行|跑一下/i;

/** Case matters here, so this one cannot share the case-insensitive pattern above. */
const CAMEL_CASE = /\b[a-z]+[A-Z][a-zA-Z]*\b/;

/**
 * Rules before the judge: a greeting is chat whatever else is going on, and
 * a message with no trace of code or of this workspace is chat as long as the
 * session has not started any work (after that, a terse non-technical message
 * is more likely steering: "again", "go on").
 */
export function chatByRule(message: string, sessionHasWork: boolean): boolean {
	const text = message.trim();
	if (!text || text.length > 400) return false;
	if (SOCIAL.test(text)) return true;
	return !sessionHasWork && !TECHNICAL.test(text) && !CAMEL_CASE.test(text);
}

function gearFor(turnType: TurnType | "unknown", filesChanged: Verdict, peakComplexity: number): Gear {
	if (turnType === "unknown") return "standard";
	// Not about code at all: only a confident "this changes files" can make it more than chat.
	if (turnType === "chat") return filesChanged === "yes" ? "standard" : "chat";
	const conversational = turnType === "chat_question" || turnType === "design_discussion";
	if (conversational && filesChanged === "no") return "chat";
	// Finding where something is never needs the heavy gear, however wide the judge rates the scope.
	if (turnType === "quick_lookup") return peakComplexity <= 1.2 ? "light" : "standard";
	if (peakComplexity >= 2.5 || turnType === "research") return "heavy";
	return "standard";
}

export const inputPreflight = defineDecision({
	id: "input.preflight",
	version: 5,
	// Acting on the gear only changes what gets appended for this turn.
	cacheImpact: "append-only",
	// Everything else is a classification of the message; the three scores default to `rate`.
	capabilities: { is_side_question: "relate", needs_clarification: "meta", swarm_worthy: "meta" },
	latency: "inline",
	questions: {
		turn_type: {
			type: "choice",
			instructions: "What does `user_message` ask for?",
			criteria: {
				chat: "Small talk or a general question that is not about code",
				chat_question: "An explanation of a concept",
				quick_lookup: "Finding where something is in the code",
				single_edit: "One small code change",
				multi_step_task: "A larger task with several steps",
				research: "A broad survey or investigation",
				design_discussion: "A discussion of options and trade-offs",
				other: "Something else",
			},
		},
		is_side_question: {
			type: "boolean",
			instructions: "Is `user_message` unrelated to the task in `task_frame`?",
		},
		needs_clarification: {
			type: "boolean",
			instructions: "Is `user_message` too vague to act on?",
		},
		needs_files_changed: {
			type: "boolean",
			instructions: "Does `user_message` request a code change?",
		},
		swarm_worthy: {
			type: "boolean",
			instructions: "Does `user_message` describe several independent tasks?",
		},
		plan_first: {
			type: "boolean",
			instructions: "Does `user_message` ask for a large or risky change?",
		},
		task_complexity: {
			type: "score",
			instructions: "What is the scope of `user_message`?",
			criteria: ["A question", "One place in the code", "Several places in the code", "The whole codebase"],
		},
		reasoning_depth: {
			type: "score",
			instructions: "How much careful reasoning does `user_message` require?",
			criteria: [
				"Recall or lookup",
				"Straightforward explanation",
				"Non-obvious analysis",
				"Deep multi-factor reasoning",
			],
		},
		tool_complexity: {
			type: "score",
			instructions: "How much tool use does `user_message` require?",
			criteria: [
				"None",
				"One or two read-only calls",
				"Several calls including edits",
				"Many calls with build or test cycles",
			],
		},
	},
	// Decisive content first: a judge with a bounded window keeps the head of the state and cuts the tail.
	buildState(input: PreflightInput) {
		return {
			user_message: input.userMessage,
			current_action: input.currentAction ?? null,
			task_frame: input.taskFrame
				? {
						goal: input.taskFrame.goal,
						constraints: input.taskFrame.constraints ?? [],
						current_subgoal: input.taskFrame.currentSubgoal ?? null,
					}
				: null,
			recent_turns: input.recentTurns,
		};
	},
	policy(answers, input): PreflightOutcome | typeof ABSTAIN {
		// The judge's confident pick wins; where it has none, an obvious chat message is still chat.
		const ruledChat = chatByRule(input.userMessage, input.sessionHasWork === true);
		const turnType = pickChoice(answers.turn_type) ?? (ruledChat ? "chat" : "unknown");
		const needsFilesChanged = threeZone(answers.needs_files_changed);
		// Rules before the judge: with no task and no history there is nothing to be a side question of.
		const hasMainLine = input.taskFrame !== undefined || input.recentTurns.length > 0;
		const verdicts = {
			sideQuestion: hasMainLine ? threeZone(answers.is_side_question) : ("no" as const),
			needsClarification: threeZone(answers.needs_clarification),
			needsFilesChanged,
			swarmWorthy: threeZone(answers.swarm_worthy),
			planFirst: threeZone(answers.plan_first),
		};
		// Nothing readable came back: let the caller behave as it would without a judge.
		if (turnType === "unknown" && Object.values(verdicts).every((verdict) => verdict === "unsure")) return ABSTAIN;

		const complexity = {
			task: answers.task_complexity.score,
			reasoning: answers.reasoning_depth.score,
			tools: answers.tool_complexity.score,
		};
		const peak = Math.max(complexity.task, complexity.reasoning, complexity.tools);
		return { turnType, gear: gearFor(turnType, needsFilesChanged, peak), ...verdicts, complexity };
	},
	// With no judge at all, the rule still spares an obvious chat message the full treatment.
	fallback(input: PreflightInput): PreflightOutcome {
		if (!chatByRule(input.userMessage, input.sessionHasWork === true)) return UNKNOWN_OUTCOME;
		return { ...UNKNOWN_OUTCOME, turnType: "chat", gear: "chat", needsFilesChanged: "no", planFirst: "no" };
	},
});
