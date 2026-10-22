/**
 * The sidebar's list is one stop in the Tab order. With a stop per conversation, a keyboard user who tabbed into the
 * sidebar went through every conversation (and its menu button) before reaching the page: 111 conversations were
 * more than 200 presses of Tab between the title bar and the scheduled tasks page. Now Tab reaches one row, the arrow
 * keys move through the rest, and the stop stays on a row that is shown.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { useRovingRows } from '@/renderer/hooks/ui/useRovingRows';

function List({ rows, current = null }: { rows: string[]; current?: string | null }) {
  const { listRef, onFocus, onKeyDown, tabIndexOf } = useRovingRows(current);
  return (
    <div ref={listRef} onFocus={onFocus} onKeyDown={onKeyDown}>
      {rows.map((key) => (
        <div key={key} role='button' aria-label={key} data-roving-row={key} tabIndex={tabIndexOf(key)}>
          {key}
          <span role='button' tabIndex={0} aria-label={`${key} menu`} />
        </div>
      ))}
    </div>
  );
}

const row = (name: string) => screen.getByRole('button', { name });
const stops = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-roving-row]'))
    .filter((element) => element.tabIndex === 0)
    .map((element) => element.dataset.rovingRow);

describe('useRovingRows', () => {
  it('makes the first row the one stop when no row is current', () => {
    render(<List rows={['section:projects', 'project:/a', 'c1', 'c2']} />);

    expect(stops()).toEqual(['section:projects']);
  });

  it('puts the stop on the current row', () => {
    render(<List rows={['section:projects', 'c1', 'c2', 'c3']} current='c2' />);

    expect(stops()).toEqual(['c2']);
  });

  it('moves through the rows with the arrow keys, Home and End, and the stop follows the focus', () => {
    render(<List rows={['c1', 'c2', 'c3', 'c4']} />);

    act(() => row('c1').focus());
    fireEvent.keyDown(row('c1'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('c2'));
    fireEvent.keyDown(row('c2'), { key: 'End' });
    expect(document.activeElement).toBe(row('c4'));
    fireEvent.keyDown(row('c4'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('c4'));
    fireEvent.keyDown(row('c4'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(row('c3'));
    fireEvent.keyDown(row('c3'), { key: 'Home' });
    expect(document.activeElement).toBe(row('c1'));

    act(() => row('c3').focus());
    expect(stops()).toEqual(['c3']);
  });

  it('leaves keys pressed on a control inside a row to that control', () => {
    render(<List rows={['c1', 'c2']} />);

    const menu = screen.getByRole('button', { name: 'c1 menu' });
    act(() => menu.focus());
    fireEvent.keyDown(menu, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(menu);
  });

  it('keeps the stop on a row that is shown when its row goes away', () => {
    const { rerender } = render(<List rows={['c1', 'c2', 'c3']} />);
    act(() => row('c2').focus());
    expect(stops()).toEqual(['c2']);

    rerender(<List rows={['c1', 'c3']} />);

    expect(stops()).toEqual(['c1']);
  });

  it('moves the stop to a row opened from elsewhere', () => {
    const { rerender } = render(<List rows={['c1', 'c2', 'c3']} current='c1' />);
    act(() => row('c2').focus());
    expect(stops()).toEqual(['c2']);

    rerender(<List rows={['c1', 'c2', 'c3']} current='c3' />);

    expect(stops()).toEqual(['c3']);
  });
});
