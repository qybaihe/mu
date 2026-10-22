import { Type } from "typebox";
import type { Decision } from "../../decision.ts";
import { type SkillCandidate, type SkillDisclosureOutcome, skillDisclosure } from "../../decisions/skill-disclosure.ts";
import { failOpen, type KyrnRuntime, userWords } from "../runtime.ts";

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

/**
 * A6: the first message of a session decides which skill descriptions the
 * system prompt carries, and that set then stays fixed so the cached prefix
 * survives. A hidden skill that becomes relevant later is announced in a
 * message instead of being put back into the prompt.
 *
 * A first verdict that arrives after the turn stopped waiting for it is applied
 * when the next turn starts (`applyLate`): one change of the prompt prefix, where
 * dropping it would carry every skill description on every request of the session.
 */
export function registerSkills(runtime: KyrnRuntime): void {
	const options = runtime.options("skills", { enabled: true, minSkills: 4, waitMs: 4000, applyLate: true });
	if (!options.enabled) return;
	const { pi } = runtime;
	const hidden = new Map<string, HiddenSkill>();
	let decided = false;
	/** The first verdict, when it came too late for its turn: the skills it was asked about, and what it said once it came. */
	let late: { skills: readonly PromptSkill[]; decision?: Decision<SkillDisclosureOutcome> } | undefined;

	const visibleOf = (all: readonly PromptSkill[]) => all.filter((skill) => !skill.disableModelInvocation);
	const disclose = (words: string, skills: readonly SkillCandidate[], signal?: AbortSignal) =>
		runtime.engine.decide(skillDisclosure, { userMessage: words, skills }, { signal });
	const candidatesToAnnounce = () => [...hidden.values()].filter((skill) => !skill.announced);
	const hide = (decision: Decision<SkillDisclosureOutcome>, skills: readonly PromptSkill[]) => {
		if (decision.source !== "judge") return;
		for (const skill of skills) {
			if (!decision.outcome.hide.includes(skill.name)) continue;
			hidden.set(skill.name, { ...skill, announced: false });
			runtime.savings.skillsHiddenChars += skill.name.length + skill.description.length + skill.filePath.length;
		}
	};
	/** Applies a late first verdict once it has come; until then the full list stays. */
	const applyLate = () => {
		if (!late?.decision) return;
		hide(late.decision, late.skills);
		late = undefined;
	};
	/** The question asked the moment the message arrived, alongside preflight: the first pick, or the later announcements. */
	let early: { turn: number; first: boolean; decision: ReturnType<typeof disclose> } | undefined;
	runtime.atTurnStart((words) => {
		if (runtime.mode(skillDisclosure.id) === "off") return;
		// Before asking which hidden skills to announce: a late first verdict decides which ones are hidden.
		applyLate();
		// The prompt's skill list before the turn is built: pi exposes it on the context where it can.
		const ctx = runtime.ctx as { getSystemPromptOptions?: () => { skills?: readonly PromptSkill[] } } | undefined;
		let all: readonly PromptSkill[] = [];
		try {
			all = ctx?.getSystemPromptOptions?.().skills ?? [];
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
			const mode = runtime.mode(skillDisclosure.id);
			if (mode === "active") applyLate();
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
			const text =
				matches.length === 0
					? "No hidden skills match."
					: matches
							.map((skill) => `- ${skill.name}: ${skill.description} (read ${skill.filePath} to use it)`)
							.join("\n");
			return { content: [{ type: "text", text }], details: { matches: matches.map((skill) => skill.name) } };
		},
	});
}
