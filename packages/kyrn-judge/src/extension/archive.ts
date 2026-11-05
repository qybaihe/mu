// The files where mu keeps the full text of tool output it shortened (admission, compaction), and their cleanup.
import { mkdirSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The archive folder of one mu process: `<temp>/kyrn-<run id>`. The run id is a UUID, so no one can guess it ahead. */
export function archiveDir(runId: string, root: string = tmpdir()): string {
	return join(root, `kyrn-${runId}`);
}

/**
 * Writes one archive file. Output can carry private data, and on Linux the temp folder is shared by every user, so
 * the folders it creates and the file are the user's alone (0700 and 0600), as pi's own output files are.
 */
export function writeArchive(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, text, { mode: 0o600 });
}

/** An archive folder nothing has written to for this long belongs to a run that is over. */
export const ARCHIVE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** `kyrn-` and a UUID: other folders of mu's in the temp folder (hive, swarm, browser) have other names. */
const ARCHIVE_NAME = /^kyrn-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Deletes the archive folders of other runs that nothing has written to for `maxAgeMs`, and only folders this user
 * owns. Says how many it deleted. A folder it cannot read or delete is left alone.
 */
export async function sweepArchives(
	keep: string,
	now: number = Date.now(),
	root: string = tmpdir(),
	maxAgeMs: number = ARCHIVE_MAX_AGE_MS,
): Promise<number> {
	const uid = process.getuid?.();
	let removed = 0;
	for (const name of await readdir(root).catch(() => [])) {
		const dir = join(root, name);
		if (!ARCHIVE_NAME.test(name) || dir === keep) continue;
		try {
			const info = await lstat(dir);
			if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) continue;
			if (now - (await lastWrite(dir, info.mtimeMs)) < maxAgeMs) continue;
			await rm(dir, { recursive: true, force: true });
			removed++;
		} catch {
			// Another run removed it first, or it is not ours to remove.
		}
	}
	return removed;
}

/** The latest change to the folder or to anything directly in it (a file written into `compacted/` counts too). */
async function lastWrite(dir: string, folderMtimeMs: number): Promise<number> {
	let latest = folderMtimeMs;
	for (const entry of await readdir(dir)) {
		const info = await lstat(join(dir, entry));
		latest = Math.max(latest, info.mtimeMs);
	}
	return latest;
}
