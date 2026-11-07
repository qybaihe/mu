import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../redact.ts";

/**
 * Skills mu drafted from runs, waiting for the user (kyrn/docs/features/procedures.md). Each draft is a folder
 * `<dir>/<name>/` with the `SKILL.md` that would be installed and a `draft.json` that says where it came from. A draft
 * is never loaded as a skill: only `accept` moves it where pi looks for skills.
 */

export interface SkillText {
	readonly name: string;
	readonly description: string;
	/** The whole file, front matter included. */
	readonly markdown: string;
}

export interface SkillDraft extends SkillText {
	/** The project the run was in. */
	readonly cwd: string;
	readonly created: string;
	/** What the user asked for in that run. */
	readonly request: string;
}

const MAX_NAME = 64;
const MAX_DESCRIPTION = 300;
const MAX_LINES = 120;

/** `Release to npm!` -> `release-to-npm`: what pi accepts as a skill's name and folder. */
export function skillName(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_NAME)
		.replace(/-+$/, "");
}

/**
 * A writer's reply read as a SKILL.md: front matter with a name and a description, then a body. Anything else is no
 * draft. The name is made safe for a folder, and secrets the environment holds are taken out of the text.
 */
export function parseSkill(reply: string, known: readonly string[] = []): SkillText | undefined {
	const text = reply
		.trim()
		.replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, "$1")
		.trim();
	const front = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	if (!front) return undefined;
	const field = (key: string) =>
		new RegExp(`^${key}:\\s*(.+)$`, "m")
			.exec(front[1])?.[1]
			.trim()
			.replace(/^["']|["']$/g, "");
	const name = skillName(field("name") ?? "");
	const description = (field("description") ?? "").slice(0, MAX_DESCRIPTION);
	const body = front[2].trim();
	if (!name || !description || !body) return undefined;
	const lines = body.split("\n").slice(0, MAX_LINES).join("\n");
	const markdown = redactSecrets(`---\nname: ${name}\ndescription: ${description}\n---\n\n${lines}\n`, known);
	return { name, description, markdown };
}

export class SkillDrafts {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	list(): SkillDraft[] {
		if (!existsSync(this.dir)) return [];
		const drafts: SkillDraft[] = [];
		for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const draft = this.get(entry.name);
			if (draft) drafts.push(draft);
		}
		return drafts.sort((a, b) => a.created.localeCompare(b.created));
	}

	get(name: string): SkillDraft | undefined {
		const folder = join(this.dir, skillName(name));
		try {
			const meta = JSON.parse(readFileSync(join(folder, "draft.json"), "utf8")) as Omit<SkillDraft, "markdown">;
			return { ...meta, markdown: readFileSync(join(folder, "SKILL.md"), "utf8") };
		} catch {
			// Not a draft, or one that is being written.
			return undefined;
		}
	}

	/** Stores a draft under a name no draft and no `taken` skill has: `release`, then `release-2`, and so on. */
	save(skill: SkillText, origin: { cwd: string; request: string }, taken: readonly string[] = []): SkillDraft {
		const used = new Set([...taken, ...this.list().map((draft) => draft.name)]);
		let name = skill.name;
		for (let n = 2; used.has(name); n++) name = `${skill.name.slice(0, MAX_NAME - 3)}-${n}`;
		const markdown = name === skill.name ? skill.markdown : skill.markdown.replace(/^name: .*$/m, `name: ${name}`);
		const meta = {
			name,
			description: skill.description,
			cwd: origin.cwd,
			request: origin.request.slice(0, 400),
			created: new Date().toISOString(),
		};
		const folder = join(this.dir, name);
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "SKILL.md"), markdown);
		writeFileSync(join(folder, "draft.json"), `${JSON.stringify(meta, null, "\t")}\n`);
		return { ...meta, markdown };
	}

	remove(name: string): boolean {
		const folder = join(this.dir, skillName(name));
		if (!existsSync(folder)) return false;
		rmSync(folder, { recursive: true, force: true });
		return true;
	}

	/**
	 * Installs a draft as `<skillsDir>/<name>/SKILL.md` and drops the draft. Refuses to replace a skill of that name:
	 * the user's own skill is never overwritten by a draft.
	 */
	accept(name: string, skillsDir: string): { readonly path: string } | { readonly error: "missing" | "exists" } {
		const draft = this.get(name);
		if (!draft) return { error: "missing" };
		const folder = join(skillsDir, draft.name);
		const path = join(folder, "SKILL.md");
		if (existsSync(path)) return { error: "exists" };
		mkdirSync(folder, { recursive: true });
		writeFileSync(path, draft.markdown);
		this.remove(draft.name);
		return { path };
	}
}
