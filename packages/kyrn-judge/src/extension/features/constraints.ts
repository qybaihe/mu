import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isReadOnlyChain, shellStart } from "../../checkpoint/mutating.ts";
import { digestOf } from "../../decision.ts";
import { type ToolConstraintInput, toolConstraint } from "../../decisions/tool-constraint.ts";
import { constraintId } from "../../frame/frame.ts";
import { environmentSecrets, redactJson, redactSecrets } from "../../redact.ts";
import { clip, failOpen, type KyrnRuntime, within } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";
import { readWhole } from "./guard.ts";
import { APPROVAL_CALL_CHARS } from "./permissions.ts";

/** Tools that change something. Reading and searching never go against "do not modify". */
const MUTATING = new Set([
	"edit",
	"write",
	"bash",
	"powershell",
	"sg_rewrite",
	"bg_start",
	"apply_patch_from",
	"conflicts_resolve",
	// A debugged program does whatever it does, and an evaluated expression can call anything in it.
	"debug_start",
	"debug_inspect",
]);

/** What a call would do, short enough to show: where, and the beginning of what. */
export function describeCall(toolName: string, input: unknown): string {
	return callPreview(toolName, inputRecord(input));
}

const MAX_REPLACEMENTS = 3;
const MAX_PATH_LENGTH = 500;
const PATH_HEAD_LENGTH = 180;
const EDIT_TEXT_LENGTH = 160;

/** Build the judge input from the final tool arguments and the user rules to check. */
export function constraintInput(
	toolName: string,
	input: unknown,
	constraints: readonly string[],
	once?: { readonly index: number; readonly userMessage: string },
): ToolConstraintInput {
	const known = environmentSecrets();
	const scrub = (text: string) => redactSecrets(text, known);
	const record = inputRecord(input);
	const preview = {
		toolName,
		call: toolName === "edit" ? describeEdit(record, scrub) : callPreview(toolName, record, known),
		constraints,
	};
	if (!once) return preview;
	// An exception must match the whole call, not a prefix that hides a second action. Don't grant on
	// redacted arguments either: two different calls could otherwise look identical to the judge.
	const full = JSON.stringify(record);
	if (
		toolName.length + 2 + full.length > APPROVAL_CALL_CHARS ||
		once.userMessage.length > APPROVAL_CALL_CHARS ||
		JSON.stringify(redactJson(record, known)) !== full ||
		scrub(full) !== full ||
		scrub(once.userMessage) !== once.userMessage
	)
		return preview;
	return { ...preview, permission: { ...once, completeCall: `${toolName}: ${full}` } };
}

function inputRecord(input: unknown): Record<string, unknown> {
	return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}

function callPreview(toolName: string, record: Record<string, unknown>, known?: readonly string[]): string {
	const text = (value: unknown) => (typeof value !== "string" ? "" : known ? redactSecrets(value, known) : value);
	if (isShellTool(toolName) || toolName === "bg_start") return clip(text(record.command), 500);
	const path = text(record.path) || text(record.file_path) || text(record.file);
	const body = text(record.content) || text(record.newText) || text(record.new_string) || text(record.rewrite);
	return clip(
		`${path}${body ? ` <- ${body}` : ""}` || JSON.stringify(known ? redactJson(record, known) : record),
		500,
	);
}

function describeEdit(record: Record<string, unknown>, scrub: (text: string) => string): string {
	const { path, edits, oldText, newText } = record;
	const target = `replace text in ${typeof path === "string" ? describeEditTarget(scrub(path)) : "[unavailable]"}`;
	const replacements: readonly unknown[] = Array.isArray(edits) ? edits : [];
	// The edit tool appends a top-level replacement after any batched replacements.
	const count = replacements.length + (typeof oldText === "string" && typeof newText === "string" ? 1 : 0);
	if (count === 0) return `${target} [replacements unavailable]`;
	const lines = [`${target} (${count} ${count === 1 ? "replacement" : "replacements"})`];
	for (let index = 0; index < Math.min(count, MAX_REPLACEMENTS); index++) {
		const replacement = index === replacements.length ? record : inputRecord(replacements[index]);
		lines.push(
			`${index + 1}. oldText: ${quotedPreview(replacement.oldText, scrub)}\n   newText: ${quotedPreview(replacement.newText, scrub)}`,
		);
	}
	if (count > MAX_REPLACEMENTS) lines.push("[truncated: additional replacements omitted]");
	return lines.join("\n");
}

function describeEditTarget(path: string): string {
	if (path.length <= MAX_PATH_LENGTH) return JSON.stringify(path);
	// Keep the basename in view and distinguish paths that differ only within the omitted directory names.
	const head = JSON.stringify(path.slice(0, PATH_HEAD_LENGTH));
	const tail = JSON.stringify(path.slice(-(MAX_PATH_LENGTH - PATH_HEAD_LENGTH)));
	return `${head} [middle omitted] ${tail} [path digest: ${digestOf(path)}]`;
}

function quotedPreview(value: unknown, scrub: (text: string) => string): string {
	if (typeof value !== "string") return "[unavailable]";
	// Redact the whole field before clipping can leave part of a secret or quoting can hide it.
	const clean = scrub(value);
	const quoted = JSON.stringify(clean.slice(0, EDIT_TEXT_LENGTH));
	return clean.length > EDIT_TEXT_LENGTH ? `${quoted} [truncated]` : quoted;
}

/**
 * A shell command that only looks (`ls -la; git status`, see `isReadOnlyChain`): no more against "do not modify" than
 * the `read` and `grep` tools. PowerShell, and a background command on Windows, are read as PowerShell.
 */
