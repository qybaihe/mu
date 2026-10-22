import { Type } from "typebox";
import type { Capability, OpenedBy } from "../../catalog/catalog.ts";
import { capabilityDisclosure } from "../../decisions/capability-disclosure.ts";
import { say } from "../../language.ts";
import { CAPABILITIES_OPEN_ENV, inheritedNames } from "../../swarm/brief.ts";
import { failOpen, type KyrnRuntime, userWords } from "../runtime.ts";
import { isUnattended } from "./unattended.ts";

export const CAPABILITY_ENTRY = "kyrn.capability";
const CAPABILITY_MESSAGE = "kyrn.capabilities";

/**
 * Left out of the request in an unattended run (`unattended.ts`): sub-agents and their patches, the browser and its
 * skill, file location by the judge, lessons for a later session, and the ways into what is hidden. In benchmark runs
 * they were next to never called, and each one is in every request.
 */
export const UNATTENDED_HIDDEN: readonly string[] = [
	"delegate",
	"apply_patch_from",
	"browse",
	"locate",
	"remember",
	"find_skill",
	"find_capability",
	"hive",
	"mu-browser",
];

interface FindDetails {
	opened: string | undefined;
	matches: string[];
}

function line(capability: Capability): string {
	return `- ${capability.id} · ${capability.title}: ${capability.description}`;
}

/** With the catalog switched off nothing is hidden, so packs and MCP servers are there from the start of a session. */
export function hidesNothing(runtime: KyrnRuntime): boolean {
	return !runtime.options("catalog", { enabled: true }).enabled;
}

/**
 * Keeps the tools of hidden capabilities out of the model's tool list, lets the
 * judge open the ones a task needs, and gives the model a way to find and open
 * the rest itself (see `../../catalog/catalog.ts`).
 *
 * The decision is `off` by default (config.ts): nobody is asked and nothing waits, capabilities stay hidden as when
 * the judge finds none needed, and `find_capability`, `/capabilities open` and a pack's own commands are the way in.
 * In `shadow` the verdicts are only recorded, with the same result. Only `active` opens what the judge is sure of.
 * With the feature switched off (`features.catalog: false`) nothing is hidden: see `hidesNothing`.
 *
 * An unattended run (`mu --print`, json mode) asks nothing: what is hidden stays hidden. It also leaves the tools and
 * skills of `unattendedHidden` out of the request, except one the person called for by its command (`/hive …`).
 *
 * A sub-agent opens what its parent has open and asks nothing (`subagentsInherit`). What its parent keeps hidden
 * stays hidden in it, and `find_capability` is its way in, as it is the parent's.
 */
