import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_JUDGES } from "../config.ts";
import type { LocalJudge } from "./config.ts";
import type { MudeFile } from "./manifest.ts";
import { type MudePaths, mudePaths } from "./paths.ts";
import { mudeBaseUrl } from "./server.ts";

/**
 * Decision models from Hugging Face besides mude 1.0 (`mu judge model add <link or owner/name>`). mu runs one the way
 * it runs mude: a repository packaged like mude 1.0's MLX edition, with its own System One server for Apple silicon
 * (`d3_server_mac.py`), started from mude's Python environment on 127.0.0.1. Adding one pins the repository at the
 * revision its link names (the default branch otherwise) with every file's size and hash as Hugging Face lists them,
 * sha256 for the files kept in LFS and the git blob sha1 for the others, so a changed file is refused like one of
 * mude's. The record is `<mu home>/local-judge/models/<id>/model.json`, beside the model, its key, its server's pid and
 * log, and its state, as mude keeps them under local-judge/mude.
 */

/**
 * Why a model can't be added: usage (not a Hugging Face model's link or name), access (private or gated), notFound (no
 * such model or revision), notRunnable (not packaged so mu can run it), network (Hugging Face could not be asked).
 */
export class ModelError extends Error {
	readonly kind: "usage" | "access" | "notFound" | "notRunnable" | "network";

	constructor(message: string, kind: ModelError["kind"]) {
		super(message);
		this.name = "ModelError";
		this.kind = kind;
	}
}

export interface ModelRef {
	/** owner/name */
	readonly repo: string;
	/** A branch, tag or commit; the default branch when the link names none. */
	readonly revision?: string;
}

export interface ModelRecord {
	/** Its name in mu.json and in `mu judge model` commands. */
	readonly id: string;
	readonly repo: string;
	/** The commit the files were pinned at. */
	readonly revision: string;
	readonly files: readonly MudeFile[];
	readonly bytes: number;
}

const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/**
 * owner/name, owner/name@revision, or a link to the model on huggingface.co (hf.co too), its page, a file of it or a
 * branch (`…/tree/<revision>`). A dataset's or a Space's link is refused: those aren't models.
 */
export function parseModelRef(input: string): ModelRef {
	const text = input.trim();
	let repo: string;
	let revision: string | undefined;
	if (/^https?:\/\//i.test(text) || /^(www\.)?(huggingface\.co|hf\.co)\//i.test(text)) {
		let url: URL;
		try {
			url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
		} catch {
			throw new ModelError(`${text} isn't a Hugging Face link`, "usage");
		}
		if (!/^(www\.)?(huggingface\.co|hf\.co)$/i.test(url.hostname))
			throw new ModelError(`${text} isn't a Hugging Face link`, "usage");
		const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		if (parts[0] === "datasets" || parts[0] === "spaces") {
			throw new ModelError(
				`${text} is a Hugging Face ${parts[0] === "datasets" ? "dataset" : "Space"}, not a model`,
				"usage",
			);
		}
		if (parts.length < 2)
			throw new ModelError(
				`${text} doesn't name a model: use a link like https://huggingface.co/owner/name`,
				"usage",
			);
		repo = `${parts[0]}/${parts[1]}`;
		if (["tree", "blob", "resolve"].includes(parts[2] ?? "") && parts[3]) revision = parts[3];
	} else {
		const at = text.lastIndexOf("@");
		repo = at > 0 ? text.slice(0, at) : text;
		revision = at > 0 ? text.slice(at + 1) : undefined;
	}
	const [owner, name, extra] = repo.split("/");
	if (!owner || !name || extra !== undefined || !PART.test(owner) || !PART.test(name)) {
		throw new ModelError(
			`${text} isn't a Hugging Face model: give its link or owner/name (for example qybaihe/mude-1.0-mlx-8bit)`,
			"usage",
		);
	}
	if (revision !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(revision)) {
		throw new ModelError(`${revision} isn't a branch, tag or commit`, "usage");
	}
	return { repo, revision };
}

export interface ResolveOptions {
	readonly endpoint?: string;
	readonly token?: string;
	readonly fetch?: typeof fetch;
}

interface TreeEntry {
	readonly type?: string;
	readonly path?: string;
	readonly size?: number;
	readonly oid?: string;
	readonly lfs?: { readonly oid?: string; readonly size?: number };
}

/** The file a repository needs to be run by mu: the System One server for Apple silicon, at its root. */
export const SERVER_FILE = "d3_server_mac.py";

/**
 * The commit `ref` names and its files, each with its size and hash, as Hugging Face lists them. Refuses a repository
 * mu can't run (no `d3_server_mac.py`), and says why when Hugging Face won't show it.
 */
