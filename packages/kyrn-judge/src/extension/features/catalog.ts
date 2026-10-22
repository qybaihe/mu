import { Type } from "typebox";
import type { Capability, OpenedBy } from "../../catalog/catalog.ts";
import { capabilityDisclosure } from "../../decisions/capability-disclosure.ts";
import { say } from "../../language.ts";
import { failOpen, type KyrnRuntime, userWords } from "../runtime.ts";

export const CAPABILITY_ENTRY = "kyrn.capability";
const CAPABILITY_MESSAGE = "kyrn.capabilities";

interface FindDetails {
	opened: string | undefined;
	matches: string[];
}

function line(capability: Capability): string {
	return `- ${capability.id} · ${capability.title}: ${capability.description}`;
}

/**
 * Keeps the tools of hidden capabilities out of the model's tool list, lets the
 * judge open the ones a task needs, and gives the model a way to find and open
 * the rest itself (see `../../catalog/catalog.ts`).
 *
 * With the decision `off` nothing is hidden. In `shadow` the verdicts are only
 * recorded, so capabilities stay hidden and `find_capability` is the way in.
 */
export function registerCatalog(runtime: KyrnRuntime): void {
	const options = runtime.options("catalog", { enabled: true, waitMs: 4000 });
	if (!options.enabled) return;
	const { pi, catalog } = runtime;
	const disclose = (words: string, candidates: readonly Capability[], signal?: AbortSignal) =>
		runtime.engine.decide(capabilityDisclosure, { userMessage: words, capabilities: candidates }, { signal });
	/** The question asked the moment the message arrived, alongside preflight. */
	let early: { turn: number; decision: ReturnType<typeof disclose> } | undefined;
	runtime.atTurnStart((words) => {
		if (runtime.mode(capabilityDisclosure.id) === "off") return;
		const candidates = catalog.hidden();
		if (candidates.length === 0) return;
		const decision = disclose(words, candidates);
		decision.catch(() => {});
		early = { turn: runtime.userTurns, decision };
	});
	// Only tools this feature switched off are ever switched back on: what the user pinned with --tools stays as it is.
	const withheld = new Set<string>();

	const applyLoadout = (hideNothing = false): void => {
		const hidden = hideNothing ? new Set<string>() : catalog.hiddenTools();
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
			if (runtime.mode(capabilityDisclosure.id) === "off") {
				applyLoadout(true);
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
			if (candidates.length > 0) {
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
