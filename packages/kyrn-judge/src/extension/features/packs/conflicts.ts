import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { Type } from "typebox";
import { UNUSABLE_TEXT } from "../../../checkpoint/git.ts";
import {
	type ConflictBlock,
	type ConflictedFile,
	describeOperation,
	diff3Of,
	listConflicted,
	looksBinary,
	parseConflicts,
	replaceBlocks,
} from "../../../packs/conflicts.ts";
import { installHint } from "../../../packs/exec.ts";
import { type Git, gitOver, lastLine, repoState } from "../../../packs/git.ts";
import { type Pack, type PackShared, text } from "./pack.ts";

/** The path with every link resolved, as git reports its root; a file that is gone resolves through its folder. */
function real(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(real(parent), basename(path));
	}
}

const NEXT =
	"Committing, and `git merge --continue` / `git rebase --continue`, are the user's to run: tell them, do not run them.";

/**
 * Conflict resolution, one file at a time. `conflicts_list` says what stopped
 * and which files wait; `conflicts_show` gives each conflict block with both
 * sides and what they started from; `conflicts_resolve` writes the resolution
 * of a file's blocks, or takes one side for the whole file, and marks the
 * file resolved. It never commits and never continues the operation.
 */
export function conflictsPack(shared: PackShared, options: { maxSideLines: number; maxChars: number }): Pack {
	const { runtime } = shared;
	const git: Git = gitOver(shared.run);

	/** The repository with a stopped operation, or why there is none. */
	const stopped = async (cwd: string) => {
		const repo = await repoState(git, cwd);
		if (!repo.ok) throw new Error(repo.reason === "no-git" ? installHint("git", shared.platform) : repo.message);
		const files = await listConflicted(git, repo.root);
		if (!repo.inProgress && files.length === 0) {
			throw new Error("No merge, rebase, cherry-pick or revert is in progress, and nothing is conflicted.");
		}
		return { repo, files };
	};

	const inRepo = (root: string, cwd: string, path: string) => {
		const inside = relative(real(root), real(isAbsolute(path) ? path : join(cwd, path))).replaceAll("\\", "/");
		if (inside.startsWith("../") || inside === "..") throw new Error(`${path} is outside the repository`);
		return inside;
	};

	const side = (label: string, lines: readonly string[]) => {
		const shown = lines.slice(0, options.maxSideLines).map((line) => `    ${line}`);
		const cut = lines.length - shown.length;
		return [
			`  ${label}${lines.length === 0 ? " (nothing)" : ""}:`,
			...shown,
			...(cut > 0 ? [`    [... ${cut} more lines]`] : []),
		];
	};

	const summary = (files: readonly ConflictedFile[]) =>
		files.length === 0
			? `All conflicts are resolved and staged. ${NEXT}`
			: `Still conflicted: ${files.map((file) => file.path).join(", ")}.`;

	return {
		id: "pack:conflicts",
		title: "Merge conflict resolution",
		description:
			"For a merge, rebase or cherry-pick that stopped on conflicts: shows each conflicted file with both sides and their common base, and resolves one file at a time.",
		tools: ["conflicts_list", "conflicts_show", "conflicts_resolve"],
		async start() {
			const probe = await git(["--version"], { cwd: shared.cwd(), timeoutMs: 5000 });
			if (probe.missing) throw new Error(installHint("git", shared.platform));
			if (probe.unusable) throw new Error(UNUSABLE_TEXT[probe.unusable]);

			runtime.pi.registerTool({
				name: "conflicts_list",
				label: "Conflicts",
				description: "What stopped (merge, rebase, cherry-pick, revert) and which files are conflicted, with how.",
				parameters: Type.Object({}),
				execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
					runtime.touch(ctx);
					const { repo, files } = await stopped(ctx.cwd);
					const lines = [
						repo.inProgress
							? await describeOperation(git, repo.root, repo.inProgress)
							: "Conflicted files without an operation in progress.",
					];
					for (const file of files) {
						let detail: string = file.kind;
						if (file.kind === "both modified" || file.kind === "both added") {
							const content = await readFile(join(repo.root, file.path)).catch(() => undefined);
							if (content && looksBinary(content)) detail += " (binary: take ours or theirs)";
							else if (content) {
								const count = parseConflicts(content.toString("utf8")).blocks.length;
								detail += `, ${count} conflict block${count === 1 ? "" : "s"}`;
							}
						}
						lines.push(`  ${file.path}: ${detail}`);
					}
					lines.push(
						files.length === 0
							? `Nothing is conflicted any more. ${NEXT}`
							: `Resolve one file at a time: conflicts_show, then conflicts_resolve. ${NEXT}`,
					);
					return { content: text(lines.join("\n")), details: { operation: repo.inProgress, files } };
				},
			});

			runtime.pi.registerTool({
				name: "conflicts_show",
				label: "Conflict blocks",
				description:
					"The conflict blocks of one file as they stand in the working tree, each with ours, theirs, and the base both started from.",
				parameters: Type.Object({ path: Type.String({ description: "The conflicted file" }) }),
				execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
					runtime.touch(ctx);
					const { repo, files } = await stopped(ctx.cwd);
					const path = inRepo(repo.root, ctx.cwd, params.path);
					const file = files.find((candidate) => candidate.path === path);
					if (!file) throw new Error(`${path} is not conflicted. ${summary(files)}`);
					if (file.kind !== "both modified" && file.kind !== "both added") {
						return {
							content: text(`${path}: ${file.kind}. Resolve it with take: "ours", "theirs" or "delete".`),
							details: { path, kind: file.kind },
						};
					}
					const content = await readFile(join(repo.root, path));
					if (looksBinary(content)) {
						return {
							content: text(`${path} is binary: resolve it with take: "ours" or "theirs".`),
							details: { path, kind: file.kind, binary: true },
						};
					}
					const parsed = parseConflicts(content.toString("utf8"));
					if (parsed.problem) throw new Error(`${path}: the conflict markers are damaged (${parsed.problem}).`);
					// The base of each block, from the three sides merged again, when the file was written without it.
					const again = parsed.blocks.some((block) => !block.base)
						? await diff3Of(git, repo.root, path)
						: undefined;
					const baseOf = (block: ConflictBlock) =>
						block.base ??
						(again?.blocks.length === parsed.blocks.length ? again.blocks[block.number - 1]?.base : undefined);
					const lines = [
						`${path}: ${parsed.blocks.length} conflict block${parsed.blocks.length === 1 ? "" : "s"}.`,
					];
					for (const block of parsed.blocks) {
						lines.push(`Block ${block.number}, lines ${block.startLine}-${block.endLine}:`);
						lines.push(...side(`ours${block.oursLabel ? ` (${block.oursLabel})` : ""}`, block.ours));
						const base = baseOf(block);
						if (base) lines.push(...side("base", base));
						lines.push(...side(`theirs${block.theirsLabel ? ` (${block.theirsLabel})` : ""}`, block.theirs));
					}
					let shown = lines.join("\n");
					if (shown.length > options.maxChars)
						shown = `${shown.slice(0, options.maxChars)}\n[... cut: read the file for the rest]`;
					return { content: text(shown), details: { path, blocks: parsed.blocks.length } };
				},
			});

			runtime.pi.registerTool({
				name: "conflicts_resolve",
				label: "Resolve conflicts",
				// It changes files: a call after it in the same batch starts once it has ended.
				executionMode: "sequential",
				description:
					"Resolve one conflicted file: give the resolved text of each of its conflict blocks, or take one side for the whole file. When no block is left the file is marked resolved (git add). Never commits.",
				parameters: Type.Object({
					path: Type.String({ description: "The conflicted file" }),
					blocks: Type.Optional(
						Type.Array(
							Type.Object({
								block: Type.Number({ description: "Block number, as conflicts_show numbers them" }),
								text: Type.String({
									description: "What replaces the whole block, markers included. Empty removes it",
								}),
							}),
						),
					),
					take: Type.Optional(
						Type.Union([Type.Literal("ours"), Type.Literal("theirs"), Type.Literal("delete")], {
							description: "Instead of blocks: keep one side of the whole file, or delete the file",
						}),
					),
				}),
				execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
					runtime.touch(ctx);
					const { repo, files } = await stopped(ctx.cwd);
					const path = inRepo(repo.root, ctx.cwd, params.path);
					const file = files.find((candidate) => candidate.path === path);
					if (!file) throw new Error(`${path} is not conflicted. ${summary(files)}`);
					const cwd = repo.root;

					if (params.take) {
						if (params.blocks?.length) throw new Error("Give either blocks or take, not both.");
						const args =
							params.take === "delete" ? ["rm", "-q", "--", path] : ["checkout", `--${params.take}`, "--", path];
						const done = await git(args, { cwd });
						if (done.code !== 0) throw new Error(`git ${args[0]} failed: ${lastLine(done.stderr)}`);
						if (params.take !== "delete") {
							const added = await git(["add", "--", path], { cwd });
							if (added.code !== 0) throw new Error(`git add failed: ${lastLine(added.stderr)}`);
						}
						const left = await listConflicted(git, cwd);
						return {
							content: text(
								`${path}: ${params.take === "delete" ? "deleted" : `took ${params.take}`}, marked resolved. ${summary(left)}`,
							),
							details: { path, resolved: true, left: left.length },
						};
					}

					const content = await readFile(join(cwd, path));
					if (looksBinary(content)) throw new Error(`${path} is binary: use take: "ours" or "theirs".`);
					const parsed = parseConflicts(content.toString("utf8"));
					if (parsed.problem)
						throw new Error(
							`${path}: the conflict markers are damaged (${parsed.problem}); edit the file instead.`,
						);
					const resolutions = new Map<number, string>();
					for (const entry of params.blocks ?? []) {
						if (!parsed.blocks.some((block) => block.number === entry.block)) {
							throw new Error(`${path} has no block ${entry.block}; it has ${parsed.blocks.length}.`);
						}
						resolutions.set(entry.block, entry.text);
					}
					if (resolutions.size === 0)
						throw new Error("Give the resolution of at least one block, or take a side.");
					const written = replaceBlocks(parsed, resolutions);
					await writeFile(join(cwd, path), written);
					const remaining = parseConflicts(written).blocks.length;
					if (remaining > 0) {
						return {
							content: text(
								`${path}: ${resolutions.size} block${resolutions.size === 1 ? "" : "s"} resolved, ${remaining} left. The file stays conflicted until none is left.`,
							),
							details: { path, resolved: false, remaining },
						};
					}
					const added = await git(["add", "--", path], { cwd });
					if (added.code !== 0) throw new Error(`git add failed: ${lastLine(added.stderr)}`);
					const left = await listConflicted(git, cwd);
					return {
						content: text(`${path}: resolved and marked resolved. ${summary(left)}`),
						details: { path, resolved: true, left: left.length },
					};
				},
			});
		},
	};
}
