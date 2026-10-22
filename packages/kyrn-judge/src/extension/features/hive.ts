import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEndEvent, getAgentDir, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type DeliverInput,
	hiveDeliver,
	hivePublish,
	hiveRelate,
	type PublishInput,
	type RelateInput,
} from "../../decisions/hive.ts";
import type { RoutingInput, RoutingOutcome } from "../../decisions/swarm-routing.ts";
import { Board, foldRelations, isDuplicate, type Note, overlapping } from "../../hive/board.ts";
import { hiveRequest, parseHiveArgs } from "../../hive/request.ts";
import { say } from "../../language.ts";
import { BRIEF_ENV, briefEnv, briefFor, knownLessons } from "../../swarm/brief.ts";
import {
	CHECKPOINT,
	conflictLine,
	correctionLine,
	HIVE_MESSAGE,
	lastCall,
	markOf,
	NOTES_HEADER,
} from "../../swarm/markers.ts";
import { type BeeSpec, type BoardSummary, SwarmRun } from "../../swarm/run.ts";
import { loadAgents } from "../agents.ts";
import { clip, failOpen, type KyrnRuntime, textOf, userWords } from "../runtime.ts";
import {
	announceRouting,
	compactSnapshot,
	controlSwarm,
	limitsFrom,
	permissionEnv,
	pickModel,
	ratingMatters,
	recordBeeUsage,
	registerSwarmCommand,
	renderSwarmResult,
	routeTasks,
	SWARM_LIMIT_DEFAULTS,
	type SwarmAssignment,
	type SwarmRunner,
	settledEnv,
	spawnRunner,
	streamUpdates,
	thinkingForRoute,
	uniqueNames,
} from "./swarm.ts";
import { isWrappingUp } from "./swarm-child.ts";

/** How long the last turn waits for the judge to finish with the notes that are still in flight. */
const LAST_CALL_WAIT_MS = 4000;

interface Candidate {
	text: string;
	source: string;
}

/**
 * What one step of a bee produced that could be news: what it said and, with `toolOutputs`, the beginning of what
 * its tools returned. Off by default: of 32 tool outputs put to the judge in 7 hives, none was published (2026-10).
 */
export function candidatesOf(
	message: { content?: unknown },
	toolResults: readonly { toolCallId?: string; toolName?: string; content?: unknown }[],
	options: { toolOutputs?: boolean; limit?: number } = {},
): Candidate[] {
	const limit = options.limit ?? 4;
	const candidates: Candidate[] = [];
	const said = textOf(message.content).trim();
	if (said.length >= 40) candidates.push({ text: clip(said, 700), source: "said" });
	if (!options.toolOutputs) return candidates;
	const calls = new Map<string, string>();
	if (Array.isArray(message.content)) {
		for (const block of message.content as Record<string, unknown>[]) {
			if (block?.type === "toolCall" && typeof block.id === "string") {
				calls.set(block.id, clip(`${String(block.name)} ${JSON.stringify(block.arguments ?? {})}`, 160));
			}
		}
	}
	for (const result of toolResults) {
		const text = textOf(result.content).trim();
		if (text.length < 80) continue;
		const call = (result.toolCallId && calls.get(result.toolCallId)) || result.toolName || "tool";
		candidates.push({ text: text.slice(0, 600), source: call });
	}
	return candidates.slice(0, limit);
}

/** What waits for a bee until its next working step. */
type InboxItem =
	| { kind: "note"; note: Note; score: number }
	| { kind: "correction"; earlier: Note; later: Note; score: number }
	| { kind: "conflict"; a: Note; b: Note; score: number };

/**
 * Inside a bee. After every step the judge decides whether what the bee said
 * or saw is news for the hive (H1), what each new note does to the earlier
 * ones it speaks about (H3), and which of the others' news matters to this
 * bee (H2). The bee's own model spends nothing on any of it.
 */
