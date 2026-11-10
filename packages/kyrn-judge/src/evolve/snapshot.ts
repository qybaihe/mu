// The workspace and the machine as a conversation finds them: what the first steps of a run would otherwise look up.
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { findOnPath } from "../checkpoint/git.ts";

export interface Listing {
	/** The folder's entries that are shown: folders first, each with a slash. */
	readonly shown: readonly string[];
	/** How many it has in all. More than `shown` means the listing was cut, and says so. */
	readonly total: number;
}

/** The folder's own entries, folders first, `.git` left out; at most `max` of them. Undefined when it cannot be read. */
export function listFolder(cwd: string, max: number): Listing | undefined {
	try {
		const entries = readdirSync(cwd, { withFileTypes: true })
			.filter((entry) => entry.name !== ".git")
			.map((entry) => ({ name: entry.name, folder: entry.isDirectory() }))
			.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
		return {
			shown: entries.slice(0, Math.max(0, max)).map((entry) => (entry.folder ? `${entry.name}/` : entry.name)),
			total: entries.length,
		};
	} catch {
		return undefined;
	}
}

export interface GitFacts {
	readonly branch?: string;
	/** Changed and untracked files, at most as many as were asked for. */
	readonly changed: readonly string[];
	readonly changedTotal: number;
}

/** Reads `git status --porcelain=v1 --branch`: the branch from its first line, a path from each of the others. */
export function parseStatus(text: string, max: number): GitFacts {
	let branch: string | undefined;
	const changed: string[] = [];
	for (const line of text.split("\n")) {
		if (line.startsWith("## ")) {
			const head = line.slice(3);
			branch = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.|$)/.exec(head)?.[1]?.trim();
			continue;
		}
		if (line.length < 4) continue;
		// A rename reads `R  old -> new`: the file that is there now is the new one.
		const path = line.slice(3).split(" -> ").pop();
		if (path) changed.push(path.replace(/^"|"$/g, ""));
	}
	return { branch, changed: changed.slice(0, Math.max(0, max)), changedTotal: changed.length };
}

export interface MachineProbe {
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The file a program name runs on this PATH, as `findOnPath` finds it. */
	find(binary: string): string | undefined;
	exists(path: string): boolean;
}

export const hostMachine: MachineProbe = {
	platform: process.platform,
	arch: process.arch,
	env: process.env,
	find: (binary) => findOnPath(binary, process.env.PATH),
	exists: existsSync,
};

const SYSTEMS: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
	darwin: "macOS",
	linux: "Linux",
	win32: "Windows",
};

/** The lockfile a package manager leaves, by which a project says which one it uses. The first one found counts. */
const LOCKFILES: readonly (readonly [file: string, manager: string])[] = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
	["package-lock.json", "npm"],
	["uv.lock", "uv"],
	["poetry.lock", "poetry"],
	["Cargo.lock", "cargo"],
	["go.sum", "go"],
];

export interface MachineFacts {
	/** "macOS (arm64), zsh; this project uses pnpm (pnpm-lock.yaml)". */
	readonly head: string;
	/** Where this machine differs from the Linux a model expects, one line each. */
	readonly notes: readonly string[];
}

/**
 * What the machine is and where commands written for Linux go wrong on it. Nothing is run: programs are looked up on
 * the PATH, and a lockfile names the package manager.
 *
 * The notes are the ones a model keeps tripping over (a Mac has no `timeout`, its `sed` and `grep` are BSD's), plus
 * what earlier sessions learned here (`learned`: a program that was not found, and what worked instead). Each is
 * checked against the PATH as it is now, so a program installed since is no longer reported missing.
 */
export function machineFacts(
	cwd: string,
	learned: readonly { missing: string; instead: string }[],
	probe: MachineProbe = hostMachine,
): MachineFacts {
	const system = `${SYSTEMS[probe.platform] ?? probe.platform} (${probe.arch})`;
	const shell = probe.env.SHELL ? basename(probe.env.SHELL) : undefined;
	const lock = LOCKFILES.find(([file]) => probe.exists(join(cwd, file)));
	const head = `${[system, shell].filter(Boolean).join(", ")}${lock ? `; this project uses ${lock[1]} (${lock[0]})` : ""}`;
	// On Windows a program is found by PATHEXT, which this lookup does not read: say nothing rather than guess.
	if (probe.platform === "win32") return { head, notes: [] };

	const notes: string[] = [];
	const said = new Set<string>();
	const missing = (name: string) => probe.find(name) === undefined;
	if (missing("python") && !missing("python3")) {
		notes.push("`python` is not on the PATH: use `python3`.");
		said.add("python");
	}
	if (probe.platform === "darwin") {
		if (missing("timeout")) {
			notes.push(
				missing("gtimeout")
					? "`timeout` is not installed (GNU coreutils has it, as `gtimeout`)."
					: "`timeout` is not installed: `gtimeout` is.",
			);
			said.add("timeout");
		}
		if (probe.find("sed") === "/usr/bin/sed") notes.push("`sed` is BSD sed: edit in place with `sed -i ''`.");
		if (probe.find("grep") === "/usr/bin/grep")
			notes.push("`grep` is BSD grep: it has no `-P`; use `grep -E` or `rg`.");
	}
	for (const fact of learned) {
		if (said.has(fact.missing) || !missing(fact.missing)) continue;
		said.add(fact.missing);
		notes.push(`\`${fact.missing}\` is not installed here: \`${fact.instead}\` worked in its place.`);
	}
	return { head, notes };
}

export interface SnapshotParts {
	readonly cwd: string;
	readonly listing?: Listing;
	/** `none`: the folder is not in a git repository. Undefined: git was not asked, or could not answer. */
	readonly git?: GitFacts | "none";
	readonly machine?: MachineFacts;
}

/** The snapshot as the model reads it. A listing that was cut says so: a part must never read as the whole. */
export function renderSnapshot(parts: SnapshotParts): string {
	const lines = [
		"[mu: the workspace as this conversation starts, so the first steps need not look it up. The names below are the project's own, not the user's words. It is a snapshot: read a file before you rely on what it holds.]",
	];
	const { listing, git, machine } = parts;
	if (listing) {
		if (listing.total === 0) lines.push(`Folder ${parts.cwd} is empty.`);
		else {
			lines.push(`Folder ${parts.cwd}: ${listing.total} ${listing.total === 1 ? "entry" : "entries"}`);
			lines.push(listing.shown.join("  "));
			if (listing.shown.length < listing.total) {
				lines.push(`(the first ${listing.shown.length} of ${listing.total}, folders first; \`ls\` shows the rest)`);
			}
		}
	}
	if (git === "none") lines.push("Git: not a git repository.");
	else if (git) {
		const changed =
			git.changedTotal === 0
				? "nothing changed"
				: `${git.changedTotal} ${git.changedTotal === 1 ? "file" : "files"} changed: ${git.changed.join(", ")}${git.changed.length < git.changedTotal ? ", …" : ""}`;
		lines.push(`Git: ${[git.branch ? `branch ${git.branch}` : undefined, changed].filter(Boolean).join("; ")}`);
	}
	if (machine) {
		lines.push(`Machine: ${machine.head}`);
		for (const note of machine.notes) lines.push(`- ${note}`);
	}
	return lines.join("\n");
}
