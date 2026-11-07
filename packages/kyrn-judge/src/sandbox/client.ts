import { createHash } from "node:crypto";

/**
 * A client for Nebius Token Factory Sandboxes (the Contree API, in beta).
 *
 * Every command is an operation: `POST /instances` starts a VM from an image, runs one command and stops.
 * Files go in through `files` (uploaded first with `POST /files`), results come back as the operation's
 * exit state and recorded output, and the filesystem it left behind becomes a new image when the request
 * said `disposable: false`. Nothing else survives between operations: no process, no shell, no memory.
 *
 * The key goes into the Authorization header and nowhere else. An error names the endpoint and the
 * status, and has the key cut out of whatever text it quotes.
 */
export const NEBIUS_SANDBOX_API = "https://api.tokenfactory.nebius.com/sandboxes/v1";

export type OperationStatus = "PENDING" | "ASSIGNED" | "EXECUTING" | "SUCCESS" | "FAILED" | "CANCELLED";
const TERMINAL: ReadonlySet<string> = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

export interface StreamRepr {
	readonly value: string;
	readonly encoding: "ascii" | "base64";
	readonly truncated?: boolean;
}

export interface InstanceResult {
	readonly state?: {
		readonly exit_code?: number | null;
		readonly signal?: number | null;
		readonly timed_out?: boolean | null;
	};
	readonly stdout?: StreamRepr;
	readonly stderr?: StreamRepr;
	readonly resources?: { readonly cost?: number | null };
}

export interface OperationResponse {
	readonly uuid: string;
	readonly kind?: "image_import" | "instance";
	readonly status: OperationStatus;
	readonly error?: string | null;
	readonly image_uuid?: string | null;
	readonly result_image_uuid?: string | null;
	readonly metadata?: { readonly result?: InstanceResult | null } | null;
	/** Image imports: the imported image. */
	readonly result?: { readonly image?: string | null; readonly tag?: string | null } | null;
}

export interface StagedFile {
	readonly uuid: string;
	/** Octal, e.g. "0644". */
	readonly mode?: string;
}

export interface SpawnRequest {
	/** An image UUID or `tag:<name>`. */
	readonly image: string;
	readonly command: string;
	readonly shell: boolean;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	/** Seconds. */
	readonly timeout?: number;
	readonly disposable: boolean;
	readonly files?: Readonly<Record<string, StagedFile>>;
	readonly truncate_output_at?: number;
}

export interface FileItem {
	readonly path: string;
	readonly size: number;
	readonly mode: number;
	readonly is_dir: boolean;
	readonly is_regular: boolean;
	readonly is_symlink: boolean;
}

export interface WhoAmI {
	readonly token_uuid: string;
	readonly token_expiration?: number | null;
	readonly permissions: Readonly<Record<string, boolean>>;
	readonly limits?: Readonly<Record<string, number>>;
}

