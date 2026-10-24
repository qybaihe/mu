import type { LayaSkipped } from "../../config.ts";
import { say } from "../../language.ts";
import { migrateConfigFile } from "../../laya-migration.ts";
import type { KyrnRuntime } from "../runtime.ts";
import type { HarnessRoots } from "./inherit.ts";
import { noticesFile, readNotices, writeNotice } from "./notices.ts";
import { judgeDisplayName } from "./welcome.ts";

/** The Laya notice: which judge answers in Laya's place, and where Laya was named. */
export interface LayaNotice {
	/** The judge in Laya's place, by its name in the order (`mude`, `jev`, …): `judge` in `judge.notice`. */
	readonly judge: string;
	/** mu.json (or kyrn.json) named Laya and lost it, or only MU_JUDGE did, which no session changes. */
	readonly from: "mu.json" | "MU_JUDGE";
}

/** Where a notice nobody has seen yet waits in notices.json. */
const PENDING_KEY = "layaRemoved";

/** The notice for a session that read its configuration without Laya: mude 1.0 when it took Laya's place, else `first`. */
export function layaNoticeOf(skipped: LayaSkipped, first: string): LayaNotice {
	return { judge: skipped.replacement ?? first, from: skipped.env && !skipped.file ? "MU_JUDGE" : "mu.json" };
}

/** How the notice names the judge in Laya's place. */
function judgeName(name: string): string {
	return name === "mude" ? "mude 1.0" : judgeDisplayName(name);
}

/**
 * What mu says when the configuration still named Laya: what answers instead and where other decision models come
 * from. Laya itself is not among them: the Hugging Face models mu adds are packaged as mude 1.0 is.
 */
export function layaNotice(notice: LayaNotice): string {
	const name = judgeName(notice.judge);
	if (notice.from === "MU_JUDGE") {
		return say({
			zh: `mu：不再内置 Laya，所以跳过了 MU_JUDGE 里的 laya，判定器现在是 ${name}。想用别的决策模型，可以从 Hugging Face 添加：mu judge model add <链接>（或在桌面端「设置 → 判定器」里添加）。`,
			en: `mu: Laya is no longer built in, so mu skips laya in MU_JUDGE and your judge is now ${name}. To use another decision model, add it from Hugging Face: mu judge model add <link> (or Settings → Judges in the desktop app).`,
		});
	}
	return say({
		zh: `mu：不再内置 Laya，你的判定器现在是 ${name}。想用别的决策模型，可以从 Hugging Face 添加：mu judge model add <链接>（或在桌面端「设置 → 判定器」里添加）。`,
		en: `mu: Laya is no longer built in, so your judge is now ${name}. To use another decision model, add it from Hugging Face: mu judge model add <link> (or Settings → Judges in the desktop app).`,
	});
}

/** The notice waiting in `file` (notices.ts) for someone to see it, if one is. */
export function pendingLayaNotice(file: string | undefined): LayaNotice | undefined {
	const value = readNotices(file)[PENDING_KEY];
	if (typeof value !== "object" || value === null) return undefined;
	const { judge, from } = value as { judge?: unknown; from?: unknown };
	if (typeof judge !== "string" || !judge.trim()) return undefined;
	return { judge, from: from === "MU_JUDGE" ? "MU_JUDGE" : "mu.json" };
}

/**
 * Leaves `notice` in `file` until someone sees it. One about mu.json says more than one about MU_JUDGE, and stays.
 * Returns whether the file holds a notice now.
 */
function holdNotice(file: string, notice: LayaNotice): boolean {
	try {
		if (notice.from === "MU_JUDGE" && pendingLayaNotice(file)?.from === "mu.json") return true;
		writeNotice(file, PENDING_KEY, notice);
		return true;
	} catch {
		return false;
	}
}

/**
 * The configuration named Laya, and this session reads it without (config.ts). At the first session start someone
 * could see (the terminal, or the desktop app over RPC), mu.json loses Laya for good (laya-migration.ts), and the notice
 * waits in `<agentDir>/mu/notices.json` until a person sends a message. A session that starts and gets no message
 * never shows it: the desktop app's backend opens one at every app start to check that mu runs.
 *
 * The first message a person sends, in this session or a later one, shows it once: `judge.notice` with the code
 * `laya_removed` for the app, then the line itself, and takes it out of the file. That is pi's `input` event, which a
 * message typed in the terminal and a prompt over RPC raise. A command of mu's own (`/goal`, `/permissions`, `/mu …`)
 * does not: pi runs it before that event, it starts no turn, and the app sends some by itself. Nor does a message an
 * extension sends.
 *
 * A run nobody watches (`mu --print`, json mode, a sub-agent) leaves the file to a later session and the notice where
 * it is. MU_JUDGE is not a file: a session started with laya in it leaves the notice again, each time.
 */
export function registerLayaNotice(
	runtime: KyrnRuntime,
	skipped: LayaSkipped | undefined,
	roots: HarnessRoots | undefined,
	muHome: string,
): void {
	const file = roots ? noticesFile(roots.agentDir) : undefined;
	if (!skipped && !file) return;
	// This session's notice, when notices.json cannot hold it.
	let held: LayaNotice | undefined;
	let started = false;
	let asked = false;

	if (skipped) {
		runtime.pi.on("session_start", (_event, ctx) => {
			try {
				if (started || !ctx.hasUI) return;
				started = true;
				if (skipped.file && roots) {
					migrateConfigFile({ agentDir: roots.agentDir, muHome, replacement: skipped.replacement });
				}
				const notice = layaNoticeOf(skipped, runtime.config.tiers[0] ?? "jev");
				if (!file || !holdNotice(file, notice)) held = notice;
			} catch {
				// A notice is never a reason for a session not to start.
			}
		});
	}

	runtime.pi.on("input", (event, ctx) => {
		try {
			if (asked || !ctx.hasUI || event.source === "extension") return;
			if (!event.text.trim() && !event.images?.length) return;
			asked = true;
			const waiting = pendingLayaNotice(file);
			const notice = waiting ?? held;
			if (!notice) return;
			held = undefined;
			if (waiting && file) {
				try {
					writeNotice(file, PENDING_KEY, undefined);
				} catch {
					// Said again at the next session's first message: nothing worse.
				}
			}
			const message = layaNotice(notice);
			runtime.touch(ctx);
			runtime.present("judge.notice", { code: "laya_removed", judge: notice.judge, message });
			ctx.ui.notify(message, "info");
		} catch {
			// The message goes on all the same.
		}
	});
}
