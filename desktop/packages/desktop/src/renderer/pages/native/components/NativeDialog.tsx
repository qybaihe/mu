/**
 * A dialog pi waits on, shown above the send box: mu's permission question as the transcript's permission card, any
 * other choice as its buttons, a line to type (`input`) or a text to edit (`editor`). A dialog with a time limit says
 * how long it has and closes itself when the time is up (pi then goes on with its default). An answer closes it at
 * once; one that does not go through brings it back, and the screen says why.
 */
import { Button, Input } from '@arco-design/web-react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeResult } from '@/common/kyrn/nativeBridge';
import type { DialogAnswer, ViewDialog } from '@/common/utils/nativeHost';
import { PermissionRequestPanel } from '@/renderer/pages/conversation/Messages/components/MessagePermission/PermissionRequestPanel';
import { useDialogDeadline } from '../hooks/useDialogDeadline';
import { dialogChoices, permissionCard } from '../utils/dialogCard';

type Answer = (answer: DialogAnswer) => Promise<void>;

type Props = {
  conversationId: string;
  dialog: ViewDialog;
  /** How many more dialogs wait after this one. */
  more: number;
  onAnswer: (dialogId: string, answer: DialogAnswer) => Promise<NativeResult<void>>;
  onExpire: (dialogId: string) => void;
};

const CARD = 'rd-12px border border-solid border-[var(--color-border-2)] bg-1 p-12px flex flex-col gap-10px';

/** mu's permission question: the permission card, worded from mu's codes. */
const PermissionDialog: React.FC<{ dialog: ViewDialog; answer: Answer }> = ({ dialog, answer }) => {
  const { t, i18n } = useTranslation();
  const card = useMemo(
    () =>
      dialog.permission ? permissionCard(dialog, dialog.permission, t, (key) => i18n?.exists(key) ?? false) : undefined,
    [dialog, i18n, t]
  );
  if (!card) return null;
  const byId = new Map(card.choices.map((choice) => [choice.id, choice]));
  return (
    <PermissionRequestPanel
      requestKey={dialog.id}
      testIdPrefix='message-acp-permission'
      title={card.title}
      description={card.description}
      operationKind={card.operationKind}
      detail={card.detail}
      options={card.choices.map((choice) => ({
        id: choice.id,
        value: choice.id,
        label: choice.label,
        intent: choice.intent,
        testId: 'native-dialog-option',
      }))}
      onConfirm={async (value) => {
        const choice = byId.get(value);
        if (choice) await answer(choice.answer);
      }}
      decision={(option) => card.decided(option.value)}
    />
  );
};

/** A choice that is not mu's permission question: a `select`'s options, or a `confirm`'s yes and no. */
const ChoiceDialog: React.FC<{ dialog: ViewDialog; answer: Answer }> = ({ dialog, answer }) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string>();
  // A failed answer is said by the screen, above the send box.
  const choose = (id: string, value: DialogAnswer) => {
    setBusy(id);
    void answer(value)
      .catch(() => {})
      .finally(() => setBusy(undefined));
  };
  const choices = dialogChoices(dialog, t);
  return (
    <div className={CARD} data-testid='native-dialog-choice'>
      <div className='text-14px font-500 text-t-primary whitespace-pre-wrap [word-break:break-word]'>
        {dialog.title}
      </div>
      {dialog.message ? (
        <div className='text-13px leading-20px text-t-secondary whitespace-pre-wrap [word-break:break-word]'>
          {dialog.message}
        </div>
      ) : null}
      <div className='flex flex-wrap gap-8px'>
        {choices.map((choice, index) => (
          <Button
            key={choice.id}
            size='small'
            type={index === 0 ? 'primary' : 'secondary'}
            loading={busy === choice.id}
            disabled={busy !== undefined}
            data-testid='native-dialog-option'
            data-option-id={choice.id}
            onClick={() => choose(choice.id, choice.answer)}
          >
            {choice.label}
          </Button>
        ))}
        {dialog.method === 'select' ? (
          <Button
            size='small'
            type='text'
            disabled={busy !== undefined}
            data-testid='native-dialog-cancel'
            onClick={() => choose('dismiss', { cancelled: true })}
          >
            {t('mu.native.dialog.dismiss')}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

/** A line to type (`input`) or a text to edit (`editor`). */
const TextDialog: React.FC<{ dialog: ViewDialog; answer: Answer }> = ({ dialog, answer }) => {
  const { t } = useTranslation();
  const editor = dialog.method === 'editor';
  const [text, setText] = useState(editor ? (dialog.prefill ?? '') : '');
  const [busy, setBusy] = useState(false);
  const send = (value: DialogAnswer) => {
    setBusy(true);
    void answer(value)
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <div className={CARD} data-testid='native-dialog-text'>
      <div className='text-14px font-500 text-t-primary whitespace-pre-wrap [word-break:break-word]'>
        {dialog.title}
      </div>
      {editor ? (
        <Input.TextArea
          value={text}
          onChange={setText}
          autoSize={{ minRows: 4, maxRows: 14 }}
          disabled={busy}
          data-testid='native-dialog-input'
        />
      ) : (
        <Input
          value={text}
          onChange={setText}
          placeholder={dialog.placeholder}
          autoFocus
          disabled={busy}
          onPressEnter={() => send({ value: text })}
          data-testid='native-dialog-input'
        />
      )}
      <div className='flex justify-end gap-8px'>
        <Button
          size='small'
          type='secondary'
          disabled={busy}
          data-testid='native-dialog-cancel'
          onClick={() => send({ cancelled: true })}
        >
          {t('mu.native.dialog.cancel')}
        </Button>
        <Button
          size='small'
          type='primary'
          loading={busy}
          data-testid='native-dialog-submit'
          onClick={() => send({ value: text })}
        >
          {editor ? t('mu.native.dialog.save') : t('mu.native.dialog.submit')}
        </Button>
      </div>
    </div>
  );
};

const NativeDialog: React.FC<Props> = ({ conversationId, dialog, more, onAnswer, onExpire }) => {
  const { t } = useTranslation();
  const left = useDialogDeadline(`${conversationId}:${dialog.id}`, dialog.timeout, () => onExpire(dialog.id));
  const answer: Answer = async (value) => {
    const result = await onAnswer(dialog.id, value);
    // The permission card says an answer that did not go through; the screen says why.
    if (result.ok === false) throw new Error(result.message);
  };
  const body =
    dialog.method === 'input' || dialog.method === 'editor' ? (
      <TextDialog dialog={dialog} answer={answer} />
    ) : dialog.permission ? (
      <PermissionDialog dialog={dialog} answer={answer} />
    ) : (
      <ChoiceDialog dialog={dialog} answer={answer} />
    );
  return (
    <div className='flex flex-col gap-6px' data-testid='native-dialog' data-method={dialog.method}>
      {body}
      {left !== undefined || more > 0 ? (
        <div className='flex justify-between gap-8px px-4px text-12px leading-18px text-t-tertiary'>
          <span data-testid='native-dialog-countdown'>
            {left !== undefined ? t('mu.native.dialog.countdown', { seconds: left }) : null}
          </span>
          <span>{more > 0 ? t('mu.native.dialog.more', { count: more }) : null}</span>
        </div>
      ) : null}
    </div>
  );
};

export default NativeDialog;
