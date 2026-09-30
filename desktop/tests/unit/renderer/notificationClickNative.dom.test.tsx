import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A click on a system notification opens the conversation it came from: the AionCore conversation's page, or the
 * native page for a native conversation (`native: true` on the click).
 */

let clicked: ((payload: { conversation_id?: string; native?: boolean }) => void) | undefined;

vi.mock('@/common', () => ({
  ipcBridge: {
    notification: {
      clicked: {
        on: (handler: typeof clicked) => {
          clicked = handler;
          return () => {
            clicked = undefined;
          };
        },
      },
    },
  },
}));

import { useNotificationClick } from '@/renderer/hooks/system/notification/useNotificationClick';

afterEach(cleanup);

const Listening: React.FC = () => {
  useNotificationClick();
  return <div data-testid='where'>{useLocation().pathname}</div>;
};

const shown = () => {
  render(
    <MemoryRouter initialEntries={['/guid']}>
      <Listening />
    </MemoryRouter>
  );
};

describe('a click on a notification', () => {
  it('opens an AionCore conversation by its page', () => {
    shown();
    act(() => clicked?.({ conversation_id: 'c1' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/conversation/c1');
  });

  it('opens a native conversation on the native page, its id made safe for the address', () => {
    shown();
    act(() => clicked?.({ conversation_id: 'a b/c', native: true }));
    expect(screen.getByTestId('where')).toHaveTextContent('/conversation/native/a%20b%2Fc');
  });

  it('goes nowhere without a conversation', () => {
    shown();
    act(() => clicked?.({ native: true }));
    expect(screen.getByTestId('where')).toHaveTextContent('/guid');
  });
});
