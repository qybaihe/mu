import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import type { OperationStatus } from "../../src/sandbox/client.ts";
import { sh } from "./git-repo.ts";

/**
 * An in-memory Nebius sandbox (Contree) API behind a `fetch`, for tests: images are maps of files,
 * operations run a test's handler against a copy of their image, and the two scripts the sandbox
 * session sends itself (seeding and pulling) are carried out here, the pull with real git so the
 * patch it returns is one git can apply.
 */
export interface FakeFile {
	readonly data: Buffer;
	readonly mode: number;
	readonly link?: string;
}

interface FakeImage {
	readonly files: Map<string, FakeFile>;
	/** The workdir's git: commit id -> files (relative paths), the current commit and the tags. */
	readonly gitHead?: string;
	readonly tags: ReadonlyMap<string, string>;
}

export interface FakeRun {
	readonly command: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly timeout?: number;
	/** The operation's filesystem: change it to change the result image. */
	readonly fs: Map<string, FakeFile>;
}

export interface FakeOutcome {
	readonly exitCode?: number | null;
	readonly stdout?: string | Buffer;
	readonly stderr?: string | Buffer;
	readonly encoding?: "ascii" | "base64";
	readonly truncated?: boolean;
	readonly timedOut?: boolean;
	readonly signal?: number;
	readonly status?: OperationStatus;
	readonly error?: string;
	readonly cost?: number;
	/** No result image, as for a disposable run or a platform failure. */
	readonly noImage?: boolean;
	/** Polls answered EXECUTING before the end. Infinity: never ends. Default 1. */
	readonly polls?: number;
}

export type FakeHandler = (run: FakeRun) => FakeOutcome | undefined;

interface FakeOperation {
	readonly uuid: string;
	readonly outcome: FakeOutcome;
	readonly resultImage?: string;
	readonly image: string;
	polls: number;
	status: OperationStatus;
}

export interface FakeRequest {
	readonly method: string;
	readonly path: string;
	readonly query: Readonly<Record<string, string>>;
	readonly headers: Readonly<Record<string, string>>;
	readonly json?: unknown;
}

const BASE_IMAGE = "00000000-0000-4000-8000-000000000001";

function readOctal(block: Buffer, offset: number, length: number): number {
	const text = block
		.toString("ascii", offset, offset + length)
		.replace(/\0.*$/s, "")
		.trim();
	return text ? Number.parseInt(text, 8) : 0;
}

function readText(block: Buffer, offset: number, length: number): string {
	return block.toString("utf8", offset, offset + length).replace(/\0.*$/s, "");
}

/** Reads a tar as `createTar` writes it: files, symlinks and PAX path records. */
export function parseTar(tar: Buffer): { path: string; mode: number; data: Buffer; link?: string }[] {
	const entries: { path: string; mode: number; data: Buffer; link?: string }[] = [];
	let pax: Record<string, string> = {};
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const block = tar.subarray(offset, offset + 512);
		if (block.every((byte) => byte === 0)) break;
		const size = readOctal(block, 124, 12);
		const type = block.toString("ascii", 156, 157);
		const data = tar.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			pax = {};
			for (const record of data.toString("utf8").split("\n").filter(Boolean)) {
				const pair = record.slice(record.indexOf(" ") + 1);
				pax[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
			}
			continue;
		}
		const prefix = readText(block, 345, 155);
		const name = pax.path ?? (prefix ? `${prefix}/${readText(block, 0, 100)}` : readText(block, 0, 100));
		const link = pax.linkpath ?? readText(block, 157, 100);
		pax = {};
		entries.push({
			path: name,
			mode: readOctal(block, 100, 8),
			data: Buffer.from(data),
			link: type === "2" ? link : undefined,
		});
	}
	return entries;
}

function stream(value: string | Buffer | undefined, encoding: "ascii" | "base64", truncated: boolean) {
	const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : (value ?? Buffer.alloc(0));
	return {
		value: encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8"),
		encoding,
		truncated,
	};
}

/** The single-quoted word after `cd ` in a script. */
function cdTarget(command: string): string {
	return /cd '((?:[^']|'\\'')*)'/.exec(command)?.[1]?.replaceAll(`'\\''`, "'") ?? "/";
}

