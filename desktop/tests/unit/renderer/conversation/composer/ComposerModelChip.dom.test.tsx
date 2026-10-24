import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { AcpConfigOptionDto, SetConfigOptionResponse } from '@/common/types/platform/acpTypes';
import ComposerModelChip from '@/renderer/pages/conversation/platforms/acp/Composer/ComposerModelChip';
import { resetEnsureConversationRuntimeStateForTests } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

const {
  ensureRuntimeInvokeMock,
  setConfigOptionInvokeMock,
  modelLevelsInvokeMock,
  settingsInvokeMock,
  streamHandlers,
  messageErrorMock,
} = vi.hoisted(() => ({
  ensureRuntimeInvokeMock: vi.fn(),
  setConfigOptionInvokeMock: vi.fn(),
  modelLevelsInvokeMock: vi.fn(),
  settingsInvokeMock: vi.fn(),
  streamHandlers: [] as Array<(message: IResponseMessage) => void>,
  messageErrorMock: vi.fn(),
}));

// The bridge the chip reads and writes through: the session's config options, and mu's record of the levels each
// model takes.
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: { ensureRuntime: { invoke: ensureRuntimeInvokeMock } },
    acpConversation: {
      setConfigOption: { invoke: setConfigOptionInvokeMock },
      responseStream: {
        on: (handler: (message: IResponseMessage) => void) => {
          streamHandlers.push(handler);
          return () => {
            const index = streamHandlers.indexOf(handler);
            if (index >= 0) streamHandlers.splice(index, 1);
          };
        },
      },
    },
  },
}));

vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { modelLevels: { invoke: modelLevelsInvokeMock }, settings: { invoke: settingsInvokeMock } },
  unwrap: <T,>(result: { ok: true; data: T }) => result.data,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { model?: string; level?: string }) => {
      const level = /^mu\.levels\.(\w+)$/.exec(key)?.[1];
      if (level) return level.charAt(0).toUpperCase() + level.slice(1);
      if (key === 'agent.model.withThoughtLevel') return `${options?.model} · ${options?.level}`;
      return key;
    },
  }),
}));

// The real label measures itself for a marquee, which prints the text more than once.
vi.mock('@/renderer/components/agent/MarqueePillLabel', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@icon-park/react', () => ({
  Brain: () => <span aria-hidden='true' />,
  Down: () => <span aria-hidden='true' />,
  Search: () => <span aria-hidden='true' />,
}));

/** Only the data attributes of what a component was handed, as the real Arco puts them on its element. */
const dataOf = (props: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(props).filter(([name]) => name.startsWith('data-')));

vi.mock('@arco-design/web-react', () => {
  const Menu = Object.assign(({ children }: { children?: React.ReactNode }) => <div role='menu'>{children}</div>, {
    Item: ({
      children,
      onClick,
      className: _className,
      ...rest
    }: {
      children?: React.ReactNode;
      onClick?: () => void;
      className?: string;
      [key: string]: unknown;
    }) => (
      <div role='menuitem' onClick={onClick} {...dataOf(rest)}>
        {children}
      </div>
    ),
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) => (
      <div role='group' aria-label={String(title)}>
        {children}
      </div>
    ),
  });
  // A radio group as the menu's levels use it: each radio says whether it is the group's value, a click picks it.
  const RadioGroupContext = React.createContext<{ value?: string; onChange?: (value: string) => void }>({});
  const Radio = Object.assign(
    ({ children, value, ...rest }: { children?: React.ReactNode; value: string; [key: string]: unknown }) => {
      const group = React.useContext(RadioGroupContext);
      return (
        <label
          role='radio'
          aria-checked={group.value === value}
          onClick={() => group.onChange?.(value)}
          {...dataOf(rest)}
        >
          {children}
        </label>
      );
    },
    {
      Group: ({
        children,
        value,
        onChange,
      }: {
        children?: React.ReactNode;
        value?: string;
        onChange?: (value: string) => void;
      }) => (
        <RadioGroupContext.Provider value={{ value, onChange }}>
          <div role='radiogroup'>{children}</div>
        </RadioGroupContext.Provider>
      ),
    }
  );
  return {
    Button: ({
      children,
      disabled,
      onClick,
      ...rest
    }: {
      children?: React.ReactNode;
      disabled?: boolean;
      onClick?: () => void;
      [key: string]: unknown;
    }) => (
      <button type='button' disabled={disabled} onClick={onClick} {...dataOf(rest)}>
        {children}
      </button>
    ),
    Dropdown: ({ children, droplist }: { children?: React.ReactNode; droplist?: React.ReactNode }) => (
      <div>
        {children}
        {droplist}
      </div>
    ),
    Menu,
    Message: { error: messageErrorMock },
    Radio,
    Tooltip: ({ children, content }: { children?: React.ReactNode; content?: React.ReactNode }) => (
      <span data-tooltip={typeof content === 'string' ? content : undefined}>{children}</span>
    ),
  };
});

