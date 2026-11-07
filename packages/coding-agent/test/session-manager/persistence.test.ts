import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const dirs: string[] = [];
const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "session-persistence-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
const circular = (): Record<string, unknown> => {
	const value: Record<string, unknown> = {};
	value.self = value;
	return value;
};

describe("SessionManager writing its file", () => {
	it("writes the file with the first conversation entry, and leaves nothing else beside it", () => {
		const dir = tempDir();
		const session = SessionManager.create(dir, dir);
		session.appendCustomEntry("setup", { a: 1 });
		expect(readdirSync(dir)).toEqual([]);

		session.appendMessage(user("first"));
		const file = session.getSessionFile();
		expect(file).toBeDefined();
		expect(readdirSync(dir)).toEqual([file?.split("/").at(-1)]);
		const types = readFileSync(file as string, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).type);
		expect(types).toEqual(["session", "custom", "message"]);
	});

	it("never writes over a file already at the new session's path", () => {
		const dir = tempDir();
		const session = SessionManager.create(dir, dir);
		const file = session.getSessionFile() as string;
		writeFileSync(file, "someone else's\n");

		expect(() => session.appendMessage(user("first"))).toThrow(/EEXIST/);
		expect(readFileSync(file, "utf8")).toBe("someone else's\n");
		expect(session.getEntries()).toEqual([]);
		expect(readdirSync(dir)).toEqual([file.split("/").at(-1)]);
	});

	it("keeps an entry that cannot be written out of the session, in memory and on disk", () => {
		const dir = tempDir();
		const session = SessionManager.create(dir, dir);
		const reserved = session.reserveEntryId();
		const firstId = session.appendMessage(user("first"));
		const file = session.getSessionFile() as string;
		const saved = readFileSync(file, "utf8");

		expect(() => session.appendCustomEntry("broken", circular())).toThrow(TypeError);
		expect(session.getLeafId()).toBe(firstId);
		expect(session.getEntries()).toHaveLength(1);
		expect(readFileSync(file, "utf8")).toBe(saved);

		// Its reserved id is not spent by an entry that failed.
		expect(() => session.appendMessage(user("bad"), reserved)).not.toThrow();
		expect(session.getLeafId()).toBe(reserved);
	});

	it("leaves no file when the first conversation entry cannot be written", () => {
		const dir = tempDir();
		const session = SessionManager.create(dir, dir);
		session.appendCustomEntry("broken-later", { fine: true });

		expect(() => session.appendMessage({ ...user("first"), extra: circular() } as never)).toThrow(TypeError);
		expect(readdirSync(dir)).toEqual([]);
		expect(session.getEntries()).toHaveLength(1);
	});

	it("rewrites an older session file whole when it opens it, with nothing left beside it", () => {
		const dir = tempDir();
		const file = join(dir, "old.jsonl");
		const v1 = [
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: dir },
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: user("hi") },
		];
		writeFileSync(file, `${v1.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const session = SessionManager.open(file, dir);

		const lines = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0].version).toBe(3);
		expect(lines[1].id).toBe(session.getEntries()[0].id);
		expect(readdirSync(dir)).toEqual(["old.jsonl"]);
	});
});
