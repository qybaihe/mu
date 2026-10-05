import { randomUUID } from "node:crypto";
import type { ClassifierQuestion, JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CapabilityCatalog } from "../catalog/catalog.ts";
import { featureOptions, type KyrnConfig } from "../config.ts";
import { DecisionEngine, type DecisionMode } from "../decision.ts";
import type { PreflightOutcome, TaskFrame } from "../decisions/input-preflight.ts";
import type { NotifyFn } from "../decisions/notify-routing.ts";
import { JudgeError } from "../errors.ts";
import { compactFrame, type Frame, type FrameState, isStale } from "../frame/frame.ts";
import type { JudgeLike } from "../judge.ts";
import { CompositeLedger, type LedgerRecord, type LedgerSink, MemoryLedger } from "../ledger.ts";
import type { ClassifierCall } from "../providers/classifier.ts";
import type { FreeJevOutcome } from "../providers/free-jev.ts";
import type { LlmCompletion } from "../providers/llm.ts";
import { buildJudge, resolveJudgeConfig } from "../registry.ts";
import { createJudgeFetch, type JudgeFetch } from "./judge-fetch.ts";
import {
	type KyrnPresentationEvent,
	PRESENTATION_STATUS_KEY,
	type PresentationListener,
	type ProgressCode,
} from "./presentation.ts";

export const LEDGER_ENTRY_TYPE = "kyrn.decision";
const GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
const STATUS_KEY = "kyrn";

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("\n");
}

export function clip(text: string, length: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

/**
 * The person's own words. A host may put its instructions in front of what the person typed: AionUi's
 * core prefixes the first message of a conversation with `[Assistant Rules] … [/Assistant Rules]`, its
 * skill list, some 1,600 characters. That text is for the main model. A judge asked about "the user's
 * message", and the task frame that takes the first message as the goal, must not read it as theirs.
 */
export function userWords(text: string): string {
	const preamble = /^\s*\[Assistant Rules\][\s\S]*?\[\/Assistant Rules\]\s*/i.exec(text);
	return preamble ? text.slice(preamble[0].length) : text;
}

/**
 * What the judge should read for a message: the person's own words, without a
 * host's preamble (`userWords`). A prompt template or a skill command stands
 * for what it does, not for its name: "/init" says nothing, its description
 * does. Undefined means there is nothing worth judging.
 */
export function judgedText(
	text: string,
	commands: readonly { name: string; description?: string }[],
): string | undefined {
	const words = userWords(text);
	const match = /^\/(\S+)\s*([\s\S]*)$/.exec(words.trim());
	if (!match) return words;
	const command = commands.find((candidate) => candidate.name === match[1]);
	// Not a command after all: a message may well start with a path.
	if (!command) return words;
	if (!command.description) return undefined;
	return match[2] ? `${command.description}\n${match[2]}` : command.description;
}

/** The user turn that asked for a decision, as this runtime stamped it on the record. */
function askedTurn(record: LedgerRecord): number | undefined {
	const origin = record.origin;
	if (typeof origin !== "object" || origin === null || !("turn" in origin)) return undefined;
	return typeof origin.turn === "number" ? origin.turn : undefined;
}

/** Short role-tagged digests of the latest user and assistant messages, oldest first. */
export function recentTurnDigests(ctx: Pick<ExtensionContext, "sessionManager">, limit = 4, length = 240): string[] {
	const digests: string[] = [];
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0 && digests.length < limit; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; content?: unknown };
		if (message.role !== "user" && message.role !== "assistant") continue;
		const said = message.role === "user" ? userWords(textOf(message.content)) : textOf(message.content);
		const text = clip(said, length);
		if (text) digests.unshift(`${message.role}: ${text}`);
	}
	return digests;
}

/**
 * True when the agent's last turn ended on a question without working on it (its final message holds
 * a question mark and made no tool call): the user message that follows is the reply, and the turn it
 * starts must act on that reply, not ask again. A rule, so it holds with no judge at all.
 */
