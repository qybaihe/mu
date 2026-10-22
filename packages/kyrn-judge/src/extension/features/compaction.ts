import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type CallItem,
	describeCall,
	type HistoryItem,
	itemsFromMessages,
	type MessageLike,
	serializeHistory,
} from "../../compaction/history.ts";
import { analyze, apply, type CallVerdict, plan } from "../../compaction/prune.ts";
import { type CompactCallInput, contextCompact } from "../../decisions/context-compact.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";

const DETAILS_VERSION = 1;
/** Rough characters per token, for turning a window measured in tokens into a budget measured in characters. */
const CHARS_PER_TOKEN = 3.5;

interface KyrnCompactionDetails {
	kyrn: { version: number; items: HistoryItem[]; metrics?: Record<string, number> };
}

/**
 * mu's own per-turn notes (hints, lessons, nudges) reach the model as user-role text, but nobody said
 * them: they were advice for one turn. In a word-for-word history they would read as the user's words.
 */
function spoken<T extends { role: string }>(messages: readonly T[]): T[] {
	return messages.filter((message) => {
		if (message.role !== "custom") return true;
		const customType = (message as { customType?: unknown }).customType;
		return !(typeof customType === "string" && customType.startsWith("kyrn."));
	});
}

function previousItems(details: unknown): HistoryItem[] | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const kyrn = (details as Partial<KyrnCompactionDetails>).kyrn;
	return kyrn?.version === DETAILS_VERSION && Array.isArray(kyrn.items) ? kyrn.items : undefined;
}

/**
 * E1, compaction without a summary (beta). When pi is about to summarize the
 * old part of the conversation, mu hands it that part word for word instead,
 * with only the tool output pruned that is no longer worth its tokens:
 *
 *   1. rules: a file read again or changed since, a command run again since;
 *   2. a lexical match between each call and the part of the conversation that stays live;
 *   3. the judge, one small question set per call, so a 1K-window local model can do it;
 *   4. a budget: lowest scores go first until the history fits.
 *
 * Every pruned output is saved to a file named in its place, and the items are
 * kept in the compaction entry, so the next compaction scores them again
 * rather than inheriting a frozen text. If what people said alone does not
 * fit the budget, pi's own summary runs as usual.
 */
