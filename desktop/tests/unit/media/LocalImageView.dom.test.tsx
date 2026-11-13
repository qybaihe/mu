/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A local image can open the shared preview on click (zoom, save) when `preview` is on — the markdown reply's
 * images — and stays a plain sized <img> without it — the three call sites that pass their own sizing classes.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LocalImageView from '@/renderer/components/media/LocalImageView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async ({ path }: { path: string }) => `data:image/png;base64,${path.replaceAll('/', '_')}`),
}));
vi.mock('@/common', () => ({ ipcBridge: { fs: { getImageBase64: { invoke } } } }));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: { error: vi.fn() } };
});

const createObjectURL = vi.fn(() => 'blob:x');
const revokeObjectURL = vi.fn();
Object.assign(URL, { createObjectURL, revokeObjectURL });

afterEach(() => {
  invoke.mockClear();
});

describe('LocalImageView', () => {
  it('opens the preview with a save action on click when preview is on', async () => {
    render(<LocalImageView src='E:/out/card.png' alt='card.png' preview />);
    const image = await screen.findByAltText('card.png');
    fireEvent.load(image); // jsdom never loads images; Arco opens the preview only once loaded
    fireEvent.click(image);
    const shown = await waitFor(() => document.querySelector('.arco-image-preview-img'), { timeout: 3000 });
    fireEvent.load(shown as HTMLElement); // and its toolbar waits for the previewed image to load
    const save = await screen.findByTestId('local-image-save', undefined, { timeout: 3000 });
    expect(save).toBeTruthy();
    expect(document.querySelector('.arco-image-preview')).toBeTruthy();
    invoke.mockClear();
    fireEvent.click(save.firstElementChild ?? save); // the span only wraps Arco's action div
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ path: 'E:/out/card.png', workspace: undefined }));
  });

  it("stays a plain img that carries the caller's sizing classes without preview", async () => {
    render(<LocalImageView src='E:/out/card.png' alt='card.png' className='max-h-320px object-contain' />);
    const image = await screen.findByAltText('card.png');
    expect(image.tagName).toBe('IMG');
    expect(image).toHaveClass('max-h-320px', 'object-contain');
    expect(document.querySelector('.arco-image')).toBeNull();
  });
});
