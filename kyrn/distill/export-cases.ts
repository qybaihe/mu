/**
 * Replays agent transcripts through mu's decision points and writes the questions each would have asked, rendered
 * exactly as a logprob judge asks them (packages/kyrn-judge/src/providers/logprob.ts). A teacher labels these, and a
 * small judge is trained on them, so what it learns and what it is later asked are the same prompts.
 *
 *   node kyrn/distill/export-cases.ts <transcripts.jsonl> <cases.jsonl> [--seed 7]
 *
 * A transcript is one JSON object per line: {id, source, repo?, resolved?, messages}, the messages in OpenAI chat
 * shape (user / assistant with tool_calls {id, name, arguments} / tool with tool_call_id), as written by
 * mu-judge-nemotron's converters. Each case is one question: {case, group, transcript, source, spec, version,
 * question, type, state, messages, labels, facts}. `group` ties the questions of one state together.
 *
 * Replayed points and when they are asked, following the runtime (packages/kyrn-judge/src/extension/features):
 * - tool.admission: middle chunks of a successful shell output of 6000+ characters (admission.ts).
 * - turn.drift: every 6 tool results, over the last 8 (monitor.ts).
 * - turn.completion: where the run could end after an edit that nothing has run since (completion.ts).
 * - turn.continue: where the run could end on a message of the assistant (continuation.ts).
 * - tool.risk: shell commands the rules flag (guard.ts, permissions.ts).
 * "Could end" is any assistant message with text: a transcript only shows where its agent went on, so each such
 * message is also a place a model could have stopped, which is when mu asks.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import type { DecisionSpec } from "../../packages/kyrn-judge/src/decision.ts";
import { toolAdmission } from "../../packages/kyrn-judge/src/decisions/tool-admission.ts";
import { toolRisk } from "../../packages/kyrn-judge/src/decisions/tool-risk.ts";
import { turnCompletion } from "../../packages/kyrn-judge/src/decisions/turn-completion.ts";
import { turnContinue } from "../../packages/kyrn-judge/src/decisions/turn-continue.ts";
import { turnDrift } from "../../packages/kyrn-judge/src/decisions/turn-drift.ts";
import { chunkLines, describeCall } from "../../packages/kyrn-judge/src/extension/features/admission.ts";
import { riskFlag } from "../../packages/kyrn-judge/src/extension/features/guard.ts";
import { clip } from "../../packages/kyrn-judge/src/extension/runtime.ts";
import { renderLabeledPrompt } from "../../packages/kyrn-judge/src/providers/logprob.ts";
import type { JsonValue, Questions } from "../../packages/kyrn-judge/src/types.ts";

interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

interface TranscriptMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

interface Transcript {
	id: string;
	source: string;
	repo?: string;
	resolved?: number;
	messages: TranscriptMessage[];
}

/** At most this many cases of each point per transcript, so long runs do not dominate. */
const CAPS = { admissionOutputs: 2, admissionChunks: 4, drift: 4, completion: 2, continue: 3, risk: 3 };
/** The runtime's own settings (admission.ts, monitor.ts). */
const ADMISSION = { judgeMinChars: 6000, chunkChars: 1200, maxChunks: 48 };
const MONITOR = { every: 6, window: 8 };

/** Messages a harness sends to keep its agent going are not the person's words, as mu's own nudges are not. */
const HARNESS_NUDGE = /^Please continue working on the task/;

/** The task as a person would put it: OpenHands wraps the issue in a long template. */
function userWords(text: string, repo: string | undefined): string {
	const issue = /<issue_description>\s*([\s\S]*?)\s*<\/issue_description>/.exec(text)?.[1];
	if (!issue) return text;
	return repo ? `In ${repo}, resolve this issue:\n\n${issue}` : `Resolve this issue:\n\n${issue}`;
}

