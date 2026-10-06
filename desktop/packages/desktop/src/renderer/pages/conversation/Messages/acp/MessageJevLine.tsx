import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import FirstHint from '@/renderer/components/base/FirstHint';
import { isTurnType, judgeName, type JevLine } from './jevLine';
import styles from './MessageJevLine.module.css';

/** The way to the judges' settings, where one is set up. Only the line that says there is none has it. */
function JudgeSetup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <button
      type='button'
      className={styles.action}
      data-testid='mu-jev-setup'
      onClick={() => void navigate('/settings/judges')}
    >
      {t('common.kyrn.jevLine.setUp')}
    </button>
  );
}

/**
 * The judge's classification of the message, as one quiet line in the person's own language ("Jev 归类为闲聊"), in
 * place of a tool call box. The judge is named as the one that answered (Jev, Laya, CLM). Shadow and late verdicts say
 * they were not used; a rule's class says so; no class says whether the judge did not answer or was not sure. With no
 * judge set up at all, the line says so once and offers to set one up. The hints the main model was given follow the
 * line as small labels ("先计划"), each with its whole sentence on hover.
 */
export default function MessageJevLine({ line }: { line: JevLine }) {
  const { t } = useTranslation();
  if (line.stage === 'quiet') return null;
  let text: string;
  if (line.stage === 'classifying') text = t('common.kyrn.jevLine.classifying', { judge: judgeName(line.judge) });
  else if (line.stage === 'noJudge') text = t('common.kyrn.jevLine.noJudge');
  else if (line.stage === 'fallback')
    text = t(line.why === 'unanswered' ? 'common.kyrn.jevLine.unanswered' : 'common.kyrn.jevLine.fallback', {
      judge: judgeName(line.judge),
    });
  else {
    const type = t(`common.kyrn.judgeView.values.${isTurnType(line.turnType) ? line.turnType : 'other'}`);
    const said = line.byRule
      ? t('common.kyrn.jevLine.byRule', { type })
      : t('common.kyrn.jevLine.classified', { type, judge: judgeName(line.judge) });
    text =
      line.state === 'shadow'
        ? t('common.kyrn.jevLine.shadow', { line: said })
        : line.state === 'late'
          ? t('common.kyrn.jevLine.late', { line: said })
          : said;
  }
  const muted =
    line.stage === 'fallback' || line.stage === 'noJudge' || (line.stage === 'classified' && line.state !== 'applied');
  const hints = line.stage === 'classifying' ? [] : (line.hints ?? []);
  const verdict = (
    <div className={styles.line} data-testid='mu-jev-line' data-stage={line.stage}>
      <span
        className={line.stage === 'classifying' ? styles.dotBusy : muted ? styles.dotMuted : styles.dot}
        aria-hidden='true'
      />
      <span className={styles.text}>{text}</span>
      {line.stage === 'noJudge' && <JudgeSetup />}
      {hints.map((id) => (
        <span
          key={id}
          className={styles.hint}
          title={t(`common.kyrn.judgeView.hints.${id}`)}
          data-testid='mu-jev-hint'
          data-hint={id}
        >
          {t(`common.kyrn.judgeView.hintChips.${id}`)}
        </span>
      ))}
    </div>
  );
  // The first verdict someone sees says once what the line is.
  return (
    <div className={styles.stack}>
      {verdict}
      <FirstHint id='jevLine' wants={line.stage === 'classified'} text={t('common.kyrn.jevLine.firstHint')} />
    </div>
  );
}