function registerMember(runtime: KyrnRuntime, dir: string): void {
	const options = runtime.options("hive", {
		enabled: true,
		maxNotesPerBee: 12,
		maxDeliveriesPerBee: 10,
		/** Earlier notes a new one is held against, at most: the ones sharing the most words with it. */
		maxRelatedPerNote: 2,
		/** A note a bee starts with FOUND: or DEAD END:, as the checkpoint asks, is published without asking the judge. */
		publishMarked: true,
		/** What a bee's tools returned is also put to the judge as a possible note, not only what the bee said. */
		publishToolOutputs: false,
		/** Tool calls a bee may make in silence before it is asked what it has found. 0 turns checkpoints off. */
		checkpointEvery: 4,
		/** Notes that arrive while a bee writes its report get one hearing: a corrected report, or "NO CHANGE". */
		lastCall: true,
	});
	const me = process.env.KYRN_HIVE_BEE ?? "bee";
	const goal = process.env.KYRN_HIVE_GOAL ?? "";
	const focus = process.env.KYRN_HIVE_FOCUS ?? "";
	const board = new Board(dir);
	const seen = new Set<string>();
	/** Notes this bee stands on: its own, and the others' it was handed or is about to be. A correction to one of them reaches it by rule. */
	const holds = new Set<string>();
	const delivered = new Set<string>();
	let posted = 0;
	let received = 0;
	let silentCalls = 0;
	/** What the judge accepted for this bee that it has not been shown yet. */
	let inbox: InboxItem[] = [];
	let lastCalled = false;
	const name = (bee: string) => (bee === me ? "you" : bee);
	/** Empties the inbox into lines for the bee, and records each note as delivered: only now has it reached anyone. */
	const takeInbox = (): string[] => {
		const replaced = new Set(
			board.relations().flatMap((row) => (row.relation === "supersedes" ? [row.earlier] : [])),
		);
		const handed = (note: Note, score: number) => {
			if (note.bee !== me && !delivered.has(note.id)) {
				delivered.add(note.id);
				board.delivered({ note: note.id, to: me, score });
			}
			holds.add(note.id);
		};
		const lines: string[] = [];
		for (const item of inbox.splice(0)) {
			if (item.kind === "note") {
				// Replaced while it waited: the correction goes out in its place, in this same batch or an earlier one.
				if (replaced.has(item.note.id)) {
					board.log({ gate: "withheld", to: me, note: item.note.id, why: "superseded" });
					continue;
				}
				handed(item.note, item.score);
				lines.push(`- ${item.note.bee} (${item.note.kind.replace("_", " ")}): ${item.note.text}`);
			} else if (item.kind === "correction") {
				handed(item.later, item.score);
				lines.push(
					correctionLine(name(item.earlier.bee), clip(item.earlier.text, 120), item.later.bee, item.later.text),
				);
			} else {
				handed(item.a, item.score);
				handed(item.b, item.score);
				lines.push(
					conflictLine(name(item.a.bee), clip(item.a.text, 240), name(item.b.bee), clip(item.b.text, 240)),
				);
			}
		}
		return lines;
	};
	// Steps are judged in order and off the bee's critical path: it never waits for the hive.
	let queue: Promise<void> = Promise.resolve();

	/** H3: what the notes just posted do to the earlier notes they share words with. */
	const relate = async (later: readonly Note[], known: readonly Note[], signal: AbortSignal | undefined) => {
		const pairs = later.flatMap((note) =>
			overlapping(note.text, known, { limit: options.maxRelatedPerNote }).map((earlier) => ({ note, earlier })),
		);
		if (pairs.length === 0) return;
		const inputs: RelateInput[] = pairs.map(({ note, earlier }) => ({
			goal,
			earlier: { bee: earlier.bee, kind: earlier.kind, text: earlier.text },
			later: { bee: note.bee, kind: note.kind, text: note.text },
		}));
		const verdicts = await runtime.engine.decideMany(hiveRelate, inputs, { signal });
		pairs.forEach(({ note, earlier }, at) => {
			const { relation, score } = verdicts[at].outcome;
			// The judge's own reading before the bar, "none" included: what calibrating the bar is done from.
			const answer = verdicts[at].answers?.relation;
			board.log({
				gate: "relate",
				by: me,
				later: note.id,
				earlier: earlier.id,
				relation,
				score,
				...(answer?.type === "choice"
					? { choice: answer.choice, ...(answer.probabilities ? { p: answer.probabilities } : {}) }
					: {}),
				reason: verdicts[at].reason,
			});
			if (relation)
				board.relate({
					later: note.id,
					earlier: earlier.id,
					relation,
					score,
					by: me,
					at: new Date().toISOString(),
				});
		});
	};

	/**
	 * Corrections and disputes reach a bee by rule, on top of the delivery cap: they are about notes it already
	 * stands on. The judge is not asked whether a bee wants to hear that what it was told no longer holds.
	 */
	const correct = (): void => {
		const rows = board.freshRelations();
		if (rows.length === 0) return;
		const byId = new Map(board.all().map((note) => [note.id, note]));
		const without = (...ids: string[]) => {
			inbox = inbox.filter((item) => item.kind !== "note" || !ids.includes(item.note.id));
		};
		for (const row of rows) {
			const earlier = byId.get(row.earlier);
			const later = byId.get(row.later);
			if (!earlier || !later) continue;
			if (row.relation === "supersedes" && later.bee !== me && holds.has(earlier.id)) {
				seen.add(later.id);
				// The correction carries the later note's words: it is not delivered a second time on its own.
				without(later.id);
				inbox.push({ kind: "correction", earlier, later, score: row.score });
				board.log({ gate: "correct", to: me, note: later.id, replaces: earlier.id, from: later.bee });
			} else if (row.relation === "contradicts" && (holds.has(earlier.id) || holds.has(later.id))) {
				seen.add(later.id);
				without(earlier.id, later.id);
				inbox.push({ kind: "conflict", a: earlier, b: later, score: row.score });
				board.log({ gate: "dispute", to: me, notes: [earlier.id, later.id] });
			}
		}
	};

	const step = async (candidates: Candidate[], signal: AbortSignal | undefined): Promise<void> => {
		const known = board.all();
		const novel = candidates.filter((candidate) => !isDuplicate(candidate.text, known));
		const mine: Note[] = [];
		if (novel.length > 0 && posted < options.maxNotesPerBee) {
			// What the bee marked as the checkpoint asks is news by its own word: the judge is asked about the rest.
			// In 7 hives every note the judge published was a marked one, and it held back 14 of 45 marked findings.
			const marks = novel.map((candidate) =>
				options.publishMarked && candidate.source === "said" ? markOf(candidate.text) : undefined,
			);
			const asked = novel.filter((_, at) => !marks[at]);
			const inputs: PublishInput[] = asked.map((candidate) => ({
				goal,
				focus,
				note: candidate.text,
				source: candidate.source,
			}));
			const judged = inputs.length > 0 ? await runtime.engine.decideMany(hivePublish, inputs, { signal }) : [];
			const verdicts = novel.map((candidate, at) => {
				const kind = marks[at];
				if (kind) return { outcome: { publish: true, kind, score: 1 }, reason: "marked" };
				return judged[asked.indexOf(candidate)];
			});
			verdicts.forEach((verdict, at) => {
				const { publish, kind, score } = verdict.outcome;
				board.log({
					gate: "publish",
					bee: me,
					source: novel[at].source,
					head: clip(novel[at].text, 100),
					text: novel[at].text,
					publish,
					kind,
					score,
					reason: verdict.reason,
				});
				if (!publish || !kind || posted >= options.maxNotesPerBee) return;
				posted++;
				const id = randomUUID().slice(0, 8);
				seen.add(id);
				holds.add(id);
				const note: Note = {
					id,
					bee: me,
					kind,
					score,
					text: novel[at].text,
					source: novel[at].source,
					at: new Date().toISOString(),
				};
				board.post(note);
				mine.push(note);
			});
		}
		if (mine.length > 0) await relate(mine, known, signal);

		const news = board.fresh().filter((note) => note.bee !== me && !seen.has(note.id));
		for (const note of news) seen.add(note.id);
		if (news.length > 0 && received < options.maxDeliveriesPerBee) {
			const inputs: DeliverInput[] = news.map((note) => ({
				focus,
				note: note.text,
				kind: note.kind,
				from: note.bee,
			}));
			const verdicts = await runtime.engine.decideMany(hiveDeliver, inputs, { signal });
			news.forEach((note, at) => {
				const { deliver, score } = verdicts[at].outcome;
				board.log({
					gate: "deliver",
					to: me,
					from: note.bee,
					note: note.id,
					deliver,
					score,
					reason: verdicts[at].reason,
				});
			});
			const accepted = news
				.filter((_, at) => verdicts[at].outcome.deliver)
				.slice(0, options.maxDeliveriesPerBee - received);
			received += accepted.length;
			// Not handed over here: a note that lands while the bee is writing its report would wake it up again
			// after it had finished, and its last words would replace the report. It gets them at its next step.
			for (const note of accepted) {
				inbox.push({ kind: "note", note, score: verdicts[news.indexOf(note)]?.outcome.score ?? 0 });
				holds.add(note.id);
			}
		}
		correct();
	};

	const tell = (content: string) =>
		runtime.pi.sendMessage({ customType: HIVE_MESSAGE, content, display: true }, { deliverAs: "steer" });

	runtime.pi.on(
		"turn_end",
		failOpen<TurnEndEvent, undefined>(async (event, ctx) => {
			runtime.touch(ctx);
			const candidates = candidatesOf(event.message as { content?: unknown }, event.toolResults, {
				toolOutputs: options.publishToolOutputs,
			});
			queue = queue.then(() => step(candidates, ctx.signal)).catch(() => undefined);
			// Told to wrap up: nothing more goes in, it only has to get its report out.
			if (isWrappingUp(runtime)) return undefined;

			if (event.toolResults.length > 0) {
				// The bee goes on anyway, so what is waiting for it costs no extra turn. All of it goes in one message:
				// a bee takes one queued message per step, so a second would wait a step, and when that step is the
				// report it would wake the bee up again after it had finished.
				const told: string[] = [];
				if (inbox.length > 0) {
					const lines = takeInbox();
					if (lines.length > 0) told.push(`${NOTES_HEADER}\n${lines.join("\n")}`);
				}
				const spoke = candidates.some((candidate) => candidate.source === "said");
				silentCalls = spoke ? 0 : silentCalls + event.toolResults.length;
				if (options.checkpointEvery > 0 && silentCalls >= options.checkpointEvery) {
					silentCalls = 0;
					told.push(CHECKPOINT);
				}
				if (told.length > 0) tell(told.join("\n\n"));
				return undefined;
			}

			// The last turn: this message is the report. Late notes get one deliberate hearing, never an open-ended one.
			if (lastCalled || !options.lastCall) return undefined;
			await Promise.race([queue, new Promise((resolve) => setTimeout(resolve, LAST_CALL_WAIT_MS))]);
			if (inbox.length === 0) return undefined;
			const lines = takeInbox();
			if (lines.length === 0) return undefined;
			lastCalled = true;
			tell(lastCall(lines));
			return undefined;
		}),
	);

	// A bee in print mode exits right after its last turn: give what it found at the end a moment to reach the board.
	runtime.pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>(async () => {
			await Promise.race([queue, new Promise((resolve) => setTimeout(resolve, 6000))]);
			return undefined;
		}),
	);
}