/** An OpenHands call as the mu tool that does the same, which is what mu's runtime would have seen. */
function asMuCall(call: ToolCall): { tool: string; input: Record<string, unknown> } | undefined {
	const args = call.arguments;
	if (call.name === "execute_bash") return { tool: "bash", input: { command: String(args.command ?? "") } };
	if (call.name === "str_replace_editor") {
		const path = String(args.path ?? "");
		const command = String(args.command ?? "");
		if (command === "view") return { tool: "read", input: { path } };
		if (command === "create") return { tool: "write", input: { path } };
		return { tool: "edit", input: { path } };
	}
	// `think` logs a thought and `finish` ends the run; mu has neither as a tool.
	if (call.name === "think" || call.name === "finish") return undefined;
	return { tool: call.name, input: args };
}

function failed(tool: string, output: string): boolean {
	if (tool === "bash") {
		const code = /exit code (-?\d+)/.exec(output.slice(-400))?.[1];
		return code !== undefined && code !== "0";
	}
	return /^ERROR:/.test(output.trimStart());
}

/** Small deterministic generator, so a seed reproduces an export. */
function random(seed: string): () => number {
	let h = 2166136261;
	for (const char of seed) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
	return () => {
		h = Math.imul(h ^ (h >>> 15), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		return ((h ^= h >>> 16) >>> 0) / 4294967296;
	};
}

function sample<T>(items: readonly T[], count: number, next: () => number): T[] {
	const pool = [...items];
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, count);
}

interface Case {
	case: string;
	group: string;
	transcript: string;
	source: string;
	spec: string;
	version: number;
	question: string;
	type: string;
	state: JsonValue;
	messages: readonly { role: string; content: string }[];
	labels: Readonly<Record<string, string>>;
	facts: Record<string, JsonValue>;
}

function casesFor<In, Qs extends Questions, Out extends JsonValue>(
	spec: DecisionSpec<In, Qs, Out>,
	input: In,
	group: string,
	transcript: Transcript,
	facts: Record<string, JsonValue>,
): Case[] {
	const state = spec.buildState(input);
	const questions: Questions = spec.questionsFor ? spec.questionsFor(input) : spec.questions;
	return Object.entries(questions).map(([id, question]) => {
		const prompt = renderLabeledPrompt(state, question);
		return {
			case: `${group}:${id}`,
			group,
			transcript: transcript.id,
			source: transcript.source,
			spec: spec.id,
			version: spec.version,
			question: id,
			type: question.type,
			state: state as JsonValue,
			messages: prompt.messages,
			labels: prompt.labels,
			facts,
		};
	});
}

