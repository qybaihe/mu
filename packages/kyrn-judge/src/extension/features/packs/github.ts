import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { missingProgram } from "../../../packs/exec.ts";
import type { Pack, PackShared } from "./pack.ts";

/** Resolves to `<package>/skills/mu-github/SKILL.md` from both `src/` and `dist/`. */
export const GITHUB_SKILL_PATH = fileURLToPath(new URL("../../../../skills/mu-github/SKILL.md", import.meta.url));

/**
 * GitHub without GitHub tools. `gh` in the shell tool already does pull
 * requests, issues, checks, reviews, releases and the API, and one skill
 * teaches how to use it well; the skill disclosure decision keeps that skill
 * out of sessions that have nothing to do with GitHub. Opening the pack only
 * checks that `gh` is installed, so the model hears of a missing program
 * before it has run a command.
 */
export function githubPack(shared: PackShared, options: { command: string }): Pack {
	return {
		id: "pack:github",
		title: "GitHub through gh",
		description:
			"For work on GitHub: pull requests, issues, CI checks and their logs, reviews, releases, the API. Adds no tools; the mu-github skill says how to use gh.",
		tools: [],
		skills: existsSync(GITHUB_SKILL_PATH) ? [GITHUB_SKILL_PATH] : [],
		async start() {
			const result = await shared.run(options.command || "gh", ["--version"], {
				cwd: shared.cwd(),
				timeoutMs: 5000,
			});
			if (result.missing || result.code !== 0 || !/^gh version/m.test(result.stdout)) {
				throw missingProgram("gh", shared.platform);
			}
		},
	};
}
