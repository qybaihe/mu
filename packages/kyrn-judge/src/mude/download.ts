import { createHash } from "node:crypto";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as wait } from "node:timers/promises";
import type { MudeFile } from "./manifest.ts";

/**
 * Downloads mude's files with resumption and checks each against its pinned sha256. A file is written to `<name>.part`
 * and renamed only once its hash matches, so a file under its own name is always a whole, checked one; an interrupted
 * download goes on from the bytes it has (an HTTP range request) the next time.
 *
 * A power cut can leave the end of a part unwritten (the system had not put it on the disk yet) while the file is
 * already that long, and a download that went on from there would fail its check at the very end. So every
 * CHECKPOINT_BYTES the part is synced to the disk and `<name>.part.saved` records how much of it is; the next download
 * goes on from there and writes the rest again. A part without that record (an older mu's) loses its last
 * CHECKPOINT_BYTES the same way.
 */

/** How often a part is synced to the disk, and how much of it a resumed download may write again. */
export const CHECKPOINT_BYTES = 32 * 1024 * 1024;

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
	/**
	 * Tries in a row that receive nothing before a file gives up. A try that receives some of the file starts the count
	 * again. Default 8: with the waits between them, about two minutes without a connection.
	 */
	readonly attempts?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	/** How often a part is synced and its checkpoint written. Default CHECKPOINT_BYTES. */
	readonly checkpointBytes?: number;
}

/** The waits between tries that receive nothing, in ms; the last one repeats. */
const RETRY_WAITS = [2000, 5000, 10_000, 20_000, 30_000];

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

/**
 * Bytes of `files` already on disk: checked files, whole files not checked yet, and what an interrupted download left
 * in `<name>.part`. Above 0 and below the files' size, an install stopped part way, and the next one goes on from there.
 */
export function downloadedBytes(dir: string, files: readonly MudeFile[]): number {
	const verified = readVerified(dir);
	let bytes = 0;
	for (const file of files) {
		if (knownGood(dir, file, verified)) {
			bytes += file.size;
			continue;
		}
		const target = join(dir, file.path);
		bytes += Math.min(file.size, Math.max(sizeOf(target), sizeOf(`${target}.part`)));
	}
	return bytes;
}

function sizeOf(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
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
		const part = `${target}.part`;
		const onBytes = (bytes: number) =>
			options.onProgress?.({ file: file.path, checking: false, done: settled + bytes, total });
		let resumed = await fetchFile(options, file, part, onBytes);
		options.onProgress?.({ file: file.path, checking: true, done: settled + file.size, total });
		let actual = await sha256File(part);
		if (actual !== file.sha256 && resumed) {
			// What an earlier try left was not what it seemed (a power cut, a file changed by hand): once more from
			// nothing, before giving up.
			dropPart(part);
			resumed = await fetchFile(options, file, part, onBytes);
			options.onProgress?.({ file: file.path, checking: true, done: settled + file.size, total });
			actual = await sha256File(part);
		}
		if (actual !== file.sha256) {
			dropPart(part);
			throw new DownloadError(
				`${file.path} does not match its pinned sha256 (got ${actual.slice(0, 12)}…, want ${file.sha256.slice(0, 12)}…); it was removed`,
				"integrity",
			);
		}
		renameSync(part, target);
		rmSync(savedPath(part), { force: true });
		remember(dir, verified, file);
		settled += file.size;
	}
	options.onProgress?.({ file: "", checking: false, done: total, total });
}

const savedPath = (part: string) => `${part}.saved`;

function dropPart(part: string): void {
	rmSync(part, { force: true });
	rmSync(savedPath(part), { force: true });
}

/**
 * Where a download of `part` goes on from: as far as its checkpoint says is on the disk, or, without one, all but its
 * last CHECKPOINT_BYTES. Never past the end of the file.
 */
export function resumeFrom(part: string, size: number, checkpointBytes = CHECKPOINT_BYTES): number {
	const have = Math.min(sizeOf(part), size);
	let saved: number | undefined;
	try {
		const value = Number.parseInt(readFileSync(savedPath(part), "utf8").trim(), 10);
		if (Number.isSafeInteger(value) && value >= 0) saved = value;
	} catch {
		// No checkpoint: an older mu's part, or one cut off before its first.
	}
	return saved === undefined ? Math.max(0, have - checkpointBytes) : Math.min(saved, have);
}

/** Records that the first `bytes` of `part` are on the disk: written aside and renamed, so it is never half there. */
function writeSaved(part: string, bytes: number): void {
	const path = savedPath(part);
	writeFileSync(`${path}.tmp`, `${bytes}\n`);
	renameSync(`${path}.tmp`, path);
}