export function lastTurnStoppedToAsk(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; content?: unknown };
		// Nothing said since the last user message: the previous turn produced no question to answer.
		if (message.role === "user") return false;
		if (message.role !== "assistant") continue;
		const parts = Array.isArray(message.content) ? message.content : [];
		if (parts.some((part) => (part as { type?: unknown } | null)?.type === "toolCall")) return false;
		const text = textOf(message.content).trim();
		return text.length > 0 && text.length <= 1200 && /[?？]/.test(text);
	}
	return false;
}

/** What one user turn has established so far. Reset when the next user message arrives. */
export interface TurnState {
	/** What the person typed, without a host's preamble (`userWords`). */
	userMessage: string;
	/** When the message arrived. Every wait before the turn starts counts from here, so waits overlap instead of adding up. */
	startedAt: number;
	/** The agent's last turn stopped to ask, and this message is the reply (`lastTurnStoppedToAsk`). */
	repliesToQuestion: boolean;
	preflight?: PreflightOutcome;
	/** Files edited or written this turn, and whether a command ran after the last edit. */
	editedFiles: Set<string>;
	ranCommandAfterLastEdit: boolean;
	nudgedForCompletion: boolean;
	/** Times the agent was sent back to work it said it would do and then did not (`turn.continue`). */
	continued: number;
}

export interface Savings {
	/** Characters of tool output kept out of the context by admission control. */
	admissionOmittedChars: number;
	/** Characters of skill descriptions kept out of the system prompt. */
	skillsHiddenChars: number;
	/** Characters of stale tool results replaced by tombstones in outgoing requests. */
	forgottenChars: number;
	/** Characters of tool output pruned by summary-free compaction. */
	compactedChars: number;
	/** Characters of new diagnostics that were never told: style noise, fixed before the model paused, or over the cap. */
	diagnosticsWithheldChars: number;
}

/**
 * Everything the features share: one engine, one config, the live context,
 * and what is known about the current turn. Features never talk to a judge
 * directly, so swapping the decision model is a one-line change here.
 */
export class KyrnRuntime {
	readonly pi: ExtensionAPI;
	readonly config: KyrnConfig;
	readonly engine: DecisionEngine;
	readonly memory = new MemoryLedger();
	/** Everything installed that the judge may open per task: packs, MCP servers, language servers. */
	readonly catalog = new CapabilityCatalog();
	readonly problems: string[] = [];
	readonly savings: Savings = {
		admissionOmittedChars: 0,
		skillsHiddenChars: 0,
		forgottenChars: 0,
		compactedChars: 0,
		diagnosticsWithheldChars: 0,
	};
	readonly sessionId = randomUUID();
	/** False when the judge is switched off (MU_JUDGE=off): the CLI stays, the judgment layer asks nothing. */
	enabled = true;
	turn: TurnState = emptyTurn("");
	userTurns = 0;
	/** Tool calls so far in this session. Zero means no work has started: a plain message is then plain chat. */
	toolCalls = 0;
	/** The assistant's latest prose, used as the stated intent of the tool calls that follow it. */
	lastAssistantText = "";
	/** When an event last reached a feature: what "in use" means to whoever keeps the judge's connection warm. */
	lastActivityAt = Date.now();
	/** The task frame as the frame feature keeps it. Undefined while that feature is off: the stand-in answers then. */
	frameState: FrameState | undefined;
	/** A goal is set and running: deciding whether the agent may stop is the goal feature's job, nobody else's. */
	goalActive = false;
	/** The harness itself cut the run that is ending (mid-stream correction), and will start the next one. Not the user's Esc. */
	harnessAbort = false;
	/**
	 * The ends of runs (pi's `agent_end` event, the one object every handler gets) after which a feature already sent
	 * the agent back to work, so a later check says nothing more about the same end. One voice is enough.
	 */
	readonly nudgedEnds = new WeakSet<object>();
	/**
	 * Whoever keeps the task frame sets this. It hears of a message the moment its turn is counted,
	 * so the frame's judge runs alongside preflight's instead of after its wait.
	 */
	onTurnBegin?: (userMessage: string) => void;
	/**
	 * Set by the permissions feature: the mode this conversation runs in. Undefined while that feature is
	 * off, and then the guard alone looks at risky commands, as before there were modes.
	 */
	permissionMode?: () => "full" | "jev" | "ask";
	/**
	 * Set by the memory feature: for each sub-agent task, the lessons of this project that apply to it,
	 * one line each, for the "known lessons" of its brief. Undefined while that feature is off.
	 */
	knownLessons?: (tasks: readonly string[], signal?: AbortSignal) => Promise<readonly (readonly string[])[]>;
	/**
	 * True when the configured judge answers concurrent calls concurrently (a hosted model). The local
	 * sidecar answers one at a time, and there the work of a turn is best asked in order of importance.
	 */
	readonly judgeParallel: boolean;
	private latestCtx: ExtensionContext | undefined;
	private firstUserMessage = "";
	private turnStartListeners: ((words: string) => void)[] = [];
	private judgeHttp: JudgeFetch | undefined;
	private presentationSequence = 0;
	onPresentation?: PresentationListener;
	/** Set by the free Jev notice: how each call went when the `jev` judge falls back to the free Jev. */
	onFreeJev?: (outcome: FreeJevOutcome) => void;
	/** Features that show the person what another feature announced: the board says a permission is waiting. */
	private readonly observers = new Map<KyrnPresentationEvent["kind"], Set<(payload: unknown) => void>>();

