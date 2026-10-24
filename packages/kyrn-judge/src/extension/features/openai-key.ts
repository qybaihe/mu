import { say } from "../../language.ts";
import type { OpenAIKeyProblem } from "../../providers/openai-decisions.ts";
import type { KyrnRuntime } from "../runtime.ts";

/**
 * Tells the person once per session when the `openai` judge has no usable key: none is set any more (they signed out of
 * OpenAI, or removed the key), or OpenAI turned the key down. Until a key is back, the judges after it answer, or the
 * decision points use their fallbacks when it is the last one.
 */
export function registerOpenAIKeyNotice(runtime: KyrnRuntime): void {
	let said = false;
	runtime.onOpenAIKey = (problem: OpenAIKeyProblem) => {
		if (said) return;
		said = true;
		const tiers = runtime.config.tiers;
		const others = tiers.length > 1 || (tiers.length === 1 && tiers[0] !== "openai");
		const meanwhile = others
			? { zh: "先由后面的判定器来判定", en: "the next judge is answering for it" }
			: { zh: "判定暂时交给规则", en: "mu is using its fallbacks" };
		const message =
			problem === "missing"
				? say({
						zh: `mu：OpenAI 的决策模型现在没有 API 密钥（可能退出了 OpenAI 登录，或删掉了密钥），${meanwhile.zh}。重新填一个 OpenAI API 密钥就能恢复：mu setup，或桌面端「设置 → 判定器」；也可以用 /mu judge 换一个判定器。`,
						en: `mu: OpenAI's decision model has no API key now (signed out of OpenAI, or the key was removed), so ${meanwhile.en}. To bring it back, add an OpenAI API key with mu setup or in the desktop app under Settings → Judges, or pick another judge with /mu judge.`,
					})
				: say({
						zh: `mu：OpenAI 拒绝了决策模型的 API 密钥（可能已失效，或这个账号用不了 Decisions API），${meanwhile.zh}。换一个 OpenAI API 密钥就能恢复：mu setup，或桌面端「设置 → 判定器」；也可以用 /mu judge 换一个判定器。`,
						en: `mu: OpenAI turned down the decision model's API key (it may be revoked, or the account can't use the Decisions API), so ${meanwhile.en}. To bring it back, add another OpenAI API key with mu setup or in the desktop app under Settings → Judges, or pick another judge with /mu judge.`,
					});
		// The coded event goes first: an app that words it by code then knows the line that follows is the same notice.
		runtime.present("judge.notice", { code: "openai_key", reason: problem, message });
		const ctx = runtime.ctx;
		if (ctx?.hasUI) ctx.ui.notify(message, "warning");
	};
}
