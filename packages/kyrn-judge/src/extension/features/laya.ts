import type { LayaSkipped } from "../../config.ts";
import { say } from "../../language.ts";
import { migrateConfigFile } from "../../laya-migration.ts";
import type { KyrnRuntime } from "../runtime.ts";
import type { HarnessRoots } from "./inherit.ts";
import { judgeDisplayName } from "./welcome.ts";

/** How the notice names the judge in Laya's place. */
function judgeName(name: string): string {
	return name === "mude" ? "mude 1.0" : judgeDisplayName(name);
}

/**
 * What mu says when the configuration still named Laya: what answers instead (mude 1.0 when it took Laya's place, else
 * the first judge) and where other decision models come from. Laya itself is not among them: the Hugging Face models
 * mu adds are packaged as mude 1.0 is.
 */
export function layaNotice(skipped: LayaSkipped, judge: string): string {
	const name = judgeName(skipped.replacement ?? judge);
	if (skipped.env && !skipped.file) {
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

/**
 * The configuration named Laya, and this session reads it without (config.ts). At the first session start someone sees
 * (the terminal, or the desktop app over RPC), mu.json loses Laya for good (laya-migration.ts) and mu says so, once:
 * `judge.notice` with the code `laya_removed` for the app, then the line itself. A run nobody watches (`mu --print`,
 * json mode, a sub-agent) leaves the file to that session, so the notice is not lost on it. MU_JUDGE is not a file:
 * a session started with laya in it says so each time.
 */
export function registerLayaNotice(
	runtime: KyrnRuntime,
	skipped: LayaSkipped,
	roots: HarnessRoots | undefined,
	muHome: string,
): void {
	let done = false;
	runtime.pi.on("session_start", (_event, ctx) => {
		try {
			if (done || !ctx.hasUI) return;
			done = true;
			if (skipped.file && roots) {
				migrateConfigFile({ agentDir: roots.agentDir, muHome, replacement: skipped.replacement });
			}
			const message = layaNotice(skipped, runtime.config.tiers[0] ?? "jev");
			runtime.present("judge.notice", {
				code: "laya_removed",
				judge: skipped.replacement ?? runtime.config.tiers[0] ?? "jev",
				message,
			});
			ctx.ui.notify(message, "info");
		} catch {
			// A notice is never a reason for a session not to start.
		}
	});
}
