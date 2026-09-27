/**
 * The language `mu setup` speaks: Chinese when the person's locale is Chinese, English otherwise. MU_LANG (the
 * desktop app's language, see ../language.ts) decides first; then the POSIX variables in their order of precedence,
 * LC_ALL, LC_MESSAGES and LANG; then what the system tells Node (Intl), which is the only answer on Windows.
 */
export type SetupLanguage = "zh" | "en";

type Env = Readonly<Record<string, string | undefined>>;

/** "zh", "zh_CN.UTF-8", "zh-Hant-TW": Chinese. "C" and "POSIX" say nothing about a language. */
function languageOf(value: string | undefined): SetupLanguage | undefined {
	const tag = value?.trim().split(/[.@]/)[0];
	if (!tag || tag === "C" || tag === "POSIX") return undefined;
	return /^zh(?:[-_]|$)/i.test(tag) ? "zh" : "en";
}

export function setupLanguage(env: Env, systemLocale: string | undefined): SetupLanguage {
	for (const name of ["MU_LANG", "KYRN_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
		const found = languageOf(env[name]);
		if (found) return found;
	}
	return languageOf(systemLocale) ?? "en";
}

/** What Node was told about the system's locale. */
export function systemLocale(): string | undefined {
	try {
		return Intl.DateTimeFormat().resolvedOptions().locale;
	} catch {
		return undefined;
	}
}

/** One sentence in both languages. */
export interface Text {
	readonly zh: string;
	readonly en: string;
}
