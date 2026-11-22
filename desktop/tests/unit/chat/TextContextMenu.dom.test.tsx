/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Electron's renderer shows no native context menu, so the text menus wrapped around the send box and the message
 * list are the only copy/cut/paste affordance a right-click has. These cover the two variants of that wrapper:
 * which entries each offers, the disabled states when nothing is selected, and the selection capture/restore that
 * keeps `document.execCommand` from acting on the selection the menu click itself cleared.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { copyTextMock } = vi.hoisted(() => ({ copyTextMock: vi.fn(() => Promise.resolve()) }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: copyTextMock }));

vi.mock('@/renderer/utils/platform', () => ({ isMacOS: () => false }));

// Dropdown and Menu stay real — they are what is under test — but Arco's imperative toasts go through
// ReactDOM.render, which React 18 removed and jsdom turns into an unhandled rejection.
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, success: vi.fn(), error: vi.fn() } };
});

import TextContextMenu from '@renderer/components/chat/TextContextMenu';

// jsdom does not implement document.execCommand; the component routes copy/cut/paste through it.
let execCommandMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  execCommandMock = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { value: execCommandMock, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** Opens the menu over a wrapped element and returns the entry carrying the given label. */
const openMenuAndFindItem = async (label: string): Promise<HTMLElement> => {
  const item = await screen.findByText(label);
  const entry = item.closest('[role="menuitem"]');
  if (!(entry instanceof HTMLElement)) throw new Error(`menu item not found for ${label}`);
  return entry;
};

describe('TextContextMenu — editable variant (send box)', () => {
  const renderEditable = () => {
    const textareaRef: { current: HTMLTextAreaElement | null } = { current: null };
    render(
      <TextContextMenu variant='editable' getTextarea={() => textareaRef.current}>
        <div data-testid='wrap'>
          <textarea ref={textareaRef} defaultValue='hello world' />
        </div>
      </TextContextMenu>
    );
    if (!(textareaRef.current instanceof HTMLTextAreaElement)) throw new Error('textarea not mounted');
    return { textarea: textareaRef.current, wrap: screen.getByTestId('wrap') };
  };

  it('offers copy, cut, paste and select all when text is selected', async () => {
    const { textarea, wrap } = renderEditable();
    textarea.setSelectionRange(0, 5);

    fireEvent.contextMenu(wrap);

    expect(await openMenuAndFindItem('common.menu.copy')).toBeTruthy();
    expect(await openMenuAndFindItem('common.menu.cut')).toBeTruthy();
    expect(await openMenuAndFindItem('common.menu.paste')).toBeTruthy();
    expect(await openMenuAndFindItem('common.menu.selectAll')).toBeTruthy();
  });

  it('disables copy and cut when nothing is selected, keeps paste and select all', async () => {
    const { textarea, wrap } = renderEditable();
    textarea.setSelectionRange(3, 3);

    fireEvent.contextMenu(wrap);

    expect((await openMenuAndFindItem('common.menu.copy')).className).toContain('disabled');
    expect((await openMenuAndFindItem('common.menu.cut')).className).toContain('disabled');

    fireEvent.click(screen.getByText('common.menu.copy'));
    fireEvent.click(screen.getByText('common.menu.cut'));
    expect(execCommandMock).not.toHaveBeenCalled();
  });

  it('restores the selection and runs copy through execCommand on the focused textarea', async () => {
    const { textarea, wrap } = renderEditable();
    textarea.setSelectionRange(0, 5);
    fireEvent.contextMenu(wrap);

    // Simulate the menu click having cleared the selection before the item ran.
    textarea.setSelectionRange(3, 3);
    execCommandMock.mockImplementation(() => {
      expect(document.activeElement).toBe(textarea);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 5]);
      return true;
    });

    fireEvent.click(await openMenuAndFindItem('common.menu.copy'));

    await waitFor(() => expect(execCommandMock).toHaveBeenCalledWith('copy'));
  });

  it('runs paste and cut through execCommand as well', async () => {
    const { textarea, wrap } = renderEditable();
    textarea.setSelectionRange(0, 5);
    fireEvent.contextMenu(wrap);

    fireEvent.click(await openMenuAndFindItem('common.menu.paste'));
    await waitFor(() => expect(execCommandMock).toHaveBeenCalledWith('paste'));

    fireEvent.contextMenu(wrap);
    fireEvent.click(await openMenuAndFindItem('common.menu.cut'));
    await waitFor(() => expect(execCommandMock).toHaveBeenCalledWith('cut'));
  });

  it('falls back to clipboard read + insertText when execCommand(paste) is refused', async () => {
    const { textarea, wrap } = renderEditable();
    textarea.setSelectionRange(0, 5);
    fireEvent.contextMenu(wrap);

    execCommandMock.mockImplementation((command: string) => (command === 'paste' ? false : true));
    const readText = vi.fn().mockResolvedValue('from clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });

    fireEvent.click(await openMenuAndFindItem('common.menu.paste'));

    await waitFor(() => expect(execCommandMock).toHaveBeenCalledWith('insertText', false, 'from clipboard'));
    expect(readText).toHaveBeenCalled();
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(5);
  });

  it('select all focuses the textarea and selects everything', async () => {
    const { textarea, wrap } = renderEditable();
    textarea.setSelectionRange(0, 0);
    fireEvent.contextMenu(wrap);

    fireEvent.click(await openMenuAndFindItem('common.menu.selectAll'));

    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 'hello world'.length]);
    });
    expect(execCommandMock).not.toHaveBeenCalledWith('selectAll');
  });

  it('clears the whole input through select + execCommand(delete)', async () => {
    const { textarea, wrap } = renderEditable();
    textarea.setSelectionRange(0, 0);
    fireEvent.contextMenu(wrap);

    fireEvent.click(await openMenuAndFindItem('common.menu.clearInput'));

    await waitFor(() => expect(execCommandMock).toHaveBeenCalledWith('delete'));
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 'hello world'.length]);
  });

  it('disables clear when the input is empty', async () => {
    const { textarea, wrap } = renderEditable();
    // Empty the controlled textarea before the menu opens.
    fireEvent.change(textarea, { target: { value: '' } });
    fireEvent.contextMenu(wrap);

    const entry = await openMenuAndFindItem('common.menu.clearInput');
    expect(entry.className).toContain('disabled');
  });
});