	constructor(pi: ExtensionAPI, config: KyrnConfig, judge?: JudgeLike, problem?: string) {
		this.pi = pi;
		this.config = config;
		if (problem) this.problems.push(problem);
		this.judgeParallel = resolveJudgeConfig(config.tiers[0] ?? "", config)?.type !== "local";
		const sessionLedger: LedgerSink = {
			append: (record: LedgerRecord) => {
				pi.appendEntry(LEDGER_ENTRY_TYPE, record);
				// Raw judge inputs are not part of the UI protocol, even when the diagnostic ledger records them.
				const { state: _state, ...visible } = record;
				// A judge that answers after the next message began still belongs to the turn that asked.
				this.present("decision", visible, askedTurn(record) ?? this.userTurns);
			},
		};
		this.engine = new DecisionEngine({
			judge: judge ?? this.buildConfiguredJudge(config.tiers),
			ledger: new CompositeLedger([this.memory, sessionLedger]),
			defaultMode: config.modes.default ?? "shadow",
			modes: Object.fromEntries(Object.entries(config.modes).filter(([specId]) => specId !== "default")),
			recordState: config.recordState,
			// Which turn asked, and under which version of the task: a verdict about "the goal" is only as good as that goal.
			origin: () => ({ turn: this.userTurns, frame: this.frameState?.frame?.version ?? 0 }),
		});
		for (const [specId, tiers] of Object.entries(config.routes)) this.route(specId, tiers);
		pi.on("session_shutdown", () => {
			void this.judgeHttp?.close().catch(() => {});
			this.judgeHttp = undefined;
		});
	}

	/** Answer one decision with its own tiers, e.g. `/mu route browser.step luna`. Empty tiers undo it. */
	route(specId: string, tiers: readonly string[]): readonly string[] {
		const before = this.problems.length;
		this.engine.setJudgeFor(specId, tiers.length > 0 ? this.buildConfiguredJudge(tiers) : undefined);
		return this.problems.slice(before);
	}

