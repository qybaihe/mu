import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CONFIG_FILE, LEGACY_CONFIG_FILE } from "../naming.ts";
import { setEnvValue } from "./env-file.ts";

/**
 * The files `mu setup` changes that pi does not write itself: models.json, mu.json and the .env. auth.json and
 * settings.json go through pi's own classes (pi-access.ts). Whatever exists is copied to <mu home>/backups/<time>/
 * before its first change, and nothing is rewritten that could not be read: a file with comments or broken JSON is
 * left as it is and the person is told what to add by hand.
 */

export interface SetupPaths {
	/** ~/.mu/agent: auth.json, models.json, settings.json, mu.json. */
	readonly agentDir: string;
	/** ~/.mu, or ~/.kyrn on a machine that has not moved its home: backups go into its `backups` folder. */
	readonly home: string;
	/** The .env the launcher reads: the checkout's, or ~/.mu/.env for the npm package. */
	readonly envFile: string;
}

/** A file that may hold keys is readable by its owner alone when mu makes it. An existing file keeps its mode. */
const PRIVATE_FILE = 0o600;
const PRIVATE_FOLDER = 0o700;

/** 2026-09-27T15-04-05, in local time: a folder name on every platform. */
export function backupStamp(now: Date): string {
	const two = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
}

/** One run's backup folder, made when the first file is copied into it. */
export class Backups {
	private readonly root: string;
	private readonly stamp: string;
	private made: string | undefined;
	private readonly saved = new Set<string>();

	constructor(home: string, now: Date) {
		this.root = join(home, "backups");
		this.stamp = backupStamp(now);
	}

	/** Copies `file` the first time it is about to change in this run. A file that does not exist has nothing to keep. */
	save(file: string): void {
		if (this.saved.has(file) || !existsSync(file)) return;
		const folder = this.folder();
		const copy = join(folder, basename(file));
		copyFileSync(file, copy);
		// Copies of auth.json and the .env hold keys.
		try {
			chmodSync(copy, PRIVATE_FILE);
		} catch {
			// Windows keeps its own permissions.
		}
		this.saved.add(file);
	}

	/** Where this run's copies are, once one was made. */
	get path(): string | undefined {
		return this.made;
	}

