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

// The model · thinking menu with the real Arco Dropdown. Arco styles a popup as a dropdown menu, with pop-out
// submenus, only when it is handed a Menu element directly: wrapped in a component of its own, the menu opened as a
// bare inline list with no edge on the home page.

vi.mock('@icon-park/react', () => ({
  Check: () => <span aria-hidden='true' />,
  Search: () => <span aria-hidden='true' />,
}));

const t = ((key: string) => key) as unknown as TFunction;

afterEach(cleanup);

describe('modelLevelMenu', () => {
  it('opens as a dropdown menu, the model in use with its levels a pop-out submenu', async () => {
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
          onPick: vi.fn(),
        })}
      >
        <button type='button'>chip</button>
      </Dropdown>
    );

    await screen.findByText('GPT-5 mini');
    const menu = document.querySelector('.arco-dropdown-menu');
    expect(menu).not.toBeNull();
    expect(menu?.classList.contains('arco-menu-inline')).toBe(false);
    expect(document.querySelector('.arco-dropdown-menu-pop-header')).not.toBeNull();
    expect(screen.getByText('GPT-5 mini')).toBeInTheDocument();
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
