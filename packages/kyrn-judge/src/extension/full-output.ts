// Where the full text of a tool result the model was shown only part of is kept, and how `recall` finds it again.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KyrnRuntime } from "./runtime.ts";

/** A custom entry beside a tool result, naming the file with its full text. Custom entries never reach the model. */
export const FULL_OUTPUT_ENTRY = "kyrn.full-output";

export interface FullOutputRecord {
	readonly toolCallId: string;
	readonly path: string;
	/**
	 * `archive`: the whole result as admission received it, already screened, before it left parts out.
	 * `page`: the whole text of a page `web_fetch` cut; past what the model was shown, nothing screened it.
	 */
	readonly kind: "archive" | "page";
}

/** Records where the full text of a result is, so `recall` can read it back in a later turn or after a reload. */
export function recordFullOutput(runtime: KyrnRuntime, record: FullOutputRecord): void {
	runtime.pi.appendEntry<FullOutputRecord>(FULL_OUTPUT_ENTRY, record);
}

/** Whether the model has `recall`: a note points to it only then, and otherwise says what it said before. */
export function canRecall(runtime: KyrnRuntime): boolean {
	return runtime.pi.getActiveTools().includes("recall");
}

/** `recall({ id: "toolu_1", offset: 20000 })`: the call a note tells the model to make. */
export function recallCall(toolCallId: string, offset?: number, limit?: number): string {
	const parts = [`id: ${JSON.stringify(toolCallId)}`];
	if (offset !== undefined) parts.push(`offset: ${offset}`);
	if (limit !== undefined) parts.push(`limit: ${limit}`);
	return `recall({ ${parts.join(", ")} })`;
}

/**
 * Saves the full text of a page in the folder where admission keeps its archives, readable by the user only, and
 * records it. Undefined when it could not be written; nothing points to it then.
 */
export function keepPage(runtime: KyrnRuntime, toolCallId: string, text: string): string | undefined {
	const dir = join(tmpdir(), `kyrn-${runtime.sessionId}`);
	// A provider may give calls of different turns the same id, so the name never depends on the id alone.
	const path = join(dir, `${toolCallId.replace(/[^\w.-]/g, "_")}-${randomBytes(4).toString("hex")}.page.txt`);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		// `wx` never follows a link someone else placed at the path.
		writeFileSync(path, text, { mode: 0o600, flag: "wx" });
	} catch {
		return undefined;
	}
	recordFullOutput(runtime, { toolCallId, path, kind: "page" });
	return path;
}