/**
 * H, the hive: several bees on ONE hard problem, each from its own angle and
 * in its own context window, with a shared board between them that only the
 * judge writes to and reads from on their behalf.
 *
 * `delegate` is for work that splits into independent parts. The hive is for
 * work that does not: a bug nobody understands, a design with unknowns,
 * where what one line of inquiry turns up changes what the others should do.
 */
export function registerHive(runtime: KyrnRuntime, runner: SwarmRunner = spawnRunner): void {
	const options = runtime.options("hive", {
		enabled: true,
		maxBees: 6,
		concurrency: 4,
		/** The role of a bee the caller named none for. */
		defaultAgent: "investigator",
		/** Cheapest to strongest; empty means the swarm ladder, and failing that the session's model. */
		models: [] as string[],
		/** Verifiers the hive may add for disputes nobody settles (0 turns it off), and how long a dispute may stand first. */
		verifyConflicts: 1,
		verifyAfterSeconds: 60,
		...SWARM_LIMIT_DEFAULTS,
	});
	if (!options.enabled) return;
	const memberDir = process.env.KYRN_HIVE_DIR;
	if (memberDir) {
		registerMember(runtime, memberDir);
		return;
	}
	// Only the top-level session may start a hive.
	if (process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;

	pi.registerTool({
		name: "hive",
		label: "Hive",
		description:
			"Put several investigators on ONE hard problem at once, each from a different angle (reproduce it, read the code involved, search history, search the web, test a hypothesis). Unlike delegate, they are not isolated: a fast judgment model watches every step and passes what one of them finds to the others it matters to, so they build on each other instead of repeating each other. Use it when a problem resists a direct attempt or its cause is unknown. Investigators do not edit files; you get their reports and the shared findings, and you make the change.",
		parameters: Type.Object({
			goal: Type.String({ description: "The problem, stated completely: symptoms, what was tried, constraints" }),
			bees: Type.Array(
				Type.Object({
					name: Type.String({ description: "Short name, e.g. repro, history, auth-code" }),
					focus: Type.String({ description: "The angle this one takes, self-contained" }),
					agent: Type.Optional(
						Type.String({ description: "Role name. Default: investigator (read-only plus bash and browse)" }),
					),
				}),
				{ minItems: 2 },
			),
		}),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			runtime.touch(ctx);
			const asked = params.bees.slice(0, options.maxBees);
			const names = uniqueNames(asked.map((bee) => bee.name));
			const bees = asked.map((bee, at) => ({ ...bee, name: names[at] }));
			announceRouting(onUpdate, bees.length);
			const dir = join(tmpdir(), `kyrn-hive-${randomUUID().slice(0, 8)}`);
			const board = new Board(dir);
			const roles = new Map(loadAgents(join(getAgentDir(), "agents")).map((agent) => [agent.name, agent]));
			const swarm = runtime.options("swarm", { enabled: true, models: [] as string[] });
			const ladder = options.models.length > 0 ? options.models : swarm.models;
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const sessionThinking = pi.getThinkingLevel();
			const roleOf = (agentName: string | undefined) =>
				roles.get(agentName ?? "") ?? roles.get(options.defaultAgent);
			/** What the judge is asked about a bee: only how hard its angle is, and only when that can matter. */
			const routing = (task: string, agentName: string | undefined): RoutingInput => ({
				task: clip(task, 600),
				rate: ratingMatters(ladder, [roleOf(agentName)]),
			});
			const placement = (verdict: RoutingOutcome, agentName: string | undefined): SwarmAssignment => {
				const agent = roleOf(agentName);
				const model = agent?.model ?? pickModel(ladder, verdict.strength) ?? current;
				return {
					agent,
					model,
					// As for delegate: a bee on the session's model keeps the session's thinking, so its first call reads
					// the parent's prompt cache.
					thinking: thinkingForRoute({
						pinned: agent?.thinking,
						model,
						sessionModel: current,
						sessionThinking,
						judged: verdict.thinking,
					}),
					routedBy: agentName && roles.has(agentName) ? "caller" : "default",
				};
			};

			const tasks = bees.map((bee) => `${bee.focus} (part of: ${params.goal})`);
			// What this project's lessons say about each angle, asked alongside the routing.
			const lessons = runtime.knownLessons?.(tasks, signal);
			const routes = await routeTasks(
				runtime,
				tasks.map((task, at) => routing(task, bees[at].agent)),
				signal,
			);
			const known = (await lessons?.catch(() => undefined)) ?? [];
			interface Member {
				name: string;
				focus: string;
				assignment: SwarmAssignment;
				lessons?: readonly string[];
			}
			const members: Member[] = bees.map((bee, at) => ({
				name: bee.name,
				focus: bee.focus,
				assignment: placement(routes[at], bee.agent),
				lessons: known[at],
			}));
			const specFor = (member: Member, all: readonly Member[]): BeeSpec<SwarmAssignment> => {
				const others = all.filter((other) => other !== member).map((other) => `- ${other.name}: ${other.focus}`);
				const lessonLines = knownLessons(member.lessons);
				const instructions = [
					`You are "${member.name}", one of ${all.length} investigators working on the same problem at the same time.`,
					`The problem:\n${params.goal}`,
					`Your angle: ${member.focus}`,
					`The others, so you do not repeat them:\n${others.join("\n")}`,
					...(lessonLines.length > 0 ? [lessonLines.join("\n")] : []),
				].join("\n\n");
				return {
					name: member.name,
					task: { title: member.name, instructions },
					assignment: member.assignment,
					role: member.assignment.agent?.name,
					model: member.assignment.model,
					thinking: member.assignment.thinking,
					env: {
						...permissionEnv(runtime),
						// The skills and capabilities this session settled on: the bee does not ask again.
						...settledEnv(runtime),
						// The angle is the bee's goal; what the user asked for is what its calls are weighed against.
						[BRIEF_ENV]: briefEnv(
							briefFor(
								{ title: member.name, instructions: `${member.focus} (part of: ${params.goal})` },
								runtime.frame,
								userWords(runtime.turn.userMessage),
							),
						),
						KYRN_HIVE_DIR: dir,
						KYRN_HIVE_BEE: member.name,
						KYRN_HIVE_GOAL: clip(params.goal, 600),
						KYRN_HIVE_FOCUS: clip(member.focus, 400),
					},
				};
			};

			const run = new SwarmRun<SwarmAssignment>({
				kind: "hive",
				title: clip(params.goal, 120),
				dir,
				limits: limitsFrom(options),
				bees: members.map((member) => specFor(member, members)),
			});
			// The board is part of the live view: what the judge let through, whom it reached, how much it has ruled on.
			run.board = () => summarizeBoard(board);
			streamUpdates(run, onUpdate);
			recordBeeUsage(runtime, run);

			// A dispute nobody settles gets a verifier of its own, while the hive still runs: one more bee whose
			// angle is the two notes. What it finds goes through the same gates, so the losing side is corrected
			// for everyone who heard it. The judge never picks a side itself.
			const firstSeen = new Map<string, number>();
			const verified = new Set<string>();
			let verifiers = 0;
			let spawning = false;
			const verify = async (a: Note, b: Note): Promise<void> => {
				spawning = true;
				try {
					const wanted = `verify-${verifiers + 1}`;
					const name = uniqueNames([...members.map((member) => member.name), wanted]).at(-1) ?? wanted;
					const focus = `Two investigators disagree. ${a.bee} reported: "${clip(a.text, 400)}" ${b.bee} reported: "${clip(b.text, 400)}" Find out which holds, or that both do under different conditions, with the command, file and line that shows it, and state it as FOUND: in your report.`;
					const [route] = await routeTasks(
						runtime,
						[routing(`${focus} (part of: ${params.goal})`, undefined)],
						signal,
					);
					const member: Member = { name, focus, assignment: placement(route, undefined) };
					if (run.add(specFor(member, [...members, member])) < 0) return;
					verifiers++;
					members.push(member);
					board.log({ gate: "verify", bee: name, notes: [a.id, b.id] });
				} catch {
					// A verifier that could not be started leaves the dispute in the report, both sides kept.
				} finally {
					spawning = false;
				}
			};
			const pollMs = Math.max(50, Math.min(2000, options.verifyAfterSeconds * 500));
			const watch = setInterval(() => {
				if (spawning || verifiers >= options.verifyConflicts) return;
				const notes = board.all();
				const state = foldRelations(notes, board.relations());
				const byId = new Map(notes.map((note) => [note.id, note]));
				const now = Date.now();
				for (const rows of state.contested.values()) {
					for (const row of rows) {
						const key = [row.earlier, row.later].sort().join("+");
						const since = firstSeen.get(key);
						if (since === undefined) {
							firstSeen.set(key, now);
							continue;
						}
						if (verified.has(key) || now - since < options.verifyAfterSeconds * 1000) continue;
						const a = byId.get(row.earlier);
						const b = byId.get(row.later);
						if (!a || !b) continue;
						verified.add(key);
						void verify(a, b);
						return;
					}
				}
			}, pollMs);
			watch.unref?.();
			let outcomes: Awaited<ReturnType<typeof run.run>>;
			try {
				outcomes = await run.run(runner, signal);
			} finally {
				clearInterval(watch);
			}
			const reports = outcomes.map((outcome) => outcome.report);

			const notes = board.all();
			const state = foldRelations(notes, board.relations());
			const deliveries = board.deliveries();
			const byId = new Map(notes.map((note) => [note.id, note]));
			const reached = (note: Note) =>
				deliveries.filter((delivery) => delivery.note === note.id).map((delivery) => delivery.to);
			const marks = (note: Note) => {
				const parts: string[] = [];
				const confirmed = state.supported.get(note.id);
				if (confirmed) parts.push(`confirmed by ${confirmed.join(", ")}`);
				if (state.contested.has(note.id)) parts.push("in dispute");
				return parts.length > 0 ? ` (${parts.join(", ")})` : "";
			};
			const standing = [...state.current].sort((a, b) => b.score - a.score);
			const corrected = [...state.superseded].flatMap(([id, row]) => {
				const earlier = byId.get(id);
				const later = byId.get(row.later);
				return earlier && later
					? [`- ${earlier.bee}: "${clip(earlier.text, 160)}" -> ${later.bee}: ${clip(later.text, 300)}`]
					: [];
			});
			const disputes = new Map<string, [Note, Note]>();
			for (const rows of state.contested.values()) {
				for (const row of rows) {
					const a = byId.get(row.earlier);
					const b = byId.get(row.later);
					if (a && b) disputes.set([row.earlier, row.later].sort().join("+"), [a, b]);
				}
			}
			const sections = [
				standing.length === 0
					? "(nothing was judged worth sharing)"
					: standing
							.slice(0, 14)
							.map((note) => {
								const to = reached(note);
								return `- [${note.kind.replace("_", " ")} ${note.score.toFixed(2)}] ${note.bee}${to.length > 0 ? ` -> ${to.join(", ")}` : ""}${marks(note)}: ${clip(note.text, 400)}`;
							})
							.join("\n"),
				corrected.length > 0 ? `Corrected, no longer standing:\n${corrected.join("\n")}` : "",
				disputes.size > 0
					? `Unsettled disputes, both sides kept:\n${[...disputes.values()].map(([a, b]) => `- ${a.bee}: "${clip(a.text, 200)}" vs ${b.bee}: "${clip(b.text, 200)}"`).join("\n")}`
					: "",
			].filter(Boolean);
			const counts = [
				`${notes.length} notes passed the judge`,
				corrected.length > 0 ? `${corrected.length} corrected` : "",
				disputes.size > 0 ? `${disputes.size} unsettled` : "",
				`${deliveries.length} deliveries between investigators`,
			]
				.filter(Boolean)
				.join(", ");
			const text = [
				...members.map((member, at) => {
					const { agent, model, thinking } = member.assignment;
					return `## ${member.name} [${[agent?.name ?? "no role", model ?? "default model", `thinking ${thinking}`].join(", ")}]\n${reports[at]}`;
				}),
				`## Hive board: ${counts}\n${sections.join("\n")}\n(every verdict of the gates: ${join(dir, "gate.jsonl")})`,
			].join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: {
					snapshot: compactSnapshot(run.snapshot()),
					reports,
					notes: notes.length,
					delivered: deliveries.length,
					corrected: corrected.length,
					disputes: disputes.size,
					dir,
				},
			};
		},
		renderResult: (result, renderOptions, theme) => renderSwarmResult(result, renderOptions, theme),
	});

	registerSwarmCommand(runtime);
	registerHiveCommand(runtime);
}

