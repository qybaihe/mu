import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonical } from "../../inherit/files.ts";
import { ruleLabel, rulesForFile } from "../../inherit/rules.ts";
import {
	type InheritanceScan,
	inheritanceSummary,
	readInheritState,
	scanInheritance,
	writeInheritState,
} from "../../inherit/scan.ts";
import type { InheritedRule } from "../../inherit/types.ts";
import { say } from "../../language.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";

/** Where inherited configuration and mu's own state live. Tests and embedders point these at fixtures. */
export interface HarnessRoots {
	/** The user's home: `.claude`, `.cursor`, `.codex` and `.claude.json` are looked for here. */
	readonly home: string;
	/** pi's agent directory. mu keeps its state in `<agentDir>/mu`. */
	readonly agentDir: string;
}

export const INHERIT_DEFAULTS = {
	enabled: true,
	/** Sources. */
	claude: true,
	cursor: true,
	codex: true,
	/** Kinds. */
	rules: true,
	skills: true,
	mcp: true,
	/** A rule handed over because a file matched is cut to this length; the rest stays a `read` away. */
	maxRuleChars: 4000,
	/** All always-on rules together. What does not fit is offered by description instead. */
	maxAlwaysChars: 16000,
};

const INDEX_PATH = "inherited rules, available on request";
const TOUCHING_TOOLS: readonly string[] = ["read", "edit", "write"];

/** One scan per session and project state, shared by this feature and the MCP feature. */
export function inheritedFor(
	runtime: KyrnRuntime,
	roots: HarnessRoots | undefined,
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	own?: unknown,
): InheritanceScan {
	const options = runtime.options("inherit", INHERIT_DEFAULTS);
	// Without roots nothing on disk is looked at: only mu's own servers, from the configuration that was handed over.
	if (!roots) {
		return scanInheritance({
			roots: { home: ctx.cwd, projectDir: ctx.cwd, projectTrusted: false },
			switches: { rules: false, skills: false, mcp: false },
			own,
			env: process.env,
		});
	}
	const off = !options.enabled;
	return scanInheritance({
		roots: { home: roots.home, projectDir: ctx.cwd, projectTrusted: ctx.isProjectTrusted() },
		switches: {
			claude: options.claude,
			cursor: options.cursor,
			codex: options.codex,
			rules: !off && options.rules,
			skills: !off && options.skills,
			mcp: !off && options.mcp,
		},
		own,
		ownSource: join(roots.agentDir, "mu.json"),
		// What pi loads by itself, so that no skill is offered twice.
		piSkillDirs: [join(roots.agentDir, "skills"), join(roots.home, ".agents", "skills")],
		env: process.env,
	});
}

/**
 * First run, nothing to set up: the rules and skills a user already wrote for
 * Claude Code, Cursor and Codex are in effect in mu as well. (Their MCP servers
 * are the MCP feature's business; this one only counts them for the notice.)
 *
 * Rules follow "install a lot, expose little". An always-on rule is part of
 * the prompt, the same text on every turn so the cached prefix holds. A rule
 * scoped to file patterns costs nothing until a tool touches a matching file;
 * then it rides along with that tool's result, once. After a compaction the
 * note is gone from the context, so it may be handed over once more. Rules
 * with neither are listed by description and read on demand.
 *
 * Nothing is ever written to the other tools' folders.
 */
