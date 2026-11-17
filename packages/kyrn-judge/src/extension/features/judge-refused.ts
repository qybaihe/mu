import { say } from "../../language.ts";
import { type JudgeRefusal, resolveJudgeConfig } from "../../registry.ts";
import { clip, type KyrnRuntime } from "../runtime.ts";

/** How much of what the service said the notice quotes. */
const SAID_CHARS = 160;

/**
 * Tells the person when a judge's service turned its key down, or cannot charge the account behind it, and mu stopped
 * asking it for now (`RefusalGuard`): once per session for each service, which judge it is, what the service said, who
 * decides meanwhile and how to bring it back. Without it a key that stopped working showed only as decisions falling
 * back, a round trip each: in the owner's sessions `tool.injection` did that 137 times in a row over a week.
 *
 * Not for OpenAI's decision model or the free Jev, which say their own (openai-key.ts, free-jev.ts).
 */
export function registerJudgeRefusedNotice(runtime: KyrnRuntime): void {
	const said = new Set<string>();
	runtime.onJudgeRefused = (refusal: JudgeRefusal, tiers: readonly string[]) => {
		if (said.has(refusal.service)) return;
		said.add(refusal.service);
		// Jev's services stand in for each other; another judge does when one comes after this one in its order.
		const meanwhile =
			resolveJudgeConfig(refusal.judge, runtime.config)?.type === "jev"
				? { zh: "先经 Jev 的下一个服务来判定", en: "mu is asking Jev through its next service" }
				: tiers.indexOf(refusal.judge) < tiers.length - 1
					? { zh: "先由后面的判定器来判定", en: "the next judge is answering for it" }
					: { zh: "判定暂时交给规则", en: "mu is using its fallbacks" };
		// The service's own words, shown as they are: without control characters, which could draw on a terminal.
		const words = clip(refusal.message.replace(/\p{Cc}/gu, " "), SAID_CHARS);
		const message =
			refusal.kind === "payment_required"
				? say({
						zh: `mu：${refusal.service} 说判定器 ${refusal.judge} 背后的账号还不能付费（“${words}”），${meanwhile.zh}。到那边绑定付款方式或充值就能恢复；也可以用 /mu judge 换一个判定器。`,
						en: `mu: ${refusal.service} can't charge the account behind the ${refusal.judge} judge ("${words}"), so ${meanwhile.en}. To bring it back, add a payment method or credit there, or pick another judge with /mu judge.`,
					})
				: say({
						zh: `mu：${refusal.service} 拒绝了判定器 ${refusal.judge} 的密钥（“${words}”），${meanwhile.zh}。换一个能用的密钥就能恢复：mu setup，或桌面端「设置 → 判定器」；也可以用 /mu judge 换一个判定器。`,
						en: `mu: ${refusal.service} turned down the key of the ${refusal.judge} judge ("${words}"), so ${meanwhile.en}. To bring it back, set a working key with mu setup or in the desktop app under Settings → Judges, or pick another judge with /mu judge.`,
					});
		// The coded event goes first: an app that words it by code then knows the line that follows is the same notice.
		runtime.present("judge.notice", {
			code: "judge_refused",
			reason: refusal.kind,
			judge: refusal.judge,
			service: refusal.service,
			said: words,
			message,
		});
		const ctx = runtime.ctx;
		if (ctx?.hasUI) ctx.ui.notify(message, "warning");
	};
}
