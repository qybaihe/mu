import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FileEntry, type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { userMsg } from "../utilities.ts";

type InternalSessionManager = SessionManager & {
	_rewriteFile(entries?: FileEntry[]): void;
};

describe("SessionManager persistence", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not advance the in-memory session when appending fails to serialize", () => {
		tempDir = mkdtempSync(join(tmpdir(), "session-persistence-"));
		const session = SessionManager.create(process.cwd(), tempDir);
		const firstId = session.appendMessage(userMsg("first"));
		const sessionFile = session.getSessionFile()!;
		const persisted = readFileSync(sessionFile, "utf8");
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => session.appendCustomEntry("circular", circular)).toThrow(TypeError);
		expect(session.getLeafId()).toBe(firstId);
		expect(session.getEntries()).toHaveLength(1);
		expect(readFileSync(sessionFile, "utf8")).toBe(persisted);
	});

	it("keeps the previous file intact when an atomic rewrite fails", () => {
		tempDir = mkdtempSync(join(tmpdir(), "session-persistence-"));
		const session = SessionManager.create(process.cwd(), tempDir);
		session.appendMessage(userMsg("first"));
		const sessionFile = session.getSessionFile()!;
		const persisted = readFileSync(sessionFile, "utf8");
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const malformed: SessionEntry = {
			type: "custom",
			customType: "circular",
			data: circular,
			id: "malformed",
			parentId: null,
			timestamp: new Date().toISOString(),
		};
		const internal = session as InternalSessionManager;

		expect(() => internal._rewriteFile([...session.getEntries(), malformed])).toThrow(TypeError);
		expect(readFileSync(sessionFile, "utf8")).toBe(persisted);
		expect(existsSync(`${sessionFile}.tmp`)).toBe(false);
		expect(readdirSync(tempDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});