	private buildConfiguredJudge(tiers: readonly string[]): JudgeLike {
		this.judgeHttp ??= createJudgeFetch();
		const built = buildJudge(
			{ ...this.config, tiers },
			{
				env: process.env,
				fetch: this.judgeHttp.fetch,
				gatewayApiKey: async () =>
					(await this.latestCtx?.modelRegistry.getApiKeyForProvider(GATEWAY_PROVIDER_ID)) ??
					process.env.AI_GATEWAY_API_KEY,
				llm: (model, options) => this.llm(model, options),
				classify: (model) => this.classifier(model),
				freeJev: (outcome) => this.onFreeJev?.(outcome),
			},
		);
		this.problems.push(...built.problems);
		return built.judge;
	}

	/** Switch the decision model at runtime, e.g. `/mu judge laya,jev`. */
	useJudges(tiers: readonly string[]): readonly string[] {
		const before = this.problems.length;
		this.engine.setJudge(this.buildConfiguredJudge(tiers));
		return this.problems.slice(before);
	}

	/**
	 * A classifier model of the host's catalog ("provider/model-id"), reached with the host's credentials for its
	 * provider. Looked up per call, because models (llama.cpp's among them) load after extensions.
	 */
	classifier(modelRef: string): ClassifierCall {
		return async ({ state, questions, signal }) => {
			const ctx = this.latestCtx;
			if (!ctx) throw new JudgeError("unreachable", "No session is attached yet");
			const slash = modelRef.indexOf("/");
			const model =
				slash > 0
					? ctx.modelRegistry.getModelOfType("classifier", modelRef.slice(0, slash), modelRef.slice(slash + 1))
					: undefined;
			if (!model) throw new JudgeError("bad_request", `Classifier "${modelRef}" is not in the model catalog`);
			// OpenCode serves its free models to anyone with the key "public", as its own client does without a sign-in.
			const free = model.provider === "opencode" && model.cost.input === 0 && model.cost.output === 0;
			const apiKey = free && !(await ctx.modelRegistry.getApiKeyForProvider(model.provider)) ? "public" : undefined;
			// Only System One takes a yes/no question without criteria; a llama.cpp classifier reads both labels.
			const systemOne = model.api.endsWith("system-one");
			const wire = Object.fromEntries(
				Object.entries(questions).map(([id, question]) => [
					id,
					question.type === "bool" && !question.criteria && !systemOne
						? { ...question, criteria: { true: "", false: "" } }
						: question,
				]),
			);
			const result = await ctx.modelRegistry.classify(
				model,
				// System One takes any JSON state; mu's states are text or objects.
				{ state: state as JsonObject, questions: wire as Record<string, ClassifierQuestion> },
				// The kernel owns timeouts and retries.
				{
					signal,
					maxRetries: 0,
					...(apiKey ? { apiKey } : {}),
					...(this.judgeHttp ? { fetch: this.judgeHttp.fetch } : {}),
				},
			);
			return {
				answers: result.answers,
				usage: result.usage ? { input: result.usage.input, output: result.usage.output } : undefined,
				stopReason: result.stopReason,
				errorMessage: result.errorMessage,
			};
		};
	}

