import type { BoardLanguage } from "./narrate.ts";

/**
 * The board's running account: one line per thing the agent did, the moment
 * it did it, and the plain-speaking model's telling of what it said or found.
 * A line is either the model's own words or a fixed sentence with a code, so
 * a client that speaks another language can word it itself.
 */
export type NoteKind = "step" | "check" | "said" | "ticked" | "asked" | "helpers" | "goal" | "trouble" | "ended";

export type NoteParams = Readonly<Record<string, string | number>>;

export interface BoardNote {
	/** With `at`, the note's identity: a note sent again with the same two replaces the earlier one. */
	readonly sequence: number;
	readonly at: number;
	readonly kind: NoteKind;
	/** The harness's own sentence, in the person's language, or the model's words. */
	readonly text: string;
	readonly by: "model" | "rules";
	/** Fixed sentences only: which one. */
	readonly code?: string;
	readonly params?: NoteParams;
	/** Something went wrong: a failed check, a command that errored, a denied permission, trouble. */
	readonly failed?: boolean;
}

type Sentence = (params: NoteParams) => string;

const one = (params: NoteParams, key: string) => Number(params[key] ?? 0) === 1;

/** The fixed sentences, in the two languages mu has wording for; the desktop words the codes in eleven more. */
const SENTENCES: Readonly<Record<string, { readonly zh: Sentence; readonly en: Sentence }>> = {
	looked: {
		zh: (p) => `看了 ${p.count} 个文件或地方`,
		en: (p) => `Looked at ${p.count} ${one(p, "count") ? "file or location" : "files or locations"}`,
	},
	changed_file: { zh: (p) => `改了 ${p.file}`, en: (p) => `Edited ${p.file}` },
	wrote_file: { zh: (p) => `写了 ${p.file}`, en: (p) => `Wrote ${p.file}` },
	ran_command: { zh: (p) => `运行了 ${p.command}`, en: (p) => `Ran ${p.command}` },
	command_failed: { zh: (p) => `运行 ${p.command} 出错了`, en: (p) => `${p.command} failed` },
	check_passed: { zh: (p) => `检查通过了：${p.command}`, en: (p) => `Check passed: ${p.command}` },
	check_failed: { zh: (p) => `检查没通过：${p.command}`, en: (p) => `Check failed: ${p.command}` },
	item_done: { zh: (p) => `做完了一条：${p.item}`, en: (p) => `Done: ${p.item}` },
	item_added: { zh: (p) => `清单上加了一条：${p.item}`, en: (p) => `Added to the checklist: ${p.item}` },
	helpers_sent: {
		zh: (p) => `派出 ${p.count} 个助手：${p.titles}`,
		en: (p) => `Started ${p.count} ${one(p, "count") ? "subagent" : "subagents"}: ${p.titles}`,
	},
	helpers_back: {
		zh: (p) => `${p.count} 个助手回来了`,
		en: (p) => `${p.count} ${one(p, "count") ? "subagent" : "subagents"} finished`,
	},
	permission_allowed: { zh: (p) => `你允许了：${p.summary}`, en: (p) => `You allowed: ${p.summary}` },
	permission_denied: { zh: (p) => `你没允许：${p.summary}`, en: (p) => `You didn't allow: ${p.summary}` },
	goal_round: {
		zh: (p) => `目标还没达成，mu 让它接着干（第 ${p.round} 轮）${p.reason ?? ""}`,
		en: (p) => `The goal isn't met yet, so mu kept the agent working (round ${p.round})${p.reason ?? ""}`,
	},
	goal_met: { zh: (p) => `目标达成了：${p.text}`, en: (p) => `Goal met: ${p.text}` },
	goal_paused: { zh: (p) => `目标暂停了${p.reason ?? ""}`, en: (p) => `Goal paused${p.reason ?? ""}` },
	trouble_loop: {
		zh: (p) => `mu 发现它在重复同一步：${p.detail}`,
		en: (p) => `mu noticed the agent repeating a step: ${p.detail}`,
	},
	trouble: { zh: (p) => `mu 发现：${p.detail}`, en: (p) => `mu noticed: ${p.detail}` },
	did: { zh: (p) => `用 ${p.tool} 做了：${p.what}`, en: (p) => `Used ${p.tool}: ${p.what}` },
	said_quote: { zh: (p) => `它说：${p.text}`, en: (p) => `It said: ${p.text}` },
	ended: { zh: () => "停下来了。", en: () => "Stopped." },
	waiting_reply: { zh: () => "停下来了，在等你回复。", en: () => "Stopped and waiting for your reply." },
};

export type NoteCode = keyof typeof SENTENCES;

/** A fixed sentence in the person's language. */
export function noteText(code: NoteCode, params: NoteParams, language: BoardLanguage): string {
	return SENTENCES[code][language](params);
}

/** The reason a goal continued or paused, as the sentence's tail: "：…" in Chinese, ": …" in English, or nothing. */
export function reasonTail(reason: string, language: BoardLanguage): string {
	return reason ? `${language === "zh" ? "：" : ": "}${reason}` : "";
}

/** A path as a person recognises it: its last two parts. */
export function shortPath(path: string): string {
	const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.slice(-2).join("/") || path;
}

/** A note read back from a session entry, or undefined when it is not one. */
export function parseBoardNote(data: unknown): BoardNote | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const value = data as Record<string, unknown>;
	if (typeof value.text !== "string" || !value.text || typeof value.at !== "number") return undefined;
	const params =
		typeof value.params === "object" && value.params !== null
			? Object.fromEntries(
					Object.entries(value.params as Record<string, unknown>).filter(
						([, item]) => typeof item === "string" || typeof item === "number",
					),
				)
			: undefined;
	return {
		sequence: typeof value.sequence === "number" ? value.sequence : 0,
		at: value.at,
		kind: KINDS.has(value.kind as NoteKind) ? (value.kind as NoteKind) : "step",
		text: value.text,
		by: value.by === "model" ? "model" : "rules",
		...(typeof value.code === "string" ? { code: value.code } : {}),
		...(params && Object.keys(params).length > 0 ? { params: params as NoteParams } : {}),
		...(value.failed === true ? { failed: true } : {}),
	};
}

const KINDS: ReadonlySet<NoteKind> = new Set([
	"step",
	"check",
	"said",
	"ticked",
	"asked",
	"helpers",
	"goal",
	"trouble",
	"ended",
]);
