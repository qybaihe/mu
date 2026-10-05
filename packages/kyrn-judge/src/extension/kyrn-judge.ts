/**
 * The mu harness layer as a pi extension.
 *
 *   pi -e packages/kyrn-judge/src/extension/kyrn-judge.ts
 *
 * Configuration lives in `<agent dir>/kyrn.json` (see `../config.ts`), with
 * environment overrides:
 *   KYRN_JUDGE            judges to use, in order: jev | laya | mock | classifier:<provider>/<model> | llm:<provider>/<model> | a name from kyrn.json; "off" disables
 *   KYRN_JUDGE_MODE       default mode of every decision: shadow (default) | active | off
 *   KYRN_LOCAL_JUDGE_URL  sidecar address for `laya` (default http://127.0.0.1:47823)
 *
 * The decision model is pluggable: features ask typed questions through one
 * engine and never know which model answers. Every handler fails open. pi
 * treats a throwing `tool_call` handler as a block, so a judge outage must
 * never surface as an exception.
 */
import { homedir } from "node:os";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Capability } from "../catalog/catalog.ts";
import { DEFAULT_CONFIG, type KyrnConfig, loadConfig } from "../config.ts";
import type { DecisionMode } from "../decision.ts";
import { Judge } from "../judge.ts";
import { FRAME_OUT_ENV } from "../swarm/brief.ts";
import type { JudgeProvider } from "../types.ts";
import { registerAdmission } from "./features/admission.ts";
import { registerBackground } from "./features/background.ts";
import { registerBoard } from "./features/board.ts";
import { registerBrowser } from "./features/browser.ts";
import { registerCatalog } from "./features/catalog.ts";
import { type CheckpointDeps, registerCheckpoint } from "./features/checkpoint.ts";
import { registerCommands } from "./features/commands.ts";
import { registerCompaction } from "./features/compaction.ts";
import { registerCompletion } from "./features/completion.ts";
import { registerConstraints } from "./features/constraints.ts";
import { registerContinuation } from "./features/continuation.ts";
import { registerForgetting } from "./features/forgetting.ts";
import { registerFrame } from "./features/frame.ts";
import { registerFreeJevNotice } from "./features/free-jev.ts";
import { registerGoal } from "./features/goal.ts";
import { registerGoogleLogin } from "./features/google-login.ts";
import { registerGuard } from "./features/guard.ts";
import { registerHive } from "./features/hive.ts";
import { registerImport } from "./features/import.ts";
import { type HarnessRoots, registerInherit } from "./features/inherit.ts";
import { registerInjection } from "./features/injection.ts";
import { registerInterjection } from "./features/interjection.ts";
import { registerJudgeItems } from "./features/judge-items.ts";
import { registerLsp } from "./features/lsp.ts";
import { registerMcp } from "./features/mcp.ts";
import { registerMemory } from "./features/memory.ts";
import { registerMonitor } from "./features/monitor.ts";
import { registerNotify } from "./features/notify.ts";
import { registerPacks } from "./features/packs.ts";
import { registerPermissions } from "./features/permissions.ts";
import { registerPreflight } from "./features/preflight.ts";
import { registerSkills } from "./features/skills.ts";
import { registerSwarm, type SwarmRunner } from "./features/swarm.ts";
import { registerSwarmChild } from "./features/swarm-child.ts";
import { registerTools } from "./features/tools.ts";
import { registerTtsr } from "./features/ttsr.ts";
import { registerWarming } from "./features/warming.ts";
import { registerWarmup } from "./features/warmup.ts";
import { registerWeb } from "./features/web.ts";
import { registerWelcome } from "./features/welcome.ts";
import type { PresentationListener } from "./presentation.ts";
import { registerLockSafeQuit } from "./quit.ts";
import { registerRejectionLog } from "./rejections.ts";
import { KyrnRuntime, recentTurnDigests } from "./runtime.ts";

export { recentTurnDigests };

export interface KyrnJudgeExtensionOptions {
	/** Native desktop/SDK observers. RPC clients receive the same events through setStatus. */
	onPresentation?: PresentationListener;
	/** A single judge backend, bypassing the configured tiers. Meant for tests and embedding. */
	provider?: JudgeProvider;
	/** Default decision mode. Overrides the config file and KYRN_JUDGE_MODE. */
	mode?: DecisionMode;
	/** Use this instead of reading kyrn.json and the environment. */
	config?: KyrnConfig;
	/** How the `delegate` tool runs a sub-agent. Defaults to a child pi process. */
	swarmRunner?: SwarmRunner;
	/** Register only these features, e.g. `["browser"]` for the browser alone on a stock pi. Default: all of them. */
	only?: readonly FeatureName[];
	/** Extra catalog entries, for embedding and tests. Whoever passes them registers their tools. */
	capabilities?: readonly Capability[];
	/**
	 * The home folder whose Claude Code, Cursor and Codex setup is inherited, and the agent directory mu keeps its
	 * state in. Default: the real ones, unless `config` or `provider` was injected, in which case no home is read.
	 */
	roots?: HarnessRoots;
	/** For tests of the checkpoint feature: how git is run. */
	checkpoint?: CheckpointDeps;
}

export type FeatureName =
	| "interjection"
	| "preflight"
	| "frame"
	| "memory"
	| "skills"
	| "catalog"
	| "guard"
	| "constraints"
	| "permissions"
	| "goal"
	| "board"
	| "ttsr"
	| "injection"
	| "admission"
	| "forgetting"
	| "compaction"
	| "monitor"
	| "lsp"
	| "completion"
	| "continuation"
	| "checkpoint"
	| "notify"
	| "warming"
	| "warmup"
	| "swarm"
	| "hive"
	| "tools"
	| "judgeItems"
	| "browser"
	| "inherit"
	| "mcp"
	| "background"
	| "web"
	| "packs"
	| "googleLogin";