	/** A completion function over one of the host's models. Looked up per call, because models load after extensions. */
	llm(modelRef: string, options: { thinking?: string } = {}): LlmCompletion {
		return async ({ system, user, signal }) => {
			const ctx = this.latestCtx;
			if (!ctx) throw new JudgeError("unreachable", "No session is attached yet");
			const slash = modelRef.indexOf("/");
			const model =
				slash > 0 ? ctx.modelRegistry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1)) : undefined;
			if (!model) throw new JudgeError("bad_request", `Model "${modelRef}" is not available`);
			const thinking = options.thinking && options.thinking !== "off" ? options.thinking : undefined;
			const message = await ctx.modelRegistry
				.streamSimple(
					model,
					{
						systemPrompt: system,
						messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
					},
					{
						signal,
						maxTokens: 2000,
						reasoning: thinking as never,
						cacheRetention: "none",
						sessionId: this.sessionId,
					},
				)
				.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new JudgeError("server", message.errorMessage?.slice(0, 200) ?? "The model call failed");
			}
			return { text: textOf(message.content), inputTokens: message.usage.input, outputTokens: message.usage.output };
		};
	}

	/** The configured writer model, or undefined when generative helpers are off. */
	writer(): LlmCompletion | undefined {
		return this.config.writer ? this.llm(this.config.writer, { thinking: "off" }) : undefined;
	}

	touch(ctx: ExtensionContext): void {
		this.latestCtx = ctx;
		this.lastActivityAt = Date.now();
	}

	get ctx(): ExtensionContext | undefined {
		return this.latestCtx;
	}

	mode(specId: string): DecisionMode {
		return this.engine.getMode(specId);
	}

	options<T extends { enabled: boolean }>(feature: string, defaults: T): T {
		return featureOptions(this.config, feature, defaults);
	}

	beginTurn(userMessage: string): void {
		this.userTurns++;
		const words = userWords(userMessage);
		if (!this.firstUserMessage) this.firstUserMessage = words;
		this.turn = emptyTurn(words);
		try {
			// The frame keeps the raw text: it matches the message by it once pi has stored it.
			this.onTurnBegin?.(userMessage);
		} catch {
			// The frame is bookkeeping: a turn starts without it.
		}
	}

	/**
	 * Features that ask the judge something about every user message register here, and start that
	 * work the moment the message arrives instead of when the turn starts: memory, skills and
	 * capabilities are then read alongside preflight, and the turn starts after the slowest of them
	 * rather than after all of them in a row. The listener gets what the judge should read
	 * (`judgedText`). It is not called when the judge answers one call at a time: there, later work
	 * would only delay preflight, and the turn's order of importance is preflight first.
	 */
	atTurnStart(listener: (words: string) => void): void {
		this.turnStartListeners.push(listener);
	}

	/** Whoever counted the turn calls this once preflight's own question is on its way. */
	startTurnWork(userMessage: string): void {
		if (!this.judgeParallel) return;
		const words = judgedText(userMessage, this.pi.getCommands());
		if (words === undefined) return;
		for (const listener of this.turnStartListeners) {
			try {
				listener(words);
			} catch {
				// Early work is an optimisation: a feature that fails to start it starts it when the turn does.
			}
		}
	}

	/**
	 * Waits for `work` until `waitMs` after the message arrived, whichever comes first; undefined
	 * when the time is up. Every wait before the turn counts from the same moment, so a judge that
	 * was slow for one feature does not buy the next feature a fresh allowance.
	 */
	untilTurnDeadline<T>(work: Promise<T>, waitMs: number): Promise<T | undefined> {
		const left = Math.max(0, this.turn.startedAt + waitMs - Date.now());
		let timer: ReturnType<typeof setTimeout> | undefined;
		return Promise.race([
			work,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), left);
			}),
		]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	}

	/** The full task frame: goal, constraints with their sources, acceptance items, open questions, version. */
	get frame(): Frame | undefined {
		return this.frameState?.frame;
	}

	/**
	 * True while the frame is known to be behind the conversation: an update failed, or one is still
	 * running although the turn has started. Filters that drop content by its relevance to the goal hold back.
	 */
	get frameStale(): boolean {
		return this.frameState !== undefined && isStale(this.frameState);
	}

	/**
	 * The one seam every consumer reads: the compact shape of the real frame. With the frame feature
	 * off, the old stand-in answers: the session's first request is the goal, the latest message the subgoal.
	 */
	taskFrame(): TaskFrame | undefined {
		const real = this.frameState && compactFrame(this.frameState);
		if (real) return real;
		if (!this.firstUserMessage) return undefined;
		const goal = clip(this.firstUserMessage, 300);
		const current = clip(this.turn.userMessage, 200);
		return { goal, currentSubgoal: current && current !== goal ? current : undefined };
	}

	status(text: string): void {
		const ctx = this.latestCtx;
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	}

	/** Whoever shows the time between a message and its turn sets this; nobody has to. */
	onProgress?: (step: string) => void;

	/** Set by the notify feature: tells the model of an event from outside the conversation now, at the next turn, or never. */
	notify?: NotifyFn;

	private readonly troubleListeners = new Set<(kind: "loop" | "drift", detail: string) => void>();

	/** Hears what the monitor noticed about the run. Whoever acts on trouble (the judged rewind) listens here. */
	onTrouble(listener: (kind: "loop" | "drift", detail: string) => void): void {
		this.troubleListeners.add(listener);
	}

	/** The monitor says the agent goes in circles or has drifted. A listener that fails is not the monitor's problem. */
	trouble(kind: "loop" | "drift", detail: string): void {
		for (const listener of this.troubleListeners) {
			try {
				listener(kind, detail);
			} catch {
				// Reacting to trouble is optional; noticing it is not.
			}
		}
	}

	/** Says what is being worked out before the turn starts ("choosing skills"). Showing it is best effort. */
	progress(step: string, code?: ProgressCode, params?: Readonly<Record<string, string | number>>): void {
		this.present("progress", { step, ...(code ? { code } : {}), ...(params ? { params } : {}) });
		try {
			this.onProgress?.(step);
		} catch {
			// A display problem is never a reason to skip the work being announced.
		}
	}

	/**
	 * Hears every `present` of one kind, inside the harness. Presentation, not control: a listener that
	 * fails changes nothing, and what it hears is what the app hears.
	 */
	observe(kind: KyrnPresentationEvent["kind"], listener: (payload: unknown) => void): void {
		const listeners = this.observers.get(kind) ?? new Set();
		listeners.add(listener);
		this.observers.set(kind, listeners);
	}

	/** A display failure must never affect execution. RPC transports this over its existing status channel. */
	present(kind: KyrnPresentationEvent["kind"], payload: unknown, turnId = this.userTurns): void {
		const event: KyrnPresentationEvent = {
			version: 1,
			sequence: ++this.presentationSequence,
			at: Date.now(),
			runtimeId: this.sessionId,
			turnId,
			kind,
			payload,
		};
		try {
			this.onPresentation?.(event);
		} catch {
			/* Observers do not own the run. */
		}
		try {
			if (this.latestCtx?.mode === "rpc")
				this.latestCtx.ui.setStatus(PRESENTATION_STATUS_KEY, JSON.stringify(event));
		} catch {
			/* A disconnected presentation does not stop the agent. */
		}
		for (const listener of this.observers.get(kind) ?? []) {
			try {
				listener(payload);
			} catch {
				/* One feature's view of another is never that other's problem. */
			}
		}
	}

	/** "cascade(local:laya>gateway:typesafe-ai/jev)" -> "laya>jev". */
	get judgeLabel(): string {
		if (!this.enabled) return "off";
		const id = this.engine.providerId.replace(/^cascade\((.*)\)$/, "$1");
		return id
			.split(">")
			.map((tier) => tier.split(/[:/]/).pop() || tier)
			.join(">");
	}
}

function emptyTurn(userMessage: string): TurnState {
	return {
		userMessage,
		startedAt: Date.now(),
		repliesToQuestion: false,
		editedFiles: new Set(),
		ranCommandAfterLastEdit: false,
		nudgedForCompletion: false,
		continued: 0,
	};
}

/**
 * `work` within `waitMs`, or undefined: for a verdict that is only worth having now. The work carries on and
 * is recorded when it lands; a rejection after the time is up is nobody's concern here.
 */
export function within<T>(work: Promise<T>, waitMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), waitMs);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/** Wraps a handler so a bug in a feature can never block a tool or a prompt: pi treats a throw as a veto. */
export function failOpen<Event, Result>(
	handler: (event: Event, ctx: ExtensionContext) => Promise<Result | undefined> | Result | undefined,
): (event: Event, ctx: ExtensionContext) => Promise<Result | undefined> {
	return async (event, ctx) => {
		try {
			return await handler(event, ctx);
		} catch {
			return undefined;
		}
	};
}
