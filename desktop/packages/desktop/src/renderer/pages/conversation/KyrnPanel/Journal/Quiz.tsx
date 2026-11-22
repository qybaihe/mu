import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Radio } from '@arco-design/web-react';
import { Check, Close, Lightning } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import type { JournalEntry } from '@/common/kyrn/journal';
import type { QuizAnswerResult, QuizQuestionView } from '@/common/chat/journal/quizCore';
import MuModal from '@renderer/components/base/MuModal';
import { quizPassed, recordQuizPass, subscribeQuizProgress } from './quizNotes';
import styles from './Quiz.module.css';

const KEY = 'common.kyrn.quizView';

/**
 * Where one answer stands: asked, or answered with its verdict in reach. A stale entry (the lesson moved since the
 * question was shown) is asked anew — the old key grades nothing.
 */
type Phase =
  | { step: 'asking' }
  | { step: 'absent'; why: 'no-model' | 'thin-entry' | 'unknown-entry' | 'no-question' | 'stale-entry' }
  | { step: 'ready'; question: QuizQuestionView; picked?: number }
  | {
      step: 'answered';
      question: QuizQuestionView;
      picked: number;
      verdict: Extract<QuizAnswerResult, { action: 'verdict' }>;
    };

/** The journal entry's quiz (side-tutor case 3): the row's button and mark, and the modal one question lives in. */
export default function EntryQuiz({ entry, model }: { entry: JournalEntry; model?: string }) {
  const { t } = useTranslation();
  const passed = useSyncExternalStore(subscribeQuizProgress, () => quizPassed(entry.id, entry.at));
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ step: 'asking' });

  const ask = useCallback(async () => {
    setPhase({ step: 'asking' });
    try {
      const answer = unwrap(await kyrnBridge.quizQuestion.invoke({ entryId: entry.id }));
      setPhase(
        answer.action === 'ask' ? { step: 'ready', question: answer.question } : { step: 'absent', why: answer.action }
      );
    } catch {
      setPhase({ step: 'absent', why: 'no-question' });
    }
  }, [entry.id]);

  // Opening the card asks; a card already open (a re-ask after a wrong answer) asks again on its own.
  useEffect(() => {
    if (open) void ask();
  }, [open, ask]);

  // A pick lands only in the ready step; the radio carries the phase's own question forward.
  const pick = (index: number) =>
    setPhase((old) => (old.step === 'ready' ? { step: 'ready', question: old.question, picked: index } : old));

  const submit = async (question: QuizQuestionView, picked: number) => {
    try {
      const answer = unwrap(
        await kyrnBridge.quizAnswer.invoke({ entryId: entry.id, hash: question.hash, choice: picked })
      );
      if (answer.action === 'verdict') {
        if (answer.correct)
          recordQuizPass({ entryId: entry.id, entryAt: entry.at, hash: question.hash, at: Date.now() });
        setPhase({ step: 'answered', question, picked, verdict: answer });
      } else setPhase({ step: 'absent', why: answer.action });
    } catch {
      setPhase({ step: 'absent', why: 'no-question' });
    }
  };

  return (
    <>
      {passed ? (
        <span className={styles.passed} data-testid='mu-quiz-passed'>
          <Check theme='outline' size='12' /> {t(`${KEY}.passed`)}
        </span>
      ) : null}
      <Button
        className={styles.launch}
        size='mini'
        type='text'
        disabled={model === undefined}
        title={model === undefined ? t(`${KEY}.noModel`) : t(`${KEY}.action`)}
        aria-label={t(`${KEY}.action`)}
        data-testid='mu-quiz-ask'
        onClick={() => setOpen(true)}
      >
        <Lightning theme='outline' size='14' />
      </Button>
      <MuModal
        visible={open}
        onCancel={() => setOpen(false)}
        footer={null}
        size='small'
        header={{ title: t(`${KEY}.title`) }}
      >
        {open ? <Card phase={phase} onPick={pick} onAsk={ask} onSubmit={submit} /> : null}
      </MuModal>
    </>
  );
}

/** The card's one question, whatever step it is in. The entry's own words stay out until the answer is in: the quiz is blind. */
function Card({
  phase,
  onPick,
  onAsk,
  onSubmit,
}: {
  phase: Phase;
  onPick: (index: number) => void;
  onAsk: () => Promise<void>;
  onSubmit: (question: QuizQuestionView, picked: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  if (phase.step === 'asking') return <p className={styles.quiet}>{t(`${KEY}.loading`)}</p>;
  if (phase.step === 'absent') {
    const message =
      phase.why === 'no-model' || phase.why === 'unknown-entry'
        ? t(`${KEY}.noModel`)
        : phase.why === 'thin-entry'
          ? t(`${KEY}.thin`)
          : phase.why === 'stale-entry'
            ? t(`${KEY}.stale`)
            : t(`${KEY}.failed`);
    return (
      <div className={styles.card}>
        <p className={styles.quiet} data-testid='mu-quiz-absent'>
          {message}
        </p>
        {phase.why === 'stale-entry' ? (
          <div className={styles.row}>
            <Button size='small' type='secondary' onClick={() => void onAsk()}>
              {t(`${KEY}.again`)}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  const { question } = phase;
  const answered = phase.step === 'answered';
  return (
    <div className={styles.card} data-testid={answered ? 'mu-quiz-answered' : 'mu-quiz-question'}>
      <p className={styles.stem}>{question.stem}</p>
      {answered ? (
        <div className={styles.options} role='listbox' aria-label={t(`${KEY}.title`)}>
          {question.options.map((option, index) => (
            <div
              key={index}
              className={`${styles.option} ${index === phase.verdict.correctIndex ? styles.optionRight : ''} ${
                index === phase.picked && !phase.verdict.correct ? styles.optionWrong : ''
              }`}
              data-testid='mu-quiz-option'
            >
              {index === phase.verdict.correctIndex ? (
                <Check theme='outline' size='14' />
              ) : index === phase.picked ? (
                <Close theme='outline' size='14' />
              ) : null}
              <span>{option}</span>
            </div>
          ))}
        </div>
      ) : (
        <Radio.Group direction='vertical' value={phase.picked} onChange={onPick}>
          {question.options.map((option, index) => (
            <Radio key={index} value={index}>
              {option}
            </Radio>
          ))}
        </Radio.Group>
      )}
      {answered ? (
        <>
          <p
            className={`${styles.verdict} ${phase.verdict.correct ? styles.right : styles.wrong}`}
            data-testid='mu-quiz-verdict'
          >
            {phase.verdict.correct ? <Check theme='outline' size='14' /> : <Close theme='outline' size='14' />}
            {t(phase.verdict.correct ? `${KEY}.correct` : `${KEY}.wrong`)}
          </p>
          {phase.verdict.source ? (
            <p className={styles.source} data-testid='mu-quiz-source'>
              {t(`${KEY}.sourceLabel`)}：{phase.verdict.source}
            </p>
          ) : null}
          <div className={styles.row}>
            <Button size='small' type='secondary' onClick={() => void onAsk()}>
              {t(`${KEY}.again`)}
            </Button>
          </div>
        </>
      ) : (
        <div className={styles.row}>
          <Button
            size='small'
            type='primary'
            disabled={phase.picked === undefined}
            data-testid='mu-quiz-submit'
            onClick={() => void onSubmit(question, phase.picked ?? 0)}
          >
            {t(`${KEY}.submit`)}
          </Button>
        </div>
      )}
    </div>
  );
}
