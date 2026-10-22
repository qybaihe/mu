import { describe, expect, it, vi } from 'vitest';
import type { AcpConfigOptionDto } from '@/common/types/platform/acpTypes';
import type { AcpDerivedOption } from '@/renderer/hooks/agent/useAcpConfigOptions';
import {
  applyModelPick,
  configErrorMessageKey,
  filterModelMenu,
  modelMenu,
} from '@/renderer/pages/conversation/platforms/acp/Composer/modelMenu';
import { modelDisplayName, providerDisplayName } from '@/renderer/utils/model/providerName';

const model = (currentValue: string): AcpDerivedOption => ({
  id: 'model',
  category: 'model',
  currentValue,
  options: [
    { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { value: 'openai/gpt-5', label: 'GPT-5' },
    { value: 'openai/gpt-4o', label: '' },
  ],
});

const thinking = (currentValue: string, values = ['off', 'low', 'medium', 'high']): AcpDerivedOption => ({
  id: 'thinking',
  category: 'thought_level',
  currentValue,
  options: values.map((value) => ({ value, label: value === 'medium' ? 'Balanced' : value })),
});

/** The session's options as a switch answers them: the model and the level in force after it. */
const answered = (modelValue: string, level: string): AcpConfigOptionDto[] => [
  { id: 'model', category: 'model', option_type: 'select', current_value: modelValue, options: [] },
  {
    id: 'thinking',
    category: 'thought_level',
    option_type: 'select',
    current_value: level,
    options: [{ value: 'off' }, { value: 'low' }, { value: 'high' }],
  },
];

/** The sign-in screens' words, as far as these tests need them. */
const signInWords = (key: string) => (key === 'mu.welcome.login.providers.anthropic.name' ? 'Claude' : key);

describe('modelMenu', () => {
  it('groups the models by provider, each with the levels it takes', () => {
    const groups = modelMenu(model('anthropic/claude-sonnet-4-5'), thinking('medium'), {
      'openai/gpt-5': ['off', 'minimal', 'high'],
      'anthropic/claude-sonnet-4-5': ['off'],
    });
    expect(groups.map((group) => group.title)).toEqual(['anthropic', 'openai']);
    // The model in use: what the session reports now, with the agent's own names; not the older record.
    expect(groups[0].models[0].levels).toEqual([
      { value: 'off', label: 'off' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'Balanced' },
      { value: 'high', label: 'high' },
    ]);
    expect(groups[1].models).toEqual([
      { value: 'openai/gpt-5', label: 'GPT-5', levels: [{ value: 'off' }, { value: 'minimal' }, { value: 'high' }] },
      // Nothing recorded: the row switches the model only. A model with no name goes by its id.
      { value: 'openai/gpt-4o', label: 'openai/gpt-4o', levels: [] },
    ]);
  });

  it('keeps another agent’s own ids in one untitled group', () => {
    const groups = modelMenu(
      { id: 'model', category: 'model', currentValue: 'sonnet', options: [{ value: 'sonnet', label: 'Sonnet' }] },
      null,
      {}
    );
    expect(groups).toEqual([{ key: '', title: '', models: [{ value: 'sonnet', label: 'Sonnet', levels: [] }] }]);
  });

  it('titles a provider by its name, and keeps what the agent says a model is', () => {
    const groups = modelMenu(
      {
        currentValue: null,
        options: [
          { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'Balanced' },
          { value: 'vercel-ai-gateway/zai/glm-5.1', label: 'GLM 5.1' },
          { value: 'relay/large', label: 'Large' },
        ],
      },
      null,
      {},
      (id) => providerDisplayName(signInWords, id)
    );
    // A subscription by its product, a built-in provider by its maker's name, one set up by hand by its id.
    expect(groups.map((group) => group.title)).toEqual(['Claude', 'Vercel AI Gateway', 'relay']);
    expect(groups[0].models[0].description).toBe('Balanced');
    expect(groups[1].models[0]).not.toHaveProperty('description');
  });

  it('titles a provider set up by hand by the name it was given, and drops a description that is only its id', () => {
    const names = new Map([['relay', 'Team relay']]);
    const groups = modelMenu(
      {
        currentValue: null,
        options: [
          // mu describes each model by its provider's id.
          { value: 'relay/large', label: 'Large', description: 'relay' },
          { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'anthropic' },
          { value: 'custom-2/small', label: 'Small', description: 'custom-2' },
        ],
      },
      null,
      {},
      (id) => providerDisplayName(signInWords, id, names)
    );
    expect(groups.map((group) => group.title)).toEqual(['Team relay', 'Claude', 'custom-2']);
    for (const group of groups) expect(group.models[0]).not.toHaveProperty('description');
  });
});

describe('providerDisplayName', () => {
  it('prefers the name a provider was given in the settings, then the product or maker, then the id', () => {
    const names = new Map([
      ['relay', 'Team relay'],
      ['anthropic', 'Anthropic through the proxy'],
    ]);
    expect(providerDisplayName(signInWords, 'relay', names)).toBe('Team relay');
    // A hand-written entry that reroutes a built-in provider goes by the name written for it.
    expect(providerDisplayName(signInWords, 'anthropic', names)).toBe('Anthropic through the proxy');
    expect(providerDisplayName(signInWords, 'anthropic')).toBe('Claude');
    expect(providerDisplayName(signInWords, 'vercel-ai-gateway', names)).toBe('Vercel AI Gateway');
    expect(providerDisplayName(signInWords, 'custom-2', names)).toBe('custom-2');
  });
});

describe('modelDisplayName', () => {
  it('names a model as the picker does: by the name mu reported for it, else by its id without the provider', () => {
    const names = new Map([
      ['openai-codex/gpt-5.6-terra', 'GPT-5.6 Terra'],
      ['openrouter/anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5'],
    ]);
    expect(modelDisplayName('openai-codex/gpt-5.6-terra', names)).toBe('GPT-5.6 Terra');
    expect(modelDisplayName('openrouter/anthropic/claude-sonnet-4.5', names)).toBe('Claude Sonnet 4.5');
    // A model mu did not report: the provider is what the picker groups by, not part of the model's name.
    expect(modelDisplayName('openai-codex/gpt-6-astra', names)).toBe('gpt-6-astra');
    expect(modelDisplayName('openrouter/meta/llama-5')).toBe('meta/llama-5');
    // An id that names no provider stays as it is.
    expect(modelDisplayName('test-model', names)).toBe('test-model');
  });
});

describe('filterModelMenu', () => {
  const groups = modelMenu(model('openai/gpt-5'), null, {});

  it('keeps rows whose name or id holds the query, and drops empty groups', () => {
    expect(filterModelMenu(groups, 'SONNET').map((group) => group.models.map((entry) => entry.value))).toEqual([
      ['anthropic/claude-sonnet-4-5'],
    ]);
    expect(filterModelMenu(groups, 'gpt-4').map((group) => group.models.map((entry) => entry.value))).toEqual([
      ['openai/gpt-4o'],
    ]);
    expect(filterModelMenu(groups, 'nothing like it')).toEqual([]);
  });

  it('keeps everything for a blank query', () => {
    expect(filterModelMenu(groups, '  ')).toBe(groups);
  });
});

describe('applyModelPick', () => {
  it('switches the model first, then the level, reading the level pi chose from the answer', async () => {
    const set = vi.fn(async (optionId: string, value: string) =>
      optionId === 'model' ? answered(value, 'high') : answered('openai/gpt-5', value)
    );
    await applyModelPick(
      set,
      { model: model('anthropic/claude-sonnet-4-5'), thoughtLevel: thinking('low') },
      { model: 'openai/gpt-5', level: 'low' }
    );
    // Before the switch the level was already `low`; after it pi had `high`, so `low` is sent again.
    expect(set.mock.calls).toEqual([
      ['model', 'openai/gpt-5'],
      ['thinking', 'low'],
    ]);
  });

  it('sends no level the switch already left in force', async () => {
    const set = vi.fn(async (_optionId: string, value: string) => answered(value, 'high'));
    await applyModelPick(
      set,
      { model: model('anthropic/claude-sonnet-4-5'), thoughtLevel: thinking('low') },
      { model: 'openai/gpt-5', level: 'high' }
    );
    expect(set.mock.calls).toEqual([['model', 'openai/gpt-5']]);
  });

  it('sends only the level for the model in use, and nothing for what is already so', async () => {
    const set = vi.fn(async () => null);
    const now = { model: model('openai/gpt-5'), thoughtLevel: thinking('medium') };
    await applyModelPick(set, now, { model: 'openai/gpt-5', level: 'high' });
    expect(set.mock.calls).toEqual([['thinking', 'high']]);

    set.mockClear();
    await applyModelPick(set, now, { model: 'openai/gpt-5', level: 'medium' });
    await applyModelPick(set, now, { model: 'openai/gpt-5' });
    expect(set).not.toHaveBeenCalled();
  });

  it('switches only the model when no level was picked', async () => {
    const set = vi.fn(async (_optionId: string, value: string) => answered(value, 'off'));
    await applyModelPick(
      set,
      { model: model('openai/gpt-5'), thoughtLevel: thinking('medium') },
      { model: 'openai/gpt-4o' }
    );
    expect(set.mock.calls).toEqual([['model', 'openai/gpt-4o']]);
  });

  it('stops at a refused model switch', async () => {
    const set = vi.fn(async () => {
      throw new Error('config_update_in_progress');
    });
    await expect(
      applyModelPick(
        set,
        { model: model('openai/gpt-5'), thoughtLevel: thinking('medium') },
        { model: 'openai/gpt-4o', level: 'off' }
      )
    ).rejects.toThrow('config_update_in_progress');
    expect(set).toHaveBeenCalledTimes(1);
  });
});

describe('configErrorMessageKey', () => {
  it('names why a switch was not taken', () => {
    expect(configErrorMessageKey(new Error('config_update_in_progress'))).toBe('agent.config.busy');
    expect(configErrorMessageKey(new Error('command_ack'))).toBe('agent.config.commandAck');
    expect(configErrorMessageKey(new Error('Wait for the current turn before changing configuration'))).toBe(
      'agent.config.failed'
    );
  });
});
