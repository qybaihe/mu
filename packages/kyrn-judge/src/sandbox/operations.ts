import { readFile } from "node:fs/promises";
import { extname, isAbsolute, posix, relative, sep } from "node:path";
import type { BashOperations, EditOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import { SandboxFileMissing, type SandboxSession } from "./session.ts";

/**
 * Where a local path is in the sandbox: the project folder is the sandbox's workdir, so
 * `<root>/src/a.ts` is `/workspace/src/a.ts`. Any other absolute path (`/tmp/x`, `/workspace/b`)
 * means that path inside the sandbox.
 */
export function toSandboxPath(localPath: string, root: string, workdir: string): string {
	const inside = relative(root, localPath);
	if (inside === "") return workdir;
	if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) {
		return posix.join(workdir, inside.split(sep).join("/"));
	}
	return localPath.split(sep).join("/");
}

function insideProject(localPath: string, root: string): boolean {
	const inside = relative(root, localPath);
	return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

export interface SandboxOperations {
	readonly bash: BashOperations;
	readonly read: ReadOperations;
	readonly write: WriteOperations;
	readonly edit: EditOperations;
}

/**
 * The built-in tools' pluggable operations, pointed at a sandbox session. The tools themselves (the
 * edit tool's matching and diff, the read tool's paging, the bash tool's truncation) stay as they are.
 *
 * Reading a path outside the project that the sandbox does not have falls back to this machine, read
 * only: skills and docs live in the user's home and the model is told to read them. Nothing is ever
 * written or run here.
 */
export function sandboxOperations(
	session: SandboxSession,
	options: { readonly defaultTimeoutS: number },
): SandboxOperations {
	const { root, workdir } = session;
	const where = (path: string) => toSandboxPath(path, root, workdir);

	const readWithFallback = async (path: string): Promise<Buffer> => {
		try {
			return await session.readFile(where(path));
		} catch (error) {
			if (!(error instanceof SandboxFileMissing) || insideProject(path, root)) throw error;
			const local = await readFile(path).catch(() => undefined);
			if (!local) throw error;
			return local;
		}
	};

	const bash: BashOperations = {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const timeoutS = timeout ?? options.defaultTimeoutS;
			const result = await session.exec(command, where(cwd), { signal, timeoutS });
			if (result.stdout.length > 0) onData(result.stdout);
			if (result.stderr.length > 0) onData(result.stderr);
			for (const note of result.notes) onData(Buffer.from(`\n[sandbox] ${note}\n`, "utf8"));
			if (result.timedOut) throw new Error(`timeout:${timeoutS}`);
			return { exitCode: result.exitCode };
		},
	};

	const read: ReadOperations = {
		readFile: readWithFallback,
		access: async (path) => {
			await readWithFallback(path);
		},
		detectImageMimeType: async (path) => IMAGE_TYPES[extname(path).toLowerCase()] ?? null,
	};

	const write: WriteOperations = {
		writeFile: (path, content) => session.writeFile(where(path), content),
		// The API creates the folders of a file it puts in place.
		mkdir: async () => {},
	};

	const edit: EditOperations = {
		readFile: (path) => session.readFile(where(path)),
		writeFile: (path, content) => session.writeFile(where(path), content),
		access: async (path) => {
			await session.readFile(where(path));
		},
	};

	return { bash, read, write, edit };
}
