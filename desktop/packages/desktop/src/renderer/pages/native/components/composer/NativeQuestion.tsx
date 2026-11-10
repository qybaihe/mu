/**
 * A question the model asked with mu's ask_user, as a card in place of the dialog pi waits on: the question, its
 * options with what each one means, and a line for the person's own words. A pick-one question answers its select
 * with the option's exact text; "Something else" answers it with the last choice, and mu then opens a line, which this
 * card asks as the same question. A pick-any question answers its line with the numbers of the options ticked, or with
 * the person's own words. Skip answers nothing: mu tells the model the questions were skipped.
 *
 * `QuestionsOpenLine` is the line above the send box while questions nobody answered in time wait: its button sends
 * `/answer`, which asks them again. `PermissionsWaitingLine` is the same line for permission questions nobody answered
 * in time: its button sends `/approve`.
 */
import { Button, Checkbox, Input, Radio } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DialogAnswer, ViewDialog, ViewQuestion } from '@/common/utils/nativeHost';

type Answer = (answer: DialogAnswer) => Promise<void>;

/** How long a pressed Answer waits for mu's dialogs before it can be pressed again. */
const ANSWER_WAIT_MS = 10_000;

const CARD = 'rd-12px border border-solid border-[var(--color-border-2)] bg-1 p-12px flex flex-col gap-10px';
const OTHER = 'other';

/** What a pick-any line is answered with: the person's own words, else the numbers of the options ticked, from 1. */
export function pickAnyAnswer(ticked: readonly number[], words: string): string {
  const own = words.trim();
  if (own) return own;
  return [...ticked]
    .toSorted((a, b) => a - b)
    .map((index) => String(index + 1))
    .join(',');
}

const Option: React.FC<{ label: string; description?: string }> = ({ label, description }) => (
  <span className='inline-flex flex-col gap-2px'>
    <span className='text-13px leading-20px text-t-primary [word-break:break-word]'>{label}</span>
    {description ? (
      <span className='text-12px leading-18px text-t-secondary [word-break:break-word]'>{description}</span>
    ) : null}
  </span>
);

