/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import PreviewToolbar from '@/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewToolbar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@icon-park/react', () => ({
  Close: () => <span aria-hidden='true'>×</span>,
}));

/**
 * Baseline props for an editable `code` tab. Individual tests override the
 * save-related flags. Everything here is required by PreviewToolbar.
 */
const baseProps = {
  content_type: 'code',
  isMarkdown: false,
  isHTML: false,
  viewMode: 'source' as const,
  isSplitScreenEnabled: false,
  showOpenInSystemButton: false,
  hasFilePath: true,
  onViewModeChange: vi.fn(),
  onSplitScreenToggle: vi.fn(),
  onOpenInSystem: vi.fn(),
  onDownload: vi.fn(),
  onClose: vi.fn(),
};

describe('PreviewToolbar save button', () => {
  it('does not render the save button when showSave is false', () => {
    render(<PreviewToolbar {...baseProps} showSave={false} />);
    expect(screen.queryByTestId('preview-save')).not.toBeInTheDocument();
  });

  it('fires onSave when clicked while there are unsaved changes', () => {
    const onSave = vi.fn();
    render(<PreviewToolbar {...baseProps} showSave saveActionable onSave={onSave} />);

    fireEvent.click(screen.getByTestId('preview-save'));

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('is shown but inert when there are no unsaved changes', () => {
    const onSave = vi.fn();
    render(<PreviewToolbar {...baseProps} showSave saveActionable={false} onSave={onSave} />);

    const save = screen.getByTestId('preview-save');
    expect(save).toBeInTheDocument();
    expect(save.className).toContain('cursor-not-allowed');

    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('renders the save button first when no open-in-system button, before refresh', () => {
    const { container } = render(
      <PreviewToolbar {...baseProps} refreshState='idle' refreshActionable showSave saveActionable onSave={vi.fn()} />
    );

    const save = container.querySelector('[data-testid="preview-save"]')!;
    const refresh = container.querySelector('[data-testid="preview-refresh"]')!;

    // Without the open-in-system button, save opens the left-aligned cluster...
    expect(save.parentElement?.firstElementChild).toBe(save);
    // ...and refresh comes after it in DOM order.
    expect(save.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('places open-in-system first and inspect second, ahead of save', () => {
    const { container } = render(
      <PreviewToolbar
        {...baseProps}
        content_type='html'
        isHTML
        showOpenInSystemButton
        onOpenInSystem={vi.fn()}
        onInspectModeToggle={vi.fn()}
        refreshState='idle'
        refreshActionable
        showSave
        saveActionable
        onSave={vi.fn()}
      />
    );

    const openInSystem = container.querySelector(`[title="${'preview.openInSystemApp'}"]`)!;
    const inspectBtn = screen.getByText('preview.html.inspectElement');
    const save = container.querySelector('[data-testid="preview-save"]')!;

    // Open-in-system leads the cluster, inspect follows, save comes third.
    expect(openInSystem.parentElement?.firstElementChild).toBe(openInSystem);
    expect(openInSystem.compareDocumentPosition(inspectBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(inspectBtn.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('PreviewToolbar view toggle', () => {
  it('shows a single source toggle that flips back to preview, with no separate preview tab', () => {
    const onViewModeChange = vi.fn();
    const { rerender } = render(
      <PreviewToolbar {...baseProps} content_type='html' isHTML viewMode='preview' onViewModeChange={onViewModeChange} />
    );

    // The old "preview" tab is gone; the code toggle is the only view switch.
    expect(screen.queryByText('preview.preview')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('preview.code'));
    expect(onViewModeChange).toHaveBeenCalledWith('source');

    rerender(
      <PreviewToolbar {...baseProps} content_type='html' isHTML viewMode='source' onViewModeChange={onViewModeChange} />
    );
    fireEvent.click(screen.getByText('preview.code'));
    expect(onViewModeChange).toHaveBeenCalledWith('preview');
  });
});
