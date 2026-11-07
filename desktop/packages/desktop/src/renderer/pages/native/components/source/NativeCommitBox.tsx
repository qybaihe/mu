/**
 * The commit box at the top of the source tab (docs/native-host-ui.md): a message and a button that commits what is
 * staged, as the person's own git would, hooks included. With nothing staged the button commits every change, new
 * files included, and says so. A merge with conflicts commits nothing until they are resolved. When git refuses (a
 * hook said no, no name to commit as) what it wrote shows under the box, and the message stays.
 *
 * "Let mu commit" sends mu's own `/commit` to the conversation: mu splits the changes into commits, writes their
 * messages, shows the plan above the send box and commits only when the person agrees.
 */
import { Button, Input, Message, Tooltip } from '@arco-design/web-react';
import { Close } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { unwrap } from '@/common/kyrn/bridge';
import { kyrnGitBridge } from '@/common/kyrn/gitBridge';
import { emitter } from '@/renderer/utils/emitter';
import { formatPrimaryEnterShortcut, isPlatformPrimaryModifier } from '@/renderer/utils/ui/keyboardShortcuts';

export type NativeCommitBoxProps = {
  cwd: string;
  /** The conversation the tab is beside: where "Let mu commit" sends `/commit`. Without one, the button is not there. */
  conversationId?: string;
  /** How many changes are staged, and how many there are in all. */
  staged: number;
  changes: number;
  /** A merge has files with conflicts. */
  conflicted: boolean;
  /** Reads the repository again, once the commit is done or refused. */
  read: () => void;
};

export default function NativeCommitBox({
  cwd,
  conversationId,
  staged,
  changes,
  conflicted,
  read,
}: NativeCommitBoxProps) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const all = staged === 0;
  const blocked = conflicted ? t('mu.native.panel.source.commit.conflicts') : undefined;
  const ready = !committing && !conflicted && changes > 0 && message.trim().length > 0;

  const commit = async () => {
    if (!ready) return;
    setCommitting(true);
    setRefusal(undefined);
    try {
      const made = unwrap(await kyrnGitBridge.commit.invoke({ cwd, message, ...(all ? { all: true } : {}) }));
      if (made.committed === false) setRefusal(made.output);
      else {
        setMessage('');
        Message.success(t('mu.native.panel.source.commit.done', { commit: made.commit, subject: made.subject }));
      }
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error));
    } finally {
      setCommitting(false);
      read();
    }
  };

  const askMu = () => {
    if (conversationId) emitter.emit('sendbox.command', '/commit', conversationId);
  };

  const commitButton = (
    <Button
      type='primary'
      size='small'
      loading={committing}
      disabled={!ready}
      onClick={() => void commit()}
      data-testid='native-commit'
      data-all={all ? 'true' : undefined}
    >
      {all ? t('mu.native.panel.source.commit.commitAll') : t('mu.native.panel.source.commit.commit')}
    </Button>
  );

  return (
    <div className='px-8px pt-8px pb-6px flex flex-col gap-6px' data-testid='native-commit-box'>
      <Input.TextArea
        value={message}
        onChange={setMessage}
        autoSize={{ minRows: 1, maxRows: 6 }}
        placeholder={t('mu.native.panel.source.commit.placeholder', { shortcut: formatPrimaryEnterShortcut('Enter') })}
        aria-label={t('mu.native.panel.source.commit.message')}
        disabled={committing}
        data-testid='native-commit-message'
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && isPlatformPrimaryModifier(event.nativeEvent)) {
            event.preventDefault();
            void commit();
          }
        }}
      />
      <div className='flex items-center gap-6px'>
        {blocked || all ? (
          <Tooltip content={blocked ?? t('mu.native.panel.source.commit.commitAllHint')}>
            <span className='inline-flex'>{commitButton}</span>
          </Tooltip>
        ) : (
          commitButton
        )}
        {conversationId ? (
          <Tooltip content={t('mu.native.panel.source.commit.askHint')}>
            <Button size='small' disabled={changes === 0 || committing} onClick={askMu} data-testid='native-commit-ask'>
              {t('mu.native.panel.source.commit.ask')}
            </Button>
          </Tooltip>
        ) : null}
      </div>
      {blocked ? (
        <p className='m-0 text-12px leading-18px text-t-tertiary' data-testid='native-commit-blocked'>
          {blocked}
        </p>
      ) : null}
      {refusal !== undefined ? (
        <div className='rd-4px bg-fill-2 px-8px py-6px' role='alert' data-testid='native-commit-refusal'>
          <div className='flex items-center gap-6px'>
            <span className='flex-1 text-12px font-500 text-danger'>{t('mu.native.panel.source.commit.failed')}</span>
            <Button
              type='text'
              size='mini'
              icon={<Close size={12} />}
              aria-label={t('mu.native.panel.source.commit.dismiss')}
              title={t('mu.native.panel.source.commit.dismiss')}
              onClick={() => setRefusal(undefined)}
            />
          </div>
          <pre
            className='m-0 mt-4px max-h-160px overflow-auto whitespace-pre-wrap break-words text-11px leading-16px text-t-secondary font-mono'
            dir='ltr'
          >
            {refusal}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
