/**
 * `mu judge mude` (see command.ts). The launcher runs this file with Node's own type stripping in a checkout, and the
 * built judge/dist/mude.js in the npm package and the desktop app: it needs nothing from node_modules either way.
 */
import { contextFromEnv, main } from "./command.ts";

main(process.argv.slice(2), contextFromEnv(), (text) => process.stdout.write(text), Boolean(process.stdout.isTTY)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`mu judge mude: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
