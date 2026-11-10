import { isReadOnlyChain, shellStart } from "../../checkpoint/mutating.ts";
import { toolConstraint } from "../../decisions/tool-constraint.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";

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

/** What a call would do, short enough for a judge: where, and the beginning of what. */
export function describeCall(toolName: string, input: unknown): string {
	const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	const text = (value: unknown) => (typeof value === "string" ? value : "");
	if (isShellTool(toolName) || toolName === "bg_start") return clip(text(record.command), 500);
	const path = text(record.path) || text(record.file_path) || text(record.file);
	const body = text(record.content) || text(record.newText) || text(record.new_string) || text(record.rewrite);
	return clip(`${path}${body ? ` <- ${body}` : ""}` || JSON.stringify(record), 500);
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
export function registerConstraints(runtime: KyrnRuntime): void {
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

	runtime.pi.on(
		"tool_call",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			if (!MUTATING.has(event.toolName)) return undefined;
			if (options.skipReadOnly && readOnlyShell(event.toolName, event.input, ctx.cwd)) return undefined;
			// The newest constraints are the ones a user is most likely to see broken.
			const framed = (runtime.frame?.constraints ?? []).slice(-options.maxConstraints).map((entry) => entry.text);
			const standing = (runtime.standingRules?.(ctx.cwd) ?? []).slice(0, Math.max(0, options.maxStanding));
			const constraints = [...framed, ...standing.map((rule) => rule.text)];
			const mode = runtime.mode(toolConstraint.id);
			if (constraints.length === 0 || mode === "off") return undefined;
			const input = { toolName: event.toolName, call: describeCall(event.toolName, event.input), constraints };
			// Shadow records what it would have stopped; only an active verdict is worth holding the call for.
			if (mode !== "active") {
				void runtime.engine.decide(toolConstraint, input).catch(() => {});
				return undefined;
			}

			const decision = await Promise.race([
				runtime.engine.decide(toolConstraint, input, { signal: ctx.signal }),
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), options.waitMs)),
			]);
			// Shadow records what it would have stopped. Only an active, judged verdict stops a call.
			if (!decision || decision.mode !== "active" || decision.source !== "judge") return undefined;
			const broken = decision.outcome.broken.map((index) => constraints[index]).filter(Boolean);
			if (broken.length === 0) return undefined;
			runtime.present("constraint.blocked", { toolName: event.toolName, constraints: broken });
			// A rule from an earlier session is named, so the user can find it and take it away.
			const rules = decision.outcome.broken.flatMap((index) => standing[index - framed.length] ?? []);
			const kept =
				rules.length > 0
					? ` ${rules.length === 1 ? "It is a standing rule" : "These are standing rules"} from an earlier session (${rules.map((rule) => `lesson ${rule.id.slice(0, 8)}`).join(", ")}; the user removes one with /forget).`
					: "";
			return {
				block: true,
				reason: `mu: this call goes against what the user said: ${broken.map((text) => `"${clip(text, 200)}"`).join("; ")}.${kept} Do it another way, or ask the user whether the instruction still holds.`,
			};
		}),
		{ final: true },
	);
}