/** How long `/hive` in print mode waits for the turn it asked for to start. It takes that long only when something is wrong. */
const TURN_START_MS = 60_000;

/** Custom message type of the request to start a hive: the model reads it, the chat does not show it. */
export const HIVE_REQUEST_ENTRY = "kyrn.hive-request";

/**
 * `/hive <question>`: a person asks for a hive. The command sends the question
 * with the request to put a hive on it at once (`hiveRequest`); the main model
 * plans the bees, because it knows the project and the angles. Without a
 * question, `/hive` is `/swarm`, as it always was.
 *
 * The command sends what was typed as a user message, so the turn runs as a
 * typed message's would and the chat shows `/hive <question>`. The request goes
 * with it as a hidden message of that turn: it is written for the model, in
 * English, and would otherwise sit in the person's bubble. Print mode ends the
 * process when the command returns, so there the command waits for the turn it
 * started to end.
 */
function registerHiveCommand(runtime: KyrnRuntime): void {
	const { pi } = runtime;
	/** The turn a waiting `/hive` asked for: whether it has started, and what to call when it is over. */
	let waiting: { started: boolean; over: () => void } | undefined;
	/** The request for the turn `/hive` is about to start, matched by what it sends as the user message. */
	let request: { typed: string; text: string } | undefined;
	pi.on(
		"before_agent_start",
		failOpen((event) => {
			const pending = request;
			request = undefined;
			if (!pending || event.messageType !== "user" || event.prompt !== pending.typed) return undefined;
			return { message: { customType: HIVE_REQUEST_ENTRY, content: pending.text, display: false } };
		}),
	);
	pi.on(
		"agent_start",
		failOpen(() => {
			if (waiting) waiting.started = true;
			return undefined;
		}),
	);
	pi.on(
		"agent_settled",
		failOpen(() => {
			if (waiting?.started) waiting.over();
			return undefined;
		}),
	);
	const untilTurnEnds = (): Promise<void> =>
		new Promise<void>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const over = () => {
				clearTimeout(timer);
				waiting = undefined;
				resolve();
			};
			waiting = { started: false, over };
			// A request pi refused never starts a turn: its error is printed, and waiting for it would hang.
			timer = setTimeout(() => {
				if (!waiting?.started) over();
			}, TURN_START_MS);
			timer.unref?.();
		});

	pi.registerCommand("hive", {
		description: say({
			zh: "让几个调查员同时查一个问题：/hive <问题>；不带问题时同 /swarm，看正在干活的子代理",
			en: "Have several investigators work on one question at once: /hive <question>. With no question, it works like /swarm",
		}),
		// No argument completions, like /swarm: "/hive stop" is typed by someone who wants it to happen now.
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const asked = parseHiveArgs(args);
			if (asked.kind !== "question") {
				const control = asked.kind === "control" ? `${asked.verb} ${asked.name ?? ""}` : "";
				controlSwarm(
					runtime,
					control,
					ctx,
					"/hive <question> puts several investigators to work on your question.",
				);
				return;
			}
			const refuse = (message: string): void => {
				// Print mode has nobody to notify: an error is what it prints.
				if (!ctx.hasUI) throw new Error(message);
				ctx.ui.notify(message, "warning");
			};
			if (!pi.getActiveTools().includes("hive")) {
				refuse("The hive tool isn't active in this session (--tools leaves it out), so /hive can't start one.");
				return;
			}
			if (!ctx.model) {
				refuse("No model is selected. Run /login, then /model.");
				return;
			}
			if (!ctx.isIdle()) {
				// A queued message joins the running loop, which starts no new turn to attach the request to:
				// the request goes in the message itself.
				pi.sendUserMessage(hiveRequest(asked.question), { deliverAs: "followUp" });
				ctx.ui.notify("The hive will start when the current turn ends.", "info");
				return;
			}
			// The request is sent by the command, and what an extension sends is not counted as the user speaking.
			// This one is the user's: the task frame, the lessons and the permission judge read it as what they typed,
			// as they do for /goal. Otherwise the judge would be asked to approve a hive against the turn before.
			const typed = `/hive ${asked.question}`;
			runtime.beginTurn(typed);
			runtime.startTurnWork(typed);
			// Without credentials pi refuses the request with an error of its own; there is no turn to wait for.
			const wait = (ctx.mode === "print" || ctx.mode === "json") && ctx.modelRegistry.hasConfiguredAuth(ctx.model);
			const over = wait ? untilTurnEnds() : undefined;
			request = { typed, text: hiveRequest(asked.question) };
			pi.sendUserMessage(typed);
			await over;
		},
	});
}

