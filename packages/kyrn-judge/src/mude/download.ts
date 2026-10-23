import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MudeFile } from "./manifest.ts";

/**
 * Downloads mude's files with resumption and checks each against its pinned sha256. A file is written to `<name>.part`
 * and renamed only once its hash matches, so a file under its own name is always a whole, checked one; an interrupted
 * download goes on from the bytes it has (an HTTP range request) the next time.
 */

export interface DownloadProgress {
	/** The file being downloaded, or checked when `checking`. */
	readonly file: string;
	readonly checking: boolean;
	/** Bytes of all the files that are in place, this one's included so far. */
	readonly done: number;
	readonly total: number;
}

export interface DownloadOptions {
	readonly dir: string;
	readonly files: readonly MudeFile[];
	readonly url: (path: string) => string;
	/** A Hugging Face token for a repository that is not public (HF_TOKEN or huggingface-cli's token file). */
	readonly token?: string;
	readonly fetch?: typeof fetch;
	readonly onProgress?: (progress: DownloadProgress) => void;
	readonly signal?: AbortSignal;
	/** A download that receives nothing for this long is dropped and tried again. Default 60 s. */
	readonly stallMs?: number;
	/** Tries per file. Default 4. */
	readonly attempts?: number;
	readonly sleep?: (ms: number) => Promise<void>;
}

/** Hugging Face's own places for a token, as huggingface_hub reads them. */
export function huggingFaceToken(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
	const direct = env.HF_TOKEN?.trim();
	if (direct) return direct;
	const files = [
		env.HF_TOKEN_PATH,
		env.HF_HOME ? join(env.HF_HOME, "token") : undefined,
		join(env.XDG_CACHE_HOME || join(home, ".cache"), "huggingface", "token"),
	];
	for (const file of files) {
		if (!file) continue;
		try {
			const token = readFileSync(file, "utf8").trim();
			if (token) return token;
		} catch {
			// Not there.
		}
	}
	return undefined;
}

export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(path), hash);
	return hash.digest("hex");
}

interface Verified {
	readonly [path: string]: { readonly size: number; readonly mtimeMs: number; readonly sha256: string };
}

function readVerified(dir: string): Record<string, Verified[string]> {
	try {
		const value: unknown = JSON.parse(readFileSync(join(dir, ".mu-verified.json"), "utf8"));
		return typeof value === "object" && value !== null ? (value as Record<string, Verified[string]>) : {};
	} catch {
		return {};
	}
}

/** Whether `file` is in place and was checked before, unchanged since: same size and modification time. */
function knownGood(dir: string, file: MudeFile, verified: Verified): boolean {
	const seen = verified[file.path];
	if (!seen || seen.sha256 !== file.sha256) return false;
	try {
		const stats = statSync(join(dir, file.path));
		return stats.size === file.size && stats.mtimeMs === seen.mtimeMs;
	} catch {
		return false;
	}
}

function remember(dir: string, verified: Record<string, Verified[string]>, file: MudeFile): void {
	const stats = statSync(join(dir, file.path));
	verified[file.path] = { size: stats.size, mtimeMs: stats.mtimeMs, sha256: file.sha256 };
	writeFileSync(join(dir, ".mu-verified.json"), `${JSON.stringify(verified, null, 1)}\n`);
}

/** Which files are missing or not yet checked. A checked file that changed since counts as missing. */
export function missingFiles(dir: string, files: readonly MudeFile[]): MudeFile[] {
	const verified = readVerified(dir);
	return files.filter((file) => !knownGood(dir, file, verified));
}

export class DownloadError extends Error {
	readonly kind: "access" | "network" | "integrity" | "aborted";

	constructor(message: string, kind: DownloadError["kind"]) {
		super(message);
		this.name = "DownloadError";
		this.kind = kind;
	}
}

