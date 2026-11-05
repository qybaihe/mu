import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AstGrepBinary,
	findAstGrep,
	formatSearch,
	planRewrite,
	rewrite,
	runSg,
	type SgQuery,
} from "../../../packs/ast-grep.ts";
import { installHint } from "../../../packs/exec.ts";
import { type Pack, type PackShared, text } from "./pack.ts";

/** Counting stops here: a pattern like `$A` matches every node of every file. */
const COUNT_CEILING = 5000;
/** A rewrite of more places than this is a mistake more often than a plan. */
const REWRITE_CEILING = 2000;

const PATTERN =
	"Code in the target language with wildcards: $NAME is one node, $$$ARGS any number of them, e.g. console.log($$$ARGS)";
const LANGUAGE = "ast-grep language name, e.g. ts, tsx, js, python, go, rust, java, c, cpp";
const PATHS = "Files or folders to look in. Default: the working directory";

export function astGrepPack(
	shared: PackShared,
	options: { command: string; maxResults: number; maxDiffChars: number },
): Pack {
	const { runtime } = shared;
	let binary: AstGrepBinary | undefined;

	const find = async (): Promise<AstGrepBinary> => {
		binary ??= await findAstGrep(shared.run, { command: options.command || undefined, cwd: shared.cwd() });
		if (!binary) throw new Error(installHint("ast-grep", shared.platform));
		return binary;
	};

	return {
		id: "pack:ast-grep",
		title: "ast-grep structural search and rewrite",
		description:
			"For finding or changing code by its syntax rather than its text: every call of a function, an API migration, the same edit across many files.",
		tools: ["sg_search", "sg_rewrite"],
		async start() {
			await find();
			runtime.pi.registerTool({
				name: "sg_search",
				label: "ast-grep search",
				description: "Find code by its syntax with ast-grep. Returns matches grouped by file, as line: text.",
				parameters: Type.Object({
					pattern: Type.String({ description: PATTERN }),
					language: Type.String({ description: LANGUAGE }),
					paths: Type.Optional(Type.Array(Type.String(), { description: PATHS })),
					maxResults: Type.Optional(
						Type.Number({ description: `Matches to return. Default ${options.maxResults}` }),
					),
				}),
				execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
					runtime.touch(ctx);
					const keep = Math.max(1, Math.min(Math.floor(params.maxResults ?? options.maxResults), 500));
					const found = await runSg(shared.run, await find(), params, {
						cwd: ctx.cwd,
						keep,
						ceiling: COUNT_CEILING,
						signal,
					});
					if (found.problem) throw new Error(`ast-grep: ${found.problem}`);
					return {
						content: text(formatSearch(found)),
						details: { total: found.total, more: found.more, shown: found.matches.length },
					};
				},
			});
			runtime.pi.registerTool({
				name: "sg_rewrite",
				label: "ast-grep rewrite",
				// It changes files: a call after it in the same batch starts once it has ended.
				executionMode: "sequential",
				description:
					"Rewrite every match of an ast-grep pattern. A dry run that returns the diff, unless apply is true.",
				parameters: Type.Object({
					pattern: Type.String({ description: PATTERN }),
					rewrite: Type.String({ description: "The replacement. Wildcards of the pattern can be used in it" }),
					language: Type.String({ description: LANGUAGE }),
					paths: Type.Optional(Type.Array(Type.String(), { description: PATHS })),
					apply: Type.Optional(
						Type.Boolean({ description: "Write the files. Default false: only show the diff" }),
					),
				}),
				execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
					runtime.touch(ctx);
					const query: SgQuery = { ...params, rewrite: params.rewrite };
					const found = await runSg(shared.run, await find(), query, {
						cwd: ctx.cwd,
						keep: REWRITE_CEILING,
						ceiling: REWRITE_CEILING + 1,
						signal,
					});
					if (found.problem) throw new Error(`ast-grep: ${found.problem}`);
					if (found.total > REWRITE_CEILING) {
						throw new Error(
							`More than ${REWRITE_CEILING} matches. Nothing was changed: narrow the paths and rewrite in parts.`,
						);
					}
					if (found.total === 0)
						return { content: text("No matches: nothing to rewrite."), details: { edits: 0 } };
					const outcome = await rewrite(
						planRewrite(found.matches),
						{
							read: (path) => readFile(path),
							write: (path, data) => writeFile(path, data),
							locked: withFileMutationQueue,
							resolve: (file) => resolve(ctx.cwd, file),
						},
						{ apply: params.apply === true, maxDiffChars: options.maxDiffChars },
					);
					const stale =
						outcome.stale.length > 0
							? `\nLeft alone, because they changed while being rewritten (run it again): ${outcome.stale.join(", ")}`
							: "";
					const head = outcome.written
						? `Rewrote ${outcome.edits} places in ${outcome.files} files.`
						: `Dry run: ${outcome.edits} places in ${outcome.files} files would change. Call again with apply: true to write them.`;
					return {
						content: text(`${head}${stale}\n${outcome.diff}`),
						details: {
							edits: outcome.edits,
							files: outcome.files,
							written: outcome.written,
							stale: outcome.stale,
						},
					};
				},
			});
		},
	};
}
