import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeResult } from '@/common/kyrn/nativeBridge';
import type { DialogAnswer, ViewDialog, ViewPermission } from '@/common/utils/nativeHost';
import NativeDialog from '@/renderer/pages/native/components/NativeDialog';
import { dialogChoices, permissionCard } from '@/renderer/pages/native/utils/dialogCard';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMessages from '@/renderer/services/i18n/locales/en-US/messages.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';

/** The dialogs pi waits on, as the native screen asks them: mu's permission question, choices, text, a countdown. */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const i18n = createInstance();
void i18n.init({
  lng: 'en',
  resources: { en: { translation: { common: enCommon, messages: enMessages, mu: enMu } } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;
const has = (key: string) => i18n.exists(key);

const ANSWERS = ['Allow once', 'Allow for this conversation (ls)', 'Don’t allow'];
const permission: ViewPermission = {
  kind: 'shell',
  summary: 'ls -la',
  answers: ANSWERS,
  answerIds: ['once', 'session', 'deny'],
  reason: 'unsure',
  grantLabel: 'ls',
  toolCallId: 'call-1',
};
const asking = (extra: Partial<ViewDialog> = {}): ViewDialog => ({
  id: 'd1',
  method: 'select',
  title: 'mu wants to run a command\nls -la\nJev is not sure this is what you want.',
  options: ANSWERS,
  inRun: true,
  permission,
  ...extra,
});

type Answered = { dialogId: string; answer: DialogAnswer };

/** The options on screen, in order: what the end-to-end tests click. */
const options = () => screen.getAllByTestId('native-dialog-option');

function show(dialog: ViewDialog, result: NativeResult<void> = { ok: true, data: undefined }, more = 0) {
  const answered: Answered[] = [];
  const expired: string[] = [];
  const view = render(
    <I18nextProvider i18n={i18n}>
      <NativeDialog
        conversationId='c1'
        dialog={dialog}
        more={more}
        onAnswer={async (dialogId, answer) => {
          answered.push({ dialogId, answer });
          return result;
        }}
        onExpire={(dialogId) => expired.push(dialogId)}
      />
    </I18nextProvider>
  );
  return { ...view, answered, expired };
}

describe('the permission card of a native dialog', () => {
  it('words mu’s question from its codes and sends mu’s own answer text back', async () => {
    const { answered } = show(asking());
    expect(screen.getByTestId('native-dialog')).toHaveAttribute('data-method', 'select');
    expect(screen.getByText('mu wants to run a command')).toBeInTheDocument();
    expect(screen.getByText('Jev is not sure this step is what you want.')).toBeInTheDocument();
    expect(screen.getByText('ls -la')).toBeInTheDocument();
    expect(options().map((option) => option.textContent)).toEqual(ANSWERS);
    await act(async () => {
      fireEvent.click(options()[1]);
    });
    expect(answered).toEqual([{ dialogId: 'd1', answer: { value: 'Allow for this conversation (ls)' } }]);
    expect(screen.getByTestId('message-acp-permission-status')).toHaveTextContent(
      'Allowed for this conversation: ls -la'
    );
  });

  it('says an answer that did not go through, and keeps the question', async () => {
    show(asking(), { ok: false, kind: 'timeout', message: 'pi did not answer respond in 30 s' });
    await act(async () => {
      fireEvent.click(options()[0]);
    });
    expect(screen.getByTestId('message-acp-permission-error')).toHaveTextContent(
      'Could not send the response. Please try again.'
    );
    expect(options()).toHaveLength(3);
  });

  it('keeps mu’s own words when it sends no codes the app knows, and reads answers by their place', () => {
    const card = permissionCard(
      asking({ title: 'Do the thing\nthing --now\nBecause.', options: ['Yes', 'Only now', 'No'] }),
      { kind: 'teleport', summary: 'thing --now', answers: ['Yes', 'Only now', 'No'] },
      t,
      has
    );
    expect(card).toMatchObject({ title: 'Do the thing', description: 'Because.', detail: 'thing --now' });
    expect(card.operationKind).toBe('tool');
    expect(card.choices.map((choice) => [choice.id, choice.label, choice.intent])).toEqual([
      ['0', 'Yes', 'allow-once'],
      ['1', 'Only now', 'allow-always'],
      ['2', 'No', 'reject-once'],
    ]);
    expect(card.decided('0')).toBeUndefined();
  });
});

describe('other native dialogs', () => {
  it('offers a select’s options, and dismissing it sends no choice', async () => {
    const dialog: ViewDialog = { id: 'd2', method: 'select', title: 'Pick a model', options: ['a', 'b'], inRun: false };
    const { answered } = show(dialog);
    expect(screen.getByTestId('native-dialog')).toHaveAttribute('data-method', 'select');
    expect(screen.getByTestId('native-dialog-choice')).toHaveTextContent('Pick a model');
    expect(options().map((option) => [option.textContent, option.getAttribute('data-option-id')])).toEqual([
      ['a', '0'],
      ['b', '1'],
    ]);
    await act(async () => {
      fireEvent.click(options()[1]);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-dialog-cancel'));
    });
    expect(answered.map((each) => each.answer)).toEqual([{ value: 'b' }, { cancelled: true }]);
  });

  it('asks a confirm as yes or no', async () => {
    const dialog: ViewDialog = { id: 'd3', method: 'confirm', title: 'Retire?', message: 'It goes.', inRun: false };
    expect(dialogChoices(dialog, t).map((choice) => choice.label)).toEqual(['Yes', 'No']);
    const { answered } = show(dialog);
    expect(screen.getByTestId('native-dialog')).toHaveAttribute('data-method', 'confirm');
    expect(screen.getByText('It goes.')).toBeInTheDocument();
    expect(screen.queryByTestId('native-dialog-cancel')).toBeNull();
    expect(options().map((option) => option.getAttribute('data-option-id'))).toEqual(['yes', 'no']);
    await act(async () => {
      fireEvent.click(options()[1]);
    });
    expect(answered[0].answer).toEqual({ confirmed: false });
  });

  it('takes a typed line, or no answer', async () => {
    const dialog: ViewDialog = { id: 'd4', method: 'input', title: 'Name it', placeholder: 'a name', inRun: false };
    const { answered } = show(dialog);
    expect(screen.getByTestId('native-dialog')).toHaveAttribute('data-method', 'input');
    const input = screen.getByTestId('native-dialog-input');
    expect(input).toHaveAttribute('placeholder', 'a name');
    fireEvent.change(input, { target: { value: 'release' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-dialog-cancel'));
    });
    expect(answered.map((each) => each.answer)).toEqual([{ value: 'release' }, { cancelled: true }]);
  });

  it('edits a text that starts as pi sent it', async () => {
    const dialog: ViewDialog = { id: 'd5', method: 'editor', title: 'The plan', prefill: 'step 1', inRun: false };
    const { answered } = show(dialog);
    expect(screen.getByTestId('native-dialog')).toHaveAttribute('data-method', 'editor');
    const area = screen.getByTestId('native-dialog-input');
    expect(area).toHaveValue('step 1');
    fireEvent.change(area, { target: { value: 'step 1\nstep 2' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-dialog-submit'));
    });
    expect(screen.getByTestId('native-dialog-submit')).toHaveTextContent('Save');
    expect(answered[0].answer).toEqual({ value: 'step 1\nstep 2' });
  });

  it('counts down a dialog with a time limit and closes it when pi stops waiting', () => {
    vi.useFakeTimers();
    const dialog: ViewDialog = { id: 'd6', method: 'confirm', title: 'Quick?', timeout: 3000, inRun: true };
    const { expired } = show(dialog, undefined, 2);
    expect(screen.getByTestId('native-dialog-countdown')).toHaveTextContent(
      'Closes in 3 s; mu then goes on without your answer.'
    );
    expect(screen.getByText('Waiting after this one: 2')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('native-dialog-countdown')).toHaveTextContent('Closes in 2 s');
    expect(expired).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(expired).toEqual(['d6']);
  });
});
