// Where the full text of a tool result the model was shown only part of is kept, and how `recall` finds it again.
import type { KyrnRuntime } from "./runtime.ts";

/** A custom entry beside a tool result, naming the file with its full text. Custom entries never reach the model. */
export const FULL_OUTPUT_ENTRY = "kyrn.full-output";

export interface FullOutputRecord {
	readonly toolCallId: string;
	readonly path: string;
	/** `archive`: the whole result as admission received it, already screened, before it left parts out. */
	readonly kind: "archive";
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
