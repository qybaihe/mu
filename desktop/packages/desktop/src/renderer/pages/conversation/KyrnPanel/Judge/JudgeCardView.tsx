import React from 'react';
import { Collapse, Tag, Tooltip } from '@arco-design/web-react';
import { ArrowRight, Help, Lightning, ListCheckbox } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { Activity } from '@/common/kyrn/types';
import { formatNumber } from '@/renderer/services/i18n/format';
import { formatNameList } from '@/renderer/services/i18n/list';
import { thinkingLevelLabel } from '@/renderer/utils/model/thinkingLevel';
import { answerRows, resultFacts, type JudgeAnswer, type JudgeCard, type JudgeFact } from './activity';
import styles from './Judge.module.css';
import { answerLabel, answerValue, hintLines, reasonText, scoreLevel } from './wording';
import { useClock } from '../clock';

const KEY = 'common.kyrn.judgeView';

/** A recorded number ("0.75"), or a count of identical answers ("×3"). */
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const TIMES = /^×(\d+)$/;

/** The judge's own input is not part of this view, even if a diagnostic build recorded it. */
const recorded = (events: Activity[]): string =>
  JSON.stringify(
    events.map(({ payload, ...event }) => {
      const { state: _state, ...visible } = payload;
      return { ...event, payload: visible };
    }),
    null,
    2
  );

/**
 * One judgment as question, verdict and effect. `plain` is the judge log's opened line: no frame of its own and no
 * state colours, since the line above it already says what it is. `lessonText` names the lessons a result is about.
 */
