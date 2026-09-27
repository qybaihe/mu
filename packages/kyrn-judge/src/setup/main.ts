import { constants } from "node:os";
import { join } from "node:path";
// pi itself: its sources in a checkout, its own bundle's index in the npm package (kyrn/npm/build.mjs).
import {
	applyHttpProxySettings,
	configureHttpDispatcher,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { exitWhenUnlocked } from "../auth/exit.ts";
import { muEnv, muHome } from "../naming.ts";
import { redactSecrets } from "../redact.ts";
import { readEnvEntries } from "./env-file.ts";
import { readTextFile } from "./files.ts";
import { setupLanguage, systemLocale } from "./language.ts";
import { piAccess } from "./pi-access.ts";
import { readAll, terminalPrompter } from "./terminal.ts";
import { runSetup } from "./wizard.ts";

/**
 * The entry of `mu setup` (wizard.ts), which kyrn/bin/mu.mjs starts: from its sources in a checkout, as
 * judge/dist/setup.js in the npm package. The launcher names the folders: MU_AGENT_DIR, MU_SETUP_HOME (mu's home, for
 * the backups) and MU_SETUP_ENV_FILE (the .env it reads for a session).
 */

// A key given on the command line comes in the environment, never in this process's argv (the launcher moved it
// there). It is taken out at once, so that nothing this process might start inherits it.
const givenKey = process.env.MU_SETUP_KEY || undefined;
delete process.env.MU_SETUP_KEY;

const home = process.env.MU_SETUP_HOME || muHome();
const agentDir = muEnv("AGENT_DIR") || join(home, "agent");
const envFile = process.env.MU_SETUP_ENV_FILE || join(home, ".env");
/** The files pi keeps under a lock, named once so that the exit waits for the same ones pi opens (../auth/exit.ts). */
const authPath = join(agentDir, "auth.json");
const modelsStorePath = join(agentDir, "models-store.json");
/** The environment as it came, before the .env's proxy settings are added for the check. */
const givenEnv: Readonly<Record<string, string | undefined>> = { ...process.env };

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

/**
 * The check goes out the way a session's requests do: through the proxy of the environment, else of the .env the
 * launcher hands to a session, else of pi's settings.json (httpProxy), with pi's own HTTP setup. Returns where the
 * proxy came from, for the sentences about a network that does not answer.
 */
function useSessionProxy(): string | undefined {
	const text = readTextFile(envFile);
	for (const entry of text === undefined ? [] : readEnvEntries(text)) {
		const proxyVariable = PROXY_VARIABLES.includes(entry.name) || /^no_proxy$/i.test(entry.name);
		if (proxyVariable && !(entry.name in process.env)) process.env[entry.name] = entry.value;
	}
	const named = PROXY_VARIABLES.find((name) => process.env[name]);
	let fromSettings: string | undefined;
	try {
		fromSettings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false })
			.getGlobalSettings()
			.httpProxy?.trim();
	} catch {
		// A settings.json that cannot be read has no proxy to give.
	}
	applyHttpProxySettings(fromSettings);
	configureHttpDispatcher();
	if (named) return named in givenEnv ? named : `${named}, .env`;
	return fromSettings ? "httpProxy, settings.json" : undefined;
}

async function main(): Promise<number> {
	const proxy = useSessionProxy();
	const runtime = await ModelRuntime.create({
		authPath,
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath,
		refreshOnCreate: false,
	});
	return runSetup(process.argv.slice(2), {
		io: terminalPrompter(),
		language: setupLanguage(process.env, systemLocale()),
		env: givenEnv,
		paths: { agentDir, home, envFile },
		pi: piAccess(runtime, agentDir),
		// pi's fetch now (configureHttpDispatcher installs it): through the proxy, as a session's requests go.
		fetch: globalThis.fetch,
		now: () => new Date(),
		interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
		stdinTerminal: process.stdin.isTTY === true,
		readStdin: () => readAll(),
		givenKey,
		proxy,
	});
}

let leaving = false;
const leave = (code: number): void => {
	if (leaving) return;
	leaving = true;
	// A key prompt ended by a signal must not leave the terminal in raw mode.
	if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
	void exitWhenUnlocked(code, [authPath, modelsStorePath], (exitCode) => process.exit(exitCode));
};

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
	process.on(signal, () => leave(128 + constants.signals[signal]));
main().then(leave, (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`mu setup: ${redactSecrets(message, givenKey ? [givenKey] : [])}\n`);
	leave(1);
});
