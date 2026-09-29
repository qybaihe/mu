// Types of mu.mjs, for the tests that call its functions with win32, linux and WSL parameters.
import type { PlatformPath } from "node:path";

export type Platform = NodeJS.Platform;
export type Env = Readonly<Record<string, string | undefined>>;

export const MIN_NODE: readonly [number, number];
export function nodeVersionOk(version: string): boolean;
export function pathFor(platform: Platform): PlatformPath;
export function muEnv(name: string, env: Env): string | undefined;
export function muHome(host: { home: string; platform: Platform; isDir(path: string): boolean }): string;
export function detectWsl(host: { platform: Platform; env: Env; procVersion?: string }): boolean;
export function platformName(host: { platform: Platform; wsl?: boolean }): string;
export function usage(platform: Platform): string;

export function parseEnvFile(text: string): { entries: [string, string][]; problems: number[] };
export function envFileAdditions(input: {
	env: Env;
	entries: readonly (readonly [string, string])[];
	platform: Platform;
}): Record<string, string>;

export type ViewKind = "symlink" | "junction" | "copy";
export function appViewPlan(platform: Platform): { name: string; kind: ViewKind }[];
export function appPackageJson(upstreamText: string): string;
export function ensureAppView(input: {
	platform: Platform;
	app: string;
	upstream: string;
	fs?: Record<string, (...args: never[]) => unknown>;
}): string[];

export function resolveTsx(input: {
	root: string;
	platform: Platform;
	exists(path: string): boolean;
	readFile(path: string): string;
}): string | undefined;
export function installHint(input: { root: string; platform: Platform }): string;
export type Layout = "repo" | "package";
export function layoutOf(input: { root: string; platform: Platform; exists(path: string): boolean }): Layout;
export function packageEntries(input: { root: string; platform: Platform }): {
	cli: string;
	extension: string;
	auth: string;
	import: string;
	setup: string;
};
export function envFilePath(input: { layout: Layout; root: string; muDir: string; platform: Platform }): string;
export function agentDirFor(input: { env: Env; muDir: string; platform: Platform }): string;
export function wantsLaya(input: {
	env: Env;
	agentDir: string;
	platform: Platform;
	readFile(path: string): string;
}): boolean;
export function localJudgeSupport(input: { platform: Platform; env: Env; wsl?: boolean }): {
	runs: boolean;
	url?: string;
	message?: string;
};
export function launchStrategy(input: { platform: Platform; env: Env; canExec: boolean }): "exec" | "spawn";

export interface LaunchPlan {
	error?: undefined;
	command: string;
	args: string[];
	env: Record<string, string>;
	strategy: "exec" | "spawn";
	layout: Layout;
	muDir: string;
	/** PI_PACKAGE_DIR: the view at <home>/app for a checkout, the package itself for mu-agent. */
	appDir: string;
	agentDir: string;
	startJudge: boolean;
	notes: string[];
	preface?: string;
}
export function planLaunch(input: {
	platform: Platform;
	env: Env;
	argv: readonly string[];
	root: string;
	home: string;
	execPath: string;
	canExec?: boolean;
	wsl?: boolean;
	/** Whether the Node that runs mu strips TypeScript types itself (process.features.typescript). Default true. */
	stripsTypes?: boolean;
	fs: { exists(path: string): boolean; isDir(path: string): boolean; readFile(path: string): string };
}): LaunchPlan | { error: string };

/** How pi runs inside a process of another program (the desktop app's runtime host): see planHost in mu.mjs. */
export interface HostPlan {
	error?: undefined;
	/** The module to import pi's `setupCli` and `main` from: pi's bundle in the package, its sources in a checkout. */
	module: string;
	/** The Node flags the host process starts with: a checkout's source resolver and compile cache, none for the package. */
	execArgv: string[];
	/** pi's arguments: the judgment layer, then the ones asked for. */
	args: string[];
	env: Record<string, string>;
	layout: Layout;
	muDir: string;
	/** PI_PACKAGE_DIR: the view at <home>/app for a checkout, the package itself for mu-agent. */
	appDir: string;
	agentDir: string;
	startJudge: boolean;
	notes: string[];
}
export function planHost(input: {
	platform: Platform;
	env: Env;
	argv: readonly string[];
	root: string;
	home: string;
	wsl?: boolean;
	/** Whether the host's Node strips TypeScript types itself (process.features.typescript). Default true. */
	stripsTypes?: boolean;
	fs: { exists(path: string): boolean; isDir(path: string): boolean; readFile(path: string): string };
}): HostPlan | { error: string };

/**
 * What is done before pi starts, for the command line and the app's host alike: the app view of a checkout, mu's agent
 * folder, the configuration's notes and the local judge. `bin` is the launcher's folder (kyrn/bin).
 */
export function prepareLaunch(input: PrepareLaunchInput): void;

/**
 * prepareLaunch for a program that must not stop while the local judge starts (the desktop app's main process): the
 * same steps and notes, the local judge started through a child process that is waited for without blocking.
 */
export function prepareLaunchAsync(input: PrepareLaunchInput): Promise<void>;

export interface PrepareLaunchInput {
	plan: Pick<HostPlan, "layout" | "appDir" | "agentDir" | "notes" | "startJudge" | "env">;
	platform: Platform;
	root: string;
	bin: string;
	err(message: string): void;
}

