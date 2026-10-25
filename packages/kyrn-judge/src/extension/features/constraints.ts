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
 */
export function registerConstraints(runtime: KyrnRuntime): void {
	const options = runtime.options("constraints", {
		enabled: true,
		maxConstraints: 6,
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
			const constraints = (runtime.frame?.constraints ?? [])
				.slice(-options.maxConstraints)
				.map((entry) => entry.text);
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
			return {
				block: true,
				reason: `mu: this call goes against what the user said: ${broken.map((text) => `"${clip(text, 200)}"`).join("; ")}. Do it another way, or ask the user whether the instruction still holds.`,
			};
		}),
	);
}
