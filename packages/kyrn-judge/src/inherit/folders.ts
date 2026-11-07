import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** The names pi looks for in a folder, in its order: the first one there is the folder's instructions. */
const NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
/** Folders whose files are not the project's own: a dependency's instructions are not the user's. */
const FOREIGN = new Set(["node_modules", ".git"]);

export interface FolderInstructions {
	/** The instruction file. */
	readonly path: string;
	/** The folder it is for, relative to the project folder. */
	readonly folder: string;
	readonly content: string;
}

const isFile = (path: string): boolean => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

/**
 * The AGENTS.md or CLAUDE.md of each folder between the project folder and `file`, outermost first. pi loads the
 * project folder's own and those above it when the session starts; a folder below it, such as one package of a
 * monorepo, has its instructions read only when the work reaches it, as Claude Code and Codex read them. Nothing for a
 * file outside the project, or inside `node_modules` or `.git`.
 */
export function folderInstructions(projectDir: string, file: string): FolderInstructions[] {
	const below = relative(projectDir, dirname(file));
	if (!below || below.startsWith("..") || isAbsolute(below)) return [];
	const parts = below.split(sep);
	if (parts.some((part) => FOREIGN.has(part))) return [];
	const found: FolderInstructions[] = [];
	for (let depth = 1; depth <= parts.length; depth++) {
		const folder = join(projectDir, ...parts.slice(0, depth));
		const name = NAMES.find((candidate) => isFile(join(folder, candidate)));
		if (!name) continue;
		try {
			const content = readFileSync(join(folder, name), "utf8").replace(/^﻿/, "");
			if (content.trim()) found.push({ path: join(folder, name), folder: parts.slice(0, depth).join("/"), content });
		} catch {
			// Unreadable: as if it were not there.
		}
	}
	return found;
}
