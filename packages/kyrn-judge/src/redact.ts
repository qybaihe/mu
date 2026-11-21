/**
 * Credentials out of what leaves for a model that is not the one the user works with: the judge's
 * states and questions, the board writer's request. The main model already sees the conversation;
 * these others need what a call does, never the key it does it with.
 *
 * Only what is surely a credential goes, so the words around it keep their meaning ("fix the password
 * reset flow" stays as it is): a token in a shape only credentials have, a value assigned to a name
 * that says it is one, and the values of this process's own credential variables (mu hands the
 * project's `.env` to the agent, so a key of any shape can show up in a tool's output).
 */

export const REDACTED = "[redacted]";

/** Shapes only credentials have. */
const SHAPES: readonly RegExp[] = [
	// A private key, the whole block, or to the end when the text was cut inside it.
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
	// OpenAI, Anthropic, OpenRouter, DeepSeek and the like.
	/\bsk-[A-Za-z0-9_-]{20,}/g,
	/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g,
	/\bglpat-[A-Za-z0-9_-]{20,}/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
	/\bAIza[0-9A-Za-z_-]{35}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g,
	/\bnpm_[A-Za-z0-9]{36}\b/g,
	/\bhf_[A-Za-z0-9]{30,}/g,
	// A JSON web token.
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** `Authorization: Bearer …` with a token that has a digit in it ("Basic usage" is words): the scheme stays. */
const BEARER = /\b(Bearer|Basic)(\s+)(?=[A-Za-z._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{12,}/g;

/** `https://user:password@host`: the user and the host stay. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi;

const KEY_WORD = "(?:SECRET|TOKEN|PASSWD|PASSWORD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)";

/*
 * Values under a credential's name. Eight characters at least: `MAX_TOKENS=4096` is a setting.
 */

/** `DB_PASSWORD=…`: an unquoted environment variable's value. */
const ENV_VALUE = new RegExp(`\\b([A-Z0-9_]*${KEY_WORD}[A-Z0-9_]*=)[^\\s"';&|]{8,}`, "g");

/** `"password":` or `apiKey =`, immediately before a quoted value. */
const QUOTED_ASSIGNMENT = /(?<![-\w.'"\\])(["']?)([A-Za-z0-9_.-]+)\1\s*[:=]\s*(?=["'])/g;
const QUOTED_LITERAL = /"(?:[^"\\\r\n]|\\[^\r\n])*"|'(?:[^'\\\r\n]|\\[^\r\n])*'/y;
// Earlier redaction also covered versioned or nonstandard credential names such as DB_PASSWORD_V2.
const LEGACY_CREDENTIAL_NAME = new RegExp(KEY_WORD.replaceAll("_?", "[_-]?"), "i");

/** Name a credential, not a setting about one (`token_type`, `passwordReset`) or an arbitrary `key`. */
function isCredentialField(name: string): boolean {
	const words = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2");
	return /(?:^|[_.-])(?:secret|token|passwd|password|passphrase|(?:api|access|private|secret)[_.-]?key|authorization|credentials?)$/i.test(
		words,
	);
}

function redactQuotedValues(text: string): string {
	let clean = "";
	let end = 0;
	for (const match of text.matchAll(QUOTED_ASSIGNMENT)) {
		if (match.index < end) continue;
		const name = match[2];
		const credential = isCredentialField(name);
		if (!credential && !LEGACY_CREDENTIAL_NAME.test(name)) continue;
		const start = match.index + match[0].length;
		QUOTED_LITERAL.lastIndex = start;
		const literal = QUOTED_LITERAL.exec(text)?.[0];
		// A bounded preview can end inside the value. Never send the unterminated prefix.
		if (!literal) return `${clean}${text.slice(end, start + 1)}${REDACTED}`;
		if (!credential && (literal.length < 10 || (/\s/.test(literal) && !/^[A-Z0-9_]+=$/.test(match[0])))) continue;
		clean += `${text.slice(end, start + 1)}${REDACTED}${literal[0]}`;
		end = start + literal.length;
	}
	return clean + text.slice(end);
}

/** `  password: hunter2hunter2` on a line of its own, as YAML and .properties files write it. */
const LINE_VALUE = new RegExp(
	`^(\\s*[A-Za-z0-9_.-]*${KEY_WORD.replaceAll("_?", "[_.-]?")}[A-Za-z0-9_.-]*\\s*[:=][ \\t]*)[^\\s#"']{8,}[ \\t]*$`,
	"gim",
);

/**
 * Names of environment variables that hold credentials. `KEY` as a word of its own too: mu's own keys are named so
 * (`MUDE_KEY`, `MU_JUDGE_OPENAI_KEY`).
 */
const CREDENTIAL_NAME =
	/SECRET|TOKEN|PASSWD|PASSWORD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|(?:^|_)KEYS?(?:_|$)/i;

/**
 * The values of `env`'s credential variables, longest first so none is left half replaced. A short
 * value without a digit is a setting ("undefined", "false"), and replacing it everywhere would cost
 * the judge that word wherever else it appears.
 */
export function environmentSecrets(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
	const values = Object.entries(env).flatMap(([name, raw]) => {
		const value = raw?.trim() ?? "";
		const secretish = value.length >= 16 || (value.length >= 8 && /\d/.test(value));
		return secretish && CREDENTIAL_NAME.test(name) ? [value] : [];
	});
	return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/** `text` with every credential in it replaced by `[redacted]`. `known` are values to take out wherever they are. */
export function redactSecrets(text: string, known: readonly string[] = []): string {
	// Take complete literals before a different rule can replace a backslash or quote inside one.
	let clean = redactQuotedValues(text);
	for (const secret of known) if (clean.includes(secret)) clean = clean.split(secret).join(REDACTED);
	for (const shape of SHAPES) clean = clean.replace(shape, REDACTED);
	return clean
		.replace(BEARER, `$1$2${REDACTED}`)
		.replace(URL_PASSWORD, `$1${REDACTED}$2`)
		.replace(ENV_VALUE, `$1${REDACTED}`)
		.replace(LINE_VALUE, `$1${REDACTED}`);
}

/**
 * Shapes that are a credential on their own, wherever they go. An AWS key id and a JSON web token also ride in links
 * that are meant to be followed (a presigned S3 link's `X-Amz-Credential`, a signed download), so they are left out.
 */
const SECRET_SHAPES = SHAPES.filter((shape) => !/AKIA|eyJ/.test(shape.source));

/**
 * Whether `text` holds a credential: one of `known` as it is or as a URL carries it, or a value in a shape only a
 * secret has. For a call that would carry it away; a value under a credential's name (`password: …`) is not enough,
 * since a config template has one.
 */
export function holdsCredential(text: string, known: readonly string[] = []): boolean {
	return (
		known.some((secret) => text.includes(secret) || text.includes(encodeURIComponent(secret))) ||
		SECRET_SHAPES.some((shape) => text.search(shape) !== -1)
	);
}

/** Redact through a JSON value, taking entire string fields named for credentials and keeping the keys. */
export function redactJson<T>(value: T, known: readonly string[] = []): T {
	if (typeof value === "string") return redactSecrets(value, known) as T;
	if (Array.isArray(value)) return value.map((item) => redactJson(item, known)) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, item]) => [
				key,
				typeof item === "string" && isCredentialField(key) ? REDACTED : redactJson(item, known),
			]),
		) as T;
	}
	return value;
}
