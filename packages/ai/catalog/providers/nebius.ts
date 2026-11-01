import { defineProvider, modelsDevModels } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";
import type { ModelsDevReasoningOption } from "../sources/models-dev.ts";

// Nebius Token Factory: vLLM behind an OpenAI-compatible gateway, modeled on NVIDIA NIM: the message role enum has
// no "developer", and strict tool schemas and prompt_cache_retention are not verified.
// https://docs.tokenfactory.nebius.com/api-reference/inference/create-chat-completion
const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

// Effort values models.dev does not list yet, measured on Token Factory (2026-10-22): Nemotron 3 Super answers
// directly with "none", and thinks longer from "low" to "medium"; "high" thinks as long as "medium".
const MEASURED_REASONING_OPTIONS: Record<string, ModelsDevReasoningOption[]> = {
	"nvidia/nemotron-3-super-120b-a12b": [{ type: "effort", values: ["none", "low", "medium", "high"] }],
};

export default defineProvider({
	id: "nebius",
	models: (ctx) =>
		modelsDevModels(ctx, "nebius", {
			api: "openai-completions",
			baseUrl: NEBIUS_BASE_URL,
			// Recorded below, with the measured effort values where models.dev has none.
			recordReasoning: false,
			map: (model, source) => {
				const reasoningOptions = source.reasoningOptions?.length
					? source.reasoningOptions
					: MEASURED_REASONING_OPTIONS[source.id];
				ctx.recordModelsDevSource(model, { ...source, reasoningOptions });
				// The gateway accepts reasoning_effort, but which values a model honors varies (Nemotron 3.5: none/high;
				// GLM 5.3: low/high/max). It is sent only to models with known effort values, which the shared rules map
				// to thinking levels. Other reasoning models get no reasoning parameter and use their default.
				if (model.reasoning && getEffortThinkingLevelMap(reasoningOptions ?? []) !== undefined) {
					model.compat = { ...model.compat, supportsReasoningEffort: true };
				}
				return model;
			},
		}),
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
		},
	},
});
