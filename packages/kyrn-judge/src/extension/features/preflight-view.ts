import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Decision } from "../../decision.ts";
import { type Gear, inputPreflight, type PreflightOutcome } from "../../decisions/input-preflight.ts";
import type { Answer } from "../../types.ts";
import { judgeDisplayName, type Paint } from "./welcome.ts";

/** Custom entry type of the verdict line. Shown in the chat, never sent to the model. */
export const VERDICT_ENTRY = "kyrn.verdict";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const MAX_ECHO_LINES = 3;

const TURN_LABELS: Readonly<Record<string, string>> = {
	chat: "chat",
	chat_question: "concept question",
	quick_lookup: "quick lookup",
	single_edit: "single edit",
	multi_step_task: "multi-step task",
	research: "research",
	design_discussion: "design discussion",
	other: "other",
	unknown: "unclassified",
};

const GEAR_LABELS: Readonly<Record<Gear, string>> = {
	chat: "answer directly",
	light: "light effort",
	standard: "standard effort",
	heavy: "full effort",
};

/** A turn type in the words the verdict line uses: "multi_step_task" is "multi-step task". */
export function turnLabel(turnType: string): string {
	return TURN_LABELS[turnType] ?? turnType;
}

/** A gear in the words the verdict line uses: "heavy" is "full effort". */
export function gearLabel(gear: Gear): string {
	return GEAR_LABELS[gear];
}

/** What the judge is asked, in the words shown to the user, in the order it is shown. */
const QUESTION_LABELS: readonly [string, string][] = [
	["turn_type", "turn type"],
	["is_side_question", "side question"],
	["needs_clarification", "too vague"],
	["needs_files_changed", "code change"],
	["needs_memory", "lessons help"],
	["swarm_worthy", "independent parts"],
	["plan_first", "large or risky"],
	["task_complexity", "scope"],
	["reasoning_depth", "reasoning"],
	["tool_complexity", "tool use"],
];

/**
 * - applied: the turn ran in the gear this verdict set
 * - shadow: recorded only, the turn ran as it would have without a judge
 * - late: it arrived after the turn had started, so it changed nothing
 * - none: no verdict at all (judge down, unsure, or skipped by the user)
 */
export type VerdictState = "applied" | "shadow" | "late" | "none";

/** One verdict as it is stored in the session: plain strings, so old entries render whatever the questions become. */
export interface VerdictData {
	version: 1;
	/** Who settled it: the judge's label, or "rule" for a message no judge had to read. */
	by: string;
	state: VerdictState;
	turnType: string;
	gear: Gear;
	latencyMs?: number;
	/** Why there is no verdict, when there is none. */
	reason?: string;
	/**
	 * The same as a stable code, for a client that translates: `skipped`, `no_answer` (params.seconds), or the
	 * decision's own reason (`off`, `shadow`, `abstain`, `error:<kind>`).
	 */
	reasonCode?: string;
	reasonParams?: Record<string, number>;
	thinking?: { from: string; to: string };
	/** What the main model was told because of this verdict. */
	hints: string[];
	/** Which hints those are, in the same order (`answered`, `resolve`, `side_question`, `plan_first`, `try_hive`, `try_delegate`). */
	hintIds?: string[];
	/** The judge's raw answers, as label and value. */
	answers: [string, string][];
	/** The same answers as the judge gave them, by question id: `{ type, probability | choice, probabilities | score }`. */
	answerValues?: Record<string, Answer>;
}

function percent(probability: number): string {
	return `${Math.round(probability * 100)}%`;
}

function describeAnswer(id: string, answer: Answer): string {
	if (answer.type === "boolean") {
		return `${answer.probability >= 0.5 ? "yes" : "no"} · ${percent(answer.probability)} likely`;
	}
	if (answer.type === "choice") {
		const ranked = Object.entries(answer.probabilities ?? {})
			.filter((pair): pair is [string, number] => typeof pair[1] === "number")
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([option, probability]) => `${TURN_LABELS[option] ?? option} ${percent(probability)}`);
		return ranked.length > 0 ? ranked.join(" · ") : (TURN_LABELS[answer.choice] ?? answer.choice);
	}
	const question = inputPreflight.questions[id as keyof typeof inputPreflight.questions];
	const levels = question?.type === "score" ? question.criteria : undefined;
	const level = levels?.[Math.round(answer.score)];
	const position = `${answer.score.toFixed(1)} of ${(levels?.length ?? 4) - 1}`;
	return level ? `${level.toLowerCase()} · ${position}` : position;
}

export interface VerdictExtras {
	by: string;
	state: VerdictState;
	reason?: string;
	reasonCode?: string;
	reasonParams?: Record<string, number>;
	/** Wall-clock wait, for a verdict that never came. */
	waitedMs?: number;
	thinking?: { from: string; to: string };
	hints?: readonly string[];
	hintIds?: readonly string[];
}

