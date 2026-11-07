import { realpathSync } from "node:fs";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Decision } from "../../decision.ts";
import { type SkillCandidate, type SkillDisclosureOutcome, skillDisclosure } from "../../decisions/skill-disclosure.ts";
import { inheritedNames, SKILLS_HIDDEN_ENV } from "../../swarm/brief.ts";
import { failOpen, type KyrnRuntime, userWords } from "../runtime.ts";
import type { HarnessRoots } from "./inherit.ts";
import {
	LISTED_ADDED,
	type ListedSkill,
	refreshMessage,
	resolvedPath,
	SkillRefresh,
	scanSkillFolders,
	skillAt,
	skillFolders,
} from "./skill-refresh.ts";

/** The message that tells the model which skills were installed or removed during the session. */
export const SKILLS_CHANGED_MESSAGE = "kyrn.skills-changed";
/** A label: the model read a skill's file, and how mu had shown it that skill. */
export const SKILL_READ_ENTRY = "kyrn.skill-read";

/**
 * How the model knew of the skill it read: in the system prompt's list (`prompt`); kept out of it by the first verdict
 * and never shown again (`hidden`), listed by `find_skill` (`found`), or announced by a later verdict (`announced`);
 * or installed during the session and announced then (`added`).
 */
export type SkillListing = "prompt" | "hidden" | "found" | "announced" | "added";

export interface SkillReadLabel {
	readonly name: string;
	readonly path: string;
	/** The user turn it was read in. */
	readonly turn: number;
	readonly listed: SkillListing;
	/**
	 * The ledger id of the session's first skills.disclosure verdict, when the judge answered it and the skill was among
	 * those it was asked about: the verdict that chose the prompt's list, or in shadow would have.
	 */
	readonly verdict?: string;
	/** Whether that verdict said to leave the skill out. A skill the model then read is a miss. */
	readonly hid?: boolean;
	/** The ledger id of the later verdict that announced it. */
	readonly announcedBy?: string;
}

interface HiddenSkill {
	name: string;
	description: string;
	filePath: string;
	announced: boolean;
}

interface PromptSkill extends SkillCandidate {
	readonly filePath: string;
	readonly disableModelInvocation?: boolean;
}

const listedOf = (skills: readonly PromptSkill[]): ListedSkill[] =>
	skills
		.filter((skill) => !skill.disableModelInvocation)
		.map(({ name, description, filePath }) => ({ name, description, filePath }));

/**
 * A6: the first message of a session decides which skill descriptions the
 * system prompt carries, and that set then stays fixed so the cached prefix
 * survives. A hidden skill that becomes relevant later is announced in a
 * message instead of being put back into the prompt.
 *
 * A first verdict that arrives after the turn stopped waiting for it is applied
 * when the next turn starts (`applyLate`): one change of the prompt prefix, where
 * dropping it would carry every skill description on every request of the session.
 *
 * A sub-agent takes its parent's verdict (`subagentsInherit`): the parent passes the skills it keeps out of the
 * prompt, and the sub-agent hides those and asks nothing. A sub-agent never shows a skill its parent hid.
 *
 * The question goes out the moment the message arrives, alongside preflight's (`askEarly`). The prompt's skill list
 * is not on the context of an `input` event, so it is taken from the last turn, and before the first turn from the
 * skill commands, which list the same skills. Asked only once the turn starts, it waited for preflight first: in the
 * owner's sessions that added a median 0.7 s to every message before the model started.
 *
 * pi loads the skills once, at the start and on `/reload`, so a skill installed later (`/skills accept`, a SKILL.md
 * the user or the agent wrote) is missing from the prompt, and a deleted one is still in it. With each message of the
 * user the folders pi finds skills in are read again (`refresh`), and what changed is told in one message: the prompt
 * stays as it was, and so does its cached prefix. Not in a sub-agent, whose list is loaded when it starts.
 *
 * A read of a skill's file is a label (`kyrn.skill-read`): how mu had shown the model that skill, and what the first
 * verdict said about it. A skill the judge kept out and the model read anyway is a miss, measured on real work.
 */