describe('TextContextMenu — readonly variant (message list)', () => {
  const stubSelection = (text: string) => {
    const stub = {
      toString: () => text,
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(stub as unknown as Selection);
    return stub;
  };

  const renderReadonly = (targetRef: { current: HTMLDivElement | null }) =>
    render(
      <TextContextMenu variant='readonly' getSelectAllTarget={() => targetRef.current}>
        <div data-testid='wrap'>
          <div ref={targetRef}>rendered message text</div>
        </div>
      </TextContextMenu>
    );

  it('offers only copy and select all — no cut, no paste', async () => {
    stubSelection('selected words');
    const targetRef: { current: HTMLDivElement | null } = { current: null };
    renderReadonly(targetRef);

    fireEvent.contextMenu(screen.getByTestId('wrap'));

    expect(await openMenuAndFindItem('common.menu.copy')).toBeTruthy();
    expect(await openMenuAndFindItem('common.menu.selectAll')).toBeTruthy();
    expect(screen.queryByText('common.menu.cut')).toBeNull();
    expect(screen.queryByText('common.menu.paste')).toBeNull();
  });

  it('disables copy when nothing was selected and swallows the click', async () => {
    stubSelection('');
    const targetRef: { current: HTMLDivElement | null } = { current: null };
    renderReadonly(targetRef);

    fireEvent.contextMenu(screen.getByTestId('wrap'));

    expect((await openMenuAndFindItem('common.menu.copy')).className).toContain('disabled');
    fireEvent.click(screen.getByText('common.menu.copy'));
    expect(copyTextMock).not.toHaveBeenCalled();
  });

  it('copies the text captured when the menu opened, not whatever is selected at click time', async () => {
    const selection = stubSelection('captured text');
    const targetRef: { current: HTMLDivElement | null } = { current: null };
    renderReadonly(targetRef);

    fireEvent.contextMenu(screen.getByTestId('wrap'));
    // The click on the menu item clears the document selection — the copy must still see the captured string.
    selection.toString = () => '';

    fireEvent.click(await openMenuAndFindItem('common.menu.copy'));

    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith('captured text'));
  });

  it('select all covers the target element contents through a document range', async () => {
    const selection = stubSelection('');
    const targetRef: { current: HTMLDivElement | null } = { current: null };
    renderReadonly(targetRef);

    fireEvent.contextMenu(screen.getByTestId('wrap'));
    fireEvent.click(await openMenuAndFindItem('common.menu.selectAll'));

    await waitFor(() => expect(selection.addRange).toHaveBeenCalledTimes(1));
    const range = selection.addRange.mock.calls[0][0] as Range;
    expect(range.commonAncestorContainer).toBe(targetRef.current);
    expect(execCommandMock).not.toHaveBeenCalled();
  });
});
