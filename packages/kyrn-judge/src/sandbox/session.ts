import { posix } from "node:path";
import { decodeStream, type OperationResponse, type SandboxClient, type StagedFile } from "./client.ts";
import { diffstat, type FileStat, type SeedArchive, seedArchive } from "./project.ts";

/** Where the project archive is put for the seeding operation, and where a pull leaves its patch. */
const SEED_ARCHIVE = "/tmp/mu-sandbox-seed.tgz";
const PATCH_FILE = "/tmp/mu-sandbox.patch";
/** The sandbox's git tag on the seeded project: the first base a pull diffs against. */
const SEED_TAG = "mu-base";
const GIT_IDENTITY = "-c user.name=mu -c user.email=mu@sandbox.invalid";
const PULL_TIMEOUT_S = 300;

export interface SandboxSessionOptions {
	readonly client: SandboxClient;
	/** The local project folder that is copied into `workdir`. */
	readonly root: string;
	/** An image UUID, `tag:<name>`, or `docker://<reference>` to import first. */
	readonly image: string;
	/** Where the project lives in the sandbox, e.g. "/workspace". */
	readonly workdir: string;
	/** The shell commands run in (the API's `SHELL`), e.g. "/bin/bash". */
	readonly shell: string;
	readonly seedTimeoutS: number;
	readonly maxSeedBytes: number;
	/** Bytes of stdout and of stderr the API records per command. */
	readonly outputBytes: number;
	/** For tests: how the project is packed. */
	readonly pack?: (root: string, maxBytes: number) => Promise<SeedArchive>;
}

interface Staged extends StagedFile {
	readonly mode: string;
	readonly content: Buffer;
}

export interface ExecResult {
	/** Null when the process ended without one and without a signal. */
	readonly exitCode: number | null;
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly timedOut: boolean;
	/** What the person and the model should know besides the output: truncation, a failed operation. */
	readonly notes: readonly string[];
}

export interface PullPlan {
	/** A git patch (`git diff --binary`), paths relative to the project root. Empty when nothing changed. */
	readonly patch: Buffer;
	readonly stats: readonly FileStat[];
	/** The sandbox commit the patch leads to. */
	readonly commit: string;
}

export interface SandboxStatus {
	readonly state: "new" | "seeding" | "ready" | "failed";
	readonly root: string;
	readonly baseImage?: string;
	readonly seedImage?: string;
	readonly head?: string;
	readonly operations: number;
	readonly cost: number;
	readonly staged: number;
	readonly seeded?: { readonly files: number; readonly bytes: number; readonly fromGit: boolean };
	/** What a pull diffs against, or why there is no pull. */
	readonly pull: { readonly base: string } | { readonly problem: string };
	readonly lastError?: string;
}

/** A file the sandbox does not have. Carries `code` like a filesystem error, which the edit tool reports. */
export class SandboxFileMissing extends Error {
	readonly code = "ENOENT";
	constructor(path: string) {
		super(`ENOENT: no such file in the sandbox: ${path}`);
		this.name = "SandboxFileMissing";
	}
}

/** A string as one single-quoted shell word. */
export function shellQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

function seedScript(workdir: string): string {
	return [
		"set -e",
		`mkdir -p ${shellQuote(workdir)}`,
		`cd ${shellQuote(workdir)}`,
		`tar -xzf ${SEED_ARCHIVE}`,
		`rm -f ${SEED_ARCHIVE}`,
		// The pull needs git; an image without it gets it when its package manager can.
		"if ! command -v git >/dev/null 2>&1; then",
		"  if command -v apt-get >/dev/null 2>&1; then",
		"    (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git ca-certificates) >/dev/null 2>&1 || true",
		"  elif command -v apk >/dev/null 2>&1; then",
		"    apk add --no-cache -q git >/dev/null 2>&1 || true",
		"  fi",
		"fi",
		`if command -v git >/dev/null 2>&1 && git init -q && git add -A && git ${GIT_IDENTITY} commit -q --no-verify --allow-empty -m "mu sandbox seed" && git tag -f ${SEED_TAG} >/dev/null; then`,
		'  echo "mu-seed-git:$(git rev-parse HEAD)"',
		"fi",
	].join("\n");
}

