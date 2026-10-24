/**
 * `mu judge mude` (see command.ts), and `mu judge model` as `model …` (models-command.ts). The launcher runs this file
 * with Node's own type stripping in a checkout, and the built judge/dist/mude.js in the npm package and the desktop
 * app: it needs nothing from node_modules either way.
 */
import { contextFromEnv, main } from "./command.ts";
import { modelMain } from "./models-command.ts";

// Ctrl-C, or the app ending an install (SIGTERM), stops a download where it is, with what it got kept for the next
// install. A command with nothing to stop ends shortly after; a second signal ends it at once.
const stop = new AbortController();
const onSignal = (signal: NodeJS.Signals) => {
	if (stop.signal.aborted) process.exit(signal === "SIGINT" ? 130 : 143);
	stop.abort();
	setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 5000).unref();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

const argv = process.argv.slice(2);
const run = argv[0] === "model" ? modelMain : main;
run(
	argv[0] === "model" ? argv.slice(1) : argv,
	{ ...contextFromEnv(), signal: stop.signal },
	(text) => process.stdout.write(text),
	Boolean(process.stdout.isTTY),
).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(
			`mu judge ${argv[0] === "model" ? "model" : "mude"}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	},
);
