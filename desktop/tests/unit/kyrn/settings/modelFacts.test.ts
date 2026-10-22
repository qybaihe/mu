import { describe, expect, it } from 'vitest';
import { factsOf, listedModels } from '../../../../packages/desktop/src/process/agent/kyrn/config/modelFacts';

/** What a model list states about each model, as each service words it (#23). */
describe('the facts a model list states', () => {
  it('reads OpenRouter: context, output, image input from the architecture, thinking from the parameters', () => {
    const row = {
      id: 'google/gemini-3.5-pro',
      name: 'Google: Gemini 3.5 Pro',
      context_length: 1048576,
      architecture: { modality: 'text+image->text', input_modalities: ['text', 'image', 'file'] },
      top_provider: { context_length: 1048576, max_completion_tokens: 65536 },
      supported_parameters: ['tools', 'reasoning', 'include_reasoning', 'max_tokens'],
    };
    expect(factsOf(row, row.id)).toEqual({
      name: 'Google: Gemini 3.5 Pro',
      contextWindow: 1048576,
      maxTokens: 65536,
      imageInput: true,
      reasoning: true,
    });
    // Parameters listed without a thinking one: the model does not think. Text in, text out: no images.
    const plain = {
      id: 'meta/llama-4',
      context_length: 131072,
      architecture: { modality: 'text->text' },
      supported_parameters: ['tools', 'max_tokens'],
    };
    expect(factsOf(plain, plain.id)).toEqual({ contextWindow: 131072, imageInput: false, reasoning: false });
  });

  it('reads Gemini: its token limits and thinking, and not its id twice as a name', () => {
    const row = {
      name: 'models/gemini-3.5-flash',
      displayName: 'Gemini 3.5 Flash',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      thinking: true,
    };
    expect(listedModels({ models: [row] })).toEqual({
      ids: ['gemini-3.5-flash'],
      facts: {
        'gemini-3.5-flash': { name: 'Gemini 3.5 Flash', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
      },
    });
  });

  it('reads the local servers: vLLM, LM Studio and Ollama-style rows', () => {
    expect(factsOf({ id: 'qwen3.6-32b', max_model_len: 262144 }, 'qwen3.6-32b')).toEqual({ contextWindow: 262144 });
    expect(factsOf({ id: 'gemma-4-vl', type: 'vlm', max_context_length: 32768 }, 'gemma-4-vl')).toEqual({
      contextWindow: 32768,
      imageInput: true,
    });
  });

  it('reads capability objects and lists: Mistral, LiteLLM, models.dev and capability arrays', () => {
    expect(
      factsOf(
        { id: 'pixtral-large', max_context_length: 131072, capabilities: { vision: true, completion_chat: true } },
        'pixtral-large'
      )
    ).toEqual({ contextWindow: 131072, imageInput: true });
    expect(
      factsOf(
        {
          id: 'claude-x',
          model_info: {
            max_input_tokens: 200000,
            max_output_tokens: 64000,
            supports_vision: true,
            supports_reasoning: true,
          },
        },
        'claude-x'
      )
    ).toEqual({ contextWindow: 200000, maxTokens: 64000, imageInput: true, reasoning: true });
    expect(
      factsOf(
        { id: 'k3', limit: { context: 262144, output: 32768 }, modalities: { input: ['text'] }, reasoning: true },
        'k3'
      )
    ).toEqual({ contextWindow: 262144, maxTokens: 32768, imageInput: false, reasoning: true });
    expect(factsOf({ id: 'x', capabilities: ['vision', 'thinking', 'tools'] }, 'x')).toEqual({
      imageInput: true,
      reasoning: true,
    });
  });

  it('reads Anthropic and Groq names for the same limits', () => {
    expect(
      factsOf(
        { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_input_tokens: 1000000, max_tokens: 128000 },
        'claude-sonnet-5-5'
      )
    ).toEqual({ name: 'Claude Sonnet 5.5', contextWindow: 1000000, maxTokens: 128000 });
    expect(factsOf({ id: 'llama', context_window: 131072, max_completion_tokens: 32768 }, 'llama')).toEqual({
      contextWindow: 131072,
      maxTokens: 32768,
    });
  });

  it('states nothing it was not told, and keeps no number that is not a sane token count', () => {
    // OpenAI's own list: ids only.
    expect(listedModels({ data: [{ id: 'gpt-5.6', object: 'model', owned_by: 'openai' }] })).toEqual({
      ids: ['gpt-5.6'],
      facts: {},
    });
    expect(factsOf({ id: 'a', context_length: -1, max_tokens: 'lots', name: 'a' }, 'a')).toEqual({});
    expect(factsOf({ id: 'a', context_length: '32768' }, 'a')).toEqual({ contextWindow: 32768 });
    // An output limit that is the whole context again says nothing about output.
    expect(factsOf({ id: 'a', context_length: 8192, max_tokens: 8192 }, 'a')).toEqual({ contextWindow: 8192 });
    expect(listedModels({ nothing: true })).toBeUndefined();
  });
});