/** A request the API answered with an error, or could not be made. Never carries the key. */
export class SandboxApiError extends Error {
	/** "GET /operations/{id}", with the id left in. */
	readonly endpoint: string;
	/** 0 when no answer came. */
	readonly status: number;
	constructor(endpoint: string, status: number, detail: string) {
		super(`Nebius sandbox ${endpoint} ${status > 0 ? `answered ${status}` : "failed"}${detail ? `: ${detail}` : ""}`);
		this.name = "SandboxApiError";
		this.endpoint = endpoint;
		this.status = status;
	}
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

export interface SandboxClientOptions {
	readonly apiKey: string;
	readonly project: string;
	/** Default `NEBIUS_SANDBOX_API`. */
	readonly baseUrl?: string;
	readonly fetch?: typeof fetch;
	/** For tests: how the client waits between polls. */
	readonly sleep?: Sleep;
	/** Time limit of one HTTP request that is not a file transfer. Default 60 s. */
	readonly requestTimeoutMs?: number;
}

interface RequestOptions {
	readonly method: "GET" | "POST" | "HEAD" | "DELETE";
	readonly path: string;
	readonly query?: Readonly<Record<string, string>>;
	readonly json?: unknown;
	readonly bytes?: Uint8Array;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	/** Statuses that are an answer here, not an error (404 for "no such file"). */
	readonly accept?: readonly number[];
}

/** 429 and 503 are retried this many times, after the Retry-After the API gives. */
const RETRIES = 4;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 2000;
/** Polls in a row that may fail before the wait gives up. */
const POLL_FAILURES = 5;

/** The bytes of a recorded stream, whichever encoding the API chose. */
export function decodeStream(stream: StreamRepr | undefined): Buffer {
	if (!stream?.value) return Buffer.alloc(0);
	return stream.encoding === "base64" ? Buffer.from(stream.value, "base64") : Buffer.from(stream.value, "utf8");
}

/** Seconds of a Retry-After header, as milliseconds; undefined when there is none or it is a date. */
function retryAfterMs(response: Response): number | undefined {
	const value = response.headers.get("retry-after");
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export class SandboxClient {
	private readonly apiKey: string;
	private readonly project: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly sleepImpl: Sleep;
	private readonly requestTimeoutMs: number;
	/** sha256 -> file uuid, for uploads this client has made or found. */
	private readonly uploaded = new Map<string, string>();

	constructor(options: SandboxClientOptions) {
		this.apiKey = options.apiKey;
		this.project = options.project;
		this.baseUrl = (options.baseUrl || NEBIUS_SANDBOX_API).replace(/\/+$/, "");
		this.fetchImpl = options.fetch ?? fetch;
		this.sleepImpl = options.sleep ?? sleep;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
	}

	private redact(text: string): string {
		return this.apiKey ? text.replaceAll(this.apiKey, "[NEBIUS_API_KEY]") : text;
	}

	private async request(options: RequestOptions): Promise<Response> {
		const endpoint = `${options.method} ${options.path}`;
		const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
		const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Project: this.project };
		let body: string | Uint8Array<ArrayBuffer> | undefined;
		if (options.json !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(options.json);
		} else if (options.bytes) {
			headers["Content-Type"] = "application/octet-stream";
			body = new Uint8Array(options.bytes);
		}
		for (let attempt = 0; ; attempt++) {
			const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
			const deadline = AbortSignal.timeout(timeoutMs);
			let response: Response;
			try {
				response = await this.fetchImpl(`${this.baseUrl}${options.path}${query}`, {
					method: options.method,
					headers,
					body,
					signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
				});
			} catch (error) {
				if (options.signal?.aborted) throw new Error("aborted");
				const detail = deadline.aborted
					? `no answer within ${Math.round(timeoutMs / 1000)} s`
					: this.redact(error instanceof Error ? error.message : String(error));
				throw new SandboxApiError(endpoint, 0, detail);
			}
			if (response.ok || options.accept?.includes(response.status)) return response;
			if ((response.status === 429 || response.status === 503) && attempt < RETRIES) {
				await response.body?.cancel().catch(() => undefined);
				await this.sleepImpl(retryAfterMs(response) ?? 1000 * 2 ** attempt, options.signal);
				continue;
			}
			const text = options.method === "HEAD" ? "" : await response.text().catch(() => "");
			throw new SandboxApiError(endpoint, response.status, this.redact(errorDetail(text)));
		}
	}

	private async json<T>(options: RequestOptions): Promise<T> {
		const response = await this.request(options);
		const text = await response.text();
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new SandboxApiError(`${options.method} ${options.path}`, response.status, "the answer is not JSON");
		}
	}

	/** Starts a command; the operation's id. A failed POST may still have started it, so it is never sent twice. */
	async spawn(request: SpawnRequest, signal?: AbortSignal): Promise<string> {
		const created = await this.json<{ uuid?: string }>({ method: "POST", path: "/instances", json: request, signal });
		if (!created.uuid) throw new SandboxApiError("POST /instances", 201, "the answer has no operation uuid");
		return created.uuid;
	}

	async operation(id: string, signal?: AbortSignal): Promise<{ operation: OperationResponse; retryAfterMs?: number }> {
		const path = `/operations/${encodeURIComponent(id)}`;
		const response = await this.request({ method: "GET", path, signal });
		const text = await response.text();
		let operation: OperationResponse;
		try {
			operation = JSON.parse(text) as OperationResponse;
		} catch {
			throw new SandboxApiError(`GET ${path}`, response.status, "the answer is not JSON");
		}
		return { operation, retryAfterMs: retryAfterMs(response) };
	}

	/** Best effort: an operation that already ended answers 409, which is fine. */
	async cancel(id: string): Promise<void> {
		await this.request({
			method: "DELETE",
			path: `/operations/${encodeURIComponent(id)}`,
			accept: [404, 409],
			timeoutMs: 15_000,
		}).catch(() => undefined);
	}