/** The files below `dir`, by path relative to it. */
function snapshot(fs: ReadonlyMap<string, FakeFile>, dir: string): Map<string, FakeFile> {
	const below = new Map<string, FakeFile>();
	for (const [path, file] of fs) if (path.startsWith(`${dir}/`)) below.set(path.slice(dir.length + 1), file);
	return below;
}

function sameFiles(a: ReadonlyMap<string, FakeFile>, b: ReadonlyMap<string, FakeFile>): boolean {
	if (a.size !== b.size) return false;
	for (const [path, file] of a) {
		const other = b.get(path);
		if (!other || !other.data.equals(file.data) || other.mode !== file.mode) return false;
	}
	return true;
}

function writeTree(dir: string, files: ReadonlyMap<string, FakeFile>): void {
	for (const [path, file] of files) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), file.data, { mode: file.mode });
	}
}

export class FakeContree {
	readonly requests: FakeRequest[] = [];
	readonly spawns: Record<string, unknown>[] = [];
	readonly images = new Map<string, FakeImage>();
	readonly tags = new Map<string, string>([["ubuntu:latest", BASE_IMAGE]]);
	/** Uploaded files by uuid. */
	readonly files = new Map<string, Buffer>();
	readonly operations = new Map<string, FakeOperation>();
	private readonly bySha = new Map<string, string>();
	private readonly commits = new Map<string, Map<string, FakeFile>>();
	/** Seconds the poll answers carry in Retry-After; undefined sends none. */
	retryAfter: number | undefined = 2;
	/** Answers the next spawns with 429 this many times. */
	busy = 0;
	/** Answers the next polls with 502 this many times. */
	failingPolls = 0;
	/** Whether the seeding script finds git in the image. */
	gitInImage = true;
	handler: FakeHandler = () => undefined;
	readonly fetch: typeof fetch;

	constructor() {
		this.images.set(BASE_IMAGE, { files: new Map(), tags: new Map() });
		this.fetch = async (input, init) => this.answer(String(input instanceof Request ? input.url : input), init ?? {});
	}

	image(uuid: string): FakeImage {
		const image = this.images.get(uuid);
		if (!image) throw new Error(`no image ${uuid}`);
		return image;
	}

	private resolve(image: string): string | undefined {
		if (image.startsWith("tag:")) return this.tags.get(image.slice(4));
		return this.images.has(image) ? image : undefined;
	}