function replay(transcript: Transcript, seed: string): Case[] {
	const next = random(`${seed}:${transcript.id}`);
	const resolved = transcript.resolved ?? null;
	const firstUser = transcript.messages.find((message) => message.role === "user");
	if (!firstUser) return [];
	let userMessage = userWords(firstUser.content, transcript.repo);
	const goal = clip(userMessage, 600);
	const pending = new Map<string, { tool: string; input: Record<string, unknown> }>();
	const actions: string[] = [];
	const edited = new Set<string>();
	let ranAfterEdit = false;
	let sinceDrift = 0;

	const admissions: { call: string; middle: string[] }[] = [];
	const drifts: { goal: string; recentActions: string[] }[] = [];
	const completions: { finalMessage: string; editedFiles: number; ranCommandAfterLastEdit: boolean }[] = [];
	const continues: string[] = [];
	const risks: { command: string; flag: string; userMessage: string }[] = [];

	for (const [index, message] of transcript.messages.entries()) {
		if (message.role === "user") {
			if (index > 0 && !HARNESS_NUDGE.test(message.content)) userMessage = message.content;
			continue;
		}
		if (message.role === "assistant") {
			const finish = message.tool_calls?.find((call) => call.name === "finish");
			const text = (finish ? String(finish.arguments.message ?? "") : "") || message.content;
			if (text.trim()) {
				continues.push(text);
				if (edited.size > 0 && !ranAfterEdit) {
					completions.push({
						finalMessage: clip(text, 600),
						editedFiles: edited.size,
						ranCommandAfterLastEdit: ranAfterEdit,
					});
				}
			}
			for (const call of message.tool_calls ?? []) {
				const mu = asMuCall(call);
				if (!mu) continue;
				pending.set(call.id, mu);
				if (mu.tool === "bash") {
					const command = String(mu.input.command);
					const flag = riskFlag(command);
					if (flag) risks.push({ command: clip(describeCall("bash", mu.input), 400), flag, userMessage });
				}
			}
			continue;
		}
		const call = pending.get(message.tool_call_id ?? "");
		if (!call) continue;
		const output = message.content;
		const isError = failed(call.tool, output);
		const described = describeCall(call.tool, call.input);
		actions.push(`${described} -> ${isError ? "error" : "ok"}`);
		if (!isError && (call.tool === "edit" || call.tool === "write")) {
			edited.add(String(call.input.path));
			ranAfterEdit = false;
		} else if (!isError && call.tool === "bash" && edited.size > 0) {
			ranAfterEdit = true;
		}
		if (++sinceDrift >= MONITOR.every) {
			sinceDrift = 0;
			drifts.push({ goal, recentActions: actions.slice(-MONITOR.window) });
		}
		if (call.tool === "bash" && !isError && output.length >= ADMISSION.judgeMinChars) {
			const chunks = chunkLines(output, ADMISSION.chunkChars);
			if (chunks.length >= 3 && chunks.length <= ADMISSION.maxChunks) {
				admissions.push({ call: described, middle: chunks.slice(1, -1) });
			}
		}
	}

	const facts = { resolved, repo: transcript.repo ?? null };
	const cases: Case[] = [];
	const group = (spec: string, n: number) => `${transcript.id}:${spec}:${n}`;
	for (const [n, output] of sample(admissions, CAPS.admissionOutputs, next).entries()) {
		for (const [k, chunk] of sample(output.middle, CAPS.admissionChunks, next).entries()) {
			cases.push(...casesFor(toolAdmission, { call: output.call, chunk }, group(toolAdmission.id, n * 100 + k), transcript, facts));
		}
	}
	for (const [n, input] of sample(drifts, CAPS.drift, next).entries()) {
		cases.push(...casesFor(turnDrift, input, group(turnDrift.id, n), transcript, facts));
	}
	for (const [n, input] of sample(completions, CAPS.completion, next).entries()) {
		cases.push(
			...casesFor(turnCompletion, { userMessage: clip(userMessage, 400), ...input }, group(turnCompletion.id, n), transcript, facts),
		);
	}
	for (const [n, text] of sample(continues, CAPS.continue, next).entries()) {
		const flat = text.replace(/\s+/g, " ").trim();
		const finalMessage = flat.length <= 600 ? flat : `…${flat.slice(-599)}`;
		cases.push(
			...casesFor(turnContinue, { userMessage: clip(userMessage, 400), finalMessage }, group(turnContinue.id, n), transcript, facts),
		);
	}
	for (const [n, risk] of sample(risks, CAPS.risk, next).entries()) {
		cases.push(
			...casesFor(
				toolRisk,
				{ command: risk.command, flag: risk.flag, userMessage: clip(risk.userMessage, 400) },
				group(toolRisk.id, n),
				transcript,
				facts,
			),
		);
	}
	return cases;
}

async function main(): Promise<void> {
	const [input, output, ...rest] = process.argv.slice(2);
	if (!input || !output) {
		console.error("usage: node kyrn/distill/export-cases.ts <transcripts.jsonl> <cases.jsonl> [--seed 7]");
		process.exit(2);
	}
	const seedFlag = rest.indexOf("--seed");
	const seed = seedFlag >= 0 ? (rest[seedFlag + 1] ?? "7") : "7";
	const out = createWriteStream(output);
	const counts = new Map<string, number>();
	let transcripts = 0;
	for await (const line of createInterface({ input: createReadStream(input), crlfDelay: Infinity })) {
		if (!line.trim()) continue;
		transcripts++;
		for (const item of replay(JSON.parse(line) as Transcript, seed)) {
			counts.set(item.spec, (counts.get(item.spec) ?? 0) + 1);
			if (!out.write(`${JSON.stringify(item)}\n`)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
		}
	}
	await new Promise<void>((resolve) => out.end(resolve));
	console.log(`${transcripts} transcripts`);
	for (const [spec, count] of [...counts].sort()) console.log(`  ${spec}: ${count} questions`);
}

await main();
