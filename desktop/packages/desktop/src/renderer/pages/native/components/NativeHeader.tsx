/**
 * The top of a native conversation: its title, the project folder it works in, and how its mu is (starting, running,
 * without a model, stopped). A mu that has not started yet says nothing: the next message starts it.
 *
 * The title is renamed where it stands, as a classic conversation's is: a click (or Enter) makes it a field, Enter or
 * leaving the field saves, Esc leaves it as it was. The new name comes back as the conversation's change, which the
 * header and the sidebar row both show; a refused one keeps the field open and says so.
 */
import { Input, Message } from '@arco-design/web-react';
import { FolderOpen } from '@icon-park/react';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeConversation, NativeHostStatus, NativeResult } from '@/common/kyrn/nativeBridge';
import { iconColors } from '@/renderer/styles/colors';
import { folderName } from '../utils/paths';

const DOT: Record<NativeHostStatus['phase'], string> = {
  idle: iconColors.disabled,
  starting: iconColors.warning,
  running: iconColors.success,
  'needs-model': iconColors.warning,
  failed: iconColors.danger,
};

const PHASE_KEY: Record<NativeHostStatus['phase'], string> = {
  idle: 'mu.native.phase.idle',
  starting: 'mu.native.phase.starting',
  running: 'mu.native.phase.running',
  'needs-model': 'mu.native.phase.needsModel',
  failed: 'mu.native.phase.failed',
};

/** As long as a classic conversation's title may be. */
const TITLE_LENGTH = 120;

/** The title, and the field it becomes while the person renames the conversation. */
const Title: React.FC<{ name: string; onRename?: (name: string) => Promise<NativeResult<void>> }> = ({
  name,
  onRename,
}) => {
  const { t } = useTranslation();
  const title = name || t('mu.native.untitled');
  // The name being written; none while the title is not being renamed.
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  // Enter and leaving the field both save: once. Esc leaves without saving.
  const done = useRef(false);

  const start = () => {
    if (!onRename) return;
    done.current = false;
    setDraft(name);
  };
  const cancel = () => {
    done.current = true;
    setDraft(undefined);
  };
  const save = async () => {
    if (done.current || draft === undefined || !onRename) return;
    const next = draft.trim();
    if (!next || next === name.trim()) {
      cancel();
      return;
    }
    done.current = true;
    setSaving(true);
    const result = await onRename(next).catch(
      (error: unknown): NativeResult<void> => ({ ok: false, kind: 'failed', message: String(error) })
    );
    setSaving(false);
    if (result.ok) {
      setDraft(undefined);
      Message.success(t('conversation.history.renameSuccess'));
      return;
    }
    done.current = false;
    Message.error(t('conversation.history.renameFailed'));
  };

  if (draft !== undefined)
    return (
      <Input
        autoFocus
        size='small'
        value={draft}
        disabled={saving}
        maxLength={TITLE_LENGTH}
        className='w-320px max-w-full min-w-0 [&_.arco-input]:text-15px [&_.arco-input]:font-500'
        placeholder={t('conversation.history.renamePlaceholder')}
        onChange={setDraft}
        onFocus={(event) => event.target.select()}
        onPressEnter={() => void save()}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }}
        data-testid='native-header-title-input'
      />
    );
  return (
    <h1 className='m-0 min-w-0 truncate text-15px leading-22px font-500 text-t-primary' title={title}>
      {onRename ? (
        <span
          role='button'
          tabIndex={0}
          className='block min-w-0 truncate cursor-text rd-6px px-4px -mx-4px hover:bg-fill-2 focus-visible:bg-fill-2 focus-visible:outline-none'
          data-testid='native-header-title'
          onClick={start}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            start();
          }}
        >
          {title}
        </span>
      ) : (
        title
      )}
    </h1>
  );
};

const NativeHeader: React.FC<{
  conversation?: NativeConversation;
  host: NativeHostStatus;
  /** Renames the conversation; without it the title is not renamed here. */
  onRename?: (name: string) => Promise<NativeResult<void>>;
}> = ({ conversation, host, onRename }) => {
  const { t } = useTranslation();
  return (
    <header
      className='shrink-0 min-h-44px flex items-center justify-between gap-16px px-16px pt-8px pb-10px bg-1'
      data-testid='native-header'
    >
      <div className='min-w-0 flex items-center gap-10px'>
        <Title name={conversation?.title ?? ''} {...(conversation && onRename ? { onRename } : {})} />
        {conversation?.cwd ? (
          <span
            className='min-w-0 flex items-center gap-4px text-12px leading-18px text-t-tertiary'
            title={conversation.cwd}
            data-testid='native-header-folder'
          >
            <FolderOpen theme='outline' size='12' fill={iconColors.secondary} className='shrink-0' />
            <span className='truncate'>{folderName(conversation.cwd)}</span>
          </span>
        ) : null}
      </div>
      <div className='shrink-0 flex items-center gap-10px text-12px leading-18px text-t-secondary'>
        {/* Before mu starts there is nothing to report: sending a message starts it. The words stay for screen readers. */}
        <span
          className={host.phase === 'idle' ? 'sr-only' : 'flex items-center gap-6px'}
          data-testid='native-header-phase'
          data-phase={host.phase}
        >
          <span className='size-6px rd-full' style={{ background: DOT[host.phase] }} aria-hidden='true' />
          {t(PHASE_KEY[host.phase])}
        </span>
      </div>
    </header>
  );
};

export default NativeHeader;
