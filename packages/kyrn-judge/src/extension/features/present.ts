import { statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { KyrnRuntime } from "../runtime.ts";

/** At most this many files one call presents. */
export const MAX_PRESENTED = 8;

export interface PresentedFile {
	/** Absolute path. */
	readonly path: string;
	/** What the user sees for it: the label the model gave, else the file's name. */
	readonly name: string;
	readonly bytes: number;
}

/** What a present result carries for a client: the files, and the model's one line for the user. */
export interface PresentDetails {
	readonly files: readonly PresentedFile[];
	readonly note?: string;
}

/** 1.2 KB, 3.4 MB: a size a person reads. */
export function sizeText(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** The path as the user's project names it, or as it is when it is outside the project. */
function shown(path: string, cwd: string): string {
	const inside = relative(cwd, path);
	return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

/**
 * Each file the model named, read from disk: a regular file that exists, or why it cannot be presented. Nothing is
 * read from inside the files: their name and size are all a client needs to show and open them.
 */
export function readPresented(
	files: readonly { readonly path: string; readonly label?: string }[],
	cwd: string,
): { files: PresentedFile[]; problems: string[] } {
	const found: PresentedFile[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		const said = file.path.trim();
		if (!said) continue;
		const path = resolve(cwd, said);
		if (seen.has(path)) continue;
		seen.add(path);
		let stats: ReturnType<typeof statSync> | undefined;
		try {
			stats = statSync(path);
		} catch {
			problems.push(`${said}: no such file`);
			continue;
		}
		if (!stats.isFile()) {
			problems.push(`${said}: ${stats.isDirectory() ? "a folder, not a file" : "not a regular file"}`);
			continue;
		}
		found.push({ path, name: file.label?.trim() || basename(path), bytes: stats.size });
	}
	return { files: found, problems };
}

/**
 * `present`: the model hands the user the files the task produced (a report, a deck, a build, an export), one call at
 * the end with up to eight of them. Each has to be a regular file that exists; nothing in it is read or copied. The
 * result names them with their size, and its details carry their absolute paths, which a client shows as a card the
 * user opens each file from (the desktop app's deliverables card; the terminal prints the list).
 *
 * The tool brings two guidelines into the system prompt: present is for the deliverables, not the source files the
 * agent edited on the way, and a file the model names is a link with the line as `#L24` and the file's name as its
 * label. Being on the list from the start keeps the prompt the same from request to request.
 *
 * Not in a sub-agent (its parent presents), nor in an unattended run (`catalog.unattendedHidden`): nobody opens the files
 * there. Only reading what is on disk, it is on the read-only lists of the permission modes, the checkpoint, the
 * credential guard and the board.
 */
export function registerPresent(runtime: KyrnRuntime): void {
	const options = runtime.options("present", { enabled: true });
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;

	pi.registerTool({
		name: "present",
		label: "Present files",
		description: `Hand the user the files this task produced and they asked for (a report, a deck, a build, an export), once, when they are ready: up to ${MAX_PRESENTED} files that exist. The user gets them as a list to open.`,
		promptGuidelines: [
			"Call present once at the end with the files the user asked for; not to list the source files you edited.",
			"When you name a file that exists, link it: [api.ts](src/api.ts#L24), the line as #L24 or #L24-L30, and the file's name as the label.",
		],
		parameters: Type.Object({
			files: Type.Array(
				Type.Object({
					path: Type.String({ description: "The file, absolute or from the working folder" }),
					label: Type.Optional(Type.String({ description: "What to call it, when not its file name" })),
				}),
				{ minItems: 1, maxItems: MAX_PRESENTED },
			),
			note: Type.Optional(Type.String({ description: "One line for the user about them" })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			runtime.touch(ctx);
			const asked = (params.files ?? []).slice(0, MAX_PRESENTED);
			const { files, problems } = readPresented(asked, ctx.cwd);
			if (files.length === 0) {
				throw new Error(
					`Nothing to present: ${problems.join("; ") || "no file named"}. Present files that exist, once they are written.`,
				);
			}
			const note = params.note?.trim();
			const lines = files.map((file) => `- ${file.name} (${shown(file.path, ctx.cwd)}, ${sizeText(file.bytes)})`);
			const text = [
				`Presented to the user (${files.length} ${files.length === 1 ? "file" : "files"}):`,
				...lines,
				...(problems.length > 0 ? [`Left out: ${problems.join("; ")}.`] : []),
			].join("\n");
			const details: PresentDetails = { files, ...(note ? { note } : {}) };
			return { content: [{ type: "text", text }], details };
		},
	});

	runtime.catalog.register({
		id: "tool:present",
		kind: "tool",
		title: "Present files",
		description:
			"Hands the user the files a task produced (a report, a deck, a build) as a list they open them from; the desktop app shows it as a card.",
		tools: ["present"],
		exposure: "always",
	});
}