	private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json", ...headers },
		});
	}

	private async answer(url: string, init: RequestInit): Promise<Response> {
		const parsed = new URL(url);
		const path = parsed.pathname.replace(/^\/sandboxes\/v1/, "");
		const method = init.method ?? "GET";
		const headers = Object.fromEntries(new Headers(init.headers).entries());
		const isJson = headers["content-type"] === "application/json";
		const json = isJson && typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
		this.requests.push({ method, path, query: Object.fromEntries(parsed.searchParams), headers, json });
		if (headers.authorization !== "Bearer test-key" || headers.project !== "test-project") {
			return this.json(401, { error: "bad credentials" });
		}

		if (method === "POST" && path === "/instances") {
			if (this.busy > 0) {
				this.busy--;
				return this.json(429, { error: "too many operations" }, { "Retry-After": "3" });
			}
			return this.spawn(json as Record<string, unknown>);
		}
		const operationPath = /^\/operations\/([^/]+)$/.exec(path);
		if (operationPath) {
			if (method === "GET" && this.failingPolls > 0) {
				this.failingPolls--;
				return new Response("bad gateway", { status: 502 });
			}
			const operation = this.operations.get(operationPath[1]);
			if (!operation) return this.json(404, { error: "no such operation" });
			if (method === "DELETE") {
				operation.status = "CANCELLED";
				return new Response(null, { status: 202 });
			}
			return this.poll(operation);
		}
		if (method === "POST" && path === "/files") {
			const data = Buffer.from(init.body as Uint8Array);
			const sha256 = createHash("sha256").update(data).digest("hex");
			const uuid = this.bySha.get(sha256) ?? randomUUID();
			this.bySha.set(sha256, uuid);
			this.files.set(uuid, data);
			return this.json(201, { uuid, sha256, size: data.length });
		}
		const filePath = /^\/files\/([0-9a-f]{64})$/.exec(path);
		if (filePath) {
			const uuid = this.bySha.get(filePath[1]);
			return uuid ? this.json(200, { uuid, sha256: filePath[1], size: 0 }) : this.json(404, { error: "not found" });
		}
		const inspectPath = /^\/inspect\/([^/]+)\/(download|list)$/.exec(path);
		if (inspectPath) {
			const image = this.images.get(inspectPath[1]);
			const wanted = parsed.searchParams.get("path") ?? "";
			if (!image) return this.json(404, { error: "no such image" });
			if (inspectPath[2] === "download") {
				const file = image.files.get(wanted);
				return file ? new Response(new Uint8Array(file.data)) : this.json(404, { error: "no such file" });
			}
			const prefix = wanted.endsWith("/") ? wanted : `${wanted}/`;
			const files = [...image.files]
				.filter(([file]) => file.startsWith(prefix) && !file.slice(prefix.length).includes("/"))
				.map(([file, entry]) => ({
					path: file.slice(prefix.length),
					size: entry.data.length,
					mode: 0o100000 | entry.mode,
					is_dir: false,
					is_regular: !entry.link,
					is_symlink: Boolean(entry.link),
				}));
			return this.json(200, { path: wanted, files });
		}
		if (method === "GET" && path === "/whoami") {
			return this.json(200, {
				token_uuid: "token-1",
				token_expiration: null,
				permissions: { spawn: true, list: true, cancel: true },
				limits: { instance_max_timeout: 3600, instance_max_concurrency: 50 },
				operations_stat: {},
			});
		}
		if (method === "POST" && path === "/images/import") {
			const uuid = randomUUID();
			const imported = randomUUID();
			this.images.set(imported, { files: new Map(), tags: new Map() });
			this.operations.set(uuid, {
				uuid,
				outcome: { exitCode: 0 },
				resultImage: imported,
				image: imported,
				polls: 0,
				status: "PENDING",
			});
			return this.json(201, { uuid });
		}
		return this.json(404, { error: `no route ${method} ${path}` });
	}

	private spawn(request: Record<string, unknown>): Response {
		this.spawns.push(request);
		const imageId = this.resolve(String(request.image));
		if (!imageId) return this.json(400, { error: `unknown image ${String(request.image)}` });
		const source = this.image(imageId);
		const fs = new Map(source.files);
		for (const [path, staged] of Object.entries(
			(request.files ?? {}) as Record<string, { uuid: string; mode?: string }>,
		)) {
			const data = this.files.get(staged.uuid);
			if (!data) return this.json(400, { error: `unknown file ${staged.uuid}` });
			fs.set(path, { data, mode: Number.parseInt(staged.mode ?? "0644", 8) });
		}
		const run: FakeRun = {
			command: String(request.command),
			cwd: String(request.cwd ?? ""),
			env: (request.env ?? {}) as Record<string, string>,
			timeout: typeof request.timeout === "number" ? request.timeout : undefined,
			fs,
		};
		let git: { head?: string; tags: Map<string, string> } = { head: source.gitHead, tags: new Map(source.tags) };
		let outcome: FakeOutcome;
		if (run.command.includes("tar -xzf /tmp/mu-sandbox-seed.tgz")) {
			({ outcome, git } = this.seed(run));
		} else if (run.command.includes("git diff --binary")) {
			({ outcome, git } = this.pullDiff(run, git));
		} else {
			outcome = this.handler(run) ?? { exitCode: 0 };
		}
		const uuid = randomUUID();
		let resultImage: string | undefined;
		if (!outcome.noImage && request.disposable === false) {
			resultImage = randomUUID();
			this.images.set(resultImage, { files: fs, gitHead: git.head, tags: git.tags });
		}
		this.operations.set(uuid, { uuid, outcome, resultImage, image: imageId, polls: 0, status: "PENDING" });
		return this.json(201, { uuid });
	}

	private seed(run: FakeRun): { outcome: FakeOutcome; git: { head?: string; tags: Map<string, string> } } {
		const archive = run.fs.get("/tmp/mu-sandbox-seed.tgz");
		if (!archive) return { outcome: { exitCode: 2, stderr: "tar: no archive" }, git: { tags: new Map() } };
		const workdir = cdTarget(run.command);
		for (const entry of parseTar(gunzipSync(archive.data))) {
			run.fs.set(posix.join(workdir, entry.path), { data: entry.data, mode: entry.mode, link: entry.link });
		}
		run.fs.delete("/tmp/mu-sandbox-seed.tgz");
		if (!this.gitInImage) return { outcome: { exitCode: 0 }, git: { tags: new Map() } };
		const commit = this.commit(snapshot(run.fs, workdir));
		return {
			outcome: { exitCode: 0, stdout: `mu-seed-git:${commit}\n`, cost: 0.5 },
			git: { head: commit, tags: new Map([["mu-base", commit]]) },
		};
	}

	private commit(files: Map<string, FakeFile>): string {
		const id = createHash("sha1").update(randomUUID()).digest("hex");
		this.commits.set(id, files);
		return id;
	}

	/** `git add -A`, a commit when something changed, and the patch from the base to it, made by real git. */
	private pullDiff(
		run: FakeRun,
		git: { head?: string; tags: Map<string, string> },
	): { outcome: FakeOutcome; git: { head?: string; tags: Map<string, string> } } {
		const workdir = cdTarget(run.command);
		const baseRef = /git diff --binary .* '([^']+)' HEAD/.exec(run.command)?.[1] ?? "";
		const baseId = git.tags.get(baseRef) ?? baseRef;
		const base = this.commits.get(baseId);
		const headFiles = git.head ? this.commits.get(git.head) : undefined;
		if (!base || !headFiles) return { outcome: { exitCode: 128, stderr: `fatal: bad revision '${baseRef}'` }, git };
		const now = snapshot(run.fs, workdir);
		const head = sameFiles(now, headFiles) ? (git.head as string) : this.commit(now);
		const scratch = mkdtempSync(join(tmpdir(), "fake-contree-git-"));
		try {
			sh(scratch, "init", "-q");
			writeTree(scratch, base);
			sh(scratch, "add", "-A");
			sh(scratch, "commit", "-q", "--allow-empty", "-m", "base");
			sh(scratch, "rm", "-rq", "--ignore-unmatch", ".");
			writeTree(scratch, now);
			sh(scratch, "add", "-A");
			const patch = sh(scratch, "diff", "--cached", "--binary", "--full-index", "HEAD");
			run.fs.set("/tmp/mu-sandbox.patch", { data: Buffer.from(patch, "utf8"), mode: 0o644 });
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
		return { outcome: { exitCode: 0, stdout: `${head}\n` }, git: { head, tags: git.tags } };
	}

	private poll(operation: FakeOperation): Response {
		const { outcome } = operation;
		const headers: Record<string, string> =
			this.retryAfter === undefined ? {} : { "Retry-After": String(this.retryAfter) };
		if (operation.status !== "CANCELLED" && operation.polls < (outcome.polls ?? 1)) {
			operation.polls++;
			operation.status = "EXECUTING";
			return this.json(200, { uuid: operation.uuid, kind: "instance", status: "EXECUTING" }, headers);
		}
		if (operation.status === "CANCELLED") {
			return this.json(200, {
				uuid: operation.uuid,
				kind: "instance",
				status: "CANCELLED",
				result_image_uuid: null,
			});
		}
		operation.status = outcome.status ?? "SUCCESS";
		const encoding = outcome.encoding ?? "ascii";
		return this.json(200, {
			uuid: operation.uuid,
			kind: "instance",
			status: operation.status,
			error: outcome.error ?? null,
			image_uuid: operation.image,
			result_image_uuid: operation.resultImage ?? null,
			metadata: {
				result: {
					state: {
						exit_code: outcome.exitCode === undefined ? 0 : outcome.exitCode,
						signal: outcome.signal ?? 0,
						timed_out: outcome.timedOut ?? false,
					},
					stdout: stream(outcome.stdout, encoding, outcome.truncated ?? false),
					stderr: stream(outcome.stderr, encoding, false),
					resources: { cost: outcome.cost ?? 0.25 },
				},
			},
			result: { image: operation.resultImage ?? null },
		});
	}

	/** A file of the image an operation produced, as text. */
	text(image: string | undefined, path: string): string | undefined {
		return image ? this.images.get(image)?.files.get(path)?.data.toString("utf8") : undefined;
	}
}