export function registerCompaction(runtime: KyrnRuntime): void {
	const options = runtime.options("compaction", {
		// Beta: opt in with `"features": { "compaction": true }` in mu.json.
		enabled: false,
		keepThreshold: 0.5,
		minChars: 600,
		headChars: 300,
		/** The pruned history may take this share of what it replaces, */
		targetRatio: 0.5,
		/** and at most this share of the model's context window. */
		maxWindowShare: 0.25,
		/** Histories up to this size are never squeezed by the budget, only by the threshold. */
		freeChars: 24_000,
		maxJudged: 120,
	});
	const policy = (_event: unknown, ctx: ExtensionContext) => {
		runtime.touch(ctx);
		runtime.present("context.policy", { betaEnabled: options.enabled, mode: runtime.mode(contextCompact.id) });
	};
	runtime.pi.on("session_start", policy);
	runtime.pi.on("agent_start", policy);
	if (!options.enabled) return;

	runtime.pi.on(
		"session_before_compact",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			const mode = runtime.mode(contextCompact.id);
			if (mode === "off") return undefined;
			const { preparation, branchEntries } = event;

			// What came before: our own items when the last compaction was ours, otherwise pi's summary as a note.
			const lastCompaction = [...branchEntries].reverse().find((entry) => entry.type === "compaction");
			const carried = previousItems((lastCompaction as { details?: unknown } | undefined)?.details);
			const items: HistoryItem[] = [
				...(carried ??
					(preparation.previousSummary ? [{ kind: "note" as const, text: preparation.previousSummary }] : [])),
				...itemsFromMessages(convertToLlm(spoken(preparation.messagesToSummarize)) as MessageLike[]),
				...itemsFromMessages(convertToLlm(spoken(preparation.turnPrefixMessages)) as MessageLike[], true),
			];
			const firstUser = items.findIndex((item) => item.kind === "user");
			if (firstUser >= 0) items[firstUser] = { ...items[firstUser], pinned: true };

			// The part of the conversation that stays as it is: what relevance is measured against.
			const keptFrom = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
			const tail = itemsFromMessages(
				convertToLlm(
					spoken(
						branchEntries
							.slice(Math.max(0, keptFrom))
							.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
					),
				) as MessageLike[],
			);
			const liveCalls = tail.filter((item): item is CallItem => item.kind === "call");
			const liveText = tail.map((item) => (item.kind === "call" ? describeCall(item) : item.text)).join("\n");
			const said = [...items, ...tail].flatMap((item) => (item.kind === "user" ? [item.text] : []));
			const goal = clip(said.slice(-3).join(" / "), 500);

			const facts = analyze(items, { text: `${goal}\n${liveText}`, calls: liveCalls });
			const judged = facts
				.filter((fact) => {
					const call = items[fact.index] as CallItem;
					return !fact.stale && !call.pinned && call.state === "full" && call.result.length >= options.minChars;
				})
				.sort((a, b) => (items[b.index] as CallItem).result.length - (items[a.index] as CallItem).result.length)
				.slice(0, options.maxJudged);
			const inputs: CompactCallInput[] = judged.map((fact) => {
				const call = items[fact.index] as CallItem;
				const after = items.slice(fact.index + 1).filter((item) => item.kind === "call").length + liveCalls.length;
				return {
					goal,
					call: describeCall(call),
					resultHead: call.result.slice(0, 600),
					resultChars: call.result.length,
					isError: call.isError,
					since: [`${after} tool calls since`],
				};
			});
			const decisions = await runtime.engine.decideMany(contextCompact, inputs, { signal: event.signal });
			// The judge scores whatever the mode: in shadow the plan is only reported, never applied.
			const verdicts = new Map<number, CallVerdict>(
				decisions.map((decision, at) => [judged[at].index, decision.judged ?? decision.outcome]),
			);

			const before = serializeHistory(items).length;
			const modelWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 200_000;
			const window = Math.min(modelWindow, preparation.settings.maxContextTokens || modelWindow) * CHARS_PER_TOKEN;
			const targetChars = Math.min(
				window * options.maxWindowShare,
				Math.max(before * options.targetRatio, Math.min(before, options.freeChars)),
			);
			const planned = plan(items, facts, verdicts, { ...options, targetChars });
			const count = (action: string) => planned.plans.filter((entry) => entry.action === action).length;
			const byRule = planned.plans.filter((entry) => entry.action === "prune" && entry.score === 0).length;
			const report = `${count("keep")} tool results kept verbatim, ${count("prune")} pruned (${byRule} by rule), ${count("drop")} calls dropped · ${before.toLocaleString()} -> ~${planned.chars.toLocaleString()} chars`;
			runtime.present("compaction.plan", {
				mode,
				fits: planned.fits,
				beforeChars: before,
				plannedChars: planned.chars,
				kept: count("keep"),
				pruned: count("prune"),
				dropped: count("drop"),
				byRule,
				fallback: !planned.fits ? "budget" : mode !== "active" ? "shadow" : null,
			});

			if (!planned.fits) {
				if (ctx.hasUI)
					ctx.ui.notify(
						`compaction (beta): the messages alone exceed the budget, so mu writes its usual summary instead. ${report}`,
						"warning",
					);
				return undefined;
			}
			if (mode !== "active") {
				if (ctx.hasUI)
					ctx.ui.notify(
						`compaction (beta, shadow): would have pruned the history instead of summarizing it. ${report}`,
						"info",
					);
				return undefined;
			}

			const archiveDir = join(tmpdir(), `kyrn-${runtime.sessionId}`, "compacted");
			const pruned = apply(items, planned.plans, options, (call) => {
				try {
					mkdirSync(archiveDir, { recursive: true });
					const path = join(archiveDir, `${call.id.replace(/[^\w.-]/g, "_")}.txt`);
					writeFileSync(path, call.result, { mode: 0o600 });
					return path;
				} catch {
					return undefined;
				}
			});
			const summary = serializeHistory(pruned);
			runtime.savings.compactedChars += Math.max(0, before - summary.length);
			if (ctx.hasUI)
				ctx.ui.notify(`compaction (beta): pruned the history instead of summarizing it. ${report}`, "info");
			const actualKept = pruned.filter((item) => item.kind === "call" && item.state === "full").length;
			const details: KyrnCompactionDetails = {
				kyrn: {
					version: DETAILS_VERSION,
					items: pruned,
					metrics: {
						beforeChars: before,
						afterChars: summary.length,
						kept: actualKept,
						pruned: pruned.filter((item) => item.kind === "call" && item.state === "pruned").length,
						dropped: count("drop"),
						byRule,
					},
				},
			};
			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details,
				},
			};
		}),
	);
}