function pullScript(workdir: string, base: string): string {
	return [
		"set -e",
		`cd ${shellQuote(workdir)}`,
		"git add -A",
		`if ! git diff --cached --quiet HEAD; then git ${GIT_IDENTITY} commit -q --no-verify -m "mu sandbox pull"; fi`,
		`git diff --binary --full-index --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ ${shellQuote(base)} HEAD > ${PATCH_FILE}`,
		"git rev-parse HEAD",
	].join("\n");
}

/** What went wrong with an operation, in one line. */
function describeOperation(operation: OperationResponse): string {
	const state = operation.metadata?.result?.state;
	const parts = [`operation ${operation.uuid} ${operation.status}`];
	if (operation.error) parts.push(operation.error);
	if (state?.timed_out) parts.push("timed out");
	if (typeof state?.exit_code === "number") parts.push(`exit code ${state.exit_code}`);
	if (typeof state?.signal === "number" && state.signal > 0) parts.push(`signal ${state.signal}`);
	return parts.join(", ");
}

function tail(buffer: Buffer, chars = 600): string {
	const text = buffer.toString("utf8").trim();
	return text.length <= chars ? text : `…${text.slice(-chars)}`;
}

/** Waits for `work`, or throws "aborted" when `signal` fires first. The work itself carries on. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * One project in one sandbox, as a chain of images. Nothing runs between commands, so the state is
 * the image the next command starts from (`head`) plus the files written since (`staged`):
 *
 *   seed: base image + project archive -> extract into workdir, git commit -> seed image = head
 *   write/edit: upload the bytes, remember them as staged (read sees them at once)
 *   bash: head + staged files -> run -> result image = head, staged files it carried are done
 *
 * Commands and pulls run one at a time, since each starts from the head the previous one left.
 */
export class SandboxSession {
	private readonly client: SandboxClient;
	private readonly options: SandboxSessionOptions;
	private readonly staged = new Map<string, Staged>();
	private seeding: Promise<void> | undefined;
	private chain: Promise<unknown> = Promise.resolve();
	/** The last file read from an image, so the read tool's access check and read cost one download. */
	private lastRead: { image: string; path: string; data: Buffer | undefined } | undefined;
	private baseImage: string | undefined;
	private seedImage: string | undefined;
	private head: string | undefined;
	private gitBase: string | undefined;
	private gitProblem: string | undefined;
	private seeded: SandboxStatus["seeded"];
	private operations = 0;
	private cost = 0;
	private lastError: string | undefined;

	constructor(options: SandboxSessionOptions) {
		this.client = options.client;
		this.options = options;
	}

	get root(): string {
		return this.options.root;
	}

	get workdir(): string {
		return this.options.workdir;
	}

	status(): SandboxStatus {
		return {
			state: this.head ? "ready" : this.seeding ? "seeding" : this.lastError ? "failed" : "new",
			root: this.options.root,
			baseImage: this.baseImage,
			seedImage: this.seedImage,
			head: this.head,
			operations: this.operations,
			cost: this.cost,
			staged: this.staged.size,
			seeded: this.seeded,
			pull: this.gitBase ? { base: this.gitBase } : { problem: this.gitProblem ?? "the sandbox is not seeded yet" },
			lastError: this.lastError,
		};
	}

	/**
	 * Seeds the sandbox once: the first caller starts it, later ones wait for the same work. A failure is
	 * reported to everyone waiting and the next call tries again. An abort stops the wait, not the seeding.
	 */
	ready(signal?: AbortSignal): Promise<void> {
		if (this.head) return Promise.resolve();
		if (!this.seeding) {
			const seeding = this.seed().then(
				() => {
					this.seeding = undefined;
				},
				(error: unknown) => {
					this.seeding = undefined;
					this.lastError = error instanceof Error ? error.message : String(error);
					throw error;
				},
			);
			// Whoever stopped waiting must not leave the failure unhandled.
			seeding.catch(() => undefined);
			this.seeding = seeding;
		}
		return untilAborted(this.seeding, signal);
	}

