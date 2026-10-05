import { constants } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Provider } from "@earendil-works/pi-ai";
// pi itself: its sources in a checkout (run with Node's own type stripping), its own bundle's index in the npm package (kyrn/npm/build.mjs).
import { defaultModelPerProvider, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { featureOptions, loadConfig } from "../config.ts";
import { antigravityProvider, geminiCliProvider } from "../google-login/providers.ts";
import { muEnv, muHome } from "../naming.ts";
import { exitWhenUnlocked } from "./exit.ts";
import { runAuth } from "./runner.ts";

/**
 * The entry of `mu auth` (see runner.ts), which kyrn/bin/mu.mjs starts: from its sources in a checkout, as
 * judge/dist/auth.js in the npm package. The agent directory is the one every part of mu uses: MU_AGENT_DIR,
 * which the launcher sets, else ~/.mu/agent.
 */
const agentDir = muEnv("AGENT_DIR") || join(muHome(), "agent");
/** The files pi keeps under a lock, named once so the exit waits for the same ones pi opens (exit.ts). */
const authPath = join(agentDir, "auth.json");
const modelsStorePath = join(agentDir, "models-store.json");
const say = (message: Readonly<Record<string, unknown>>) => process.stdout.write(`${JSON.stringify(message)}\n`);

/**
 * The Google sign-ins are mu's, offered while its googleLogin feature is on, which is read from the user's mu.json
 * the way a session reads it. Should they fail to load, pi's own sign-ins still work.
 */
function googleProviders(): Provider[] {
	try {
		const loaded = loadConfig({ dir: agentDir, env: process.env });
		if (loaded.disabled) return [];
		const options = featureOptions(loaded.config, "googleLogin", {
			enabled: true,
			geminiCli: true,
			antigravity: true,
		});
		if (!options.enabled) return [];
		return [
			...(options.geminiCli ? [geminiCliProvider()] : []),
			...(options.antigravity ? [antigravityProvider()] : []),
		];
	} catch {
		return [];
	}
}

async function main(): Promise<number> {
	const runtime = await ModelRuntime.create({
		authPath,
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath,
		refreshOnCreate: false,
	});
	return runAuth(process.argv.slice(2), {
		runtime,
		preferred: defaultModelPerProvider,
		extra: googleProviders(),
		io: {
			say,
			listen: (line, end) => {
				const lines = createInterface({ input: process.stdin });
				lines.on("line", line);
				lines.on("close", end);
			},
		},
	});
}

let leaving = false;
const leave = (code: number): void => {
	if (leaving) return;
	leaving = true;
	void exitWhenUnlocked(code, [authPath, modelsStorePath], (exitCode) => process.exit(exitCode));
};

// Exits once the answer is out: a sign-in's callback server or an idle connection must not keep the process alive.
// A run the app ends (SIGTERM, at its time limit or when it quits) ends the same way, with no lock left either.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
	process.on(signal, () => leave(128 + constants.signals[signal]));
main().then(leave, (error: unknown) => {
	say({ type: "error", message: error instanceof Error ? error.message : String(error) });
	leave(1);
});