/** Node's arguments for running a checkout's TypeScript, up to the entry file. */
export function sourceRuntime(input: {
	root: string;
	platform: Platform;
	stripsTypes: boolean;
	exists(path: string): boolean;
	readFile(path: string): string;
}): { error?: undefined; args: string[] } | { error: string };

export const AUTH_COMMANDS: readonly string[];
export interface AuthPlan {
	error?: undefined;
	command: string;
	args: string[];
	env: Record<string, string>;
	strategy: "exec" | "spawn";
	agentDir: string;
}
export function planAuth(input: {
	platform: Platform;
	env: Env;
	argv: readonly string[];
	root: string;
	home: string;
	execPath: string;
	canExec?: boolean;
	/** Whether the Node that runs mu strips TypeScript types itself (process.features.typescript). Default true. */
	stripsTypes?: boolean;
	fs: { exists(path: string): boolean; isDir(path: string): boolean; readFile(path: string): string };
}): AuthPlan | { error: string };

export type JudgePlan =
	| { kind: "script"; command: string; args: string[] }
	| { kind: "health"; url: string }
	| { kind: "unsupported"; message: string };
export function planJudge(input: {
	platform: Platform;
	env: Env;
	argv: readonly string[];
	bin: string;
	wsl?: boolean;
}): JudgePlan;

export function planImport(input: {
	platform: Platform;
	env: Env;
	argv: readonly string[];
	root: string;
	home: string;
	execPath: string;
	/** Whether the Node that runs mu strips TypeScript types itself (process.features.typescript). Default true. */
	stripsTypes?: boolean;
	fs: { exists(path: string): boolean; isDir(path: string): boolean; readFile(path: string): string };
}): { error?: undefined; command: string; args: string[]; env: Record<string, string>; agentDir: string } | { error: string };

export const SETUP_DECLINED_FILE: string;
export const SETUP_EXIT_START: number;
export const SETUP_EXIT_CANCELLED: number;
export const SETUP_VALUE_FLAGS: readonly string[];
export const MODEL_KEY_VARIABLES: readonly string[];
export interface SetupPlan {
	error?: undefined;
	command: string;
	args: string[];
	env: Record<string, string>;
	strategy: "spawn";
	agentDir: string;
	/** A key came on the command line; it is in env.MU_SETUP_KEY, and never in args. */
	keyGiven: boolean;
}
export function planSetup(input: {
	platform: Platform;
	env: Env;
	argv: readonly string[];
	root: string;
	home: string;
	execPath: string;
	/** Whether the Node that runs mu strips TypeScript types itself (process.features.typescript). Default true. */
	stripsTypes?: boolean;
	fs: { exists(path: string): boolean; isDir(path: string): boolean; readFile(path: string): string };
}): SetupPlan | { error: string; code?: number };
export function planFirstRun(input: {
	platform: Platform;
	env: Env;
	argv: readonly string[];
	/** stdin and stdout are both terminals. */
	interactive: boolean;
	agentDir: string;
	/** The .env the launcher reads, when there is one. */
	envText?: string;
	fs: { exists(path: string): boolean; readFile(path: string): string };
}): boolean;

export function linkPath(input: { platform: Platform; env: Env; home: string }): string;
export function shimContent(input: { linkDir: string; bin: string }): string;
export function findOnPath(input: {
	name: string;
	platform: Platform;
	env: Env;
	isFile(path: string): boolean;
}): string | undefined;
export function onPath(input: { dir: string; platform: Platform; env: Env }): boolean;
export type LinkPlan =
	| { action: "refuse"; errors: string[] }
	| { action: "link"; link: string; target: string; content?: string; message: string; notes: string[] };
export function planLink(input: {
	platform: Platform;
	env: Env;
	home: string;
	bin: string;
	argv: readonly string[];
	fs: {
		realPath(path: string): string;
		exists(path: string): boolean;
		isFile(path: string): boolean;
		readFile(path: string): string;
	};
}): LinkPlan;
export function planUnlink(input: {
	platform: Platform;
	env: Env;
	home: string;
	fs: { isLink(path: string): boolean; readFile(path: string): string };
}): { remove?: string; message: string };
export function linkState(input: {
	platform: Platform;
	link: string;
	bin: string;
	fs: { readFile(path: string): string; readlink(path: string): string };
}): string | undefined;

export interface ProcessRow {
	pid: number;
	name: string;
	command: string;
}
export interface Busy {
	sessions: number[];
	browser: number[];
	desktop: number[];
}
export function parseCsv(text: string): string[][];
export function parseTasklist(text: string): ProcessRow[];
export function parseWindowsProcesses(text: string): ProcessRow[];
export function busyFromProcesses(input: {
	processes: readonly ProcessRow[];
	old: string;
	platform: Platform;
	self: number;
}): Busy;
export function findBusy(input: {
	platform: Platform;
	old: string;
	self: number;
	run(command: string, args: string[]): string | undefined;
}): Busy | undefined;
export function migrate(input: {
	platform: Platform;
	home: string;
	argv: readonly string[];
	self: number;
	run(command: string, args: string[]): string | undefined;
	alive(pid: number): boolean;
	out(line: string): void;
	err(line: string): void;
	fs: {
		isLink(path: string): boolean;
		isDir(path: string): boolean;
		exists(path: string): boolean;
		readlink(path: string): string;
		readFile(path: string): string;
		rename(from: string, to: string): void;
		link(target: string, at: string, kind: "junction" | "dir"): void;
	};
}): number;

export function main(argv?: string[]): Promise<number>;
