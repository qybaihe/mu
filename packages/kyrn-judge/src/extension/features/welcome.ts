import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { keyText, VERSION as PI_VERSION, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { appLanguage } from "../../language.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

/**
 * The letter μ, three rows tall so its stem can drop below the line. Drawn in blocks rather than typed:
 * U+03BC has ambiguous width, and a terminal that renders it two cells wide would push the frame's right edge out.
 */
const WORDMARK = ["█  █  ", "█▄▄█▄ ", "█     "];

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
/** A model as provider/id. None for no model, and for pi's placeholder when there is no model at all, unknown/unknown. */
export function modelRef(model: { readonly provider: string; readonly id: string } | undefined): string | undefined {
	return model && !(model.provider === "unknown" && model.id === "unknown")
		? `${model.provider}/${model.id}`
		: undefined;
}

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
	unreachable: "unreachable",
	auth: "no usable key (run mu setup)",
	payment_required: "out of credit",
};

/**
 * A judge's label as people read it: "jev" is Jev, "jev-1.13-free" is "Jev 1.13 (free)", and a cascade ("laya>jev" or
 * "laya,jev") is "Laya, Jev". Other labels stay as they are.
 */
export function judgeDisplayName(label: string): string {
	return label
		.split(/[>,]/)
		.map((name) => {
			// TypeSafe's own model id for Jev is jev-latest; OpenCode Zen names a version, and its free one says so.
			if (name === "jev" || name === "jev-latest") return "Jev";
			if (name === "laya") return "Laya";
			const versioned = /^jev-([\d.]+)(-free)?$/.exec(name);
			if (!versioned) return name;
			return versioned[2] ? `Jev ${versioned[1]} (free)` : `Jev ${versioned[1]}`;
		})
		.join(", ");
}

function healthText(view: WelcomeView, paint: Paint): string {
	if (view.judge === "off") return paint.fg("muted", "off · every decision point uses its fallback");
	const judge = judgeDisplayName(view.judge);
	if (view.health === "checking") return `${judge} ${paint.fg("dim", "· checking…")}`;
	if (view.health.ok) {
		return `${judge} ${paint.fg("success", `· answering in ${view.health.latencyMs} ms`)} ${paint.fg("dim", `· decision points ${view.mode === "shadow" ? "in shadow" : view.mode}`)}`;
	}
	const why = HEALTH_ERROR[view.health.error ?? ""] ?? `failing (${view.health.error ?? "error"})`;
	return `${judge} ${paint.fg("warning", `· ${why}; using the fallbacks`)}`;
}

/** The rule under the header: as wide as the screen, up to the width the header itself takes. */
const MAX_RULE_WIDTH = 76;

/**
 * The welcome screen as lines no wider than `width`: the μ beside what mu is, then the readout (the judge and how it
 * answers, the model, the folder) and the keys worth knowing, over a hairline. No frame: it reads as the top of the
 * session, not as a dialog. Values are read at render time, so switching the judge or the model shows up without any
 * bookkeeping.
 */
export function renderWelcome(view: WelcomeView, width: number, paint: Paint): string[] {
	const home = homedir();
	const cwd = view.cwd.startsWith(home) ? `~${view.cwd.slice(home.length)}` : view.cwd;
	const model = view.model
		? `${view.model}${view.thinking ? paint.fg("dim", ` · thinking ${view.thinking}`) : ""}`
		: paint.fg("warning", "none yet · run /login, or mu setup in a terminal");
	const beside = [
		`${paint.bold(paint.fg("text", "mu"))}  ${paint.fg("dim", `v${view.version}`)}`,
		paint.fg("text", "judgment-first coding agent"),
		// μ is "micro" as a unit prefix, 微 in Chinese: see the small thing, know the large one.
		paint.fg("dim", `built on pi ${view.piVersion}${appLanguage()?.wording === "zh" ? " · 见微知著" : ""}`),
	];
	// The letter fades from the judge's pink at the top to the accent at its stem, as the app's icon does.
	const shades = ["customMessageLabel", "thinkingHigh", "accent"] as const;
	const title = WORDMARK.map((row, index) => `${paint.bold(paint.fg(shades[index], row))}   ${beside[index]}`);
	const readout: [string, string, string][] = [
		[paint.fg("customMessageLabel", "◆"), "judge", healthText(view, paint)],
		[" ", "model", model],
		[" ", "cwd", cwd],
	];

	const dot = paint.fg("muted", " · ");
	const hints = [
		`${paint.fg("dim", "/")} commands`,
		`${paint.fg("dim", "!")} bash`,
		`${paint.fg("dim", view.keys.model)} model`,
		`${paint.fg("dim", view.keys.thinking)} thinking`,
		`${paint.fg("dim", view.keys.expand)} ${view.expanded ? "less" : "more"}`,
	].join(dot);
	const tryLine = `${paint.fg("dim", "Try")} /help${dot}/status${dot}/agents${dot}/browse <url> [goal]${dot}/init`;
	const more = view.expanded
		? [
				"",
				paint.fg("muted", "What the judge does here"),
				"  reads every message first, sets the turn's thinking level and adds hints",
				"  keeps noisy tool output, stale results and irrelevant skills out of context",
				'  checks risky commands, and catches drift, loops and unverified "done"',
				"  drives the browser click by click and gives each subagent a role and a model",
				paint.fg("muted", "Change it"),
				"  /mu judge laya,jev     which models answer, in order",
				"  /mu mode default shadow     log verdicts without acting on them",
			]
		: [];
	const rule = paint.fg("borderMuted", "─".repeat(Math.max(0, Math.min(width - 2, MAX_RULE_WIDTH))));
	return [
		"",
		...[
			...title,
			"",
			...readout.map(([mark, label, value]) => `${mark} ${paint.fg("muted", label.padEnd(7))}${value}`),
			"",
			hints,
			tryLine,
			...more,
		].map((line) => truncateToWidth(`  ${line}`, width)),
		truncateToWidth(`  ${rule}`, width),
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
								model: modelRef(model),
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
