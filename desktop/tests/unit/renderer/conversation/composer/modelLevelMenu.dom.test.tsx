/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Dropdown } from '@arco-design/web-react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelLevelMenu } from '@/renderer/pages/conversation/platforms/acp/Composer/ModelLevelMenu';

// The model · thinking menu with the real Arco Dropdown. Arco styles a popup as a dropdown menu only when it is handed a
// Menu element directly: wrapped in a component of its own, the menu opened as a bare inline list with no edge on the
// home page. The thinking levels of the model in use sit under the list, outside the part that scrolls, so a long list
// never pushes them out of view.

vi.mock('@icon-park/react', () => ({
  Check: () => <span aria-hidden='true' />,
  Search: () => <span aria-hidden='true' />,
}));

const t = ((key: string) => key) as unknown as TFunction;

afterEach(cleanup);

describe('modelLevelMenu', () => {
  it('opens as a dropdown menu, the levels of the model in use under the list, outside its scroll', async () => {
    const onPick = vi.fn();
    render(
      <Dropdown
        popupVisible
        droplist={modelLevelMenu(t, {
          groups: [
            {
              key: 'openai',
              title: 'OpenAI',
              models: [
                { value: 'openai/gpt-5', label: 'GPT-5', levels: [{ value: 'low' }, { value: 'high' }] },
                { value: 'openai/gpt-5-mini', label: 'GPT-5 mini', levels: [] },
              ],
            },
          ],
          total: 2,
          query: '',
          onQuery: vi.fn(),
          current: 'openai/gpt-5',
          level: 'high',
          levels: [{ value: 'low' }, { value: 'high' }],
          onPick,
        })}
      >
        <button type='button'>chip</button>
      </Dropdown>
    );

    await screen.findByText('GPT-5 mini');
    const menu = document.querySelector('.arco-dropdown-menu');
    expect(menu).not.toBeNull();
    expect(menu?.classList.contains('arco-menu-inline')).toBe(false);
    // No row opens a flyout any more: every model is a plain row.
    expect(document.querySelector('.arco-dropdown-menu-pop-header')).toBeNull();
    const footer = screen.getByTestId('composer-thinking');
    expect(footer.closest('.dropdown-search-scroll')).toBeNull();
    expect(screen.getByTestId('composer-thinking-note').textContent).toBe('agent.thoughtLevel.label');
    const levels = screen.getAllByTestId('composer-level-option');
    expect(levels.map((level) => level.getAttribute('data-value'))).toEqual(['low', 'high']);
    expect(levels[1].classList.contains('arco-radio-checked')).toBe(true);

    fireEvent.click(levels[0]);
    expect(onPick).toHaveBeenLastCalledWith('openai/gpt-5', 'low');
    fireEvent.click(screen.getByText('GPT-5 mini'));
    expect(onPick).toHaveBeenLastCalledWith('openai/gpt-5-mini');
  });

  it('offers no levels for a model in use that takes one or none', async () => {
    render(
      <Dropdown
        popupVisible
        droplist={modelLevelMenu(t, {
          groups: [
            { key: 'openai', title: 'OpenAI', models: [{ value: 'openai/gpt-4o', label: 'GPT-4o', levels: [] }] },
          ],
          total: 1,
          query: '',
          onQuery: vi.fn(),
          current: 'openai/gpt-4o',
          levels: [{ value: 'off' }],
          onPick: vi.fn(),
        })}
      >
        <button type='button'>chip</button>
      </Dropdown>
    );
    await screen.findByText('GPT-4o');
    expect(screen.queryByTestId('composer-thinking')).toBeNull();
  });

  it('toggles the short list from a row under it, and stays open', async () => {
    const onShowAll = vi.fn();
    const onVisibleChange = vi.fn();
    const view = (showAll: boolean) => (
      <Dropdown
        popupVisible
        onVisibleChange={onVisibleChange}
        droplist={modelLevelMenu(t, {
          groups: [{ key: 'openai', title: 'OpenAI', models: [{ value: 'openai/gpt-6', label: 'GPT-6', levels: [] }] }],
          total: 9,
          query: '',
          onQuery: vi.fn(),
          current: 'openai/gpt-6',
          levels: [],
          onPick: vi.fn(),
          hidden: 8,
          showAll,
          onShowAll,
        })}
      >
        <button type='button'>chip</button>
      </Dropdown>
    );
    const { rerender } = render(view(false));
    const toggle = await screen.findByTestId('composer-model-show-all');
    expect(toggle.textContent).toBe('conversation.composer.showAllModels');
    expect(toggle.closest('.dropdown-search-scroll')).not.toBeNull();
    fireEvent.click(toggle);
    expect(onShowAll).toHaveBeenLastCalledWith(true);
    expect(onVisibleChange).not.toHaveBeenCalledWith(false);

    rerender(view(true));
    fireEvent.click(screen.getByTestId('composer-model-show-all'));
    expect(screen.getByTestId('composer-model-show-all').textContent).toBe('conversation.composer.showFewerModels');
    expect(onShowAll).toHaveBeenLastCalledWith(false);
  });

  it('offers no toggle when the short list leaves nothing out', async () => {
    render(
      <Dropdown
        popupVisible
        droplist={modelLevelMenu(t, {
          groups: [{ key: 'openai', title: 'OpenAI', models: [{ value: 'openai/gpt-6', label: 'GPT-6', levels: [] }] }],
          total: 1,
          query: '',
          onQuery: vi.fn(),
          levels: [],
          onPick: vi.fn(),
          hidden: 0,
          onShowAll: vi.fn(),
        })}
      >
        <button type='button'>chip</button>
      </Dropdown>
    );
    await screen.findByText('GPT-6');
    expect(screen.queryByTestId('composer-model-show-all')).toBeNull();
  });

  const menu = (current: string, onMakeDefault = vi.fn()) =>
    render(
      <Dropdown
        popupVisible
        droplist={modelLevelMenu(t, {
          groups: [
            {
              key: 'openai',
              title: 'OpenAI',
              models: [
                { value: 'openai/gpt-5', label: 'GPT-5', levels: [] },
                { value: 'openai/gpt-5-mini', label: 'GPT-5 mini', levels: [] },
              ],
            },
          ],
          total: 2,
          query: '',
          onQuery: vi.fn(),
          current,
          levels: [],
          onPick: vi.fn(),
          defaultModel: 'openai/gpt-5',
          onMakeDefault,
        })}
      >
        <button type='button'>chip</button>
      </Dropdown>
    );

  it('marks the default model, and offers to make the model in use the default when it is another one', async () => {
    const onMakeDefault = vi.fn();
    menu('openai/gpt-5-mini', onMakeDefault);
    await screen.findByText('GPT-5 mini');
    const tag = screen.getByTestId('composer-model-default');
    expect(tag.closest('[data-value]')?.getAttribute('data-value')).toBe('openai/gpt-5');
    fireEvent.click(screen.getByText('conversation.composer.makeDefault'));
    expect(onMakeDefault).toHaveBeenCalledTimes(1);
  });

  it('offers nothing to make default while the default model is in use', async () => {
    menu('openai/gpt-5');
    await screen.findByText('GPT-5 mini');
    expect(screen.queryByTestId('composer-make-default')).toBeNull();
  });
});