/** Downloads and checks every missing file. Files already in place and checked are left alone. */
export async function downloadFiles(options: DownloadOptions): Promise<void> {
	const { dir, files } = options;
	const total = files.reduce((sum, file) => sum + file.size, 0);
	mkdirSync(dir, { recursive: true });
	const verified = readVerified(dir);
	let settled = 0;
	for (const file of files) {
		if (knownGood(dir, file, verified)) {
			settled += file.size;
			continue;
		}
		const target = join(dir, file.path);
		mkdirSync(dirname(target), { recursive: true });
		// A whole file under its own name from an earlier run (or put there by hand) is checked, not downloaded again.
		if (existsSync(target) && statSync(target).size === file.size) {
			options.onProgress?.({ file: file.path, checking: true, done: settled, total });
			if ((await sha256File(target)) === file.sha256) {
				remember(dir, verified, file);
				settled += file.size;
				continue;
			}
			rmSync(target, { force: true });
		}
		await fetchFile(options, file, target, (bytes) =>
			options.onProgress?.({ file: file.path, checking: false, done: settled + bytes, total }),
		);
		options.onProgress?.({ file: file.path, checking: true, done: settled + file.size, total });
		const part = `${target}.part`;
		const actual = await sha256File(part);
		if (actual !== file.sha256) {
			rmSync(part, { force: true });
			throw new DownloadError(
				`${file.path} does not match its pinned sha256 (got ${actual.slice(0, 12)}…, want ${file.sha256.slice(0, 12)}…); it was removed`,
				"integrity",
			);
		}
		renameSync(part, target);
		remember(dir, verified, file);
		settled += file.size;
	}
	options.onProgress?.({ file: "", checking: false, done: total, total });
}

async function fetchFile(
	options: DownloadOptions,
	file: MudeFile,
	target: string,
	onBytes: (bytes: number) => void,
): Promise<void> {
	const part = `${target}.part`;
	const attempts = options.attempts ?? 4;
	const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (options.signal?.aborted) throw new DownloadError("The download was stopped", "aborted");
		try {
			await fetchOnce(options, file, part, onBytes);
			return;
		} catch (error) {
			if (error instanceof DownloadError && error.kind !== "network") throw error;
			lastError = error;
			if (attempt < attempts) await sleep([2000, 5000, 10000][attempt - 1] ?? 10000);
		}
	}
	const reason = lastError instanceof Error ? lastError.message : String(lastError);
	throw new DownloadError(
		`${file.path} could not be downloaded (${reason}); run the install again to go on from here`,
		"network",
	);
}

async function fetchOnce(
	options: DownloadOptions,
	file: MudeFile,
	part: string,
	onBytes: (bytes: number) => void,
): Promise<void> {
	let have = 0;
	try {
		have = statSync(part).size;
	} catch {
		// Nothing yet.
	}
	if (have > file.size) {
		rmSync(part, { force: true });
		have = 0;
	}
	if (have === file.size) return;
	const controller = new AbortController();
	const stallMs = options.stallMs ?? 60_000;
	let stall = setTimeout(() => controller.abort(new Error(`no data for ${stallMs / 1000} s`)), stallMs);
	const onAbort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const headers: Record<string, string> = {};
		if (have > 0) headers.Range = `bytes=${have}-`;
		if (options.token) headers.Authorization = `Bearer ${options.token}`;
		const response = await (options.fetch ?? fetch)(options.url(file.path), {
			headers,
			redirect: "follow",
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403 || response.status === 404) {
			throw new DownloadError(
				`Hugging Face answered ${response.status} for ${file.path}: the model is not public yet, or this machine's token cannot read it`,
				"access",
			);
		}
		if (response.status === 416 && have > 0) {
			// The range starts at the end: the part is whole already.
			return;
		}
		if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
		const resumed = response.status === 206;
		if (!resumed) have = 0;
		const out = createWriteStream(part, { flags: resumed ? "a" : "w" });
		let received = have;
		onBytes(received);
		const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
		body.on("data", (chunk: Buffer) => {
			received += chunk.length;
			clearTimeout(stall);
			stall = setTimeout(() => controller.abort(new Error(`no data for ${stallMs / 1000} s`)), stallMs);
			onBytes(received);
		});
		await pipeline(body, out);
		if (received !== file.size) throw new Error(`got ${received} of ${file.size} bytes`);
	} catch (error) {
		if (options.signal?.aborted) throw new DownloadError("The download was stopped", "aborted");
		throw error;
	} finally {
		clearTimeout(stall);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
