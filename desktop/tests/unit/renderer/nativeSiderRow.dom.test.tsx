import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NativeConversation } from '@/common/kyrn/nativeBridge';
import SiderRow, { type RowActions } from '@/renderer/pages/native/sider/SiderRow';

/** A sidebar row redraws when what it shows changes, not when the list around it does (a run starting elsewhere). */

const renders = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-i18next', () => ({
  useTranslation: () => {
    renders.count += 1;
    return { t: (key: string) => key };
  },
}));

const conversation = (extra: Partial<NativeConversation> = {}): NativeConversation =>
  ({
    id: 'a',
    cwd: '/work/a',
    title: 'Fix the build',
    createdAt: 1,
    updatedAt: 1,
    live: false,
    ...extra,
  }) as NativeConversation;

const actions: RowActions = {
  open: vi.fn(),
  menu: vi.fn(),
  pin: vi.fn(),
  toggleUnread: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
};

const row = (props: Partial<React.ComponentProps<typeof SiderRow>> = {}) => (
  <SiderRow
    conversation={conversation()}
    active={false}
    pinned={false}
    archived={false}
    unread={false}
    menuOpen={false}
    actions={actions}
    {...props}
  />
);

describe('a sidebar row', () => {
  it('does not redraw when its list redraws with the same conversation and actions', () => {
    const same = conversation();
    const { rerender } = render(row({ conversation: same }));
    const before = renders.count;
    rerender(row({ conversation: same }));
    expect(renders.count).toBe(before);
  });

  it('redraws when its own conversation changes', () => {
    const { rerender } = render(row());
    const before = renders.count;
    rerender(row({ conversation: conversation({ running: true }) }));
    expect(renders.count).toBe(before + 1);
  });

  it('asks the list with its own conversation', () => {
    const mine = conversation({ id: 'b' });
    const { getByTestId } = render(row({ conversation: mine }));
    getByTestId('native-sidebar-item').click();
    expect(actions.open).toHaveBeenCalledWith(mine);
  });
});
