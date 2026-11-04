import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { readShellSettings } from "../../background/shell.ts";
import {
	type Confinement,
	confinedCommand,
	type Floor,
	type FloorReady,
	prepareFloor,
	refusalNote,
	refusedWrites,
} from "../../confine/floor.ts";
import type { KyrnRuntime } from "../runtime.ts";

export interface ConfineDeps {
	readonly platform?: NodeJS.Platform;
	/** How the floor is tried at the start. Default: running `true` inside it. */
	readonly probe?: (how: Confinement) => Promise<{ ok: true } | { ok: false; reason: string }>;
	/** Where the home folder and the temporary folders are, for tests. */
	readonly home?: string;
	readonly tmp?: readonly string[];
}

/** Bash operations that run each command inside the floor, in the shell the foreground tool would use. */
function confinedOperations(how: Confinement, shellPath: string | undefined): BashOperations {
	const local = createLocalBashOperations({ shellPath });
	const shell = getShellConfig(shellPath);
	return {
		exec: (command, cwd, options) => local.exec(confinedCommand(how, shell.shell, shell.args, command), cwd, options),
	};
}

/**
 * A result whose output shows the floor refused a write gets a line that says so: without it the model reads a bare
 * "Operation not permitted" and looks for another way to make the same change.
 */
function withRefusalNote<T extends { content: readonly { type: string; text?: string }[] }>(
	result: T,
	floor: Floor,
	cwd: string,
): T {
	const output = result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
	const note = refusalNote(refusedWrites(output, floor, cwd), floor);
	return note ? { ...result, content: [...result.content, { type: "text", text: `\n${note}` }] } : result;
}

/**
 * The write floor (`features.confine`, off by default): the agent's bash commands and background jobs run where the
 * operating system lets them write only the project, the temporary folders and package caches, with the project's
 * `.git/hooks` and `.git/config` read-only. Seatbelt on macOS, bubblewrap on Linux, nothing on Windows. A floor that
 * cannot start (no bubblewrap, user namespaces turned off, Windows) refuses every command rather than running it
 * unconfined. The judge and the permission modes ask as before: the floor bounds what an approved command can do.
 * A bash result whose output shows a refused write gets a line saying so (`refusalNote`).
 * Design and measurements: kyrn/docs/13-local-write-sandbox.md. The Nebius sandbox, when on, takes bash over again.
 */
export function registerConfine(runtime: KyrnRuntime, deps: ConfineDeps = {}): void {
	const options = runtime.options("confine", {
		enabled: false,
		/** More folders the agent's commands may write, such as a cache mu does not know. Never the home folder or ~/.mu. */
		writable: [] as string[],
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	const ready = new Map<string, Promise<FloorReady>>();
	const floor = (cwd: string): Promise<FloorReady> => {
		let found = ready.get(cwd);
		if (!found) {
			found = prepareFloor(
				cwd,
				{ platform: deps.platform, home: deps.home, tmp: deps.tmp, extra: options.writable },
				deps.probe,
			);
			ready.set(cwd, found);
		}
		return found;
	};
	runtime.floor = floor;

	const bash = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...bash,
		description: `${bash.description} Commands run in a write sandbox: they can write only to the project, the temporary folders and package caches, and the project's .git/hooks and .git/config are read-only.`,
		async execute(id, params, signal, onUpdate, ctx) {
			runtime.touch(ctx);
			const state = await floor(ctx.cwd);
			if (!state.ok)
				throw new Error(`mu: the write sandbox is on but cannot start here (${state.reason}). Nothing ran.`);
			const shell = readShellSettings(ctx.cwd, undefined, ctx.isProjectTrusted());
			const result = await createBashToolDefinition(ctx.cwd, {
				operations: confinedOperations(state.confinement, shell.shellPath),
				commandPrefix: shell.commandPrefix,
				shellPath: shell.shellPath,
			}).execute(id, params, signal, onUpdate, ctx);
			return withRefusalNote(result, state.floor, ctx.cwd);
		},
	});

	// Tried at the start, so the status line says at once whether commands will run.
	pi.on("session_start", async (_event, ctx) => {
		runtime.touch(ctx);
		const state = await floor(ctx.cwd);
		if (ctx.hasUI)
			ctx.ui.setStatus(
				"mu.confine",
				state.ok ? "Write sandbox: on" : `Write sandbox: cannot start (${state.reason}); commands are refused`,
			);
	});
}
