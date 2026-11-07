import type { ListedModel } from '../../../../common/kyrn/models';
import { asRecord, text, type JsonRecord } from '../piRpc';

/**
 * What a model list says about each model, for the rows a new provider starts with (#23). Services put the same facts
 * under different names: OpenRouter `context_length` and `architecture.input_modalities`, Gemini `inputTokenLimit`
 * and `thinking`, vLLM `max_model_len`, LM Studio `max_context_length` and `type: "vlm"`, Mistral `capabilities.vision`,
 * Groq `context_window`, LiteLLM `model_info.supports_vision`, models.dev `limit.context` and `modalities.input`.
 * A fact is kept only where the list states it; anything else stays at the row's defaults.
 */

/** Context window fields, most specific first. */
const CONTEXT_PATHS = [
  'context_length',
  'context_window',
  'contextWindow',
  'max_context_length',
  'max_model_len',
  'max_input_tokens',
  'inputTokenLimit',
  'input_token_limit',
  'max_context_tokens',
  'limit.context',
  'top_provider.context_length',
  'model_info.max_input_tokens',
] as const;

/** Output limit fields. `max_tokens` is the output limit where it appears next to a context field (Anthropic, LiteLLM). */
const OUTPUT_PATHS = [
  'max_completion_tokens',
  'max_output_tokens',
  'outputTokenLimit',
  'output_token_limit',
  'maxOutputTokens',
  'limit.output',
  'top_provider.max_completion_tokens',
  'model_info.max_output_tokens',
  'max_tokens',
  'model_info.max_tokens',
] as const;

const NAME_PATHS = ['display_name', 'displayName', 'name'] as const;

/** Words that mean thinking, in `supported_parameters` or a `capabilities` list. */
const THINKING_WORDS = new Set(['reasoning', 'include_reasoning', 'reasoning_effort', 'thinking']);
const IMAGE_WORDS = new Set(['image', 'images', 'vision', 'image_input']);
/** Flags that say yes outright. */
const THINKING_FLAGS = [
  'reasoning',
  'thinking',
  'supports_reasoning',
  'supports_thinking',
  'capabilities.reasoning',
  'capabilities.thinking',
  'model_info.supports_reasoning',
];
const IMAGE_FLAGS = [
  'supports_vision',
  'supports_image_input',
  'vision',
  'capabilities.vision',
  'capabilities.image_input',
  'model_info.supports_vision',
];

/** The largest number a row takes (ModelRows' fields). */
const MAX_TOKENS = 100_000_000;

function at(row: JsonRecord, path: string): unknown {
  let value: unknown = row;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as JsonRecord)[key];
  }
  return value;
}

/** A whole number of tokens, from a number or a numeric string. */
function tokens(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 && number <= MAX_TOKENS
    ? number
    : undefined;
}

const firstTokens = (row: JsonRecord, paths: readonly string[]): number | undefined => {
  for (const path of paths) {
    const value = tokens(at(row, path));
    if (value !== undefined) return value;
  }
  return undefined;
};

const words = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.toLowerCase())
    : undefined;

/** The input side of OpenRouter's `architecture.modality`, as in `text+image->text`. */
const modalityInputs = (value: unknown): string[] | undefined =>
  typeof value === 'string' && value.includes('->') ? value.split('->')[0].toLowerCase().split('+') : undefined;

/** Whether the model reads images: true or false where the list says, undefined where it does not. */
function imageInput(row: JsonRecord): boolean | undefined {
  const inputs =
    words(at(row, 'architecture.input_modalities')) ??
    words(at(row, 'input_modalities')) ??
    words(at(row, 'modalities.input')) ??
    modalityInputs(at(row, 'architecture.modality'));
  if (inputs) return inputs.some((entry) => IMAGE_WORDS.has(entry));
  if (IMAGE_FLAGS.some((path) => at(row, path) === true)) return true;
  if (words(at(row, 'capabilities'))?.some((entry) => IMAGE_WORDS.has(entry))) return true;
  if (text(row.type) === 'vlm') return true;
  return undefined;
}

/** Whether the model thinks: true where the list says so, false where it lists its parameters without one. */
function reasoning(row: JsonRecord): boolean | undefined {
  if (THINKING_FLAGS.some((path) => at(row, path) === true)) return true;
  if (words(at(row, 'capabilities'))?.some((entry) => THINKING_WORDS.has(entry))) return true;
  const parameters = words(at(row, 'supported_parameters'));
  if (parameters) return parameters.some((entry) => THINKING_WORDS.has(entry));
  return undefined;
}

/** A display name that is more than the id again (`name` is Gemini's id, `models/x`). */
function displayName(row: JsonRecord, id: string): string | undefined {
  for (const path of NAME_PATHS) {
    const name = text(row[path]).trim();
    if (name && name !== id && !name.startsWith('models/') && name.length <= 120) return name;
  }
  return undefined;
}

/** The facts one row of a model list states about its model; empty when it states none. */
export function factsOf(value: unknown, id: string): ListedModel {
  const row = asRecord(value);
  const facts: ListedModel = {};
  const name = displayName(row, id);
  if (name) facts.name = name;
  const contextWindow = firstTokens(row, CONTEXT_PATHS);
  if (contextWindow !== undefined) facts.contextWindow = contextWindow;
  const output = firstTokens(row, OUTPUT_PATHS);
  // An output limit that is the context window again, or more, says nothing about output.
  if (output !== undefined && (contextWindow === undefined || output < contextWindow)) facts.maxTokens = output;
  const image = imageInput(row);
  if (image !== undefined) facts.imageInput = image;
  const thinks = reasoning(row);
  if (thinks !== undefined) facts.reasoning = thinks;
  return facts;
}

/** Model ids from the three list shapes (OpenAI and Anthropic `{data:[{id}]}`, Google `{models:[{name:"models/x"}]}`), each with its facts. */
export function listedModels(body: unknown): { ids: string[]; facts: Record<string, ListedModel> } | undefined {
  const record = asRecord(body);
  const rows = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : undefined;
  if (!rows) return undefined;
  const ids: string[] = [];
  const facts: Record<string, ListedModel> = {};
  for (const row of rows) {
    if (ids.length >= 500) break;
    const id = text(asRecord(row).id) || text(asRecord(row).name).replace(/^models\//, '');
    if (!id) continue;
    ids.push(id);
    const stated = factsOf(row, id);
    if (Object.keys(stated).length) facts[id] = stated;
  }
  return { ids, facts };
}