const QuestionCard: React.FC<{ dialog: ViewDialog; question: ViewQuestion; answer: Answer }> = ({
  dialog,
  question,
  answer,
}) => {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string>();
  const [ticked, setTicked] = useState<number[]>([]);
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  // A failed answer is said by the screen, above the send box; the card stays for another try.
  const send = (value: DialogAnswer) => {
    setBusy(true);
    void answer(value)
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  const pickOne = dialog.method === 'select';
  const ownWords = dialog.method === 'input' && !question.multiSelect;
  const choices = question.choices ?? [];
  const ready = pickOne ? picked !== undefined : ownWords ? words.trim() !== '' : ticked.length > 0 || !!words.trim();
  const submit = () => {
    if (!ready) return;
    if (pickOne) {
      const index = picked === OTHER ? choices.length - 1 : Number(picked);
      const choice = choices[index];
      if (choice !== undefined) send({ value: choice });
      return;
    }
    send({ value: ownWords ? words.trim() : pickAnyAnswer(ticked, words) });
  };
  return (
    <div
      className={CARD}
      data-testid='native-question'
      data-question-id={question.id}
      data-step={pickOne ? 'pick' : ownWords ? 'words' : 'pick-any'}
    >
      {question.header || question.count > 1 ? (
        <div className='flex items-center gap-8px text-12px leading-18px text-t-tertiary'>
          {question.header ? (
            <span className='rd-4px px-6px py-1px bg-fill-2 text-t-secondary' data-testid='native-question-header'>
              {question.header}
            </span>
          ) : null}
          {question.count > 1 ? (
            <span>{t('mu.native.question.position', { index: question.index + 1, count: question.count })}</span>
          ) : null}
        </div>
      ) : null}
      <div className='text-14px font-500 text-t-primary whitespace-pre-wrap [word-break:break-word]' dir='auto'>
        {question.question}
        {question.multiSelect ? (
          <span className='ml-6px text-12px font-400 text-t-tertiary'>{t('mu.native.question.pickAny')}</span>
        ) : null}
      </div>
      {pickOne ? (
        <Radio.Group
          direction='vertical'
          value={picked}
          onChange={(value: string) => setPicked(value)}
          disabled={busy}
          data-testid='native-question-options'
        >
          {question.options.map((option, index) => (
            <Radio key={option.label} value={String(index)} data-testid='native-question-option'>
              <Option label={option.label} description={option.description} />
            </Radio>
          ))}
          <Radio value={OTHER} data-testid='native-question-other'>
            <Option label={t('mu.native.question.other')} />
          </Radio>
        </Radio.Group>
      ) : null}
      {question.multiSelect && !ownWords ? (
        <Checkbox.Group
          direction='vertical'
          value={ticked}
          onChange={(values: number[]) => setTicked(values)}
          disabled={busy}
          data-testid='native-question-options'
        >
          {question.options.map((option, index) => (
            <Checkbox key={option.label} value={index} data-testid='native-question-option'>
              <Option label={option.label} description={option.description} />
            </Checkbox>
          ))}
        </Checkbox.Group>
      ) : null}
      {!pickOne ? (
        <Input
          value={words}
          onChange={setWords}
          placeholder={t('mu.native.question.ownWords')}
          autoFocus={ownWords}
          disabled={busy}
          onPressEnter={submit}
          data-testid='native-question-words'
        />
      ) : null}
      <div className='flex justify-end gap-8px'>
        <Button
          size='small'
          type='secondary'
          disabled={busy}
          data-testid='native-question-skip'
          onClick={() => send({ cancelled: true })}
        >
          {t('mu.native.question.skip')}
        </Button>
        <Button
          size='small'
          type='primary'
          loading={busy}
          disabled={!ready}
          data-testid='native-question-send'
          onClick={submit}
        >
          {t('mu.native.question.send')}
        </Button>
      </div>
    </div>
  );
};

/** One quiet line above the send box while something of mu's waits for the person: what waits, and a button to take it up. */
const WaitingLine: React.FC<{
  text: string;
  action: string;
  testId: string;
  actionTestId: string;
  onAct: () => void;
}> = ({ text, action, testId, actionTestId, onAct }) => {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return undefined;
    const timer = setTimeout(() => setAsking(false), ANSWER_WAIT_MS);
    return () => clearTimeout(timer);
  }, [asking]);
  return (
    <div
      className='mb-8px flex items-center justify-between gap-8px px-4px text-13px leading-20px text-t-secondary'
      role='status'
      data-testid={testId}
    >
      <span>{text}</span>
      <Button
        type='text'
        size='mini'
        disabled={asking}
        data-testid={actionTestId}
        onClick={() => {
          setAsking(true);
          onAct();
        }}
      >
        {action}
      </Button>
    </div>
  );
};

/** While mu's questions wait: what waits, and a button that sends `/answer`. */
export const QuestionsOpenLine: React.FC<{ onAnswer: () => void }> = ({ onAnswer }) => {
  const { t } = useTranslation();
  return (
    <WaitingLine
      text={t('mu.native.question.waiting')}
      action={t('mu.native.question.answer')}
      testId='native-questions-open'
      actionTestId='native-questions-answer'
      onAct={onAnswer}
    />
  );
};

/** While calls wait for the person's permission: that they wait, and a button that sends `/approve`. */
export const PermissionsWaitingLine: React.FC<{ onApprove: () => void }> = ({ onApprove }) => {
  const { t } = useTranslation();
  return (
    <WaitingLine
      text={t('mu.native.permission.waiting')}
      action={t('mu.native.permission.review')}
      testId='native-permissions-waiting'
      actionTestId='native-permissions-review'
      onAct={onApprove}
    />
  );
};

export default QuestionCard;
