import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTestLog, planTestLog, renderTestLog, type TestLogStrategy } from "../../admission/test-log.ts";
import { type AdmissionOutcome, toolAdmission, toolAdmissionBatch } from "../../decisions/tool-admission.ts";
import { clip, failOpen, type KyrnRuntime, textOf, within } from "../runtime.ts";

/** What one batched request may carry in chunks: the judge takes 64 KiB, and the call and the questions need room too. */
const BATCH_STATE_CHARS = 48_000;

/** Splits on line boundaries into pieces of at most `size` characters; an over-long line becomes its own piece. */
export function chunkLines(text: string, size: number): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const line of text.split("\n")) {
		if (current && current.length + line.length + 1 > size) {
			chunks.push(current);
			current = "";
		}
		current = current ? `${current}\n${line}` : line;
		while (current.length > size) {
			chunks.push(current.slice(0, size));
			current = current.slice(size);
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

/**
 * Programs that print a file, or part of one, as it is. What they print is what the agent asked to read, as with the
 * `read` tool. In Terminal-Bench 2.1 such prints and fetched pages were half of what the judge was asked, it found
 * nothing worth dropping in any of them, and the one chunk it did drop from a `cat` (a makefile, as "passing") was
 * wrong.
 */
export const PRINT_COMMANDS: readonly string[] = [
	"cat",
	"sed -n",
	"head",
	"tail",
	"nl",
	"less",
	"bat",
	"grep",
	"rg",
	"od",
	"xxd",
	"git show",
	"git diff",
	"readelf",
	"objdump",
];

/** Tools whose `command` is a shell command line. */
const SHELLS: readonly string[] = ["bash", "powershell"];

/** Commands that may stand between the prints without printing anything long of their own: `cd dir`, `echo ===`. */
const BETWEEN = /^(?:cd|echo|printf)(?:\s|$)/;

/**
 * Whether a shell command only prints files: every command in it, split at `;`, `&&`, `||`, `|` and line breaks,
 * starts with one of `programs` (`sed -n` counts, `sed -i` does not), apart from a `cd` or an `echo` between them.
 * A command that can do more than print is not one: a redirect or a here document, `$(…)`, a job sent to the
 * background, `tail -f`. So `cat > main.c <<EOF … EOF && make` still has its build output judged.
 */
export function printsFile(command: string, programs: readonly string[] = PRINT_COMMANDS): boolean {
	if (programs.length === 0 || /`|\$\(/.test(command)) return false;
	const names = programs.map((name) =>
		name
			.trim()
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			.replace(/\s+/g, "\\s+"),
	);
	const start = new RegExp(`^(?:${names.join("|")})(?=\\s|$)`);
	const bare = command
		// What is quoted is an argument, whatever characters it holds: `grep -E "a|b"`.
		.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
		// Error output thrown away or merged changes nothing about what is printed.
		.replace(/(^|\s)2>(?:\s*\/dev\/null|&1)(?=\s|[;&|]|$)/g, "$1");
	const parts = bare
		.split(/&&|\|\||[;|\n]/)
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.some((part) => /[<>&]/.test(part) || !(BETWEEN.test(part) || start.test(part)))) return false;
	if (parts.some((part) => /^tail\b.*\s(?:-[a-zA-Z]*[fF]|--follow)\b/.test(part))) return false;
	return parts.some((part) => !BETWEEN.test(part));
}

/** A compact description of a tool call for the judge: the command, pattern or path that produced the output. */
export function describeCall(toolName: string, input: Record<string, unknown>): string {
	const value = input.command ?? input.pattern ?? input.path ?? input.query;
	return clip(`${toolName}: ${typeof value === "string" ? value : JSON.stringify(input)}`, 300);
}

/**
 * B1: long tool output is classified chunk by chunk before it enters the
 * context, and confident noise (progress, repeated warnings, passing checks)
 * is archived instead. Rules come first: errors, short output, images and
 * source reads always pass, and the first and last chunk always stay because
 * that is where commands put their summary and exit status. A shell command
 * that only prints a file (`printsFile`) passes like a `read` does, and so does
 * a fetched page: what the agent asked to read is not judged.
 *
 * `testLog` (off by default) gives test-runner output its own path, see
 * admission/test-log.ts. It also takes failing runs, which the chunk path skips:
 * in real sessions every long test log was a failing one, and half of its text
 * repeated an earlier part of itself.
 */
export function registerAdmission(runtime: KyrnRuntime): void {
	const options = runtime.options("admission", {
		enabled: true,
		minChars: 4000,
		/** Below this, output is admitted whole rather than judged chunk by chunk: the round trips would cost more than the tokens saved. */
		judgeMinChars: 6000,
		chunkChars: 1200,
		maxChunks: 48,
		/** Chunks put to a hosted judge in one request. The local sidecar is asked one chunk at a time whatever this says. */
		batchChunks: 16,
		/** Requests in flight at once: batches for a hosted judge, chunks for the local sidecar. */
		concurrency: 4,
		/** A verdict later than this is not worth holding the result for: the output goes in whole, the verdict is only recorded. */
		waitMs: 4000,
		/**
		 * Tools whose output is never judged: file contents and pages the model asked for, and sub-agent reports the bees
		 * already shaped.
		 */
		passThrough: ["read", "edit", "write", "delegate", "hive", "web_fetch"],
		/** Shell commands made of these programs only print files, and are not judged either (`printsFile`). Empty: all are. */
		printCommands: [...PRINT_COMMANDS],
		/** "rules" omits exact repeats in test-runner output; "jev" also asks the judge about what is left. */
		testLog: "off" as TestLogStrategy | "off",
		/** Tell test runners an agent is reading: Vitest then prints failures and the summary only. */
		agentEnv: true,
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	// An explicit reporter flag still wins, so the agent can list every passing test when it needs them.
	if (options.agentEnv) process.env.AI_AGENT ??= "1";

	pi.on(
		"message_end",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			const message = event.message as { role?: unknown; content?: unknown };
			if (message.role !== "assistant") return undefined;
			const text = textOf(message.content);
			if (text.trim()) runtime.lastAssistantText = text;
			return undefined;
		}),
	);

	/**
	 * One verdict per chunk, in order. A hosted judge takes many chunks in one request, the state billed once
	 * (measured 2026-09-23 on jev: 16 chunks in 0.44 s and 7.6k tokens, against 1.4 s and 11.6k tokens as 16
	 * requests, with the same verdicts). The local sidecar's window holds one chunk, and a logprob judge sends each
	 * question with its state, so both are asked one chunk at a time.
	 */
	const judgeChunks = async (
		call: string,
		middle: readonly string[],
		signal: AbortSignal | undefined,
	): Promise<readonly AdmissionOutcome[]> => {
		if (!runtime.judgeBatches) {
			const decisions = await runtime.engine.decideMany(
				toolAdmission,
				middle.map((chunk) => ({ call, chunk })),
				{ signal, concurrency: options.concurrency },
			);
			return decisions.map((decision) => decision.outcome);
		}
		const size = Math.max(1, Math.min(options.batchChunks, Math.floor(BATCH_STATE_CHARS / options.chunkChars)));
		const batches: { call: string; chunks: string[] }[] = [];
		for (let start = 0; start < middle.length; start += size) {
			batches.push({ call, chunks: middle.slice(start, start + size) });
		}
		const decisions = await runtime.engine.decideMany(toolAdmissionBatch, batches, {
			signal,
			concurrency: options.concurrency,
		});
		return decisions.flatMap((decision) => decision.outcome);
	};

	pi.on(
		"tool_result",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			const toolName = "toolName" in event ? String(event.toolName) : "";
			if (options.passThrough.includes(toolName)) return undefined;
			const command = event.input.command;
			if (SHELLS.includes(toolName) && typeof command === "string" && printsFile(command, options.printCommands)) {
				return undefined;
			}
			if (event.content.some((block) => block.type !== "text")) return undefined;
			const text = textOf(event.content);
			if (text.length < options.minChars) return undefined;
			// bg_output is called with a job id; what produced the text is the job's command, which its result carries.
			const details = event.details as { command?: unknown } | undefined;
			const call = describeCall(
				toolName,
				typeof details?.command === "string" ? { command: details.command } : event.input,
			);
			const archiveDir = join(tmpdir(), `kyrn-${runtime.sessionId}`);
			const archivePath = join(archiveDir, `${event.toolCallId.replace(/[^\w.-]/g, "_")}.txt`);

			if (options.testLog !== "off" && isTestLog(call, text)) {
				const frame = runtime.taskFrame();
				const goal = [frame?.goal, frame?.currentSubgoal].filter(Boolean).join("\n");
				const intent = clip(runtime.lastAssistantText, 400);
				// Selecting by the goal needs a goal that is current. The repeat rule never reads it, so it carries on.
				const strategy = options.testLog === "jev" && runtime.frameStale ? "rules" : options.testLog;
				const plan = await planTestLog({ call, goal, intent, output: text }, strategy, runtime.engine, {
					signal: ctx.signal,
				});
				const rendered = renderTestLog(plan, archivePath);
				if (!rendered.applied) return undefined;
				// The markers count lines of this text, so this text is what gets archived, not pi's own full-output file.
				mkdirSync(archiveDir, { recursive: true });
				writeFileSync(archivePath, text);
				runtime.savings.admissionOmittedChars += rendered.omittedChars;
				return { content: [{ type: "text" as const, text: rendered.text }] };
			}

			const mode = runtime.mode(toolAdmission.id);
			if (mode === "off" || event.isError || text.length < options.judgeMinChars) return undefined;
			const chunks = chunkLines(text, options.chunkChars);
			if (chunks.length < 3 || chunks.length > options.maxChunks) return undefined;
			const middle = chunks.slice(1, -1);
			// Shadow records what it would have dropped; only an active verdict is worth holding the result for.
			if (mode !== "active") {
				void judgeChunks(call, middle, undefined).catch(() => {});
				return undefined;
			}
			// Measured in real sessions before batching: up to 30 s in front of one result. Past the limit the output
			// goes in whole; the verdicts still land in the ledger, where the wait they would have cost can be read.
			const outcomes = await within(judgeChunks(call, middle, ctx.signal), options.waitMs);
			if (!outcomes) return undefined;

			const dropped = outcomes.map((outcome) => outcome.drop);
			if (!dropped.some(Boolean)) return undefined;

			mkdirSync(archiveDir, { recursive: true });
			writeFileSync(archivePath, text);

			const kept: string[] = [chunks[0]];
			let omittedChars = 0;
			let run: string[] = [];
			const kinds = new Set<string>();
			const flush = () => {
				if (run.length === 0) return;
				const chars = run.reduce((sum, chunk) => sum + chunk.length, 0);
				const lines = run.reduce((sum, chunk) => sum + chunk.split("\n").length, 0);
				omittedChars += chars;
				kept.push(
					`[mu: ${lines} lines (${chars} chars) of ${[...kinds].join("/")} output omitted; full output: ${archivePath}]`,
				);
				kinds.clear();
				run = [];
			};
			middle.forEach((chunk, index) => {
				if (dropped[index]) {
					run.push(chunk);
					kinds.add(outcomes[index].kind);
				} else {
					flush();
					kept.push(chunk);
				}
			});
			flush();
			kept.push(chunks[chunks.length - 1]);

			runtime.savings.admissionOmittedChars += omittedChars;
			return { content: [{ type: "text" as const, text: kept.join("\n") }] };
		}),
	);
}