	private async seed(): Promise<void> {
		const { client, options } = this;
		const base = options.image.startsWith("docker://") ? await client.importImage(options.image) : options.image;
		this.baseImage = base;
		const pack = await (options.pack ?? seedArchive)(options.root, options.maxSeedBytes);
		const archive = await client.upload(pack.archive);
		const operation = await client.run({
			image: base,
			command: seedScript(options.workdir),
			shell: true,
			cwd: "/",
			env: { SHELL: options.shell },
			timeout: options.seedTimeoutS,
			disposable: false,
			files: { [SEED_ARCHIVE]: { uuid: archive, mode: "0644" } },
			truncate_output_at: 65_536,
		});
		this.account(operation);
		const result = operation.metadata?.result;
		if (operation.status !== "SUCCESS" || result?.state?.exit_code !== 0 || !operation.result_image_uuid) {
			const said = tail(decodeStream(result?.stderr));
			throw new Error(`Seeding the sandbox failed (${describeOperation(operation)})${said ? `: ${said}` : ""}`);
		}
		const commit = /mu-seed-git:([0-9a-f]{40})/.exec(decodeStream(result.stdout).toString("utf8"))?.[1];
		this.gitBase = commit ? SEED_TAG : undefined;
		this.gitProblem = commit ? undefined : "git is not available in the sandbox image, so nothing can be diffed";
		this.seedImage = operation.result_image_uuid;
		this.head = operation.result_image_uuid;
		this.seeded = { files: pack.files, bytes: pack.bytes, fromGit: pack.fromGit };
		this.lastError = undefined;
	}

	private account(operation: OperationResponse): void {
		this.operations++;
		const cost = operation.metadata?.result?.resources?.cost;
		if (typeof cost === "number" && Number.isFinite(cost)) this.cost += cost;
	}

	private locked<T>(work: () => Promise<T>): Promise<T> {
		const run = this.chain.then(work, work);
		this.chain = run.catch(() => undefined);
		return run;
	}

	private stagedFiles(staged: readonly [string, Staged][]): Record<string, StagedFile> {
		return Object.fromEntries(staged.map(([path, file]) => [path, { uuid: file.uuid, mode: file.mode }]));
	}

	/** The operation left an image: it is the new head, and the staged files it carried are in it. */
	private advance(image: string, carried: readonly [string, Staged][]): void {
		this.head = image;
		for (const [path, file] of carried) if (this.staged.get(path) === file) this.staged.delete(path);
	}

	/** Runs a shell command in `cwd` of the sandbox, on top of everything written so far. */
	async exec(command: string, cwd: string, run: { signal?: AbortSignal; timeoutS: number }): Promise<ExecResult> {
		await this.ready(run.signal);
		return this.locked(async () => {
			const head = this.head;
			if (!head) throw new Error("The sandbox is not seeded");
			const carried = [...this.staged];
			const operation = await this.client.run(
				{
					image: head,
					command,
					shell: true,
					cwd,
					env: { SHELL: this.options.shell },
					timeout: Math.max(1, Math.ceil(run.timeoutS)),
					disposable: false,
					files: this.stagedFiles(carried),
					truncate_output_at: this.options.outputBytes,
				},
				run.signal,
			);
			this.account(operation);
			// Like a local command, one that failed or timed out keeps what it changed.
			if (operation.result_image_uuid) this.advance(operation.result_image_uuid, carried);
			const result = operation.metadata?.result;
			const state = result?.state;
			const exitCode = typeof state?.exit_code === "number" ? state.exit_code : undefined;
			const signal = typeof state?.signal === "number" && state.signal > 0 ? state.signal : undefined;
			if (operation.status === "CANCELLED") throw new Error(`The sandbox ${describeOperation(operation)}`);
			if (operation.status === "FAILED" && exitCode === undefined && signal === undefined && !state?.timed_out) {
				throw new Error(`The sandbox ${describeOperation(operation)}`);
			}
			const notes: string[] = [];
			for (const [name, stream] of [
				["stdout", result?.stdout],
				["stderr", result?.stderr],
			] as const) {
				if (stream?.truncated) notes.push(`${name} was cut at ${this.options.outputBytes} bytes by the sandbox`);
			}
			if (operation.status === "FAILED") notes.push(describeOperation(operation));
			if (!operation.result_image_uuid) notes.push("the sandbox kept no filesystem state from this command");
			return {
				exitCode: signal !== undefined ? 128 + signal : (exitCode ?? null),
				stdout: decodeStream(result?.stdout),
				stderr: decodeStream(result?.stderr),
				timedOut: state?.timed_out === true,
				notes,
			};
		});
	}