function readOnlyShell(toolName: string, input: Readonly<Record<string, unknown>>, cwd: string): boolean {
	if (!isShellTool(toolName) && toolName !== "bg_start") return false;
	const powershell = toolName === "powershell" || (toolName === "bg_start" && process.platform === "win32");
	return (
		typeof input.command === "string" &&
		isReadOnlyChain(input.command, powershell, cwd, shellStart(toolName, input, cwd))
	);
}

/**
 * Keeps the user's hard constraints, not just shows them: a call that changes
 * something is checked against every constraint in the task frame before it
 * runs. The block reason is the user's own sentence.
 *
 * The standing rules of the project are checked the same way (`runtime.standingRules`): lessons in the user's word
 * that recalling was not enough for. They come from earlier sessions, so a call stopped by one is told which lesson it
 * was and how the user takes it away.
 */
export function registerConstraints(runtime: KyrnRuntime): (() => void) | undefined {
	const options = runtime.options("constraints", {
		enabled: true,
		maxConstraints: 6,
		/** Standing rules checked beside the task's constraints, the most recently confirmed first. 0 checks none. */
		maxStanding: 4,
		waitMs: 5000,
		/** Read-only shell commands are not checked, as reading tools are not. */
		skipReadOnly: true,
	});
	if (!options.enabled) return;
	const matchedCalls = new WeakMap<ToolCallEvent, NonNullable<KyrnRuntime["framePermissionOnce"]>>();

	runtime.pi.on(
		"tool_call",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			if (!MUTATING.has(event.toolName)) return undefined;
			if (options.skipReadOnly && readOnlyShell(event.toolName, event.input, ctx.cwd)) return undefined;
			// The newest constraints are the ones a user is most likely to see broken.
			const active = runtime.frame?.constraints ?? [];
			const framed = active.slice(-options.maxConstraints).map((entry) => entry.text);
			const grant = runtime.framePermissionOnce;
			const target =
				grant?.turn === runtime.userTurns
					? active.find(({ text }) => constraintId(text) === grant.id)?.text
					: undefined;
			// A targeted grant remains one-use even if its recurring rule falls outside the usual shortlist.
			if (target && !framed.includes(target)) framed.push(target);
			const standing = (runtime.standingRules?.(ctx.cwd) ?? []).slice(0, Math.max(0, options.maxStanding));
			const constraints = [...framed, ...standing.map((rule) => rule.text)];
			const mode = runtime.mode(toolConstraint.id);
			if (constraints.length === 0 || mode === "off") return undefined;
			const input = constraintInput(
				event.toolName,
				event.input,
				constraints,
				grant && target ? { index: framed.indexOf(target), userMessage: grant.userMessage } : undefined,
			);
			// Shadow records what it would have stopped; only an active verdict is worth holding the call for.
			if (mode !== "active") {
				void runtime.engine.decide(toolConstraint, input).catch(() => {});
				return undefined;
			}

			const decision = await within(
				runtime.engine.decide(toolConstraint, input, { signal: ctx.signal }),
				options.waitMs,
			);
			// Shadow records what it would have stopped. Only an active, judged verdict stops a call.
			if (!decision || decision.mode !== "active" || decision.source !== "judge") return undefined;
			// A withdrawal may land while this call is judged. Never cite a frame rule the user already removed.
			const brokenIndexes = decision.outcome.broken.filter(
				(index) => index >= framed.length || runtime.frame?.constraints.some(({ text }) => text === framed[index]),
			);
			if (
				grant &&
				target &&
				input.permission &&
				decision.outcome.matchesOnce &&
				readWhole(decision) &&
				runtime.frame?.constraints.some(({ text }) => text === target)
			) {
				const index = input.permission.index;
				if (
					runtime.framePermissionOnce === grant &&
					brokenIndexes.includes(index) &&
					brokenIndexes.every((broken) => framed[broken] === target)
				) {
					matchedCalls.set(event, grant);
					return undefined;
				}
			}
			const broken = brokenIndexes.map((index) => constraints[index]).filter(Boolean);
			if (broken.length === 0) return undefined;
			runtime.present("constraint.blocked", { toolName: event.toolName, constraints: broken });
			// A rule from an earlier session is named, so the user can find it and take it away.
			const frameIds = brokenIndexes
				.filter((index) => index < framed.length)
				.map((index) => constraintId(framed[index]).slice(0, 8));
			const inFrame = frameIds.length
				? ` The user can inspect ${frameIds.join(", ")} with /frame or withdraw a rule with /frame remove <id>.`
				: "";
			const rules = brokenIndexes.flatMap((index) => standing[index - framed.length] ?? []);
			const kept =
				rules.length > 0
					? ` ${rules.length === 1 ? "It is a standing rule" : "These are standing rules"} from an earlier session (${rules.map((rule) => `lesson ${rule.id.slice(0, 8)}`).join(", ")}; the user removes one with /forget).`
					: "";
			return {
				block: true,
				reason: `mu: this call goes against what the user said: ${broken.map((text) => `"${clip(text, 200)}"`).join("; ")}.${inFrame}${kept} Do it another way, or ask the user whether the instruction still holds.`,
			};
		}),
		{ final: true },
	);

	// Final handlers share one call object. If a later gate refuses it, that call never reaches this handler.
	return () =>
		runtime.pi.on(
			"tool_call",
			failOpen((event) => {
				const grant = matchedCalls.get(event);
				if (!grant) return undefined;
				matchedCalls.delete(event);
				if (!runtime.frame?.constraints.some(({ text }) => constraintId(text) === grant.id)) return undefined;
				if (runtime.framePermissionOnce !== grant)
					return { block: true, reason: "mu: the one-call exception was already used or expired." };
				runtime.framePermissionOnce = undefined;
				return undefined;
			}),
			{ final: true },
		);
}
