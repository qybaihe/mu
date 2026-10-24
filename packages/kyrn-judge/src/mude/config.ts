import { readFileSync, writeFileSync } from "node:fs";
import { BUILT_IN_JUDGES } from "../config.ts";
import { envFileValue } from "../setup/env-file.ts";
import {
	Backups,
	judgeConfigPath,
	judgeOff,
	readJsonFile,
	tiersOf,
	withJudge,
	withTiers,
	writeEnvValue,
	writeJsonFile,
} from "../setup/files.ts";
import type { MudePaths } from "./paths.ts";
import { DEFAULT_PORT, mudeBaseUrl } from "./server.ts";

/**
 * What enabling mude changes in mu's files, and how disabling it puts them back:
 *
 * - mu.json `tiers`: "mude" goes first. With the fallback kept (the default), the judges that were there stay behind
 *   it: what mude cannot answer (its server is down, or it is unsure) goes to them, and what they read leaves this
 *   machine when they are hosted. Local only: "mude" alone, and a decision mude cannot answer takes its fallback.
 * - mu.json `judges.mude`: only when the server is not on its usual port. mu's built-in `mude` (config.ts) has the
 *   address and the capability profile, and an entry in the file would replace all of it.
 * - the .env: MU_JUDGE_MUDE_KEY, the key the server was started with.
 * - mu.json `routes`: with the fallback kept, two checks keep going to the judges behind mude. Screening a tool's
 *   description for injected instructions (`tool.description`) is where mude was measurably weaker than Jev, and for
 *   injected instructions in fetched content (`tool.injection`) there was no evidence either way. Local only, mude
 *   answers them too: there is no other judge to send them to.
 * - mu.json `modes.default`: a judge that was off ("Not now" in mu setup) is turned on, and off again on disable.
 *
 * state.json keeps what is needed to go back: the judges before mude went first, whether the judge was off, and
 * which routes it wrote (a route someone set by hand is left as it is).
 */

/** Decisions that keep their own judges when there are judges behind mude. */
export const ROUTED_AWAY = ["tool.description", "tool.injection"] as const;

export const MUDE = "mude";
export const KEY_VARIABLE = "MU_JUDGE_MUDE_KEY";

/**
 * A decision model that runs on this Mac behind its own server: mude, or one added from Hugging Face (models.ts). The
 * same rules put either first and take it out again; only its name, its key's variable and its mu.json entry differ.
 */
export interface LocalJudge {
	/** Its name in `tiers`. */
	readonly name: string;
	/** The .env variable with the key its server was started with. */
	readonly keyVariable: string;
	/** Its mu.json `judges` entry for a server on `port`, or undefined where mu's built-in one serves. */
	readonly entry: (port: number) => Record<string, unknown> | undefined;
}

/** mude: mu's built-in entry serves on the usual port; on another, an entry with that address. */
export const MUDE_JUDGE: LocalJudge = {
	name: MUDE,
	keyVariable: KEY_VARIABLE,
	entry: (port) => (port === DEFAULT_PORT ? undefined : entryFor(port)),
};

export interface MudeState {
	readonly port: number;
	/** The judge order before mude was put first, without mude. */
	readonly previousTiers?: readonly string[];
	/** The judge was off (`modes.default` "off") when mude was enabled. */
	readonly judgeWasOff?: boolean;
	/** mu.json has a `judges.mude` entry written by mu judge mude (the server is on another port). */
	readonly wroteEntry?: boolean;
	/** The routes mu judge mude wrote, with the judges it gave them. */
	readonly wroteRoutes?: Readonly<Record<string, readonly string[]>>;
}