	/** A file as the next command would see it. Throws `SandboxFileMissing` when there is none. */
	async readFile(path: string, signal?: AbortSignal): Promise<Buffer> {
		const staged = this.staged.get(path);
		if (staged) return staged.content;
		await this.ready(signal);
		const head = this.head as string;
		const cached = this.lastRead;
		const data =
			cached && cached.image === head && cached.path === path
				? cached.data
				: await this.client.download(head, path, signal);
		this.lastRead = { image: head, path, data };
		if (!data) throw new SandboxFileMissing(path);
		return data;
	}

	/** Writes a file for the next command: uploaded now, put in place when a command or a pull runs. */
	async writeFile(path: string, content: string, signal?: AbortSignal): Promise<void> {
		await this.ready(signal);
		const data = Buffer.from(content, "utf8");
		const uuid = await this.client.upload(data, signal);
		const mode = this.staged.get(path)?.mode ?? (await this.modeOf(path, signal)) ?? "0644";
		this.staged.set(path, { uuid, mode, content: data });
	}

	/** The permission bits a file has in the head image, so rewriting a script keeps it executable. */
	private async modeOf(path: string, signal?: AbortSignal): Promise<string | undefined> {
		try {
			const entries = await this.client.list(this.head as string, posix.dirname(path), signal);
			const entry = entries?.find((item) => item.path === posix.basename(path) && item.is_regular);
			return entry ? (entry.mode & 0o7777).toString(8).padStart(4, "0") : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Everything that changed in the sandbox since the last pull (or the seed), as a git patch. `decide`
	 * sees it while nothing else runs; when it says the patch was applied here, that state becomes the base
	 * of the next pull. Otherwise the sandbox is left as it was.
	 */
	async pull(decide: (plan: PullPlan) => Promise<boolean>, signal?: AbortSignal): Promise<PullPlan> {
		await this.ready(signal);
		return this.locked(async () => {
			const base = this.gitBase;
			if (!base) throw new Error(`Cannot pull: ${this.gitProblem ?? "the sandbox is not seeded"}`);
			const head = this.head as string;
			const carried = [...this.staged];
			const operation = await this.client.run(
				{
					image: head,
					command: pullScript(this.options.workdir, base),
					shell: true,
					cwd: "/",
					env: { SHELL: this.options.shell },
					timeout: PULL_TIMEOUT_S,
					disposable: false,
					files: this.stagedFiles(carried),
					truncate_output_at: 65_536,
				},
				signal,
			);
			this.account(operation);
			const result = operation.metadata?.result;
			const commit = /([0-9a-f]{40})\s*$/.exec(decodeStream(result?.stdout).toString("utf8"))?.[1];
			const image = operation.result_image_uuid;
			if (operation.status !== "SUCCESS" || result?.state?.exit_code !== 0 || !commit || !image) {
				const said = tail(decodeStream(result?.stderr));
				throw new Error(`Diffing the sandbox failed (${describeOperation(operation)})${said ? `: ${said}` : ""}`);
			}
			const patch = await this.client.download(image, PATCH_FILE, signal);
			if (!patch) throw new Error(`The sandbox wrote no patch at ${PATCH_FILE}`);
			const plan: PullPlan = { patch, stats: diffstat(patch.toString("utf8")), commit };
			if (patch.length === 0) return plan;
			if (await decide(plan)) {
				this.advance(image, carried);
				this.gitBase = commit;
			}
			return plan;
		});
	}
}
