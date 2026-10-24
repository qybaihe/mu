import type { JudgeErrorKind } from "../errors.ts";
import type { JudgeWarning } from "../types.ts";

export const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * The kind of a failed call by its HTTP status, for the hosted judges (TypeSafe, OpenAI). A 403 that speaks of credit,
 * payment, billing or quota is an account that can't pay yet; any other 403 is a key without access.
 */
export function errorKindForStatus(status: number, message: string): JudgeErrorKind {
	if (status === 401) return "auth";
	if (status === 402) return "payment_required";
	if (status === 403) return /credit|payment|billing|quota/i.test(message) ? "payment_required" : "auth";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "server";
	return "bad_request";
}

/** Reads `{error: {message}}`, `{error: "..."}`, `{message}` or `{detail: "..."}`; returns "" when there is none. */
export function messageFromErrorBody(body: unknown): string {
	if (typeof body !== "object" || body === null) return "";
	const record = body as Record<string, unknown>;
	const nested = record.error;
	if (typeof nested === "object" && nested !== null) {
		const nestedMessage = (nested as Record<string, unknown>).message;
		if (typeof nestedMessage === "string") return nestedMessage;
	}
	if (typeof nested === "string") return nested;
	if (typeof record.message === "string") return record.message;
	// FastAPI's shape, which CLM's server answers with. A list there echoes the request back, and is left out.
	return typeof record.detail === "string" ? record.detail : "";
}

/** Keeps well-formed warnings and drops the rest, so a provider cannot break a call with a bad diagnostic. */
export function readWarnings(value: unknown): JudgeWarning[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const warnings: JudgeWarning[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		if (typeof record.type !== "string") continue;
		warnings.push({
			type: record.type,
			message: typeof record.message === "string" ? record.message.slice(0, MAX_ERROR_MESSAGE_LENGTH) : undefined,
			questionId: typeof record.questionId === "string" ? record.questionId : undefined,
		});
	}
	return warnings.length > 0 ? warnings : undefined;
}
