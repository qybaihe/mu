import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../setup/files.ts";

/**
 * `<agentDir>/mu/notices.json`: what mu has said and keeps from saying again (`freeJev`, the day the free Jev notice
 * was said), and what it has yet to say (`layaRemoved`, laya.ts). Each notice keeps to its own key: a write keeps the
 * others as they are.
 */
export function noticesFile(agentDir: string): string {
	return join(agentDir, "mu", "notices.json");
}

/** The file's notices; none when there is no file, or it is not a JSON object. */
export function readNotices(file: string | undefined): Record<string, unknown> {
	if (!file) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Sets the notice `key` to `value`, or takes it out when `value` is undefined. Throws when the file cannot be written. */
export function writeNotice(file: string, key: string, value: unknown): void {
	const notices: Record<string, unknown> = { ...readNotices(file), version: 1 };
	if (value === undefined) delete notices[key];
	else notices[key] = value;
	writeFileAtomic(file, `${JSON.stringify(notices, null, "\t")}\n`);
}
