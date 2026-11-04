import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * The write floor: the commands the agent runs can write only to the project, the temporary folders and package
 * caches, and the project's `.git/hooks` and `.git/config` stay read-only. The operating system holds to it (Seatbelt
 * on macOS, bubblewrap on Linux), so it does not depend on any judgment being right: a script the agent wrote and a
 * judge approved as `npm test` cannot change `~/.zshrc`. Design and measurements: kyrn/docs/13-local-write-sandbox.md.
 */
export interface Floor {
	/** The project, as a real path. */
	readonly project: string;
	/** Every folder a command may write, real paths, the project first. */
	readonly writable: readonly string[];
	/** Inside the project, what stays read-only. */
	readonly readOnly: readonly string[];
}

/** Package managers' caches under the home folder: without them `npm install` fails on `~/.npm/_cacache`. */
export const CACHE_FOLDERS: readonly string[] = [
	".npm",
	".cache",
	"Library/Caches",
	".cargo/registry",
	".cargo/git",
	"go/pkg/mod",
	".gradle/caches",
	".m2/repository",
	".pnpm-store",
	".bun/install/cache",
	".yarn/berry/cache",
];

export interface FloorPlace {
	readonly home?: string;
	/** The temporary folders. Default: the system's, and `/tmp`. */
	readonly tmp?: readonly string[];
	/** More folders the user lets commands write (`features.confine.writable`). */
	readonly extra?: readonly string[];
	readonly platform?: NodeJS.Platform;
	/** mu's own folder, which nothing may make writable. */
	readonly muHome?: string;
}

const real = (path: string): string | undefined => {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
};

const inside = (path: string, folder: string): boolean =>
	path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

/** The floor for a project, or why there can be none: a project that is the home folder or `/` is everything. */
export function floorFor(cwd: string, place: FloorPlace = {}): Floor | { readonly problem: string } {
	const home = real(place.home ?? homedir()) ?? place.home ?? homedir();
	const project = real(cwd);
	if (!project) return { problem: `the project folder ${cwd} does not exist` };
	if (dirname(project) === project || inside(home, project))
		return { problem: `the project folder ${project} holds the home folder, so the floor would cover nothing` };
	const muHome = real(place.muHome ?? join(home, ".mu"));
	const platform = place.platform ?? process.platform;
	const temporary = place.tmp ?? [tmpdir(), "/tmp", ...(platform === "darwin" ? ["/private/var/folders"] : [])];
	const caches = CACHE_FOLDERS.map((folder) => join(home, folder));
	const writable = [project];
	for (const folder of [...temporary, ...caches, ...(place.extra ?? [])]) {
		const path = real(folder);
		if (!path || writable.includes(path)) continue;
		// The home folder, and mu's own settings, never become writable this way.
		if (path === home || inside(home, path) || (muHome && (inside(path, muHome) || inside(muHome, path)))) continue;
		writable.push(path);
	}
	const git = join(project, ".git");
	return { project, writable, readOnly: [join(git, "hooks"), join(git, "config")] };
}

/** A string in Seatbelt's profile language. */
const sbpl = (text: string): string => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * The macOS profile: everything allowed but writing, writing allowed in the floor's folders and the few devices a
 * shell uses, and the read-only parts denied again. Seatbelt takes the last rule that matches, so the denial at the end
 * wins inside the writable project.
 */
export function seatbeltProfile(floor: Floor): string {
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		"(allow file-write*",
		...floor.writable.map((folder) => `  (subpath ${sbpl(folder)})`),
		'  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
		'  (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
		"(deny file-write*",
		...floor.readOnly.map((path) => `  (subpath ${sbpl(path)})`),
		")",
		"",
	].join("\n");
}

/**
 * bubblewrap's arguments on Linux: the whole system read-only, the floor's folders bound writable, the read-only
 * parts bound again read-only when they exist. A process namespace of its own: without one, `/proc/<pid>/root` of a
 * process outside leads around the view of the files.
 */
export function bwrapArgs(floor: Floor): string[] {
	return [
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		...floor.writable.flatMap((folder) => ["--bind", folder, folder]),
		...floor.readOnly.flatMap((path) => ["--ro-bind-try", path, path]),
		"--unshare-pid",
		"--die-with-parent",
	];
}

/** How to start a program inside the floor: the runner and its arguments before the program's own. */
export interface Confinement {
	readonly runner: string;
	readonly args: readonly string[];
}

/** Single-quoted for a POSIX shell. */
export const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * A command line that runs `command` in `shell` inside the floor, for a shell that already runs it: the outer shell
 * gives its process to the runner (`exec`), so stopping the call stops what runs inside.
 */
export function confinedCommand(
	confinement: Confinement,
	shell: string,
	shellArgs: readonly string[],
	command: string,
): string {
	return ["exec", confinement.runner, ...confinement.args, shell, ...shellArgs, command].map(shellQuote).join(" ");
}

/**
 * The runner for this platform. Undefined where there is none (Windows). The macOS profile goes on the command line, not
 * in a file: a file in a writable folder could be rewritten by the command it confines, for the next one.
 */
export function confinement(floor: Floor, platform: NodeJS.Platform = process.platform): Confinement | undefined {
	if (platform === "darwin") return { runner: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile(floor)] };
	if (platform === "linux") return { runner: "bwrap", args: [...bwrapArgs(floor), "--"] };
	return undefined;
}

/** How a refused write reads: Seatbelt says EPERM, a read-only bind of bubblewrap says EROFS. */
const REFUSED = /operation not permitted|\bEPERM\b|read-only file system|\bEROFS\b/i;

