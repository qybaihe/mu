import { createHash } from "node:crypto";
import type { CacheImpact } from "../../decision.ts";
import type { LedgerRecord } from "../../ledger.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

/** Written when a request to the model no longer starts with the request before it. */
export const PREFIX_ENTRY = "kyrn.prefix";

/** A provider's request as far as its prompt cache sees it: what comes before the conversation, and the conversation. */
export interface Fingerprint {
	readonly model?: string;
	/** The system prompt, the tools and the tool choice. */
	readonly head: string;
	/** Each message of the conversation, hashed with every message before it. */
	readonly items: readonly string[];
	/** Each message's role, or its type where it has none (a Responses API item). */
	readonly kinds: readonly string[];
}

/** Where a request stopped starting with the one before it. */
export interface PrefixBreak {
	readonly part: "model" | "system and tools" | "messages";
	/** The first message that differs, counted from 0, with its role. */
	readonly index?: number;
	readonly kind?: string;
	readonly before: number;
	readonly after: number;
}

export interface PrefixEntry extends PrefixBreak {
	readonly model?: string;
	/** What mu decided since the request before, each with what its spec says acting on it does to the cache. */
	readonly decisions: readonly { readonly specId: string; readonly cacheImpact: CacheImpact | "unknown" }[];
}

/** Where the conversation is, in the request formats pi sends: chat and Anthropic messages, Responses input, Gemini. */
const LISTS = ["messages", "input", "contents"] as const;
/** What comes before the conversation and is part of the cached prefix. Sampling settings are not. */
const HEAD = [
	"system",
	"instructions",
	"systemInstruction",
	"system_instruction",
	"tools",
	"tool_choice",
	"toolConfig",
];

/** A value as text, keys sorted, without Anthropic's cache markers: they move to the newest message every request. */
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([key, item]) => key !== "cache_control" && item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The fingerprint of a provider request, or undefined for a format without a conversation list. */
export function fingerprint(payload: unknown): Fingerprint | undefined {
	if (payload === null || typeof payload !== "object") return undefined;
	const body = payload as Record<string, unknown>;
	const list = LISTS.map((key) => body[key]).find(Array.isArray);
	if (!list) return undefined;
	const items: string[] = [];
	let previous = "";
	for (const item of list) {
		previous = sha(`${previous}\n${stable(item)}`);
		items.push(previous);
	}
	const kinds = list.map((item) => {
		const record = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
		return String(record.role ?? record.type ?? "?");
	});
	return {
		...(typeof body.model === "string" ? { model: body.model } : {}),
		head: sha(stable(HEAD.map((key) => body[key]))),
		items,
		kinds,
	};
}

/** Where `now` stops starting with `before`, or undefined when it only adds to it, as a cached request should. */
export function prefixBreak(before: Fingerprint, now: Fingerprint): PrefixBreak | undefined {
	const sizes = { before: before.items.length, after: now.items.length };
	if (before.model !== now.model) return { part: "model", ...sizes };
	if (before.head !== now.head) return { part: "system and tools", ...sizes };
	const last = before.items.length - 1;
	if (last < 0 || now.items[last] === before.items[last]) return undefined;
	// Each item's hash covers every item before it, so the first that differs is where the two part.
	const index = before.items.findIndex((item, at) => now.items[at] !== item);
	return { part: "messages", index, kind: now.kinds[index] ?? before.kinds[index], ...sizes };
}

/**
 * The prompt cache watch (`features.prefix`, on by default). A provider reuses the work of a request whose start it has
 * seen; mu goes to some length for that (`cache.warming`, `context.forget` at cache boundaries), and a decision declares
 * what acting on it does to the cache (`cacheImpact`). Nothing checked it. Before each request to the model this
 * compares the request with the one before it. When it no longer starts with it, the session gets a `kyrn.prefix`
 * entry: which part changed (the model, the system prompt and tools, or the first message that differs), and what mu
 * decided in between, each decision with its declared cache impact, so the change can be traced. Only hashes, counts
 * and roles are kept; nothing is sent anywhere.
 */
export function registerPrefix(runtime: KyrnRuntime): void {
	const options = runtime.options("prefix", { enabled: true });
	if (!options.enabled) return;
	const { pi } = runtime;
	let before: Fingerprint | undefined;
	let seen: LedgerRecord | undefined;

	/** The decisions recorded since the request before, oldest first. */
	const decidedSince = (): LedgerRecord[] => {
		const records = runtime.memory.records;
		const from = seen ? records.lastIndexOf(seen) + 1 : 0;
		seen = records.at(-1);
		return records.slice(from);
	};

	pi.on(
		"before_provider_request",
		failOpen((event) => {
			const now = fingerprint(event.payload);
			const decided = decidedSince();
			if (!now) return undefined;
			const broke = before ? prefixBreak(before, now) : undefined;
			before = now;
			if (!broke) return undefined;
			const decisions = [
				...new Set(decided.filter((record) => record.mode === "active").map((record) => record.specId)),
			];
			pi.appendEntry<PrefixEntry>(PREFIX_ENTRY, {
				...broke,
				...(now.model ? { model: now.model } : {}),
				decisions: decisions.map((specId) => ({
					specId,
					cacheImpact: runtime.engine.cacheImpactOf(specId) ?? "unknown",
				})),
			});
			return undefined;
		}),
	);
}
