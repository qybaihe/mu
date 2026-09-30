/**
 * What the screen says about mu itself, above the send box: that it has no model to answer with (and the way to the
 * page where one is set up), that it stopped (why, and its last output), or that the last thing asked of it failed
 * for a reason the transcript cannot show. The failure's own message, plain English, goes under the sentence.
 */
import { Button } from '@arco-design/web-react';
import { Attention, Close } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { NativeFailure, NativeHostStatus } from '@/common/kyrn/nativeBridge';
import { iconColors } from '@/renderer/styles/colors';
import { errorKey } from '../utils/errorWords';

const CARD = 'rd-12px border border-solid border-[var(--color-border-2)] bg-1 p-12px flex items-start gap-8px';

const Detail: React.FC<{ text?: string; testId?: string }> = ({ text, testId }) =>
  text ? (
    <div
      className='text-12px leading-18px text-t-tertiary whitespace-pre-wrap [word-break:break-word]'
      data-testid={testId}
    >
      {text}
    </div>
  ) : null;

/** mu runs without a model: the guide's job, said as the transcript says it. */
const NoModel: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const page = t('mu.sections.providers');
  return (
    <div className={CARD} data-testid='native-needs-model'>
      <Attention theme='filled' size='16' fill={iconColors.warning} className='m-t-2px shrink-0' />
      <div className='flex-1 min-w-0 flex flex-col gap-6px'>
        <div className='text-14px font-500 text-t-primary'>{t('mu.noModel.title')}</div>
        <div className='text-13px leading-20px text-t-secondary'>
          {t('mu.noModel.body', { place: `${t('common.settings')} › ${page}` })}
        </div>
        <div className='flex justify-end'>
          <Button type='primary' size='small' onClick={() => void navigate('/settings/providers')}>
            {t('mu.noModel.open', { page })}
          </Button>
        </div>
      </div>
    </div>
  );
};

/** mu stopped unasked: why, its last output, and that the next message starts it again. */
const Stopped: React.FC<{ error: { kind: NativeFailure['kind']; message: string; stderr: string } }> = ({ error }) => {
  const { t } = useTranslation();
  return (
    <div className={CARD} data-testid='native-failed' data-kind={error.kind}>
      <Attention theme='filled' size='16' fill={iconColors.danger} className='m-t-2px shrink-0' />
      <div className='flex-1 min-w-0 flex flex-col gap-6px'>
        <div className='text-14px font-500 text-t-primary'>{t(errorKey(error.kind))}</div>
        <Detail text={error.message} />
        {error.stderr ? (
          <details className='text-12px text-t-tertiary'>
            <summary className='cursor-pointer select-none'>{t('mu.native.host.output')}</summary>
            <pre className='m-0 mt-6px max-h-160px overflow-auto whitespace-pre-wrap [word-break:break-word] text-11px leading-16px'>
              {error.stderr}
            </pre>
          </details>
        ) : null}
        <div className='text-12px leading-18px text-t-secondary'>{t('mu.native.host.restartHint')}</div>
      </div>
    </div>
  );
};

/** The last command that failed, until the person closes it or sends again. */
const CommandFailed: React.FC<{ failure: NativeFailure; onClose: () => void }> = ({ failure, onClose }) => {
  const { t } = useTranslation();
  return (
    <div className={CARD} role='alert' data-testid='native-command-failed' data-kind={failure.kind}>
      <Attention theme='filled' size='16' fill={iconColors.danger} className='m-t-2px shrink-0' />
      <div className='flex-1 min-w-0 flex flex-col gap-4px'>
        <div className='text-13px font-500 text-t-primary'>{t(errorKey(failure.kind))}</div>
        <Detail text={failure.message} />
      </div>
      <Button
        type='text'
        size='mini'
        icon={<Close theme='outline' size='12' />}
        aria-label={t('common.close')}
        onClick={onClose}
      />
    </div>
  );
};

const NativeHostNotice: React.FC<{
  host: NativeHostStatus;
  commandFailure?: NativeFailure;
  onClearFailure: () => void;
}> = ({ host, commandFailure, onClearFailure }) => {
  const notices: React.ReactNode[] = [];
  if (host.phase === 'needs-model') notices.push(<NoModel key='model' />);
  if (host.phase === 'failed') notices.push(<Stopped key='failed' error={host.error} />);
  // A command that failed because the host stopped says what the host's own card already says: one card, not two.
  const saidByHost =
    host.phase === 'failed' &&
    commandFailure?.kind === host.error.kind &&
    commandFailure.message === host.error.message;
  if (commandFailure && !saidByHost) {
    notices.push(<CommandFailed key='command' failure={commandFailure} onClose={onClearFailure} />);
  }
  if (!notices.length) return null;
  return <div className='flex flex-col gap-8px mb-8px'>{notices}</div>;
};

export default NativeHostNotice;