export default function JudgeCardView({
  card,
  plain = false,
  lessonText,
}: {
  card: JudgeCard;
  plain?: boolean;
  lessonText?: (id: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const clock = useClock();
  const percent = (probability: number): string =>
    formatNumber(probability, language, { style: 'percent', maximumFractionDigits: 0 });
  // Only identifier-like names can be known labels. Paths and skill names stay as recorded; numbers follow the
  // app language. A value may also be a board phase or a thinking level, which have names of their own.
  const label = (group: 'fields' | 'values', name: string): string => {
    if (group === 'values' && NUMBER.test(name))
      return formatNumber(Number(name), language, { maximumFractionDigits: 2 });
    const times = group === 'values' ? TIMES.exec(name) : null;
    if (times) return `×${formatNumber(Number(times[1]), language)}`;
    if (!/^[A-Za-z_]+$/.test(name)) return name;
    return group === 'values'
      ? t([`${KEY}.values.${name}`, `common.kyrn.boardView.phases.${name}`, `mu.levels.${name}`], {
          defaultValue: name,
        })
      : t(`${KEY}.fields.${name}`, { defaultValue: name });
  };
  // "error:timeout" keeps its cause: a fallback after a timeout is not one after an abstention.
  const reason = reasonText(t, language, card.reason, card.reasonParams, card.reasonFallback);
  const hints = hintLines(t, card.hints, card.hintIds);
  const facts = resultFacts(card, lessonText);
  const answers = answerRows(card);

  const fact = (item: JudgeFact, index: number) => (
    <li key={`${index}:${item.name}`} className={styles.fact}>
      {item.pairs ? (
        <>
          <span className={styles.factName}>{item.name}</span>
          {item.pairs
            .map((pair) =>
              t(`${KEY}.fieldValue`, { field: label('fields', pair.key), value: label('values', pair.value) })
            )
            .join(' · ')}
        </>
      ) : (
        <>
          <span className={styles.factName}>{label(item.tally ? 'values' : 'fields', item.name)}</span>
          {formatNameList(
            item.values.map((value) => (item.text ? value : label('values', value))),
            language
          )}
        </>
      )}
      {item.more ? ` ${t('common.kyrn.judgeView.more', { count: item.more })}` : ''}
    </li>
  );

  // A question and its answers in the decision point's own words; an answer it has none for (an element, a role or an
  // item named at run time) is shown as recorded, numbers in the app language.
  const answer = (row: JudgeAnswer) => {
    const said = (value: string): string => answerValue(t, card.stage, row.id, value) ?? label('values', value);
    return (
      <li key={row.id} className={styles.answer}>
        <span className={styles.answerId}>{answerLabel(t, language, card.stage, row.id)}</span>
        {row.type === 'boolean' && t(`${KEY}.probabilityValue`, { percent: percent(row.probability) })}
        {row.type === 'score' &&
          [
            scoreLevel(t, card.stage, row.id, row.score),
            t(`${KEY}.scoreValue`, {
              value: formatNumber(row.score, language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            }),
          ]
            .filter(Boolean)
            .join(' · ')}
        {row.type === 'text' && row.text}
        {row.type === 'choice' &&
          [
            said(row.choice),
            ...row.options.map((option) =>
              t(`${KEY}.optionProbability`, { option: said(option.name), percent: percent(option.probability) })
            ),
          ].join(' · ')}
      </li>
    );
  };

  return (
    <article className={plain ? styles.plainCard : styles.card} data-state={card.state} data-testid='judge-card'>
      <div className={styles.cardHead}>
        <Tag size='small'>
          {!plain && <span className={styles.stateMark} data-testid='judge-state-mark' aria-hidden='true' />}
          {t(`${KEY}.state.${card.state}`)}
        </Tag>
        {card.unlinked && (
          <Tooltip content={t('common.kyrn.judgeView.unlinkedHint')}>
            <Tag size='small'>{t('common.kyrn.judgeView.unlinked')}</Tag>
          </Tooltip>
        )}
        <span className={styles.meta}>
          {[
            clock(card.at),
            card.model,
            card.latencyMs === undefined
              ? ''
              : t(`${KEY}.latency`, { ms: formatNumber(Math.round(card.latencyMs), language) }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>

      <section className={styles.step}>
        <h4 className={styles.stepLabel}>
          <Help size={12} />
          {t('common.kyrn.judgeView.question')}
        </h4>
        <div className={styles.stepBody}>{t(`${KEY}.questions.${card.stage}`)}</div>
        {card.route && (
          <div className={styles.route}>
            <span>{card.route.from || t('common.kyrn.judgeView.unreported')}</span>
            {card.route.to && (
              <>
                <ArrowRight size={12} />
                <span>{card.route.to}</span>
              </>
            )}
          </div>
        )}
        {card.preview && <div className={styles.preview}>{card.preview}</div>}
      </section>

      <section className={styles.step}>
        <h4 className={styles.stepLabel}>
          <ListCheckbox size={12} />
          {t('common.kyrn.judgeView.result')}
        </h4>
        {facts.length > 0 ? (
          <ul className={styles.facts}>{facts.map(fact)}</ul>
        ) : (
          <div className={styles.muted}>{t('common.kyrn.judgeView.noResult')}</div>
        )}
        {reason && <div className={styles.muted}>{t(`${KEY}.reasonValue`, { reason })}</div>}
        {/* Two whole sentences, each on its own line: no space glued between them ("。 " reads wrong in Chinese). */}
        {card.batch && (
          <div className={styles.muted}>{t('common.kyrn.judgeView.batch', { count: card.batch.size })}</div>
        )}
        {card.batch && card.batch.failures > 0 && (
          <div className={styles.muted}>{t('common.kyrn.judgeView.batchFailures', { count: card.batch.failures })}</div>
        )}
      </section>

      <section className={styles.step}>
        <h4 className={styles.stepLabel}>
          <Lightning size={12} />
          {t('common.kyrn.judgeView.action')}
        </h4>
        <div className={styles.stepBody}>{t(`${KEY}.actions.${card.action}`)}</div>
        {card.thinking && (
          <div className={styles.effect}>
            {t('common.kyrn.judgeView.changedThinking', {
              from: thinkingLevelLabel(t, card.thinking.from),
              to: thinkingLevelLabel(t, card.thinking.to),
            })}
          </div>
        )}
        {hints.length > 0 && (
          <div className={styles.effect}>
            {t('common.kyrn.judgeView.sentHints')}
            <ul className={styles.hints}>
              {hints.map((hint, index) => (
                <li key={index}>{hint}</li>
              ))}
            </ul>
          </div>
        )}
        {/* What the person did about it: their answer to the question it sent them to, and a mark that it was wrong. */}
        {card.userAnswer && (
          <div className={styles.effect} data-testid='judge-user-answer'>
            {t(`${KEY}.userAnswer.${card.userAnswer}`)}
          </div>
        )}
        {card.markedWrong && (
          <div className={styles.effect} data-testid='judge-marked-wrong'>
            {card.markedWrong.note
              ? t(`${KEY}.markedWrongWhy`, { note: card.markedWrong.note })
              : t(`${KEY}.markedWrong`)}
          </div>
        )}
      </section>

      <Collapse bordered={false} className={styles.collapse}>
        <Collapse.Item name='details' header={t('common.kyrn.judgeView.details')}>
          {answers.rows.length > 0 && (
            <>
              <div className={styles.sectionLabel}>{t('common.kyrn.judgeView.answers')}</div>
              <ul className={styles.answers}>{answers.rows.map(answer)}</ul>
              {answers.more > 0 && (
                <div className={styles.muted}>{t('common.kyrn.judgeView.more', { count: answers.more })}</div>
              )}
            </>
          )}
          <div className={styles.sectionLabel}>{t('common.kyrn.judgeView.raw')}</div>
          {/* JSON reads left to right in every app language, including fa-IR. */}
          <pre className={styles.recordText} dir='ltr'>
            {recorded(card.evidence)}
          </pre>
        </Collapse.Item>
      </Collapse>
    </article>
  );
}