export function createKyrnJudgeExtension(options: KyrnJudgeExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => registerKyrn(pi, options);
}

export default function kyrnJudgeExtension(pi: ExtensionAPI): void {
	registerKyrn(pi, {});
}

function registerKyrn(pi: ExtensionAPI, options: KyrnJudgeExtensionOptions): void {
	// The desktop app runs mu on its own Electron as Node, which only ELECTRON_RUN_AS_NODE makes it do, and every child
	// inherits that variable: an Electron app the agent starts would run as a script. Only mu's own sub-agents, which
	// run on this same binary, get it back (swarm.ts).
	delete process.env.ELECTRON_RUN_AS_NODE;
	// Whatever else is on or off: in RPC mode, a promise nothing handled is logged instead of ending mu.
	registerRejectionLog(pi);
	// An injected provider or config means the caller owns the setup: do not read the user's files.
	const loaded =
		options.config || options.provider
			? { config: options.config ?? DEFAULT_CONFIG, disabled: false, problem: undefined }
			: loadConfig({ dir: getAgentDir(), env: process.env });
	// KYRN_JUDGE=off keeps the CLI (welcome screen, commands) and the permission modes, and asks no judge: every
	// decision is off.
	const config: KyrnConfig = loaded.disabled
		? { ...loaded.config, tiers: ["mock"], modes: { default: "off" } }
		: options.mode
			? { ...loaded.config, modes: { ...loaded.config.modes, default: options.mode } }
			: loaded.config;

	const runtime = new KyrnRuntime(
		pi,
		config,
		options.provider ? new Judge({ provider: options.provider }) : undefined,
		loaded.problem,
	);
	runtime.enabled = !loaded.disabled;
	runtime.onPresentation = options.onPresentation;
	for (const capability of options.capabilities ?? []) runtime.catalog.register(capability);
	registerWelcome(runtime);
	// Whoever injected a provider or a config owns the setup, and that includes not reading the user's home folder.
	const roots: HarnessRoots | undefined =
		options.roots ?? (options.config || options.provider ? undefined : { home: homedir(), agentDir: getAgentDir() });
	if (loaded.disabled) {
		// Asking the user needs no judge, so the permission mode the user chose holds with judging off too. In Jev
		// approval, with no Jev to ask, what Jev would have decided goes to the user.
		if (!options.only || options.only.includes("permissions")) registerPermissions(runtime, roots);
		registerCommands(runtime, roots);
		registerImport(pi);
		if (roots) registerLockSafeQuit(pi, roots.agentDir);
		return;
	}

	// A sub-agent first of all listens to its parent: a wrap-up request has to be known before anything else reacts to a step.
	if (process.env.KYRN_SWARM_CONTROL)
		registerSwarmChild(runtime, process.env.KYRN_SWARM_CONTROL, process.env[FRAME_OUT_ENV]);

	// Order matters where two features share an event: interjection must see a
	// mid-run message before anything else, and preflight must set the turn's
	// gear before memory and skills read it.
	const features: readonly [FeatureName, (runtime: KyrnRuntime) => void][] = [
		["interjection", registerInterjection],
		["preflight", registerPreflight],
		// Right after preflight, which counts the turns: the frame has to be current before anything reads it.
		["frame", registerFrame],
		["memory", (shared) => registerMemory(shared, roots)],
		["skills", registerSkills],
		// Registered before the features that add capabilities, and that is fine: it reads the catalog when a turn starts.
		["catalog", registerCatalog],
		["guard", registerGuard],
		["constraints", registerConstraints],
		// After the constraint gate: a call the user ruled out is stopped before anyone is asked to allow it.
		["permissions", (shared) => registerPermissions(shared, roots)],
		// Before admission, which then archives the screened text, and before the MCP feature, whose label goes in front of it.
		["injection", registerInjection],
		["admission", registerAdmission],
		["forgetting", registerForgetting],
		["compaction", registerCompaction],
		["monitor", registerMonitor],
		["ttsr", registerTtsr],
		// Before the goal and completion checks: errors an edit introduced are said before "verify your change" is.
		["lsp", registerLsp],
		["goal", registerGoal],
		["completion", registerCompletion],
		// After the completion check and the language servers: when either sent the agent back, this one says nothing.
		["continuation", registerContinuation],
		// Reads the frame and the steps; says nothing to the model, so its place among the others does not matter.
		["board", (shared) => registerBoard(shared, roots)],
		// After the guard and the monitor: a blocked call needs no checkpoint, and the monitor's trouble is what the rewind hears.
		["checkpoint", (shared) => registerCheckpoint(shared, roots, options.checkpoint)],
		["notify", registerNotify],
		["warming", registerWarming],
		["warmup", registerWarmup],
		["swarm", (shared) => registerSwarm(shared, options.swarmRunner)],
		["hive", (shared) => registerHive(shared, options.swarmRunner)],
		["tools", registerTools],
		["judgeItems", registerJudgeItems],
		["browser", registerBrowser],
		["inherit", (shared) => registerInherit(shared, roots)],
		["mcp", (shared) => registerMcp(shared, roots)],
		["background", registerBackground],
		["web", registerWeb],
		["packs", registerPacks],
		["googleLogin", registerGoogleLogin],
	];
	for (const [name, register] of features) {
		if (!options.only || options.only.includes(name)) register(runtime);
	}
	registerFreeJevNotice(runtime, roots);
	registerCommands(runtime, roots);
	registerImport(pi);
	if (roots) registerLockSafeQuit(pi, roots.agentDir);
}
