import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARCHIVE_MAX_AGE_MS, archiveDir, sweepArchives, writeArchive } from "../src/extension/archive.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("archive files", () => {
	const roots: string[] = [];
	afterEach(() => {
		while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
	});
	const root = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "mu-archive-test-"));
		roots.push(dir);
		return dir;
	};

	it.skipIf(process.platform === "win32")("are the user's alone, folders included", () => {
		const dir = join(archiveDir("0b6f3c1e-1d2a-4c55-9a77-3e2f4b5c6d7e", root()), "compacted");
		writeArchive(join(dir, "call_1.txt"), "secret output");
		expect(statSync(join(dir, "call_1.txt")).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "..")).mode & 0o777).toBe(0o700);
	});

	it("sweeps the archive folders of other runs not written to for 14 days, and nothing else", async () => {
		const temp = root();
		const now = Date.now();
		const old = (now - ARCHIVE_MAX_AGE_MS - DAY) / 1000;
		const folder = (name: string, ageSeconds: number, child?: { name: string; ageSeconds: number }): string => {
			const dir = join(temp, name);
			mkdirSync(dir);
			writeFileSync(join(dir, "call.txt"), "output");
			utimesSync(join(dir, "call.txt"), ageSeconds, ageSeconds);
			if (child) {
				mkdirSync(join(dir, child.name));
				utimesSync(join(dir, child.name), child.ageSeconds, child.ageSeconds);
			}
			utimesSync(dir, ageSeconds, ageSeconds);
			return dir;
		};
		const stale = folder("kyrn-11111111-2222-4333-8444-555555555555", old);
		const fresh = folder("kyrn-21111111-2222-4333-8444-555555555555", now / 1000 - 60);
		// Old itself, but compaction wrote into its `compacted/` folder an hour ago.
		const busy = folder("kyrn-31111111-2222-4333-8444-555555555555", old, {
			name: "compacted",
			ageSeconds: now / 1000 - 3600,
		});
		const current = folder("kyrn-41111111-2222-4333-8444-555555555555", old);
		// mu's other folders in the temp folder have other names.
		const hive = folder("kyrn-hive-1a2b3c4d", old);
		writeFileSync(join(temp, "kyrn-51111111-2222-4333-8444-555555555555"), "a file, not a folder");

		expect(await sweepArchives(current, now, temp)).toBe(1);

		const exists = (path: string): boolean => {
			try {
				statSync(path);
				return true;
			} catch {
				return false;
			}
		};
		expect(exists(stale)).toBe(false);
		expect([fresh, busy, current, hive].every(exists)).toBe(true);
		expect(exists(join(temp, "kyrn-51111111-2222-4333-8444-555555555555"))).toBe(true);
	});

	it("finds nothing to do in a folder it cannot read", async () => {
		expect(await sweepArchives("", Date.now(), join(root(), "missing"))).toBe(0);
	});
});
