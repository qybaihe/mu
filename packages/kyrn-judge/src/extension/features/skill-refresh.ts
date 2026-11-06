import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

/** A skill as the model is told of it. */
export interface ListedSkill {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
}

/** What changed on disk since the model was last told: skills it can now read, and skills whose files are gone. */
export interface SkillChange {
	readonly added: readonly ListedSkill[];
	readonly removed: readonly ListedSkill[];
}

/** The `.agents/skills` folders from `cwd` up to the repository's root, or to the top of the disk outside one. */
function ancestorAgentsFolders(cwd: string): string[] {
	const folders: string[] = [];
	let dir = resolve(cwd);
	while (true) {
		folders.push(join(dir, ".agents", "skills"));
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return folders;
}

/**
 * The folders pi finds skills in without being told: `<agent dir>/skills` and `~/.agents/skills`, and in a trusted
 * project `.pi/skills` and the `.agents/skills` folders up to the repository's root. `/skills accept` installs into the
 * first or the third. A skill that a setting or a package adds lives elsewhere, and only its removal is noticed.
 */
export function skillFolders(agentDir: string, home: string, cwd: string, trusted: boolean): string[] {
	const folders = [join(agentDir, "skills"), join(home, ".agents", "skills")];
	if (trusted) folders.push(resolve(cwd, CONFIG_DIR_NAME, "skills"), ...ancestorAgentsFolders(cwd));
	return [...new Set(folders)];
}

/** The skills in these folders, first name wins as in pi; the ones only a person can call are left out. */
export function scanSkillFolders(folders: readonly string[]): ListedSkill[] {
	const found = new Map<string, ListedSkill>();
	for (const dir of folders) {
		if (!existsSync(dir)) continue;
		let skills: readonly { name: string; description: string; filePath: string; disableModelInvocation: boolean }[];
		try {
			skills = loadSkillsFromDir({ dir, source: "path" }).skills;
		} catch {
			continue;
		}
		for (const skill of skills) {
			if (skill.disableModelInvocation || found.has(skill.name)) continue;
			found.set(skill.name, { name: skill.name, description: skill.description, filePath: skill.filePath });
		}
	}
	return [...found.values()];
}

/**
 * The skills the model knows of, kept up to date across a session without touching the system prompt. pi loads the
 * prompt's list once, at the start and on `/reload`; a skill installed later (`/skills accept`, a file the user or the
 * agent wrote) is not in it, and a skill deleted later still is.
 *
 * Only a file that was not on disk when the list was loaded counts as added: a skill pi left out on purpose (switched
 * off in the settings, or losing a name to another) stays out. A new list, after `/reload`, starts over.
 */
export class SkillRefresh {
	private readonly known = new Map<string, ListedSkill>();
	private seenFiles = new Set<string>();
	private loadedKey: string | undefined;

	/** The prompt's list as pi loaded it, and what the folders hold now. */
	update(loaded: readonly ListedSkill[], scanned: readonly ListedSkill[]): SkillChange {
		const key = loaded
			.map((skill) => `${skill.name}\0${skill.filePath}`)
			.sort()
			.join("\n");
		if (key !== this.loadedKey) {
			this.loadedKey = key;
			this.known.clear();
			for (const skill of loaded) this.known.set(skill.name, skill);
			this.seenFiles = new Set(scanned.map((skill) => skill.filePath));
			return { added: [], removed: [] };
		}
		const removed = [...this.known.values()].filter((skill) => !existsSync(skill.filePath));
		for (const skill of removed) {
			this.known.delete(skill.name);
			// Put back later, it is added again.
			this.seenFiles.delete(skill.filePath);
		}
		const added = scanned.filter((skill) => !this.known.has(skill.name) && !this.seenFiles.has(skill.filePath));
		for (const skill of added) {
			this.known.set(skill.name, skill);
			this.seenFiles.add(skill.filePath);
		}
		return { added, removed };
	}
}

/** Skills listed in full in one message; the rest are named, and `find_skill` lists them. */
export const LISTED_ADDED = 10;

export function refreshMessage(change: SkillChange): string | undefined {
	const parts: string[] = [];
	if (change.added.length > 0) {
		const listed = change.added.slice(0, LISTED_ADDED);
		const rest = change.added.slice(LISTED_ADDED);
		const lines = listed.map((skill) => `- ${skill.name}: ${skill.description} (read ${skill.filePath} to use it)`);
		if (rest.length > 0) {
			lines.push(`- and ${rest.length} more (${rest.map((skill) => skill.name).join(", ")}): find_skill lists them`);
		}
		parts.push(`Skills installed during this session, which the system prompt does not list:\n${lines.join("\n")}`);
	}
	if (change.removed.length > 0) {
		const names = change.removed.map((skill) => `${skill.name} (${skill.filePath})`).join(", ");
		parts.push(`Skills removed during this session: their files are gone, so do not use them: ${names}.`);
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** A path as the read tool resolves it: `~` is the home folder, a leading `@` is dropped, the rest is from `cwd`. */
export function resolvedPath(path: string, cwd: string): string {
	const bare = path.startsWith("@") ? path.slice(1) : path;
	const expanded = bare === "~" ? homedir() : bare.startsWith("~/") ? join(homedir(), bare.slice(2)) : bare;
	return resolve(cwd, expanded);
}

/**
 * The skill whose file this is, by path and then through links: `realOf` gives a file's real path, or undefined for one
 * that is not there. Only a markdown file can be one.
 */
export function skillAt<T extends ListedSkill>(
	path: string,
	skills: readonly T[],
	realOf: (path: string) => string | undefined,
): T | undefined {
	if (!path.toLowerCase().endsWith(".md")) return undefined;
	const exact = skills.find((skill) => skill.filePath === path);
	if (exact) return exact;
	const real = realOf(path);
	return real === undefined ? undefined : skills.find((skill) => realOf(skill.filePath) === real);
}