export function registerSkills(runtime: KyrnRuntime, roots?: HarnessRoots): void {
	const options = runtime.options("skills", {
		enabled: true,
		minSkills: 4,
		waitMs: 3000,
		applyLate: true,
		/** Sub-agents take the skills this session hides instead of asking the judge again. */
		subagentsInherit: true,
		/** Ask when the message arrives, alongside preflight, instead of after preflight's wait. */
		askEarly: true,
		/** Tell the model, with the user's next message, of skills installed or removed during the session. */
		refresh: true,
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	const hidden = new Map<string, HiddenSkill>();
	let decided = false;
	/** Inside a sub-agent: the skills its parent hides. Its first verdict, so nothing is asked. */
	const inherited = inheritedNames(SKILLS_HIDDEN_ENV);
	/** The first verdict, when it came too late for its turn: the skills it was asked about, and what it said once it came. */
	let late: { skills: readonly PromptSkill[]; decision?: Decision<SkillDisclosureOutcome> } | undefined;
	/** The first verdict, in any mode, once it came, and the skills it was asked about: what a skill's read is labelled with. */
	let first: { asked: ReadonlySet<string>; decision?: Decision<SkillDisclosureOutcome> } | undefined;
	/** The later verdicts that announced a hidden skill, by its name. */
	const announcedBy = new Map<string, string>();
	/** Hidden skills `find_skill` listed. */
	const found = new Set<string>();
	/** The prompt's whole list as pi loaded it, before this feature hid any. */
	let loaded: readonly ListedSkill[] = [];
	/** Skills installed during the session that the model was told of, by name. */
	const added = new Map<string, ListedSkill>();

	const visibleOf = (all: readonly PromptSkill[]) => all.filter((skill) => !skill.disableModelInvocation);
	const disclose = (words: string, skills: readonly SkillCandidate[], signal?: AbortSignal) =>
		runtime.engine.decide(skillDisclosure, { userMessage: words, skills }, { signal });
	const candidatesToAnnounce = () => [...hidden.values()].filter((skill) => !skill.announced);
	const hideNamed = (names: ReadonlySet<string>, skills: readonly PromptSkill[]) => {
		for (const skill of skills) {
			if (!names.has(skill.name)) continue;
			hidden.set(skill.name, { ...skill, announced: false });
			runtime.savings.skillsHiddenChars += skill.name.length + skill.description.length + skill.filePath.length;
		}
	};
	const hide = (decision: Decision<SkillDisclosureOutcome>, skills: readonly PromptSkill[]) => {
		if (decision.source === "judge") hideNamed(new Set(decision.outcome.hide), skills);
	};
	/** Applies a late first verdict once it has come; until then the full list stays. */
	const applyLate = () => {
		if (!late?.decision) return;
		hide(late.decision, late.skills);
		late = undefined;
	};
	/** The question asked the moment the message arrived, alongside preflight: the first pick, or the later announcements. */
	let early: { turn: number; first: boolean; decision: ReturnType<typeof disclose> } | undefined;
	/** The prompt's skill list as the last turn had it, before this feature hid any. */
	let seen: readonly PromptSkill[] | undefined;
	/**
	 * The prompt's skill list before the turn is built. An `input` event's context has no `getSystemPromptOptions` (a
	 * command's has), so the last turn's list stands in, and before the first turn the skill commands do: pi makes one
	 * `/skill:<name>` command of every skill it loaded, the same list the prompt starts from.
	 */
	const promptSkills = (): readonly PromptSkill[] => {
		if (seen) return seen;
		const ctx = runtime.ctx as { getSystemPromptOptions?: () => { skills?: readonly PromptSkill[] } } | undefined;
		const listed = ctx?.getSystemPromptOptions?.().skills;
		if (listed) return listed;
		return pi
			.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => ({
				name: command.name.replace(/^skill:/, ""),
				description: command.description ?? "",
				filePath: command.sourceInfo.path,
			}));
	};
	if (options.subagentsInherit) {
		runtime.skillsHidden = () => {
			if (!decided || runtime.mode(skillDisclosure.id) === "off") return undefined;
			// A first verdict still on its way is no answer yet; one that came, but waits for the next turn, is.
			if (late && !late.decision) return undefined;
			const names = new Set(hidden.keys());
			const verdict = late?.decision;
			if (late && verdict?.source === "judge") {
				for (const skill of late.skills) if (verdict.outcome.hide.includes(skill.name)) names.add(skill.name);
			}
			return [...names];
		};
	}
	// Before the handler below hides any skill from the list it reads.
	const refresh = options.refresh && roots && !process.env.KYRN_SWARM_DEPTH ? new SkillRefresh() : undefined;
	pi.on(
		"before_agent_start",
		failOpen((event, ctx) => {
			loaded = listedOf(event.systemPromptOptions.skills ?? []);
			if (!refresh || !roots || event.messageType !== "user") return undefined;
			const folders = skillFolders(roots.agentDir, roots.home, ctx.cwd, ctx.isProjectTrusted());
			const change = refresh.update(loaded, scanSkillFolders(folders));
			// What pi loaded is in the prompt now: after a `/reload` nothing is added any more.
			for (const skill of loaded) added.delete(skill.name);
			for (const skill of change.removed) {
				added.delete(skill.name);
				hidden.delete(skill.name);
			}
			for (const skill of change.added) added.set(skill.name, skill);
			// The ones the message only names: find_skill lists them, and a later verdict may announce them.
			for (const skill of change.added.slice(LISTED_ADDED)) hidden.set(skill.name, { ...skill, announced: false });
			const content = refreshMessage(change);
			if (!content) return undefined;
			return { message: { customType: SKILLS_CHANGED_MESSAGE, content, display: true } };
		}),
	);

	runtime.atTurnStart((words) => {
		if (!options.askEarly || inherited || runtime.mode(skillDisclosure.id) === "off") return;
		// Before asking which hidden skills to announce: a late first verdict decides which ones are hidden.
		applyLate();
		let all: readonly PromptSkill[] = [];
		try {
			all = promptSkills();
		} catch {
			return;
		}
		const visible = visibleOf(all);
		if (visible.length < options.minSkills) return;
		const first = !decided;
		const skills = first ? visible : runtime.userTurns > 1 ? candidatesToAnnounce() : [];
		if (skills.length === 0) return;
		const decision = disclose(words, skills);
		decision.catch(() => {});
		early = { turn: runtime.userTurns, first, decision };
	});

	pi.on(
		"before_agent_start",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			if (inherited) {
				// Whatever this process's own mode or skill count: a sub-agent shows no skill its parent hid.
				const all = event.systemPromptOptions.skills ?? [];
				if (!decided) {
					decided = true;
					hideNamed(inherited, visibleOf(all));
				}
				if (hidden.size > 0) event.systemPromptOptions.skills = all.filter((skill) => !hidden.has(skill.name));
				return undefined;
			}
			const mode = runtime.mode(skillDisclosure.id);
			if (mode === "active") applyLate();
			seen = event.systemPromptOptions.skills ?? [];
			if (event.messageType === "custom") {
				if (mode !== "off") {
					event.systemPromptOptions.skills = (event.systemPromptOptions.skills ?? []).filter(
						(skill) => !hidden.has(skill.name),
					);
				}
				return undefined;
			}
			const started = early?.turn === runtime.userTurns ? early : undefined;
			early = undefined;
			const all = event.systemPromptOptions.skills ?? [];
			const visible = visibleOf(all);
			if (mode === "off" || visible.length < options.minSkills) return undefined;

			// Shadow records the verdict; only an active one is worth holding the turn for.
			const settle = <T>(work: Promise<T>): Promise<T | undefined> => {
				if (mode === "active") return runtime.untilTurnDeadline(work, options.waitMs);
				void work.catch(() => {});
				return Promise.resolve(undefined);
			};

			if (!decided) {
				decided = true;
				runtime.progress("choosing which skills this session needs", "skills");
				const work = started?.first ? started.decision : disclose(userWords(event.prompt), visible, ctx.signal);
				const asked: NonNullable<typeof first> = { asked: new Set(visible.map((skill) => skill.name)) };
				first = asked;
				work.then(
					(settled) => {
						asked.decision = settled;
					},
					() => {},
				);
				const decision = await settle(work);
				if (decision) hide(decision, visible);
				else if (mode === "active" && options.applyLate) {
					const pending: NonNullable<typeof late> = { skills: visible };
					late = pending;
					work.then(
						(settled) => {
							pending.decision = settled;
						},
						() => {},
					);
				}
			}
			if (hidden.size === 0) return undefined;

			// Same set on every turn: the prompt prefix must not move once it has been cached.
			event.systemPromptOptions.skills = all.filter((skill) => !hidden.has(skill.name));

			if (runtime.userTurns <= 1) return undefined;
			const candidates = candidatesToAnnounce();
			if (candidates.length === 0) return undefined;
			const again = await settle(
				started && !started.first ? started.decision : disclose(userWords(event.prompt), candidates, ctx.signal),
			);
			if (again?.source !== "judge" || again.outcome.relevant.length === 0) return undefined;
			const lines: string[] = [];
			for (const name of again.outcome.relevant) {
				const skill = hidden.get(name);
				if (!skill) continue;
				skill.announced = true;
				if (again.ledgerId) announcedBy.set(name, again.ledgerId);
				lines.push(`- ${skill.name}: ${skill.description} (read ${skill.filePath} to use it)`);
			}
			return {
				message: {
					customType: "kyrn.skills",
					content: `Skills that may help with this request:\n${lines.join("\n")}`,
					display: true,
				},
			};
		}),
	);

	pi.registerTool({
		name: "find_skill",
		label: "Find skill",
		description:
			"List installed skills that are not shown in the system prompt. Use it when a task needs a capability you have no skill for.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Words to look for in skill names and descriptions" })),
		}),
		execute: async (_toolCallId, params) => {
			const words = (params.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
			const matches = [...hidden.values()].filter((skill) => {
				const text = `${skill.name} ${skill.description}`.toLowerCase();
				return words.length === 0 || words.some((word) => text.includes(word));
			});
			for (const skill of matches) found.add(skill.name);
			const text =
				matches.length === 0
					? "No hidden skills match."
					: matches
							.map((skill) => `- ${skill.name}: ${skill.description} (read ${skill.filePath} to use it)`)
							.join("\n");
			return { content: [{ type: "text", text }], details: { matches: matches.map((skill) => skill.name) } };
		},
	});

	/** Real paths, through links: a skill's own is asked again on every read of a markdown file. */
	const realPaths = new Map<string, string | undefined>();
	const realOf = (path: string): string | undefined => {
		if (!realPaths.has(path)) {
			let real: string | undefined;
			try {
				real = realpathSync(path);
			} catch {
				real = undefined;
			}
			realPaths.set(path, real);
		}
		return realPaths.get(path);
	};
	/** Each skill once per turn: the label is what was read, not how often. */
	const labelled = new Set<string>();
	pi.on(
		"tool_result",
		failOpen((event: ToolResultEvent, ctx) => {
			if (event.toolName !== "read" || event.isError) return undefined;
			const path = (event.input as { path?: unknown } | undefined)?.path;
			if (typeof path !== "string") return undefined;
			const skill = skillAt(resolvedPath(path, ctx.cwd), [...loaded, ...added.values()], realOf);
			if (!skill) return undefined;
			const key = `${runtime.userTurns}\0${skill.name}`;
			if (labelled.has(key)) return undefined;
			labelled.add(key);
			const shown = hidden.get(skill.name);
			const listed: SkillListing = added.has(skill.name)
				? "added"
				: !shown
					? "prompt"
					: shown.announced
						? "announced"
						: found.has(skill.name)
							? "found"
							: "hidden";
			const verdict = first?.decision;
			const judged = verdict?.judged && verdict.ledgerId && first?.asked.has(skill.name) ? verdict : undefined;
			const label: SkillReadLabel = {
				name: skill.name,
				path: skill.filePath,
				turn: runtime.userTurns,
				listed,
				...(judged?.ledgerId
					? { verdict: judged.ledgerId, hid: judged.judged?.hide.includes(skill.name) ?? false }
					: {}),
				...(announcedBy.has(skill.name) ? { announcedBy: announcedBy.get(skill.name) } : {}),
			};
			pi.appendEntry(SKILL_READ_ENTRY, label);
			return undefined;
		}),
	);
}
