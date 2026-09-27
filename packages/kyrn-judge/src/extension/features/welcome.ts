import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { keyText, VERSION as PI_VERSION, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

/**
 * The letter μ, three rows tall so its stem can drop below the line. Drawn in blocks rather than typed:
 * U+03BC has ambiguous width, and a terminal that renders it two cells wide would push the frame's right edge out.
 */
const WORDMARK = ["█  █  ", "█▄▄█▄ ", "█     "];
const MAX_BOX_WIDTH = 78;
const MIN_BOX_WIDTH = 44;

export interface Versions {
	/** mu's own: what `npm i -g mu-agent` installed, or what this source tree is released as. */
	readonly mu: string;
	/** The pi mu is built on. */
	readonly pi: string;
}

/**
 * mu's version and pi's, from where each is written down. `judgeRoot` is the judgment layer's own folder:
 *
 *   npm package (mu-agent)   <package>/package.json: `version` is mu's, `muBuild.pi` is pi's (kyrn/npm/build.mjs)
 *   source checkout          kyrn/npm/package.template.json is mu's, packages/coding-agent/package.json is pi's
 *
 * Two places that look right are not. The judgment layer's own package.json says 0.1.0, a number never released.
 * pi's `VERSION` is read from PI_PACKAGE_DIR, which the launcher points at mu-agent's folder in the package, so
 * there it is mu's version: mu 0.1.3 greeted with "v0.1.0 · built on pi 0.1.3".
 */
export function readVersions(judgeRoot: URL, fallbackPi = PI_VERSION): Versions {
	const read = (path: string): Record<string, unknown> => {
		try {
			const parsed: unknown = JSON.parse(readFileSync(new URL(path, judgeRoot), "utf8"));
			return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	};
	const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
	const installed = read("../package.json");
	// Only the npm build writes `muBuild`.
	if (typeof installed.muBuild === "object" && installed.muBuild !== null) {
		return {
			mu: text(installed.version) ?? "0.0.0",
			pi: text((installed.muBuild as { pi?: unknown }).pi) ?? fallbackPi,
		};
	}
	return {
		mu: text(read("../../kyrn/npm/package.template.json").version) ?? "0.0.0",
		pi: text(read("../coding-agent/package.json").version) ?? fallbackPi,
	};
}

/** The judgment layer's folder, from `src/` and from the bundle alike: the build rewrites `import.meta.url`. */
export const VERSIONS = readVersions(new URL("../../../", import.meta.url));

export type JudgeHealth = "checking" | { ok: boolean; latencyMs: number; error?: string };

export interface WelcomeView {
	version: string;
	piVersion: string;
	judge: string;
	health: JudgeHealth;
	mode: string;
	model: string | undefined;
	thinking: string | undefined;
	cwd: string;
	expanded: boolean;
	/** "ctrl+o" and friends, as the user has them bound. */
	keys: { expand: string; model: string; thinking: string };
}

/** The part of pi's Theme the welcome screen needs, so it can be rendered without one in tests. */
export type Paint = Pick<Theme, "fg" | "bold">;

/** Failures the user can act on, said as what to fix rather than as the error's name. */
const HEALTH_ERROR: Readonly<Record<string, string>> = {
	unreachable: "not reachable",
	auth: "no usable key (mu setup)",
	payment_required: "out of credit",
};

function healthText(view: WelcomeView, paint: Paint): string {
	if (view.judge === "off") return paint.fg("muted", "off · pi's stock behaviour everywhere");
	if (view.health === "checking") return `${view.judge} ${paint.fg("dim", "· checking…")}`;
	if (view.health.ok) {
		return `${view.judge} ${paint.fg("success", `· answering in ${view.health.latencyMs} ms`)} ${paint.fg("dim", `· decisions ${view.mode}`)}`;
	}
	const why = HEALTH_ERROR[view.health.error ?? ""] ?? `failing (${view.health.error ?? "error"})`;
	return `${view.judge} ${paint.fg("warning", `· ${why}, falling back to stock behaviour`)}`;
}

/**
 * The welcome screen as lines no wider than `width`. Values are read at render
 * time, so switching the judge or the model shows up without any bookkeeping.
 */
export function renderWelcome(view: WelcomeView, width: number, paint: Paint): string[] {
	const home = homedir();
	const cwd = view.cwd.startsWith(home) ? `~${view.cwd.slice(home.length)}` : view.cwd;
	const model = view.model
		? `${view.model}${view.thinking ? paint.fg("dim", ` · thinking ${view.thinking}`) : ""}`
		: paint.fg("warning", "none yet · /login, or mu setup in a terminal");
	const rows: [string, string][] = [
		["judge", healthText(view, paint)],
		["model", model],
		["cwd", cwd],
	];
	const beside = [
		`${paint.bold(paint.fg("text", "mu"))}${paint.fg("text", " · judgment-first coding agent")}`,
		paint.fg("dim", `v${view.version} · built on pi ${view.piVersion}`),
		// μ is "micro" as a unit prefix, 微 in Chinese: see the small thing, know the large one.
		paint.fg("dim", "见微知著"),
	];
	const title = WORDMARK.map((row, index) => `${paint.bold(paint.fg("accent", row))}  ${beside[index]}`);
	const body = [
		"",
		...title,
		"",
		...rows.map(([label, value]) => `${paint.fg("muted", label.padEnd(8))}${value}`),
		"",
	];

	const dot = paint.fg("muted", " · ");
	const hints = [
		`${paint.fg("dim", "/")} commands`,
		`${paint.fg("dim", "!")} bash`,
		`${paint.fg("dim", view.keys.model)} model`,
		`${paint.fg("dim", view.keys.thinking)} thinking`,
		`${paint.fg("dim", view.keys.expand)} ${view.expanded ? "less" : "more"}`,
	].join(dot);
	const tryLine = `${paint.fg("dim", "Try")} /help${dot}/status${dot}/agents${dot}/browse <url> <goal>${dot}/init`;
	const more = view.expanded
		? [
				"",
				paint.fg("muted", "What the judge does here"),
				"  reads every message first and sets the turn's gear (thinking level, hints)",
				"  keeps noisy tool output, stale results and irrelevant skills out of the context",
				'  vouches for risky commands, notices drift, loops and unverified "done"',
				"  drives the browser click by click and routes sub-agents to a role and a model",
				paint.fg("muted", "Switch it"),
				"  /mu judge laya,jev     which models answer, in order",
				"  /mu mode default shadow     record verdicts without acting on them",
			]
		: [];

	if (width < MIN_BOX_WIDTH) {
		// Too narrow for a frame: plain lines, cut to fit.
		return ["", ...body.slice(1, -1), "", hints, tryLine, ...more, ""].map((line) => truncateToWidth(line, width));
	}
	const boxWidth = Math.min(width, MAX_BOX_WIDTH);
	const inner = boxWidth - 6;
	const border = (text: string) => paint.fg("borderAccent", text);
	const framed = body.map((line) => {
		const cut = truncateToWidth(line, inner);
		return `${border("│")}  ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))}  ${border("│")}`;
	});
	return [
		"",
		border(`╭${"─".repeat(boxWidth - 2)}╮`),
		...framed,
		border(`╰${"─".repeat(boxWidth - 2)}╯`),
		...[hints, tryLine, ...more].map((line) => truncateToWidth(`  ${line}`, width)),
		"",
	];
}

/** Who the model is told it is. Constant for the whole session, so it costs the prompt cache nothing. */
export const IDENTITY = `This harness is mu (written μ), a judgment-first coding agent built on pi. If asked what you are or where you run, say mu.
A small judgment model works beside you. It may replace noisy tool output with a one-line pointer to the full text, add one-line hints or lessons before a turn, and it performs every click of the \`browse\` tool.
Work like a careful colleague. When a request is loosely worded, look at the workspace and take the most plausible reading instead of asking; say the assumption in one line and go on. Ask the user only for what cannot be found here, after doing what does not depend on it. When the user replies to something you asked, act on the reply.
Commands the user can type: /help, /status, /doctor.`;

/**
 * The first thing the user sees: what mu is, which judge is answering and
 * how fast, which model is thinking, and the handful of commands worth knowing.
 */
export function registerWelcome(runtime: KyrnRuntime): void {
	const options = runtime.options("welcome", { enabled: true });
	if (!options.enabled) return;
	let health: JudgeHealth = "checking";

	runtime.pi.on(
		"before_agent_start",
		failOpen((event) => {
			event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, mu: IDENTITY };
			return undefined;
		}),
	);

	runtime.pi.on(
		"session_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			if (ctx.mode !== "tui") return undefined;
			let redraw: (() => void) | undefined;
			// The title bar has no frame to keep aligned, so the letter itself can stand here.
			ctx.ui.setTitle(`μ - ${basename(ctx.cwd)}`);
			ctx.ui.setHeader((tui, theme) => {
				let expanded = false;
				redraw = () => tui.requestRender();
				return {
					setExpanded(value: boolean) {
						expanded = value;
					},
					invalidate() {},
					render(width: number): string[] {
						const current = runtime.ctx;
						const model = current?.model;
						return renderWelcome(
							{
								version: VERSIONS.mu,
								piVersion: VERSIONS.pi,
								judge: runtime.judgeLabel,
								health,
								mode: runtime.mode("*"),
								model: model ? `${model.provider}/${model.id}` : undefined,
								thinking: current?.thinkingLevel ?? runtime.pi.getThinkingLevel(),
								cwd: current?.cwd ?? ctx.cwd,
								expanded,
								keys: {
									expand: keyText("app.tools.expand"),
									model: keyText("app.model.select"),
									thinking: keyText("app.thinking.cycle"),
								},
							},
							width,
							theme,
						);
					},
				};
			});
			// Asked once per session start: a judge that is down is the first thing worth knowing.
			health = "checking";
			void runtime.engine.probe().then((result) => {
				health = result;
				redraw?.();
			});
			return undefined;
		}),
	);
}