export function registerInherit(runtime: KyrnRuntime, roots: HarnessRoots | undefined): void {
	const options = runtime.options("inherit", INHERIT_DEFAULTS);
	// Without roots the caller owns the setup (tests, embedding): no home folder is looked at.
	if (!options.enabled || !roots) return;
	const { pi } = runtime;
	let scan: InheritanceScan | undefined;
	let always: { path: string; content: string }[] = [];
	let userCount = 0;
	const delivered = new Set<string>();

	const ensureScanned = (ctx: ExtensionContext): InheritanceScan => {
		if (scan) return scan;
		scan = inheritedFor(runtime, roots, ctx, runtime.config.mcp);
		const found = scan;
		let budget = options.maxAlwaysChars;
		const onRequest: InheritedRule[] = found.rules.filter((rule) => rule.mode === "described");
		const user: typeof always = [];
		const project: typeof always = [];
		for (const rule of found.rules.filter((entry) => entry.mode === "always")) {
			if (rule.content.length > budget) {
				onRequest.push(rule);
				continue;
			}
			budget -= rule.content.length;
			(rule.scope === "user" ? user : project).push({ path: rule.path, content: rule.content });
		}
		if (onRequest.length > 0) {
			const lines = onRequest.slice(0, 40).map((rule) => `- ${rule.path}: ${clip(rule.description, 160)}`);
			project.push({
				path: INDEX_PATH,
				content: `Rules that are not loaded. Read the file when the work touches its topic:\n${lines.join("\n")}`,
			});
		}
		// The user's own rules first, the project's last: pi's files go in between, and what comes later wins an argument.
		always = [...user, ...project];
		userCount = user.length;
		runtime.present("inherit.found", {
			rules: found.rules.length,
			skills: found.skills.length,
			servers: found.servers.filter((server) => server.tool !== "mu").length,
			problems: found.problems.length,
		});
		return found;
	};

	pi.on(
		"session_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			const found = ensureScanned(ctx);
			for (const problem of found.problems) runtime.problems.push(`${problem.source}: ${problem.message}`);
			// Sub-agents inherit the same things in silence, and a notice nobody can see is not shown.
			if (!ctx.hasUI || process.env.KYRN_SWARM_DEPTH) return undefined;
			const summary = inheritanceSummary(found);
			if (!summary || readInheritState(roots.agentDir).noticeShownAt) return undefined;
			ctx.ui.notify(`${summary} /inherit lists them; features.inherit in mu.json switches sources off.`, "info");
			writeInheritState(roots.agentDir, { noticeShownAt: new Date().toISOString() });
			return undefined;
		}),
	);

	pi.on(
		"resources_discover",
		failOpen((_event, ctx) => {
			const skills = ensureScanned(ctx).skills;
			return skills.length > 0 ? { skillPaths: skills.map((skill) => skill.dir) } : undefined;
		}),
	);

	pi.on(
		"before_agent_start",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			ensureScanned(ctx);
			if (always.length === 0) return undefined;
			const files = event.systemPromptOptions.contextFiles;
			const present = new Set(files.map((file) => canonical(file.path)));
			const fresh = (entries: typeof always) => entries.filter((entry) => !present.has(canonical(entry.path)));
			event.systemPromptOptions.contextFiles = [
				...fresh(always.slice(0, userCount)),
				...files,
				...fresh(always.slice(userCount)),
			];
			return undefined;
		}),
	);

	pi.on(
		"tool_result",
		failOpen((event, ctx) => {
			if (!scan || event.isError || !TOUCHING_TOOLS.includes(event.toolName)) return undefined;
			const path = (event.input as { path?: unknown }).path;
			if (typeof path !== "string" || !path) return undefined;
			const file = isAbsolute(path) ? path : resolve(ctx.cwd, path);
			const matching = rulesForFile(scan.rules, file).filter((rule) => !delivered.has(rule.path));
			if (matching.length === 0) return undefined;
			const notes = matching.map((rule) => {
				delivered.add(rule.path);
				runtime.present("inherit.rule", { rule: ruleLabel(rule), tool: rule.tool, file: path });
				const body =
					rule.content.length > options.maxRuleChars
						? `${rule.content.slice(0, options.maxRuleChars)}\n[cut here; the whole rule: ${rule.path}]`
						: rule.content;
				return `[mu: a project rule applies to files like this one (${ruleLabel(rule)}, for ${rule.globs.join(", ")}). Follow it for the rest of the session.]\n${body}`;
			});
			return { content: [...event.content, { type: "text" as const, text: notes.join("\n\n") }] };
		}),
	);

	// The notes went out with the compacted part of the conversation: they may be given again.
	pi.on(
		"session_compact",
		failOpen(() => {
			delivered.clear();
			return undefined;
		}),
	);

	pi.registerCommand("inherit", {
		description: say({
			zh: "mu 从 Claude Code、Cursor 和 Codex 沿用了什么，各来自哪个文件",
			en: "What mu took over from Claude Code, Cursor and Codex, and from where",
		}),
		handler: async (_args, ctx) => {
			runtime.touch(ctx);
			const found = ensureScanned(ctx);
			const lines: string[] = [inheritanceSummary(found) ?? "Nothing was inherited."];
			if (found.rules.length > 0) lines.push("", "Rules:");
			for (const rule of found.rules) {
				const how = rule.mode === "glob" ? `when touching ${rule.globs.join(", ")}` : rule.mode;
				lines.push(`  ${rule.path}  (${how})`);
			}
			if (found.skills.length > 0) lines.push("", "Skills:");
			for (const skill of found.skills) lines.push(`  ${skill.name}  ${skill.dir}`);
			const servers = found.servers.filter((server) => server.tool !== "mu");
			if (servers.length > 0) lines.push("", "MCP servers (each a capability: /capabilities; once open, /mcp):");
			for (const server of servers)
				lines.push(`  ${server.name}  ${server.source}${server.scope === "project" ? "  (project)" : ""}`);
			if (found.skipped.length > 0) lines.push("", "Not used:");
			for (const entry of found.skipped) lines.push(`  ${entry.name}  ${entry.source}: ${entry.reason}`);
			if (found.problems.length > 0) lines.push("", "Problems:");
			for (const problem of found.problems) lines.push(`  ${problem.source}: ${problem.message}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