	private folder(): string {
		if (this.made) return this.made;
		mkdirSync(this.root, { recursive: true, mode: PRIVATE_FOLDER });
		for (let attempt = 1; ; attempt++) {
			const candidate = join(this.root, attempt === 1 ? this.stamp : `${this.stamp}-${attempt}`);
			try {
				mkdirSync(candidate, { mode: PRIVATE_FOLDER });
				this.made = candidate;
				return candidate;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
	}
}

export type JsonFile =
	| { readonly state: "absent" }
	| { readonly state: "ok"; readonly value: Record<string, unknown> }
	/** Not plain JSON (comments, a typo) or not an object: never rewritten. */
	| { readonly state: "unreadable" };

export function readJsonFile(path: string): JsonFile {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
		return { state: "unreadable" };
	}
	if (!text.trim()) return { state: "ok", value: {} };
	try {
		const value: unknown = JSON.parse(text.replace(/^﻿/, ""));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? { state: "ok", value: value as Record<string, unknown> }
			: { state: "unreadable" };
	} catch {
		return { state: "unreadable" };
	}
}

/**
 * Writes the whole file at once: a new file beside it, then renamed over it, so that a reader never sees half of it.
 * An existing file keeps its mode; a new one is private.
 */
export function writeFileAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	let mode = PRIVATE_FILE;
	try {
		mode = statSync(path).mode & 0o777;
	} catch {
		// A new file.
	}
	const temporary = `${path}.mu-setup-${process.pid}`;
	writeFileSync(temporary, text, { mode });
	try {
		chmodSync(temporary, mode);
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

export function writeJsonFile(path: string, value: Record<string, unknown>): void {
	writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------------------------
// models.json
// ---------------------------------------------------------------------------------------------------------------

export interface ProviderEntry {
	readonly name?: string;
	readonly baseUrl: string;
	readonly api: string;
	/** Only for a service that takes no key (Ollama): pi needs one to count the provider as usable. Never a real key. */
	readonly apiKey?: string;
	/** How the endpoint differs from OpenAI's (services.ts). */
	readonly compat?: Readonly<Record<string, boolean | string>>;
	readonly models: readonly { readonly id: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The provider entry models.json already has under this id. */
export function existingProvider(models: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
	const providers = models.providers;
	return isRecord(providers) && isRecord(providers[id]) ? providers[id] : undefined;
}

function mergeModels(existing: unknown, added: readonly { readonly id: string }[]): unknown[] {
	const kept = Array.isArray(existing) ? [...existing] : [];
	const have = new Set(kept.flatMap((model) => (isRecord(model) && typeof model.id === "string" ? [model.id] : [])));
	return [...kept, ...added.filter((model) => !have.has(model.id)).map((model) => ({ ...model }))];
}

/**
 * models.json with one provider of mu's added or brought up to date. Every other provider stays as it is, and so does
 * whatever this one already has that mu does not set (headers, compat, model overrides, the models it lists).
 */
export function withProvider(
	models: Record<string, unknown>,
	id: string,
	entry: ProviderEntry,
): Record<string, unknown> {
	const providers = isRecord(models.providers) ? models.providers : {};
	const current = isRecord(providers[id]) ? providers[id] : {};
	const next: Record<string, unknown> = {
		...current,
		name: typeof current.name === "string" ? current.name : entry.name,
		baseUrl: entry.baseUrl,
		api: entry.api,
		models: mergeModels(current.models, entry.models),
	};
	if (entry.apiKey !== undefined && current.apiKey === undefined) next.apiKey = entry.apiKey;
	if (entry.compat !== undefined && current.compat === undefined) next.compat = { ...entry.compat };
	if (next.name === undefined) delete next.name;
	return { ...models, providers: { ...providers, [id]: next } };
}

/** models.json with a model pi does not know added to one of pi's own providers; the rest of pi's models stay. */
export function withModel(
	models: Record<string, unknown>,
	providerId: string,
	modelId: string,
): Record<string, unknown> {
	const providers = isRecord(models.providers) ? models.providers : {};
	const current = isRecord(providers[providerId]) ? providers[providerId] : {};
	return {
		...models,
		providers: { ...providers, [providerId]: { ...current, models: mergeModels(current.models, [{ id: modelId }]) } },
	};
}

// ---------------------------------------------------------------------------------------------------------------
// mu.json
// ---------------------------------------------------------------------------------------------------------------

/**
 * The file the judgment layer reads (config.ts): mu.json, or kyrn.json on a machine that only has that one. Writing
 * a new mu.json beside a kyrn.json would hide everything else in kyrn.json.
 */
export function judgeConfigPath(agentDir: string, exists: (path: string) => boolean = existsSync): string {
	const current = join(agentDir, CONFIG_FILE);
	const legacy = join(agentDir, LEGACY_CONFIG_FILE);
	return !exists(current) && exists(legacy) ? legacy : current;
}

/** The judges a config asks for, as config.ts reads them: `tiers`, else Jev. */
export function tiersOf(config: Record<string, unknown> | undefined): string[] {
	const tiers = config?.tiers;
	const named = Array.isArray(tiers) ? tiers.filter((tier): tier is string => typeof tier === "string") : [];
	return named.length > 0 ? named : ["jev"];
}

export function withTiers(config: Record<string, unknown>, tiers: readonly string[]): Record<string, unknown> {
	return { ...config, tiers: [...tiers] };
}

// ---------------------------------------------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------------------------------------------

export function readTextFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Sets one variable in the .env, every other line as it was. A new .env is private: it holds keys. */
export function writeEnvValue(path: string, name: string, value: string): void {
	writeFileAtomic(path, setEnvValue(readTextFile(path) ?? "", name, value));
}