const MODELS = [
  { value: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { value: 'openai/gpt-5', name: 'GPT-5' },
  { value: 'openai/gpt-4o', name: 'GPT-4o' },
];

/** The session's options as mu reports them through the app's backend: a model, and the levels it takes now. */
const optionsFor = (model: string, level: string, levels = ['off', 'low', 'medium', 'high']): AcpConfigOptionDto[] => [
  { id: 'model', category: 'model', option_type: 'select', current_value: model, options: MODELS },
  {
    id: 'thinking',
    category: 'thought_level',
    option_type: 'select',
    current_value: level,
    options: levels.map((value) => ({ value, name: value })),
  },
];

/** What the session holds now: what a fresh read returns, and what a switch moves. */
let server: AcpConfigOptionDto[] = [];

/** The session takes a switch and answers with its options after it, as the app's backend relays them. */
const answer = (model: string, level: string, levels?: string[]): SetConfigOptionResponse => {
  server = optionsFor(model, level, levels);
  return { confirmation: 'observed', config_options: server };
};

const RECORDED = {
  'anthropic/claude-sonnet-4-5': ['off', 'low', 'medium', 'high'],
  'openai/gpt-5': ['off', 'minimal', 'low', 'medium', 'high'],
  'openai/gpt-4o': ['off'],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A conversation of its own for each test: a switch's progress is kept per conversation, across renders. */
let conversationId = '';
let conversations = 0;

const renderChip = (props: { busy?: boolean } = {}) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, revalidateOnFocus: false }}>
      <ComposerModelChip conversation_id={conversationId} busy={props.busy ?? false} />
    </SWRConfig>
  );

const chipLabel = () => screen.getByTestId('composer-model-pill').textContent;
const modelRow = (value: string) =>
  screen.getAllByTestId('composer-model-option').find((row) => row.getAttribute('data-value') === value)!;
/** A level under the list: the levels of the model in use. */
const levelOption = (level: string) =>
  screen.getAllByTestId('composer-level-option').find((option) => option.getAttribute('data-value') === level)!;
const levelValues = () =>
  screen.queryAllByTestId('composer-level-option').map((option) => option.getAttribute('data-value'));

