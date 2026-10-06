import React, { useMemo, useState } from 'react';
import { Button, Collapse, Pagination, Tag } from '@arco-design/web-react';
import { Terminal } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { HiveBee } from '@/common/kyrn/hive';
import type { Activity } from '@/common/kyrn/types';
import { useModelNames } from '@/renderer/hooks/agent/useModelNames';
import { beeRecords } from './activity';
import BeeAvatar from './BeeAvatar';
import { beeErrorText } from './codes';
import { beeModel, beeRole } from './HiveToolCard';
import styles from './Hive.module.css';
import { useClock } from '../clock';
import { beeCounters, ErrorNotice, quietLabel } from '../text';

/** `dir='ltr'` keeps recorded JSON left to right in a right-to-left app language (fa-IR). */
function RecordText({ text, dir }: { text: string; dir?: 'ltr' }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <pre className={styles.recordText} dir={dir}>
        {expanded ? text : text.slice(0, 4000)}
      </pre>
      {text.length > 4000 && (
        <Button type='text' size='mini' onClick={() => setExpanded(!expanded)}>
          {t(expanded ? 'common.collapse' : 'common.more')}
        </Button>
      )}
    </>
  );
}

export default function BeeInspector({ bee, focus, events }: { bee: HiveBee; focus?: string; events: Activity[] }) {
  const { t, i18n } = useTranslation();
  const clock = useClock();
  const names = useModelNames();
  const [page, setPage] = useState(1);
  const records = useMemo(() => beeRecords(events, bee.name).reverse(), [events, bee.name]);
  const status = t(bee.status === 'unknown' ? 'common.kyrn.hiveView.unknown' : `common.kyrn.beeStatus.${bee.status}`);
  return (
    <section className={styles.inspector} aria-label={t('common.kyrn.hiveView.context')}>
      <div className={styles.cardHeader}>
        <BeeAvatar name={bee.name} status={bee.status} />
        <div className='min-w-0 flex-1'>
          <h3 className={styles.beeName}>{bee.name}</h3>
          <div className={styles.hint}>{bee.role && beeRole(t, bee.role)}</div>
        </div>
      </div>
      <div className='flex flex-wrap gap-6px my-8px'>
        <Tag>{status}</Tag>
        <span className={styles.hint}>{beeModel(t, bee, names)}</span>
      </div>
      <p className={styles.hint}>{beeCounters(t, bee)}</p>
      {bee.quietMs > 0 && <p className={styles.hint}>{quietLabel(t, bee.quietMs, i18n.language)}</p>}
      {bee.error && <ErrorNotice title={t('common.kyrn.beeFailed')} detail={beeErrorText(t, bee, i18n.language)} />}
      <div className={styles.current}>
        <div className={styles.sectionLabel}>{t('common.kyrn.hiveView.current')}</div>
        <div className='flex gap-6px items-start'>
          {bee.tool && <Terminal size={16} />}
          <span className={styles.wrap}>{bee.tool?.summary || status}</span>
        </div>
        {bee.said && <p className={styles.said}>{bee.said}</p>}
      </div>
      <Collapse bordered={false} className={styles.collapse}>
        <Collapse.Item name='assignment' header={t('common.kyrn.hiveView.focus')}>
          <RecordText text={focus || t('common.kyrn.hiveView.missingFocus')} />
        </Collapse.Item>
      </Collapse>
      <h4 className={styles.sectionLabel}>{t('common.kyrn.hiveView.records')}</h4>
      <p className={styles.hint}>{t('common.kyrn.hiveView.contextHint')}</p>
      {!records.length && <p className={styles.hint}>{t('common.kyrn.hiveView.noRecords')}</p>}
      <Collapse bordered={false} className={styles.collapse}>
        {records.slice((page - 1) * 20, page * 20).map((entry) => (
          <Collapse.Item
            key={entry.id}
            name={entry.id}
            header={
              <div className='min-w-0'>
                <div className={styles.wrap}>
                  {entry.name || t(`common.kyrn.hiveView.${entry.kind}`)}
                  {entry.error && <span className='text-danger'> · {t('common.failed')}</span>}
                </div>
                <div className={styles.hint}>{t('common.kyrn.hiveView.recordedAt', { time: clock(entry.at) })}</div>
              </div>
            }
          >
            {entry.input && (
              <>
                <div className={styles.sectionLabel}>{t('common.kyrn.hiveView.input')}</div>
                <RecordText text={entry.input} dir='ltr' />
              </>
            )}
            {entry.kind === 'tool' && <div className={styles.sectionLabel}>{t('common.kyrn.hiveView.output')}</div>}
            <RecordText
              text={
                entry.text || t(entry.complete ? 'common.kyrn.hiveView.noText' : 'common.kyrn.hiveView.waitingOutput')
              }
            />
          </Collapse.Item>
        ))}
      </Collapse>
      {records.length > 20 && (
        <Pagination simple current={page} total={records.length} pageSize={20} onChange={setPage} />
      )}
    </section>
  );
}
