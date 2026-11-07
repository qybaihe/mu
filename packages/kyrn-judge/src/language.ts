import { muEnv } from "./naming.ts";

/**
 * The language the person reads mu in. The desktop app passes its interface
 * language as MU_LANG ("zh-CN", "en-US", "ja-JP", ...); a terminal user can set
 * it too. Unset means nobody said, and every caller keeps its own default.
 */
export interface AppLanguage {
	/** The tag as given, e.g. "zh-TW". */
	readonly code: string;
	/** mu's own wording exists in Chinese and English; any other language reads the English one. */
	readonly wording: "zh" | "en";
	/** What a model is told to write in: "Traditional Chinese", "Japanese". */
	readonly name: string;
}

/** A BCP 47 tag and nothing else: the value ends up in a model's instructions. */
const TAG = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/;

function nameOf(code: string): string {
	const [base, ...rest] = code.toLowerCase().split("-");
	if (base === "zh") {
		const region = rest.join("-");
		return /hant|tw|hk|mo/.test(region) ? "Traditional Chinese" : "Simplified Chinese";
	}
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(base) ?? code;
	} catch {
		return code;
	}
}

export function appLanguage(env: Record<string, string | undefined> = process.env): AppLanguage | undefined {
	const raw = muEnv("LANG", env)?.trim();
	if (!raw || !TAG.test(raw)) return undefined;
	const code = raw.replaceAll("_", "-");
	const base = code.split("-")[0].toLowerCase();
	return { code, wording: base === "zh" ? "zh" : "en", name: nameOf(code) };
}

const ENGLISH: AppLanguage = { code: "en", wording: "en", name: "English" };
const BY_SCRIPT = {
	kana: { code: "ja", wording: "en", name: "Japanese" },
	hangul: { code: "ko", wording: "en", name: "Korean" },
	han: { code: "zh-CN", wording: "zh", name: "Simplified Chinese" },
} as const satisfies Record<string, AppLanguage>;
/** Kana before Han: Japanese is written with both. Hangul before Han: Korean text may carry a few Han characters. */
const SCRIPTS = [
	["kana", /[぀-ヿㇰ-ㇿ]/],
	["hangul", /[가-힯ᄀ-ᇿ㄰-㆏]/],
	["han", /[㐀-鿿豈-﫿]/],
] as const;
/** App languages not written in Latin letters: a message in Latin letters is not in one of them. */
const NOT_LATIN = new Set(["zh", "ja", "ko", "ru", "uk", "be", "bg", "mk", "el", "fa", "ar", "ur", "he", "hi", "th"]);

/**
 * The language a person writes in, from their latest messages, newest first: what a model writing for them
 * (the board) should write in. Each message is read by its script, and the first that tells decides:
 * - kana: Japanese; Hangul: Korean; Han characters: Chinese;
 * - two or more words in Latin letters: the app's language when it is one written in Latin letters other than
 *   English (a German app, a German message), else English;
 * - letters of another script (Cyrillic, Arabic, …): the app's language unless it is English, Chinese, Japanese or
 *   Korean, else English.
 * A message that tells nothing ("ok", "1", a lone path) passes to the one before it; when none tells, the app's
 * language (MU_LANG) does, else English. The app's own tag wins whenever it names the same language, so a
 * Traditional Chinese app keeps "Traditional Chinese".
 */
export function writingLanguage(messages: readonly string[], app = appLanguage()): AppLanguage {
	const base = app?.code.split("-")[0].toLowerCase() ?? "";
	for (const text of messages.slice(0, 3)) {
		const script = SCRIPTS.find(([, pattern]) => pattern.test(text))?.[0];
		if (script) return app && base === BY_SCRIPT[script].code.split("-")[0] ? app : BY_SCRIPT[script];
		const latinWords = text.match(/\p{Script=Latin}{2,}/gu)?.length ?? 0;
		if (latinWords >= 2) return app && base !== "en" && !NOT_LATIN.has(base) ? app : ENGLISH;
		if (/[^\P{L}\p{Script=Latin}]/u.test(text)) {
			return app && !["en", "zh", "ja", "ko"].includes(base) ? app : ENGLISH;
		}
	}
	return app ?? ENGLISH;
}

/** The Chinese or the English of a message, by the app's language; English when none is set. */
export function say(texts: { readonly zh: string; readonly en: string }, language = appLanguage()): string {
	return language?.wording === "zh" ? texts.zh : texts.en;
}

/**
 * A line a person reads, as a stable code and what it names, for a client
 * that translates into a language mu has no wording for. The English (or the
 * zh/en) text always stays beside it; see docs/features/presentation-codes.md.
 */
export interface Coded {
	readonly code: string;
	readonly params?: Readonly<Record<string, string | number>>;
}

/** An error that also says what it is as a code. `coded`, not `code`: Node's own errors use that for ENOENT. */
export function codedError(message: string, coded: Coded): Error & { coded: Coded } {
	return withCode(new Error(message), coded);
}

/** Gives an error of any class its code. */
export function withCode<E extends Error>(error: E, coded: Coded): E & { coded: Coded } {
	return Object.assign(error, { coded });
}

export function codeOf(error: unknown): Coded | undefined {
	const coded = (error as { coded?: Coded } | undefined)?.coded;
	return coded && typeof coded.code === "string" ? coded : undefined;
}

/** "1 commit", "3 commits": English needs the plural, Chinese does not. */
export function count(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}
