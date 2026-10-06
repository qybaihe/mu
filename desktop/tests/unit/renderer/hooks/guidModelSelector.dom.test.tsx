/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import GuidModelSelector from '@/renderer/pages/guid/components/GuidModelSelector';

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useProvidersQuery: () => ({ data: [] }),
}));

vi.mock('@/renderer/utils/model/agentLogo', () => ({
  getModelDisplayLabel: ({
    selectedLabel,
    selected_value,
    fallbackLabel,
  }: {
    selectedLabel?: string;
    selected_value?: string | null;
    fallbackLabel: string;
  }) => selectedLabel || selected_value || fallbackLabel,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { model?: string; level?: string }) => {
      const level = /^mu\.levels\.(\w+)$/.exec(key)?.[1];
      if (level) {
        const names: Record<string, string> = {
          off: 'Off',
          minimal: 'Minimal',
          low: 'Low',
          medium: 'Medium',
          high: 'High',
          xhigh: 'Very high',
          max: 'Max',
        };
        return names[level] ?? key;
      }
      if (key === 'agent.model.withThoughtLevel') return `${options?.model} · ${options?.level}`;
      if (key === 'common.defaultModel') return 'Default';
      if (key === 'common.model') return 'Model';
      if (key === 'conversation.welcome.modelSwitchNotSupported') return 'Model switch is not supported';
      if (key === 'agent.thoughtLevel.label') return 'Thinking Level';
      return key;
    },
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

// The real label measures itself for a marquee, which prints the text more than once.
vi.mock('@/renderer/components/agent/MarqueePillLabel', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@icon-park/react', () => ({
  Brain: () => <span aria-hidden='true'>brain</span>,
  Down: () => <span aria-hidden='true'>v</span>,
  Plus: () => <span aria-hidden='true'>+</span>,
  Search: () => <span aria-hidden='true'>search</span>,
}));

vi.mock('@arco-design/web-react', () => {
  const Menu = Object.assign(
    ({ children, className }: { children?: React.ReactNode; className?: string }) => (
      <div data-testid='guid-model-menu' className={className}>
        {children}
      </div>
    ),
    {
      Item: ({
        children,
        className,
        onClick,
      }: {
        children?: React.ReactNode;
        className?: string;
        onClick?: () => void;
      }) => (
        <div role='menuitem' className={className} onClick={onClick}>
          {children}
        </div>
      ),
      ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) => (
        <div role='group' aria-label={String(title)}>
          <div>{title}</div>
          {children}
        </div>
      ),
      // SubMenu renders both its title row and its children so tests can inspect both levels.
      SubMenu: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) => (
        <div role='group'>
          <div data-testid='submenu-title'>{title}</div>
          <div data-testid='submenu-body'>{children}</div>
        </div>
      ),
    }
  );

  return {
    Button: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <button type='button' {...props}>
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
    Tooltip: ({ children, content }: { children?: React.ReactNode; content?: React.ReactNode }) => (
      <span data-tooltip-content={typeof content === 'string' ? content : undefined}>{children}</span>
    ),
  };
});