/** The board as the live view shows it. Read from the files every time: the bees write them from their own processes. */
export function summarizeBoard(board: Board): BoardSummary {
	const notes = board.all();
	const deliveries = board.deliveries();
	const state = foldRelations(notes, board.relations());
	const published: Record<string, number> = {};
	const received: Record<string, number> = {};
	for (const note of notes) published[note.bee] = (published[note.bee] ?? 0) + 1;
	for (const delivery of deliveries) received[delivery.to] = (received[delivery.to] ?? 0) + 1;
	const disputes = new Set<string>();
	for (const rows of state.contested.values()) {
		for (const row of rows) disputes.add([row.earlier, row.later].sort().join("+"));
	}
	return {
		notes: notes.length,
		deliveries: deliveries.length,
		judged: board.judged(),
		corrections: state.superseded.size,
		conflicts: disputes.size,
		published,
		received,
		latest: notes.slice(-8).map((note) => ({
			at: note.at,
			bee: note.bee,
			kind: note.kind,
			score: note.score,
			to: deliveries.filter((delivery) => delivery.note === note.id).map((delivery) => delivery.to),
			text: clip(note.text, 200),
			...(state.superseded.has(note.id)
				? { state: "superseded" as const }
				: state.contested.has(note.id)
					? { state: "contested" as const }
					: {}),
		})),
	};
}