/** The stored form of one preflight decision. `decision` is undefined when none arrived. */
export function verdictData(decision: Decision<PreflightOutcome> | undefined, extras: VerdictExtras): VerdictData {
	// What the turn acted on in active mode; what the judge would have said in shadow mode.
	const shown = decision
		? decision.mode === "active"
			? decision.outcome
			: (decision.judged ?? decision.outcome)
		: undefined;
	const answers = decision?.answers ?? {};
	const decided = shown && shown.turnType !== "unknown" ? undefined : decision?.reason;
	const reasonCode = extras.reasonCode ?? decided;
	return {
		version: 1,
		by: extras.by,
		state: extras.state,
		turnType: shown?.turnType ?? "unknown",
		gear: shown?.gear ?? "standard",
		latencyMs: decision?.latencyMs ?? extras.waitedMs,
		reason: extras.reason ?? decided,
		...(reasonCode ? { reasonCode } : {}),
		...(extras.reasonParams ? { reasonParams: { ...extras.reasonParams } } : {}),
		thinking: extras.thinking,
		hints: [...(extras.hints ?? [])],
		hintIds: [...(extras.hintIds ?? [])],
		answers: QUESTION_LABELS.flatMap(([id, label]): [string, string][] =>
			answers[id] ? [[label, describeAnswer(id, answers[id])]] : [],
		),
		answerValues: Object.fromEntries(
			QUESTION_LABELS.flatMap(([id]): [string, Answer][] => (answers[id] ? [[id, answers[id]]] : [])),
		),
	};
}

function seconds(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "◆ jev-latest  chat · answer directly · thinking medium → low · 640 ms" */
export function verdictHeadline(data: VerdictData, paint: Paint): string {
	const dot = paint.fg("dim", " · ");
	// The judge's mark, in the color mu gives its own lines (pink in mu's themes, as in the app).
	const mark = data.state === "applied" ? paint.fg("customMessageLabel", "◆") : paint.fg("muted", "◇");
	const by = paint.fg("muted", judgeDisplayName(data.by));
	if (data.state === "none") {
		const why = data.reason ? `no verdict (${data.reason})` : "no verdict";
		const waited = data.latencyMs === undefined ? "" : `${dot}${paint.fg("dim", seconds(data.latencyMs))}`;
		return `${mark} ${by}  ${paint.fg("warning", why)}${dot}${paint.fg("dim", "using the fallback this turn")}${waited}`;
	}
	const parts = [
		paint.bold(paint.fg(data.state === "applied" ? "accent" : "text", TURN_LABELS[data.turnType] ?? data.turnType)),
		paint.fg("text", GEAR_LABELS[data.gear]),
	];
	if (data.thinking) parts.push(paint.fg("text", `thinking ${data.thinking.from} → ${data.thinking.to}`));
	if (data.latencyMs !== undefined) parts.push(paint.fg("dim", seconds(data.latencyMs)));
	if (data.state === "shadow") parts.push(paint.fg("muted", "shadow, not applied"));
	if (data.state === "late") parts.push(paint.fg("warning", "arrived after the turn started, not applied"));
	return `${mark} ${by}  ${parts.join(dot)}`;
}

/** The verdict as it stays in the chat: one line, or every answer behind it when expanded. */
export function renderVerdict(data: VerdictData, expanded: boolean, width: number, paint: Paint): string[] {
	const lines = [verdictHeadline(data, paint)];
	if (expanded) {
		const pad = Math.max(...QUESTION_LABELS.map(([, label]) => label.length)) + 2;
		for (const [label, value] of data.answers) lines.push(`  ${paint.fg("muted", label.padEnd(pad))}${value}`);
		// Hints are sentences: they wrap where an answer would be cut.
		const room = Math.max(16, width - pad - 4);
		const told = (data.hints.length > 0 ? data.hints : ["nothing extra"]).flatMap((hint) =>
			wrapTextWithAnsi(`- ${hint}`, room).map((line, index) => (index === 0 ? line : `  ${line}`)),
		);
		told.forEach((line, index) => {
			lines.push(
				`  ${paint.fg("muted", (index === 0 ? "told the model" : "").padEnd(pad))}${paint.fg("dim", line)}`,
			);
		});
	}
	return lines.map((line) => truncateToWidth(` ${line}`, width));
}

export interface PendingView {
	message: string;
	/** The judge being waited for. */
	judge: string;
	elapsedMs: number;
	/** Set once the wait is over, whichever way it ended. */
	verdict?: VerdictData;
	/** What is being worked out between the verdict and the start of the turn. */
	step?: string;
	/** Whether a key can end the wait. */
	skipKey?: string;
}

/**
 * The message while the judge reads it. pi only puts a message in the chat
 * when the agent starts, so without this it would be nowhere on screen for as
 * long as the judge takes: gone from the editor, not yet in the chat.
 */
export function renderPending(view: PendingView, width: number, paint: Paint): string[] {
	const inner = Math.max(8, width - 3);
	const wrapped = view.message
		.trim()
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(line, inner));
	const echo = wrapped.slice(0, MAX_ECHO_LINES);
	if (wrapped.length > MAX_ECHO_LINES)
		echo[MAX_ECHO_LINES - 1] = `${truncateToWidth(echo[MAX_ECHO_LINES - 1], inner - 2)} …`;
	const lines = echo.map((line) => `${paint.fg("borderAccent", "┃")} ${line}`);

	if (view.verdict) {
		lines.push(verdictHeadline(view.verdict, paint), paint.fg("dim", `  ${view.step ?? "preparing the turn"}…`));
	} else {
		const frame = SPINNER_FRAMES[Math.floor(view.elapsedMs / 80) % SPINNER_FRAMES.length];
		const skip = view.skipKey ? paint.fg("dim", ` · ${view.skipKey} to skip`) : "";
		lines.push(
			`${paint.fg("accent", frame)} ${paint.fg("muted", view.judge)}  ${paint.fg("text", "reading your message")}${paint.fg("dim", ` · ${(view.elapsedMs / 1000).toFixed(1)} s`)}${skip}`,
			paint.fg("dim", `  ${QUESTION_LABELS.map(([, label]) => label).join(" · ")}`),
		);
	}
	return lines.map((line) => truncateToWidth(` ${line}`, width));
}