describe('GuidModelSelector', () => {
  const thoughtLevelOption = {
    id: 'reasoning_effort',
    category: 'thought_level',
    currentValue: 'medium',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  };

  it('shows ACP model descriptions in option tooltips', () => {
    render(
      <GuidModelSelector
        isGeminiMode={false}
        modelList={[]}
        current_model={undefined}
        setCurrentModel={vi.fn()}
        currentAcpCachedModelInfo={{
          current_model_id: 'default',
          current_model_label: 'Default',
          available_models: [
            {
              id: 'default',
              label: 'Default',
              description: 'Use the default model currently configured by the CLI',
            },
          ],
        }}
        selectedAcpModel='default'
        setSelectedAcpModel={vi.fn()}
      />
    );

    expect(screen.queryByText('Use the default model currently configured by the CLI')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('guid-model-menu')).getByText('Default').closest('[data-tooltip-content]')
    ).toHaveAttribute('data-tooltip-content', 'Use the default model currently configured by the CLI');
  });

  it('offers the conversation’s model · thinking menu: models by provider, the one in use opening to its levels', () => {
    const setSelectedAcpModel = vi.fn();
    const onThoughtLevelSelect = vi.fn();

    render(
      <GuidModelSelector
        isGeminiMode={false}
        modelList={[]}
        current_model={undefined}
        setCurrentModel={vi.fn()}
        currentAcpCachedModelInfo={{
          current_model_id: 'vercel-ai-gateway/zai/glm-5.1',
          current_model_label: 'GLM 5.1',
          available_models: [
            { id: 'vercel-ai-gateway/zai/glm-5.1', label: 'GLM 5.1' },
            { id: 'openai/gpt-5', label: 'GPT-5' },
          ],
        }}
        selectedAcpModel='vercel-ai-gateway/zai/glm-5.1'
        setSelectedAcpModel={setSelectedAcpModel}
        thoughtLevelOption={thoughtLevelOption}
        onThoughtLevelSelect={onThoughtLevelSelect}
      />
    );

    expect(screen.getByText('GLM 5.1 · Medium')).toBeInTheDocument();
    // By provider, each by its name rather than its id; no separate "Model" and "Thinking level" rows.
    expect(screen.getByRole('group', { name: 'Vercel AI Gateway' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'OpenAI' })).toBeInTheDocument();
    expect(screen.queryByText('Thinking Level')).not.toBeInTheDocument();

    // The model in use opens to its levels: one pick sets the level.
    const [inUse] = screen.getAllByTestId('submenu-body');
    fireEvent.click(within(inUse).getByText('High'));
    expect(onThoughtLevelSelect).toHaveBeenCalledWith('high');
    expect(setSelectedAcpModel).not.toHaveBeenCalled();

    // Another model is picked as it is.
    fireEvent.click(screen.getByText('GPT-5'));
    expect(setSelectedAcpModel).toHaveBeenCalledWith('openai/gpt-5');
  });

  it('names the default model while nothing is picked, not the one the agent reported last', () => {
    const onMakeDefault = vi.fn();
    const info = {
      current_model_id: 'google-antigravity/gemini-3.8-flash',
      current_model_label: 'Gemini 3.8 Flash',
      available_models: [
        { id: 'google-antigravity/gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
        { id: 'openai-codex/gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      ],
    };
    const chip = (selected: string | null) => (
      <GuidModelSelector
        isGeminiMode={false}
        modelList={[]}
        current_model={undefined}
        setCurrentModel={vi.fn()}
        currentAcpCachedModelInfo={info}
        selectedAcpModel={selected}
        setSelectedAcpModel={vi.fn()}
        defaultModel='openai-codex/gpt-5.6-luna'
        onMakeDefault={onMakeDefault}
      />
    );
    const { rerender } = render(chip(null));
    expect(screen.getByTestId('guid-model-selector')).toHaveTextContent('GPT-5.6 Luna');
    // The default is in use: nothing to make default.
    expect(screen.queryByText('conversation.composer.makeDefault')).not.toBeInTheDocument();

    rerender(chip('google-antigravity/gemini-3.8-flash'));
    expect(screen.getByTestId('guid-model-selector')).toHaveTextContent('Gemini 3.8 Flash');
    fireEvent.click(screen.getByText('conversation.composer.makeDefault'));
    expect(onMakeDefault).toHaveBeenCalledWith('google-antigravity/gemini-3.8-flash');
  });

  it('does not add thought level options to the Aion CLI provider model menu', () => {
    render(
      <GuidModelSelector
        isGeminiMode
        modelList={[{ id: 'openai', name: 'OpenAI', enabled: true, models: ['gpt-5.3-codex'] } as any]}
        current_model={{ id: 'openai', name: 'OpenAI', models: ['gpt-5.3-codex'], use_model: 'gpt-5.3-codex' } as any}
        setCurrentModel={vi.fn()}
        currentAcpCachedModelInfo={null}
        selectedAcpModel={null}
        setSelectedAcpModel={vi.fn()}
        thoughtLevelOption={thoughtLevelOption}
        onThoughtLevelSelect={vi.fn()}
      />
    );

    expect(screen.getAllByText('gpt-5.3-codex').length).toBeGreaterThan(0);
    expect(screen.queryByText('Thinking Level')).not.toBeInTheDocument();
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();
  });

  it('sends "add a model" to the providers page, not the retired model page', () => {
    navigateMock.mockClear();
    render(
      <GuidModelSelector
        isGeminiMode
        modelList={[]}
        current_model={undefined}
        setCurrentModel={vi.fn()}
        currentAcpCachedModelInfo={null}
        selectedAcpModel={null}
        setSelectedAcpModel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('settings.addModel'));
    expect(navigateMock).toHaveBeenCalledWith('/settings/providers');
  });
});