/** Downloads `part` until it is whole, trying again while tries receive some of it. Whether it went on from bytes it had. */
async function fetchFile(
	options: DownloadOptions,
	file: MudeFile,
	part: string,
	onBytes: (bytes: number) => void,
): Promise<boolean> {
	const attempts = options.attempts ?? 8;
	// A stop ends a wait at once (the loop then says the download was stopped), not when the wait is over.
	const sleep = options.sleep ?? ((ms: number) => wait(ms, undefined, { signal: options.signal }).catch(() => {}));
	let resumed = false;
	let failures = 0;
	let lastError: unknown;
	for (;;) {
		if (options.signal?.aborted) throw new DownloadError("The download was stopped", "aborted");
		const before = resumeFrom(part, file.size, options.checkpointBytes);
		try {
			resumed = (await fetchOnce(options, file, part, onBytes)) || resumed;
			return resumed;
		} catch (error) {
			if (error instanceof DownloadError && error.kind !== "network") throw error;
			// A full disk stays full: trying again would only take two more minutes and then blame the connection.
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOSPC" || code === "EDQUOT") {
				throw new Error(
					`The disk is full: couldn't write ${file.path}. Free up some space, then run mu judge mude install to resume`,
				);
			}
			lastError = error;
			// A try that got some of the file was worth it: the count of tries in a row that got nothing starts again.
			failures = resumeFrom(part, file.size, options.checkpointBytes) > before ? 1 : failures + 1;
			if (failures >= attempts) break;
			await sleep(RETRY_WAITS[Math.min(failures, RETRY_WAITS.length) - 1]);
		}
	}
	const reason = lastError instanceof Error ? lastError.message : String(lastError);
	throw new DownloadError(
		`${file.path} could not be downloaded (${reason}). Run mu judge mude install again to resume`,
		"network",
	);
}

/** One request for what `part` is missing. Whether it went on from bytes the part had. */
async function fetchOnce(
	options: DownloadOptions,
	file: MudeFile,
	part: string,
	onBytes: (bytes: number) => void,
): Promise<boolean> {
	const checkpointBytes = options.checkpointBytes ?? CHECKPOINT_BYTES;
	let have = resumeFrom(part, file.size, checkpointBytes);
	if (have === file.size) {
		// Whole and on the disk already; a part longer than the file loses what is past its end.
		if (sizeOf(part) > file.size) truncateSync(part, file.size);
		return true;
	}
	const controller = new AbortController();
	const stallMs = options.stallMs ?? 60_000;
	let stall = setTimeout(() => controller.abort(new Error(`no data for ${stallMs / 1000} s`)), stallMs);
	const onAbort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	// How much of the part is written, and how much of that is synced to the disk.
	let written = 0;
	let synced = 0;
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
				`Hugging Face returned ${response.status} for ${file.path}: the model isn't public yet, or this machine's token can't access it`,
				"access",
			);
		}
		if (response.status === 416) {
			// The server has no such range: the part is not what it seems. The next try starts from nothing.
			dropPart(part);
			throw new Error("HTTP 416");
		}
		if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
		// A server that ignores the range sends the whole file: it is written from the start.
		const resumed = response.status === 206 && have > 0;
		if (!resumed) have = 0;
		mkdirSync(dirname(part), { recursive: true });
		handle = await open(part, existsSync(part) ? "r+" : "w");
		await handle.truncate(have);
		// The checkpoint never names more than the part has now (it may have said more before a start from nothing).
		writeSaved(part, have);
		written = have;
		synced = have;
		onBytes(written);
		const reader = response.body.getReader();
		for (;;) {
			const { done, value: chunk } = await reader.read();
			if (done) break;
			clearTimeout(stall);
			stall = setTimeout(() => controller.abort(new Error(`no data for ${stallMs / 1000} s`)), stallMs);
			if (written + chunk.length > file.size) throw new Error(`got more than the ${file.size} bytes of the file`);
			await handle.write(chunk, 0, chunk.length, written);
			written += chunk.length;
			if (written - synced >= checkpointBytes) {
				await handle.sync();
				synced = written;
				writeSaved(part, synced);
			}
			onBytes(written);
		}
		if (written !== file.size) throw new Error(`got ${written} of ${file.size} bytes`);
		return resumed;
	} catch (error) {
		if (options.signal?.aborted) throw new DownloadError("The download was stopped", "aborted");
		throw error;
	} finally {
		clearTimeout(stall);
		options.signal?.removeEventListener("abort", onAbort);
		if (handle) {
			// Whatever this try got stays for the next one: synced, then recorded.
			try {
				await handle.sync();
				if (written > synced) writeSaved(part, written);
			} catch {
				// The checkpoint from before still holds.
			}
			await handle.close();
		}
	}
}