export function registerCatalog(runtime: KyrnRuntime): void {
	const options = runtime.options("catalog", {
		enabled: true,
		/** Counted from the arrival of the message, as preflight's wait is. */
		waitMs: 3000,
		/** Ask which capabilities a task needs in a `mu --print` or json run too. Off: they stay hidden, and nothing waits. */
		askUnattended: false,
		/** Tools and skills, by name, left out of the request in a `mu --print` or json run. */
		unattendedHidden: UNATTENDED_HIDDEN,
		/** Sub-agents open the capabilities this session has open instead of asking the judge again. */
		subagentsInherit: true,
	});
	if (!options.enabled) return;
	const { pi, catalog } = runtime;
	const unattendedHidden = Array.isArray(options.unattendedHidden)
		? options.unattendedHidden.filter((name): name is string => typeof name === "string")
		: [];
	/** What this run leaves out of every request: set before each run of an unattended session. */
	const leftOut = new Set<string>();
	/** Inside a sub-agent: the capabilities its parent has open. They are opened once, and nothing is asked. */
	const inherited = inheritedNames(CAPABILITIES_OPEN_ENV);
	let inheritedOpened = false;
	/**
	 * Whether to ask the judge: never with the decision off, nor in a sub-agent that took its parent's answer, nor in an
	 * unattended run unless `askUnattended` says so.
	 */
	const asks = (): boolean =>
		runtime.mode(capabilityDisclosure.id) !== "off" &&
		!inherited &&
		(options.askUnattended || !isUnattended(runtime.ctx));
	/** A turn has chosen what it opens: from then on a sub-agent can take this session's answer. */
	let chosen = false;
	if (options.subagentsInherit) {
		runtime.capabilitiesOpen = () => (chosen ? catalog.history().map((record) => record.id) : undefined);
	}
	const disclose = (words: string, candidates: readonly Capability[], signal?: AbortSignal) =>
		runtime.engine.decide(capabilityDisclosure, { userMessage: words, capabilities: candidates }, { signal });
	/** The question asked the moment the message arrived, alongside preflight. */
	let early: { turn: number; decision: ReturnType<typeof disclose> } | undefined;
	runtime.atTurnStart((words) => {
		if (!asks()) return;
		const candidates = catalog.hidden();
		if (candidates.length === 0) return;
		const decision = disclose(words, candidates);
		decision.catch(() => {});
		early = { turn: runtime.userTurns, decision };
	});
	// Only tools this feature switched off are ever switched back on: what the user pinned with --tools stays as it is.
	const withheld = new Set<string>();
	/** Left-out names the person called for by their command in this session. */
	const released = new Set<string>();

	const applyLoadout = (): void => {
		const hidden = new Set(catalog.hiddenTools());
		for (const name of leftOut) hidden.add(name);
		const active = new Set(pi.getActiveTools());
		for (const tool of hidden) {
			if (active.delete(tool)) withheld.add(tool);
		}
		for (const tool of [...withheld]) {
			if (hidden.has(tool)) continue;
			withheld.delete(tool);
			active.add(tool);
		}
		pi.setActiveTools([...active]);
	};

	const open = async (id: string, by: OpenedBy): Promise<Capability | undefined> => {
		if (!(await catalog.open(id, by, runtime.userTurns))) return undefined;
		const capability = catalog.get(id);
		// A capability the model had to ask for is a miss of the disclosure decision: the label it is measured by.
		pi.appendEntry(CAPABILITY_ENTRY, { id, by, turn: runtime.userTurns });
		runtime.present("capability.opened", { id, by, title: capability?.title, tools: capability?.tools });
		return capability;
	};

	pi.on(
		"before_agent_start",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			if (isUnattended(ctx)) {
				// A tool called for by its command stays for the session: `mu -p "/hive …"` needs its hive.
				const called = event.messageType === "user" ? /^\/([^\s:]+)/.exec(event.prompt)?.[1] : undefined;
				if (called && unattendedHidden.includes(called)) released.add(called);
				leftOut.clear();
				for (const name of unattendedHidden) if (!released.has(name)) leftOut.add(name);
				// Rebuilt from the base list before every run, so this is done on every one.
				if (event.systemPromptOptions.skills) {
					event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter(
						(skill) => !leftOut.has(skill.name),
					);
				}
			}
			if (inherited) {
				// Whatever this process's own mode: a sub-agent shows nothing its parent kept hidden.
				if (!inheritedOpened) {
					inheritedOpened = true;
					for (const id of inherited) await open(id, "parent").catch(() => undefined);
				}
				applyLoadout();
				return undefined;
			}
			if (event.messageType === "custom") {
				applyLoadout();
				return undefined;
			}
			const started = early?.turn === runtime.userTurns ? early : undefined;
			early = undefined;
			const candidates = catalog.hidden();
			const opened: Capability[] = [];
			if (candidates.length > 0 && asks()) {
				const pending = started?.decision ?? disclose(userWords(event.prompt), candidates, ctx.signal);
				// Shadow records the verdict; only an active one is worth holding the turn for.
				let decision: Awaited<typeof pending> | undefined;
				if (runtime.mode(capabilityDisclosure.id) === "active") {
					runtime.progress("choosing which capabilities this task needs", "capabilities");
					decision = await runtime.untilTurnDeadline(pending, options.waitMs);
				} else void pending.catch(() => {});
				if (decision?.source === "judge") {
					for (const id of decision.outcome.open) {
						// One that fails to start stays hidden and findable; the others still open.
						const capability = await open(id, "judge").catch(() => undefined);
						if (capability) opened.push(capability);
					}
				}
			}
			chosen = true;
			applyLoadout();
			// On the first turn the tools are simply there. Later the model has to be told its tool list grew.
			if (opened.length === 0 || runtime.userTurns <= 1) return undefined;
			return {
				message: {
					customType: CAPABILITY_MESSAGE,
					content: `Capabilities opened for this request:\n${opened.map((capability) => `${line(capability)}${capability.tools.length > 0 ? ` (tools: ${capability.tools.join(", ")})` : ""}`).join("\n")}`,
					display: true,
				},
			};
		}),
	);

	pi.registerTool({
		name: "find_capability",
		label: "Find capability",
		description:
			"List installed capabilities that are not in your tool list yet (debugger, structural search, MCP servers, review and commit helpers and more), or open one by id. Use it when a task needs a tool you do not have.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Words to look for in capability names and descriptions" })),
			open: Type.Optional(Type.String({ description: "Id of the capability to open, as listed by this tool" })),
		}),
		execute: async (_toolCallId, params) => {
			if (params.open) {
				const known = catalog.get(params.open);
				if (!known) {
					return {
						content: [
							{
								type: "text",
								text: `No capability has the id "${params.open}". Call this tool without "open" to list them.`,
							},
						],
						details: { opened: undefined, matches: [] } satisfies FindDetails as FindDetails,
					};
				}
				try {
					await open(params.open, "requested");
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `${known.title} could not be started: ${reason}` }],
						details: { opened: undefined, matches: [] } satisfies FindDetails as FindDetails,
					};
				}
				applyLoadout();
				// Read again: a capability that only learns its tools by starting (an MCP server) replaced its entry while opening.
				const tools = (catalog.get(params.open) ?? known).tools;
				return {
					content: [
						{
							type: "text",
							text:
								tools.length > 0
									? `${known.title} is open. Its tools are available from your next step: ${tools.join(", ")}`
									: `${known.title} is open. It adds no tools: ${known.description}`,
						},
					],
					details: { opened: params.open, matches: [] } satisfies FindDetails as FindDetails,
				};
			}
			const matches = catalog.search(params.query ?? "");
			const text =
				matches.length === 0
					? "No hidden capabilities match."
					: `${matches.map(line).join("\n")}\nOpen one with find_capability({ open: "<id>" }).`;
			return {
				content: [{ type: "text", text }],
				details: {
					opened: undefined,
					matches: matches.map((capability) => capability.id),
				} satisfies FindDetails as FindDetails,
			};
		},
	});

	pi.registerCommand("capabilities", {
		description: say({
			zh: "装了哪些能力、这次打开了哪些：/capabilities 查看，/capabilities open <ID> 打开",
			en: "Show what's installed and what's turned on; /capabilities open <id> turns one on",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const [verb, id] = args.trim().split(/\s+/);
			if (verb === "open" && id) {
				const capability = await open(id, "user").catch(() => undefined);
				applyLoadout();
				ctx.ui.notify(
					capability
						? `${capability.title} is now open.`
						: `"${id}" is unknown, already open, or failed to start.`,
					capability ? "info" : "warning",
				);
				return;
			}
			const history = new Map(catalog.history().map((record) => [record.id, record]));
			const rows = catalog.list().map((capability) => {
				const record = history.get(capability.id);
				const state = capability.exposure === "always" ? "always" : record ? `open (${record.by})` : "hidden";
				return `${state.padEnd(16)} ${capability.id} · ${capability.title}`;
			});
			ctx.ui.notify(rows.length > 0 ? rows.join("\n") : "No capabilities registered yet.", "info");
		},
	});
}
