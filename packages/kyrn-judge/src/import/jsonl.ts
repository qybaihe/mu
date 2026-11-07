/**
 * Reading JSON-lines transcripts that can be very large: a Codex rollout reaches gigabytes (screenshots inline as
 * base64), a single line tens of megabytes. Only node: built-ins here, so that `mu import` runs on a bare Node.
 */
import { closeSync, createReadStream, fstatSync, openSync, readSync } from "node:fs";

/** One line of a transcript: the parsed value, or why there is none. */
export type JsonLine = { value: unknown; bytes: number } | { problem: "malformed" | "oversized"; bytes: number };

/** A line longer than this is skipped, not parsed: nothing a person reads is that long, and it would not fit a string. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

function parse(bytes: Buffer): JsonLine {
	const text = bytes.toString("utf8").trim();
	if (!text) return { problem: "malformed", bytes: bytes.length };
	try {
		return { value: JSON.parse(text) as unknown, bytes: bytes.length };
	} catch {
		return { problem: "malformed", bytes: bytes.length };
	}
}

const blank = (bytes: Buffer): boolean => bytes.toString("utf8").trim() === "";

/** Every non-empty line of the file, in order, without ever holding more than one line in memory. */
export async function* readJsonLines(path: string, maxLineBytes = MAX_LINE_BYTES): AsyncGenerator<JsonLine> {
	let parts: Buffer[] = [];
	let size = 0;
	let oversized = false;
	for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
		const buffer = chunk as Buffer;
		let start = 0;
		for (let newline = buffer.indexOf(10, start); newline !== -1; newline = buffer.indexOf(10, start)) {
			const piece = buffer.subarray(start, newline);
			start = newline + 1;
			if (oversized || size + piece.length > maxLineBytes) {
				yield { problem: "oversized", bytes: size + piece.length };
			} else if (size + piece.length > 0) {
				const line = parts.length === 0 ? piece : Buffer.concat([...parts, piece]);
				if (!blank(line)) yield parse(line);
			}
			parts = [];
			size = 0;
			oversized = false;
		}
		const rest = buffer.subarray(start);
		if (rest.length === 0) continue;
		if (oversized || size + rest.length > maxLineBytes) {
			oversized = true;
			parts = [];
			size += rest.length;
			continue;
		}
		parts.push(Buffer.from(rest));
		size += rest.length;
	}
	if (oversized) yield { problem: "oversized", bytes: size };
	else if (size > 0) {
		const line = Buffer.concat(parts);
		if (!blank(line)) yield parse(line);
	}
}

/**
 * The first lines of a file, for a listing: `visit` sees each parsed line and returns true once it has what it needs.
 * Reading stops there, or after `limit` bytes; a line cut off by the limit is not parsed.
 */
export function readHead(path: string, visit: (value: unknown) => boolean, limit = 1024 * 1024): void {
	const fd = openSync(path, "r");
	try {
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let pending = Buffer.alloc(0);
		let read = 0;
		while (read < limit) {
			const count = readSync(fd, chunk, 0, Math.min(chunk.length, limit - read), null);
			if (count === 0) {
				if (!blank(pending)) {
					const last = parse(pending);
					if ("value" in last) visit(last.value);
				}
				return;
			}
			read += count;
			pending = Buffer.concat([pending, chunk.subarray(0, count)]);
			let start = 0;
			for (let newline = pending.indexOf(10, start); newline !== -1; newline = pending.indexOf(10, start)) {
				const line = pending.subarray(start, newline);
				start = newline + 1;
				if (blank(line)) continue;
				const parsed = parse(line);
				if ("value" in parsed && visit(parsed.value)) return;
			}
			pending = pending.subarray(start);
		}
	} finally {
		closeSync(fd);
	}
}

/** The last lines of a file, for a listing: each whole line in the last `limit` bytes, parsed, in order. */
export function readTail(path: string, limit = 256 * 1024): unknown[] {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - limit);
		const buffer = Buffer.allocUnsafe(size - start);
		const count = readSync(fd, buffer, 0, buffer.length, start);
		let text = buffer.subarray(0, count);
		// The first line is cut unless the read began at the start of the file or of a line.
		if (start > 0) {
			const newline = text.indexOf(10);
			text = newline === -1 ? Buffer.alloc(0) : text.subarray(newline + 1);
		}
		const values: unknown[] = [];
		for (const line of text.toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			const parsed = parse(Buffer.from(line));
			if ("value" in parsed) values.push(parsed.value);
		}
		return values;
	} finally {
		closeSync(fd);
	}
}

/** A plain object, or undefined: transcripts are data from elsewhere, nothing in them is trusted to have a shape. */
export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