describe('ComposerModelChip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamHandlers.length = 0;
    resetEnsureConversationRuntimeStateForTests();
    conversations += 1;
    conversationId = `conv-${conversations}`;
    server = optionsFor('anthropic/claude-sonnet-4-5', 'medium');
    ensureRuntimeInvokeMock.mockImplementation(async () => ({
      recovered: true,
      config_options: server,
      runtime: null,
    }));
    modelLevelsInvokeMock.mockResolvedValue({ ok: true, data: RECORDED });
    settingsInvokeMock.mockResolvedValue({ ok: true, data: { models: { providers: [], foreign: [] } } });
  });

  it('reads the model and its thinking level from the session', async () => {
    renderChip();
    await waitFor(() => expect(chipLabel()).toBe('Claude Sonnet 4.5 · Medium'));
    expect(screen.getByTestId('composer-model-chip').getAttribute('data-model')).toBe('anthropic/claude-sonnet-4-5');
    expect(modelLevelsInvokeMock).toHaveBeenCalledWith({ conversationId });
  });

  // mu without a model reports none; conversations from before that report pi's placeholder.
  it.each(['', 'unknown/unknown'])(
    'asks to choose a model, with no thinking level, when mu runs on "%s"',
    async (value) => {
      server = optionsFor(value, 'off');
      renderChip();
      await waitFor(() => expect(chipLabel()).toBe('mu.noModel.chip'));
      expect(screen.getByTestId('composer-model-chip').getAttribute('data-model')).toBe('');
      // Every model is still there to pick.
      expect(screen.getAllByTestId('composer-model-option')).toHaveLength(3);
    }
  );

  it('is not there when the session offers no model', async () => {
    server = [];
    renderChip();
    await waitFor(() => expect(ensureRuntimeInvokeMock).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('composer-model-chip')).toBeNull();
    expect(modelLevelsInvokeMock).not.toHaveBeenCalled();
  });

  it('lists every model, and the levels of the model in use under them', async () => {
    renderChip();
    await waitFor(() => expect(screen.getAllByTestId('composer-model-option')).toHaveLength(3));
    await waitFor(() => expect(levelValues()).toEqual(['off', 'low', 'medium', 'high']));

    // The model in use takes the levels the session reports now, by the app's names, the one in force checked.
    expect(screen.getAllByTestId('composer-level-option').map((option) => option.textContent)).toEqual([
      'Off',
      'Low',
      'Medium',
      'High',
    ]);
    expect(levelOption('medium').getAttribute('aria-checked')).toBe('true');
    // The rows switch the model only: no row holds levels of its own.
    expect(within(modelRow('openai/gpt-5')).queryAllByTestId('composer-level-option')).toHaveLength(0);
    // The cache note is on the levels' title, on hover.
    expect(screen.getByTestId('composer-thinking-note').closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'conversation.composer.thinkingNote'
    );
    // Grouped by provider.
    // A provider goes by its name, not its id.
    expect(screen.getByRole('group', { name: 'OpenAI' })).toBeTruthy();
  });

  it('switches the model through the session, and shows only what the session answered', async () => {
    const modelSwitch = deferred();
    // pi puts the new model at a level of its own choosing.
    setConfigOptionInvokeMock.mockImplementationOnce(async () => {
      await modelSwitch.promise;
      return answer('openai/gpt-5', 'high', RECORDED['openai/gpt-5']);
    });
    renderChip();
    await waitFor(() => expect(screen.getAllByTestId('composer-model-option')).toHaveLength(3));

    fireEvent.click(modelRow('openai/gpt-5'));
    await waitFor(() =>
      expect(setConfigOptionInvokeMock).toHaveBeenCalledWith({
        conversation_id: conversationId,
        option_id: 'model',
        value: 'openai/gpt-5',
      })
    );
    // Not an optimistic copy: until the session answers, the chip says what is in force.
    expect(chipLabel()).toBe('Claude Sonnet 4.5 · Medium');

    await act(async () => {
      modelSwitch.resolve();
    });
    await waitFor(() => expect(chipLabel()).toBe('GPT-5 · High'));
    expect(setConfigOptionInvokeMock.mock.calls.map(([input]) => input)).toEqual([
      { conversation_id: conversationId, option_id: 'model', value: 'openai/gpt-5' },
    ]);
    // The levels under the list are the new model's.
    await waitFor(() => expect(levelValues()).toEqual(['off', 'minimal', 'low', 'medium', 'high']));
    expect(levelOption('high').getAttribute('aria-checked')).toBe('true');
  });

  it('offers no levels while the model in use takes only one', async () => {
    server = optionsFor('openai/gpt-4o', 'off', ['off']);
    renderChip();
    await waitFor(() => expect(chipLabel()).toBe('GPT-4o · Off'));
    expect(screen.getAllByTestId('composer-model-option')).toHaveLength(3);
    expect(screen.queryByTestId('composer-thinking')).toBeNull();
  });

  it('changes only the level when the pick is the model in use', async () => {
    setConfigOptionInvokeMock.mockImplementationOnce(async () => answer('anthropic/claude-sonnet-4-5', 'high'));
    renderChip();
    await waitFor(() => expect(chipLabel()).toBe('Claude Sonnet 4.5 · Medium'));

    fireEvent.click(levelOption('high'));
    await waitFor(() => expect(chipLabel()).toBe('Claude Sonnet 4.5 · High'));
    expect(setConfigOptionInvokeMock.mock.calls.map(([input]) => input)).toEqual([
      { conversation_id: conversationId, option_id: 'thinking', value: 'high' },
    ]);
  });

  it('follows a change the session pushes on its own', async () => {
    renderChip();
    await waitFor(() => expect(chipLabel()).toBe('Claude Sonnet 4.5 · Medium'));

    server = optionsFor('openai/gpt-4o', 'off', ['off']);
    act(() => {
      for (const handler of streamHandlers)
        handler({
          type: 'acp_config_option',
          conversation_id: conversationId,
          msg_id: 'm',
          data: { config_options: server },
        });
    });
    await waitFor(() => expect(chipLabel()).toBe('GPT-4o · Off'));
  });

  it('says why it waits while a turn runs, and takes no pick', async () => {
    renderChip({ busy: true });
    await waitFor(() => expect(chipLabel()).toBe('Claude Sonnet 4.5 · Medium'));
    expect((screen.getByTestId('composer-model-pill') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('composer-model-chip').closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'conversation.composer.modelBusy'
    );
    expect(screen.queryAllByTestId('composer-model-option')).toHaveLength(0);
  });

  it('titles a provider set up by hand by the name it was given in the settings', async () => {
    server = [
      {
        ...optionsFor('anthropic/claude-sonnet-4-5', 'medium')[0],
        // mu describes each model by its provider's id.
        options: [...MODELS, { value: 'relay/large', name: 'Large', description: 'relay' }],
      },
      optionsFor('anthropic/claude-sonnet-4-5', 'medium')[1],
    ];
    settingsInvokeMock.mockResolvedValue({
      ok: true,
      data: { models: { providers: [{ id: 'relay', name: 'Team relay' }], foreign: [] } },
    });
    renderChip();
    await waitFor(() => expect(screen.getByRole('group', { name: 'Team relay' })).toBeTruthy());
    expect(screen.queryByRole('group', { name: 'relay' })).toBeNull();
    // The provider's id is not repeated as the row's hint.
    expect(modelRow('relay/large').querySelector('[data-tooltip]')).toBeNull();
  });

  it('tells the person when the session refuses the switch', async () => {
    setConfigOptionInvokeMock.mockRejectedValueOnce(
      new Error('Wait for the current turn before changing configuration')
    );
    renderChip();
    await waitFor(() => expect(screen.getAllByTestId('composer-model-option')).toHaveLength(3));

    fireEvent.click(modelRow('openai/gpt-4o'));
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalledWith('agent.config.failed'));
    expect(chipLabel()).toBe('Claude Sonnet 4.5 · Medium');
  });
});