/** The paths a refusal line names: quoted ones, then bare ones; a program's own name at the start is not one. */
function namedPaths(line: string): string[] {
	const quoted = [...line.matchAll(/'([^']+)'|"([^"]+)"|‘([^’]+)’/g)].map((match) => match[1] ?? match[2] ?? match[3]);
	const bare = [...line.matchAll(/(?:^|[\s(])((?:\/|\.{1,2}\/|\.git\/)[^\s:'",)]*)/g)]
		.filter((match) => !(match.index === 0 && line.slice(match[0].length).startsWith(":")))
		.map((match) => match[1]);
	return [...quoted, ...bare].filter((path): path is string => Boolean(path && /\//.test(path)));
}

/** A path with its existing part resolved to its real location: a file that was never made has no real path of its own. */
function realAsFarAsItExists(path: string): string {
	const found = real(path);
	if (found) return found;
	const parent = dirname(path);
	return parent === path ? path : join(realAsFarAsItExists(parent), basename(path));
}

/** A write the floor refused, as a command's output tells it. */
export interface RefusedWrite {
	/** The path as the output names it, made absolute. */
	readonly path: string;
	/** In one of the project's read-only parts, rather than outside every writable folder. */
	readonly readOnly: boolean;
}

/**
 * The writes in a confined command's output that the floor refused: a path on a line that says the operating system
 * refused it, outside every writable folder or in a read-only part. A path the floor lets through is not one: its
 * refusal came from somewhere else.
 */
export function refusedWrites(output: string, floor: Floor, cwd: string): RefusedWrite[] {
	const found = new Map<string, RefusedWrite>();
	for (const line of output.split("\n")) {
		if (!REFUSED.test(line)) continue;
		for (const named of namedPaths(line)) {
			const path = resolve(cwd, named);
			// The floor's folders are real paths; `/tmp/x` is `/private/tmp/x` on macOS.
			const where = realAsFarAsItExists(path);
			const readOnly = floor.readOnly.some((part) => inside(where, part));
			if (readOnly || !floor.writable.some((folder) => inside(where, folder))) found.set(path, { path, readOnly });
		}
	}
	return [...found.values()];
}

/**
 * The line a command's result gets when the floor refused some of its writes, so the model knows why and does not look
 * for another way to make the same change. `wayOut`: the permission gate is there to decide `outside: true`, so the
 * line names it.
 */
export function refusalNote(refused: readonly RefusedWrite[], floor: Floor, wayOut = false): string | undefined {
	if (refused.length === 0) return undefined;
	const shown = (paths: readonly RefusedWrite[]) =>
		paths
			.slice(0, 3)
			.map((write) => (inside(write.path, floor.project) ? relative(floor.project, write.path) : write.path))
			.join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
	const outside = refused.filter((write) => !write.readOnly);
	const readOnly = refused.filter((write) => write.readOnly);
	const out =
		"If the task needs this write, run the command again with outside: true and a reason: it then runs outside the sandbox, once, if the judge or the user allows it.";
	const lines: string[] = [];
	if (outside.length > 0)
		lines.push(
			`[mu write sandbox: ${shown(outside)} ${outside.length === 1 ? "is" : "are"} outside what commands may write here (this project, the temporary folders and package caches), so the write was refused. ${wayOut ? `Do the work inside the project if you can. ${out} A folder the task keeps needing, the user can allow with features.confine.writable.` : "Do the work inside the project, or tell the user which folder the task needs: they can allow it with features.confine.writable."}]`,
		);
	if (readOnly.length > 0)
		lines.push(
			`[mu write sandbox: ${shown(readOnly)} ${readOnly.length === 1 ? "is" : "are"} read-only here, as .git/hooks and .git/config always are, so the write was refused. ${wayOut ? out : "Commands such as git config and git remote add need the user: tell them what to run."}]`,
		);
	return lines.join("\n");
}

/** A floor ready to confine commands with, or why it cannot start here. */
export type FloorReady =
	| { readonly ok: true; readonly floor: Floor; readonly confinement: Confinement }
	| { readonly ok: false; readonly reason: string };

/** The floor for a project, tried once here: a floor that cannot start is reported, never skipped. */
export async function prepareFloor(
	cwd: string,
	place: FloorPlace = {},
	tryIt: (how: Confinement) => Promise<{ ok: true } | { ok: false; reason: string }> = probe,
): Promise<FloorReady> {
	const platform = place.platform ?? process.platform;
	const floor = floorFor(cwd, place);
	if ("problem" in floor) return { ok: false, reason: floor.problem };
	const how = confinement(floor, platform);
	if (!how) return { ok: false, reason: `mu has no write sandbox on ${platform}` };
	const tried = await tryIt(how);
	return tried.ok ? { ok: true, floor, confinement: how } : { ok: false, reason: tried.reason };
}

/** Whether `confinement` starts a program here: `true` run inside it. Its error output says why not. */
export function probe(how: Confinement, timeoutMs = 5000): Promise<{ ok: true } | { ok: false; reason: string }> {
	const program = existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";
	return new Promise((resolve) => {
		execFile(how.runner, [...how.args, program], { timeout: timeoutMs }, (error, _stdout, stderr) => {
			if (!error) return resolve({ ok: true });
			const said = String(stderr).trim().split("\n")[0] || error.message;
			resolve({ ok: false, reason: `${how.runner} could not start a program: ${said}` });
		});
	});
}
