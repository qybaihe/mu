import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JudgeErrorKind } from "../../errors.ts";
import { say } from "../../language.ts";
import type { FreeJevOutcome } from "../../providers/free-jev.ts";
import type { KyrnRuntime } from "../runtime.ts";
import type { HarnessRoots } from "./inherit.ts";

/** Failures that mean the free Jev is no longer free or no longer there, not a passing hiccup. */
const ENDED: ReadonlyMap<JudgeErrorKind, "paid" | "gone"> = new Map([
	["auth", "paid"],
	["payment_required", "paid"],
	["bad_request", "gone"],
]);

const today = (): string => {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** The day the notice was last said, in `<agentDir>/mu/notices.json`. */
function saidOn(file: string | undefined): string | undefined {
	if (!file) return undefined;
	try {
		const value = JSON.parse(readFileSync(file, "utf8")) as { freeJev?: unknown };
		return typeof value.freeJev === "string" ? value.freeJev : undefined;
	} catch {
		return undefined;
	}
}

function markSaid(file: string | undefined, day: string): void {
	if (!file) return;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify({ version: 1, freeJev: day }, null, "\t")}\n`);
	} catch {
		// Said again tomorrow at the latest: nothing worse.
	}
}

/**
 * Tells the person when the `jev` judge falls back to the free Jev on OpenCode Zen because no key is set: once a day,
 * at its first answer, where what it judges goes and how to use a key of their own. Once per session, when the free
 * Jev stops answering because it now asks for a key or is gone: plain rules decide until a key is set.
 */
export function registerFreeJevNotice(runtime: KyrnRuntime, roots: HarnessRoots | undefined): void {
	const file = roots ? join(roots.agentDir, "mu", "notices.json") : undefined;
	let inUseSaid = false;
	let endSaid = false;

	// The coded event goes first: an app that words it by code then knows the line that follows is the same notice.
	const tell = (code: "free_jev" | "free_jev_unavailable", message: string, reason?: string): void => {
		runtime.present("judge.notice", { code, ...(reason ? { reason } : {}), message });
		const ctx = runtime.ctx;
		if (ctx?.hasUI) ctx.ui.notify(message, code === "free_jev" ? "info" : "warning");
	};

	runtime.onFreeJev = (outcome: FreeJevOutcome) => {
		if (outcome === "answered") {
			if (inUseSaid) return;
			inUseSaid = true;
			const day = today();
			if (saidOn(file) === day) return;
			markSaid(file, day);
			tell(
				"free_jev",
				say({
					zh: "mu：没有配置 Jev 密钥，判定器先用 OpenCode Zen 上限时免费的 Jev 1.13。判定要读的内容会发给 OpenCode，它不拿来训练模型。想用自己的密钥：运行 mu setup，或在桌面端「设置 → 判定器」里填。",
					en: "mu: no Jev key is set, so the judge uses Jev 1.13 on OpenCode Zen, free for a limited time. What it judges is sent to OpenCode, which does not train on it. To use a key of your own, run mu setup, or fill one in under Settings → Judges in the desktop app.",
				}),
			);
			return;
		}
		const reason = ENDED.get(outcome);
		if (!reason || endSaid) return;
		endSaid = true;
		tell(
			"free_jev_unavailable",
			reason === "paid"
				? say({
						zh: "mu：OpenCode Zen 上的免费 Jev 现在要密钥或付费了，判定暂时交给规则。配置一个 Jev 密钥就能恢复：mu setup，或桌面端「设置 → 判定器」。",
						en: "mu: the free Jev on OpenCode Zen now asks for a key or payment, so plain rules decide for now. Set a Jev key to get the judge back: mu setup, or Settings → Judges in the desktop app.",
					})
				: say({
						zh: "mu：OpenCode Zen 已经不提供免费的 Jev 了，判定暂时交给规则。配置一个 Jev 密钥就能恢复：mu setup，或桌面端「设置 → 判定器」。",
						en: "mu: OpenCode Zen no longer offers the free Jev, so plain rules decide for now. Set a Jev key to get the judge back: mu setup, or Settings → Judges in the desktop app.",
					}),
			reason,
		);
	};
}