export async function resolveModel(
	ref: ModelRef,
	options: ResolveOptions = {},
): Promise<{ revision: string; files: MudeFile[] }> {
	const endpoint = (options.endpoint ?? "https://huggingface.co").replace(/\/+$/, "");
	const get = options.fetch ?? fetch;
	const headers: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {};
	const request = async (url: string): Promise<Response> => {
		let response: Response;
		try {
			response = await get(url, { headers, signal: AbortSignal.timeout(30_000) });
		} catch (error) {
			throw new ModelError(
				`Couldn't reach Hugging Face (${error instanceof Error ? error.message : String(error)}): check the connection, then add it again`,
				"network",
			);
		}
		if (response.status === 401 || response.status === 403) {
			// Asked without a token, Hugging Face answers 401 for a model that doesn't exist too, so a typo lands here.
			throw new ModelError(
				response.status === 401 && !options.token
					? `Couldn't open ${ref.repo} on Hugging Face (401): it doesn't exist, or it's private or gated. Check the name; for a gated model, accept its terms on huggingface.co, set HF_TOKEN, then add it again`
					: `${ref.repo} is private or gated on Hugging Face (${response.status}). Accept its terms on huggingface.co, set HF_TOKEN, then add it again`,
				"access",
			);
		}
		if (response.status === 404) {
			throw new ModelError(
				`Hugging Face has no model ${ref.repo}${ref.revision ? ` at ${ref.revision}` : ""}`,
				"notFound",
			);
		}
		if (!response.ok) throw new ModelError(`Hugging Face returned ${response.status} for ${ref.repo}`, "network");
		return response;
	};
	const info = (await (
		await request(`${endpoint}/api/models/${ref.repo}/revision/${encodeURIComponent(ref.revision ?? "main")}`)
	).json()) as { sha?: unknown };
	const revision = typeof info.sha === "string" ? info.sha : "";
	if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`Hugging Face didn't say which commit ${ref.repo} is at`);
	const files: MudeFile[] = [];
	let next: string | undefined = `${endpoint}/api/models/${ref.repo}/tree/${revision}?recursive=true`;
	while (next) {
		const response = await request(next);
		for (const entry of (await response.json()) as TreeEntry[]) {
			if (entry.type !== "file" || typeof entry.path !== "string" || typeof entry.size !== "number") continue;
			if (entry.path.split("/").some((part) => part === ".." || part === "")) continue;
			const sha256 = entry.lfs?.oid;
			if (sha256 && /^[0-9a-f]{64}$/.test(sha256)) files.push({ path: entry.path, size: entry.size, sha256 });
			else if (entry.oid && /^[0-9a-f]{40}$/.test(entry.oid))
				files.push({ path: entry.path, size: entry.size, gitSha1: entry.oid });
			else throw new Error(`Hugging Face listed ${entry.path} of ${ref.repo} without a hash, so mu can't check it`);
		}
		// Hugging Face pages a long listing: the next page is in the Link header.
		next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
	}
	if (!files.some((file) => file.path === SERVER_FILE)) {
		throw new ModelError(
			`${ref.repo} isn't packaged as a decision model mu can run: it has no ${SERVER_FILE}. mu runs models packaged like mude 1.0's MLX edition, with their own System One server`,
			"notRunnable",
		);
	}
	return { revision, files };
}

/** Names mu.json already gives meaning to, which an added model doesn't take. */
function reserved(name: string): boolean {
	return name in BUILT_IN_JUDGES || name === "off" || name.startsWith("jev") || name.includes(":");
}

const slug = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");

/** A short name for `repo`: its model name, or owner-name when that is taken or means something already. */
export function modelId(repo: string, taken: ReadonlySet<string>): string {
	const [owner = "", name = ""] = repo.split("/");
	const short = slug(name);
	if (short && !reserved(short) && !taken.has(short)) return short;
	const long = slug(`${owner}-${name}`);
	if (!reserved(long) && !taken.has(long)) return long;
	for (let n = 2; ; n++) if (!taken.has(`${long}-${n}`)) return `${long}-${n}`;
}

export function modelsDir(muHome: string): string {
	return join(muHome, "local-judge", "models");
}

/** Where an added model lives. Its Python environment and uv are mude's: the same packages run every one of them. */
export function modelPaths(muHome: string, record: Pick<ModelRecord, "id" | "revision">): MudePaths {
	const shared = mudePaths(muHome);
	const root = join(modelsDir(muHome), record.id);
	const model = join(root, "model", record.revision);
	return {
		...shared,
		root,
		model,
		verified: join(model, ".mu-verified.json"),
		key: join(root, "key"),
		pid: join(root, "server.pid"),
		log: join(root, "server.log"),
		state: join(root, "state.json"),
		install: join(root, "install.json"),
		installLock: join(root, "install.lock"),
	};
}

export function writeRecord(muHome: string, record: ModelRecord): void {
	const root = join(modelsDir(muHome), record.id);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "model.json"), `${JSON.stringify(record, null, 1)}\n`);
}

function isRecord(value: unknown): value is ModelRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<ModelRecord>;
	return (
		typeof record.id === "string" &&
		typeof record.repo === "string" &&
		typeof record.revision === "string" &&
		typeof record.bytes === "number" &&
		Array.isArray(record.files)
	);
}

/** Every added model, by id. */
export function listRecords(muHome: string): ModelRecord[] {
	let names: string[];
	try {
		names = readdirSync(modelsDir(muHome));
	} catch {
		return [];
	}
	const records: ModelRecord[] = [];
	for (const name of names.sort()) {
		try {
			const value: unknown = JSON.parse(readFileSync(join(modelsDir(muHome), name, "model.json"), "utf8"));
			if (isRecord(value) && value.id === name) records.push(value);
		} catch {
			// Not a model's folder, or one cut off before its record was written.
		}
	}
	return records;
}

/** The added model `name` names: its id, or its repository. */
export function findRecord(muHome: string, name: string): ModelRecord | undefined {
	const records = listRecords(muHome);
	const lower = name.toLowerCase();
	return (
		records.find((record) => record.id === lower) ?? records.find((record) => record.repo.toLowerCase() === lower)
	);
}

/** The .env variable with an added model's key: MU_JUDGE_<ID>_KEY. */
export function keyVariable(id: string): string {
	return `MU_JUDGE_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_KEY`;
}

/** An added model as mu's judge: a System One server on this Mac, like mude's built-in entry, under its own name. */
export function localJudgeOf(id: string): LocalJudge {
	return {
		name: id,
		keyVariable: keyVariable(id),
		entry: (port) => ({
			type: "typesafe",
			baseUrl: mudeBaseUrl(port),
			model: id,
			apiKeyEnv: keyVariable(id),
			timeoutMs: 4000,
		}),
	};
}