export function readState(paths: MudePaths): MudeState | undefined {
	try {
		const value = JSON.parse(readFileSync(paths.state, "utf8")) as MudeState;
		return Number.isInteger(value.port) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function writeState(paths: MudePaths, state: MudeState): void {
	writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export interface ConfigFiles {
	readonly agentDir: string;
	/** mu's home: backups go to its `backups` folder. */
	readonly home: string;
	readonly envFile: string;
	readonly now?: Date;
}

export interface JudgeSetting {
	/** mude answers first. */
	readonly enabled: boolean;
	/** mude is the only judge: nothing it cannot answer goes to another one. */
	readonly localOnly: boolean;
	/** The judges behind mude, in order. */
	readonly fallback: readonly string[];
	/** mu.json could not be read as plain JSON, so nothing was or will be changed in it. */
	readonly unreadable?: boolean;
}

export function judgeSetting(files: ConfigFiles, name = MUDE): JudgeSetting {
	const file = readJsonFile(judgeConfigPath(files.agentDir));
	if (file.state === "unreadable") return { enabled: false, localOnly: false, fallback: [], unreadable: true };
	const config = file.state === "ok" ? file.value : {};
	const tiers = tiersOf(config);
	const enabled = tiers[0] === name && !judgeOff(config);
	const fallback = tiers.filter((tier) => tier !== name);
	return { enabled, localOnly: enabled && fallback.length === 0, fallback };
}

/** Whether mu.json has the judge `name` (mude unless said) anywhere in its judge order. */
export function mudeInTiers(files: ConfigFiles, name = MUDE): boolean {
	const file = readJsonFile(judgeConfigPath(files.agentDir));
	return file.state === "ok" && tiersOf(file.value).includes(name);
}

/** mu.json's judge order, or none when it can't be read. */
export function currentTiers(files: ConfigFiles): string[] {
	const file = readJsonFile(judgeConfigPath(files.agentDir));
	return file.state === "ok" ? tiersOf(file.value) : [];
}

function readConfig(files: ConfigFiles): { path: string; config: Record<string, unknown> } {
	const path = judgeConfigPath(files.agentDir);
	const file = readJsonFile(path);
	if (file.state === "unreadable") {
		throw new Error(
			`${path} is not plain JSON (comments, or a typo), so mu leaves it alone. Fix it, then run this again.`,
		);
	}
	return { path, config: file.state === "ok" ? file.value : {} };
}

function recordOf(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};
}

function judgesOf(config: Record<string, unknown>): Record<string, unknown> {
	return recordOf(config.judges);
}

/** `config` with `key` set to `value`, or without it when `value` is empty. */
function withSection(
	config: Record<string, unknown>,
	key: string,
	value: Record<string, unknown>,
): Record<string, unknown> {
	if (Object.keys(value).length > 0) return { ...config, [key]: value };
	const { [key]: _gone, ...rest } = config;
	return rest;
}

const sameTiers = (a: unknown, b: readonly string[]): boolean =>
	Array.isArray(a) && a.length === b.length && a.every((tier, index) => tier === b[index]);

/** Takes out the routes mu judge mude wrote, where they still say what it wrote. */
function withoutOwnRoutes(config: Record<string, unknown>, state: MudeState | undefined): Record<string, unknown> {
	const routes = recordOf(config.routes);
	for (const [spec, tiers] of Object.entries(state?.wroteRoutes ?? {})) {
		if (sameTiers(routes[spec], tiers)) delete routes[spec];
	}
	return withSection(config, "routes", routes);
}

/** The entry for a server on another port than the built-in's: the built-in's settings with that address. */
function entryFor(port: number): Record<string, unknown> {
	return { ...BUILT_IN_JUDGES[MUDE], baseUrl: mudeBaseUrl(port) };
}

export interface EnableOptions {
	readonly port: number;
	readonly key: string;
	readonly localOnly: boolean;
}

/** Puts mude first, with or without the judges behind it. Returns the new order. */
export function enableMude(paths: MudePaths, files: ConfigFiles, options: EnableOptions): string[] {
	return enableLocal(MUDE_JUDGE, paths, files, options);
}

/** Puts `judge` first, with or without the judges behind it. Returns the new order. */
export function enableLocal(judge: LocalJudge, paths: MudePaths, files: ConfigFiles, options: EnableOptions): string[] {
	const name = judge.name;
	const { path, config } = readConfig(files);
	const state = readState(paths);
	const current = tiersOf(config).filter((tier) => tier !== name);
	// The order to fall back on: what is there now, or, when the judge is there alone (local only), what was there before.
	const before = current.length > 0 ? current : [...(state?.previousTiers ?? ["jev"])];
	const tiers = options.localOnly ? [name] : [name, ...before.filter((tier) => tier !== name)];
	const judgeWasOff = state?.judgeWasOff ?? judgeOff(config);
	let next = withJudge(withTiers(withoutOwnRoutes(config, state), tiers), true);
	const judges = judgesOf(next);
	const written = judge.entry(options.port);
	if (written) judges[name] = written;
	else if (state?.wroteEntry) delete judges[name];
	const entry = written !== undefined;
	next = withSection(next, "judges", judges);
	// The two checks mude is not trusted with go to the judges behind it; a route someone set by hand stays.
	const fallback = tiers.slice(1);
	const routes = recordOf(next.routes);
	const wroteRoutes: Record<string, readonly string[]> = {};
	if (fallback.length > 0) {
		for (const spec of ROUTED_AWAY) {
			if (routes[spec] !== undefined) continue;
			routes[spec] = [...fallback];
			wroteRoutes[spec] = fallback;
		}
	}
	next = withSection(next, "routes", routes);
	const backups = new Backups(files.home, files.now ?? new Date());
	backups.save(path);
	writeJsonFile(path, next);
	if (envFileValue(readText(files.envFile), judge.keyVariable) !== options.key) {
		backups.save(files.envFile);
		writeEnvValue(files.envFile, judge.keyVariable, options.key);
	}
	writeState(paths, {
		port: options.port,
		previousTiers: before,
		judgeWasOff,
		wroteEntry: entry || undefined,
		wroteRoutes: Object.keys(wroteRoutes).length > 0 ? wroteRoutes : undefined,
	});
	return tiers;
}

/** Takes mude out of the order: the judges behind it go first again, or the ones from before it was enabled. */
export function disableMude(paths: MudePaths, files: ConfigFiles, options: { removeEntry?: boolean } = {}): string[] {
	return disableLocal(MUDE_JUDGE, paths, files, options);
}

/** Takes `judge` out of the order: the judges behind it go first again, or the ones from before it was enabled. */
export function disableLocal(
	judge: LocalJudge,
	paths: MudePaths,
	files: ConfigFiles,
	options: { removeEntry?: boolean } = {},
): string[] {
	const { path, config } = readConfig(files);
	const state = readState(paths);
	const rest = tiersOf(config).filter((tier) => tier !== judge.name);
	const tiers = rest.length > 0 ? rest : [...(state?.previousTiers ?? ["jev"])];
	let next = withTiers(withoutOwnRoutes(config, state), tiers);
	if (state?.judgeWasOff) next = withJudge(next, false);
	if (options.removeEntry && state?.wroteEntry) {
		const judges = judgesOf(next);
		delete judges[judge.name];
		next = withSection(next, "judges", judges);
	}
	new Backups(files.home, files.now ?? new Date()).save(path);
	writeJsonFile(path, next);
	if (state) {
		writeState(paths, {
			...state,
			judgeWasOff: undefined,
			wroteRoutes: undefined,
			wroteEntry: options.removeEntry ? undefined : state.wroteEntry,
		});
	}
	return tiers;
}

function readText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}
