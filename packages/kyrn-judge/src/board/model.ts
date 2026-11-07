export type Wording = "zh" | "en";

const pick = (texts: { readonly zh: string; readonly en: string }, wording: Wording) =>
	wording === "zh" ? texts.zh : texts.en;

/**
 * Which model writes the board. It is asked once, the first time the board
 * is switched on, and kept for every project: the board's words are only as
 * good as the model that writes them, and each update costs one call of it.
 */
export interface RecommendedModel {
	readonly name: string;
	/** Matched against model ids, whatever the provider: anthropic, Bedrock, Copilot, OpenRouter... */
	readonly pattern: RegExp;
	readonly why: { readonly zh: string; readonly en: string };
	/** Where it usually comes from, for someone who does not have it yet. */
	readonly from: { readonly zh: string; readonly en: string };
}

export const RECOMMENDED_BOARD_MODELS: readonly RecommendedModel[] = [
	{
		name: "Claude Opus 4.6",
		pattern: /claude-opus-4[.-]6/,
		why: { zh: "讲得最自然、最稳", en: "the most natural and consistent" },
		from: { zh: "登录 Anthropic（/login）", en: "sign in to Anthropic (/login)" },
	},
	{
		name: "Gemini 3.8 Flash",
		pattern: /gemini-3\.8-flash/,
		why: { zh: "更快，也更省", en: "faster and cheaper" },
		from: { zh: "登录 Google（/login）", en: "sign in with Google (/login)" },
	},
];

export interface ModelLike {
	readonly provider: string;
	readonly id: string;
	readonly name?: string;
}

export type ModelChoice =
	| { readonly label: string; readonly kind: "model"; readonly ref: string }
	| { readonly label: string; readonly kind: "other" }
	| { readonly label: string; readonly kind: "add"; readonly recommended?: RecommendedModel };

export const refOf = (model: ModelLike): string => `${model.provider}/${model.id}`;

/** Stored instead of a model: the board is written by whatever model the conversation uses. */
export const SESSION_MODEL = "session";

/** The provider a recommended model is best taken from, when several offer it: the maker's own first. */
const PREFERRED = ["anthropic", "google", "github-copilot", "openrouter"];

function bestOf(available: readonly ModelLike[], pattern: RegExp): ModelLike | undefined {
	const matching = available.filter((model) => pattern.test(model.id));
	const rank = (model: ModelLike) => {
		const at = PREFERRED.indexOf(model.provider);
		return at < 0 ? PREFERRED.length : at;
	};
	return [...matching].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * The first picker: the recommended models first (each with why, and how to get it when it is not set up
 * yet), then the conversation's own model, then everything else the user has, then adding one.
 */
export function boardModelChoices(
	available: readonly ModelLike[],
	current: ModelLike | undefined,
	wording: Wording,
): ModelChoice[] {
	const choices: ModelChoice[] = [];
	const offered = new Set<string>();
	for (const recommended of RECOMMENDED_BOARD_MODELS) {
		const model = bestOf(available, recommended.pattern);
		if (model) {
			offered.add(refOf(model));
			choices.push({
				kind: "model",
				ref: refOf(model),
				label: pick(
					{
						zh: `推荐 · ${recommended.name}：${recommended.why.zh}（${model.provider}）`,
						en: `Recommended · ${recommended.name}: ${recommended.why.en} (${model.provider})`,
					},
					wording,
				),
			});
		} else {
			choices.push({
				kind: "add",
				recommended,
				label: pick(
					{
						zh: `推荐 · ${recommended.name}：${recommended.why.zh}（还没有，选它看怎么添加）`,
						en: `Recommended · ${recommended.name}: ${recommended.why.en} (not set up yet; pick it to see how)`,
					},
					wording,
				),
			});
		}
	}
	choices.push({
		kind: "model",
		ref: SESSION_MODEL,
		label: current
			? pick(
					{
						zh: `跟着对话用的模型（现在是 ${refOf(current)}）`,
						en: `The session's model (currently ${refOf(current)})`,
					},
					wording,
				)
			: pick({ zh: "跟着对话用的模型", en: "The session's model" }, wording),
	});
	if (available.some((model) => !offered.has(refOf(model)))) {
		choices.push({
			kind: "other",
			label: pick({ zh: "从已有的模型里选…", en: "Pick another model you have…" }, wording),
		});
	}
	choices.push({ kind: "add", label: pick({ zh: "添加一个模型…", en: "Add a model…" }, wording) });
	return choices;
}

/** The second picker: every model the user can call, by name, the maker's first. */
export function otherModelChoices(available: readonly ModelLike[]): { label: string; ref: string }[] {
	return [...available]
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
		.slice(0, 80)
		.map((model) => ({ label: `${model.name ?? model.id} (${refOf(model)})`, ref: refOf(model) }));
}

/** What adding a model means here, said once, with the recommended one when that is what was picked. */
export function addModelHelp(wording: Wording, recommended?: RecommendedModel): string {
	const first = recommended
		? pick(
				{
					zh: `要用 ${recommended.name}，先${recommended.from.zh}。`,
					en: `To use ${recommended.name}, first ${recommended.from.en}.`,
				},
				wording,
			)
		: "";
	return [
		first,
		pick(
			{
				zh: "添加模型：/login 登录 Anthropic、Google、OpenAI 等账号，或在设置里填一个 OpenAI / Anthropic 兼容的接口地址和密钥。加好之后用 /board model 选它；在那之前，看板先用这次对话的模型来写。",
				en: "To add a model, sign in to Anthropic, Google, OpenAI or another provider with /login, or add an OpenAI- or Anthropic-compatible endpoint and key in settings. Then pick it with /board model. Until then, the session's model writes the board.",
			},
			wording,
		),
	]
		.filter(Boolean)
		.join("\n");
}