	/**
	 * Polls until the operation ends, after the Retry-After the API asks for. A poll that gets no answer or
	 * a 5xx is tried again a few times: the operation runs on regardless. An abort, or polling that keeps
	 * failing, cancels the operation (`DELETE /operations/{id}`), so no VM runs on with nobody to read it.
	 */
	async wait(id: string, signal?: AbortSignal): Promise<OperationResponse> {
		let delay = FIRST_POLL_MS;
		let failures = 0;
		try {
			for (;;) {
				let polled: { operation: OperationResponse; retryAfterMs?: number };
				try {
					polled = await this.operation(id, signal);
					failures = 0;
				} catch (error) {
					const transient = error instanceof SandboxApiError && (error.status === 0 || error.status >= 500);
					if (signal?.aborted || !transient || ++failures > POLL_FAILURES) throw error;
					await this.sleepImpl(delay, signal);
					continue;
				}
				if (TERMINAL.has(polled.operation.status)) return polled.operation;
				await this.sleepImpl(polled.retryAfterMs ?? delay, signal);
				delay = Math.min(MAX_POLL_MS, Math.round(delay * 1.5));
			}
		} catch (error) {
			await this.cancel(id);
			if (signal?.aborted) throw new Error("aborted");
			throw error;
		}
	}

	/** `spawn` and `wait`. */
	async run(request: SpawnRequest, signal?: AbortSignal): Promise<OperationResponse> {
		if (signal?.aborted) throw new Error("aborted");
		const id = await this.spawn(request, signal);
		return this.wait(id, signal);
	}

	/** Uploads bytes once: content the API already holds (by sha256) is not sent again. The file's uuid. */
	async upload(data: Uint8Array, signal?: AbortSignal): Promise<string> {
		const sha256 = createHash("sha256").update(data).digest("hex");
		const known = this.uploaded.get(sha256);
		if (known) return known;
		const existing = await this.request({ method: "GET", path: `/files/${sha256}`, accept: [404], signal });
		let uuid: string | undefined;
		if (existing.status === 200) {
			uuid = ((await existing.json()) as { uuid?: string }).uuid;
		} else {
			await existing.body?.cancel().catch(() => undefined);
			const created = await this.json<{ uuid?: string }>({
				method: "POST",
				path: "/files",
				bytes: data,
				signal,
				timeoutMs: TRANSFER_TIMEOUT_MS,
			});
			uuid = created.uuid;
		}
		if (!uuid) throw new SandboxApiError("POST /files", 201, "the answer has no file uuid");
		this.uploaded.set(sha256, uuid);
		return uuid;
	}

	/** A file of an image, read without starting a VM. Undefined when the image has no file there. */
	async download(image: string, path: string, signal?: AbortSignal): Promise<Buffer | undefined> {
		const response = await this.request({
			method: "GET",
			path: `/inspect/${encodeURIComponent(image)}/download`,
			query: { path },
			accept: [404],
			signal,
			timeoutMs: TRANSFER_TIMEOUT_MS,
		});
		if (response.status === 404) {
			await response.body?.cancel().catch(() => undefined);
			return undefined;
		}
		return Buffer.from(await response.arrayBuffer());
	}

	/** The entries of a directory of an image. Undefined when there is no such directory. */
	async list(image: string, path: string, signal?: AbortSignal): Promise<readonly FileItem[] | undefined> {
		const response = await this.request({
			method: "GET",
			path: `/inspect/${encodeURIComponent(image)}/list`,
			query: { path },
			accept: [404, 422],
			signal,
		});
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => undefined);
			return undefined;
		}
		return ((await response.json()) as { files?: FileItem[] }).files ?? [];
	}

	whoami(signal?: AbortSignal): Promise<WhoAmI> {
		return this.json<WhoAmI>({ method: "GET", path: "/whoami", signal });
	}

	/** Imports `docker://…` (the root filesystem only) and waits for it. The image's uuid. */
	async importImage(url: string, signal?: AbortSignal): Promise<string> {
		const created = await this.json<{ uuid?: string }>({
			method: "POST",
			path: "/images/import",
			json: { registry: { url } },
			signal,
		});
		if (!created.uuid) throw new SandboxApiError("POST /images/import", 201, "the answer has no operation uuid");
		const done = await this.wait(created.uuid, signal);
		const image = done.result?.image;
		if (done.status !== "SUCCESS" || !image) {
			throw new SandboxApiError(
				"POST /images/import",
				200,
				`importing ${url} ended ${done.status}${done.error ? `: ${this.redact(done.error)}` : ""}`,
			);
		}
		return image;
	}
}

/** The `error` of an API error body, or the start of whatever text came back. */
function errorDetail(text: string): string {
	try {
		const parsed = JSON.parse(text) as { error?: unknown };
		if (typeof parsed.error === "string") return parsed.error.slice(0, 300);
		if (parsed.error !== undefined) return JSON.stringify(parsed.error).slice(0, 300);
	} catch {
		// Not JSON: say what it was.
	}
	return text.trim().slice(0, 300);
}
