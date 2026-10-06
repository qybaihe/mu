/**
 * Picking Claude Code and Codex conversations to bring into mu (common/kyrn/importChats.ts): every one found on this
 * computer, under its tool, newest first, with its project folder, date and first message. The chosen ones become mu
 * conversations in the conversation list (with the native host on, the mu sessions themselves); one alone opens right
 * away. The settings dialogs' frame (AionModal's
 * standard variant, as the theme and MCP import dialogs): the title at the start, hairlines between title, body and
 * buttons.
 */
import { Button, Checkbox, Input, Message, Spin } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { TFunction } from 'i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { groupChats, IMPORT_TOOL_NAMES, type FoundChat, type ImportOutcome } from '@/common/kyrn/importChats';
import AionModal from '@/renderer/components/base/AionModal';
import { emitter } from '@/renderer/utils/emitter';
import { formatByteSize, formatDateTime } from '@/renderer/services/i18n/format';
import { getWorkspaceDisplayName } from '@/renderer/utils/workspace/workspace';
import { muErrorText, toMuError, type MuErrorText } from '@/renderer/pages/settings/KyrnSettings/fields/muError';
import { rereadNativeConversations, useNativeEnabled } from '@/renderer/pages/native/hooks/useNativeConversations';
import { nativeConversationPath } from '@/renderer/pages/native/utils/paths';

type Props = {
  visible: boolean;
  onClose: () => void;
  /**
   * The page stays where it is (the first-run guide, whose choices are not saved yet): nothing opens after an import,
   * and a conversation already imported offers no way to open it.
   */
  stay?: boolean;
};

type State = { phase: 'loading' } | { phase: 'ready'; chats: FoundChat[] } | { phase: 'failed'; error: MuErrorText };

type Failed = Extract<ImportOutcome, { status: 'failed' }>;
type Done = Exclude<ImportOutcome, Failed>;

/** Why one transcript was left out, in the app language. */
function failureText(t: TFunction, outcome: Failed): string {
  switch (outcome.reason) {
    case 'folderMissing':
      return t('mu.importChats.failure.folderMissing', { folder: outcome.detail });
    case 'other':
      return t('mu.importChats.failure.other', { detail: outcome.detail });
    default:
      return t(`mu.importChats.failure.${outcome.reason}`);
  }
}

const ChatRow: React.FC<{
  chat: FoundChat;
  checked: boolean;
  failure?: string;
  onToggle: (path: string) => void;
  onOpen?: (target: { conversationId: string; native?: true }) => void;
}> = ({ chat, checked, failure, onToggle, onOpen }) => {
  const { t, i18n } = useTranslation();
  const listed = Boolean(chat.conversationId);
  const modified = Date.parse(chat.modified);
  const details = [
    chat.cwd ? getWorkspaceDisplayName(chat.cwd, false) : t('mu.importChats.dialog.folderUnknown'),
    Number.isNaN(modified) ? '' : formatDateTime(modified, i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    formatByteSize(chat.size, i18n.language),
  ].filter(Boolean);
  return (
    <div
      className='flex items-start gap-10px px-8px py-8px rd-6px hover:bg-fill-1'
      data-testid='import-chat-row'
      data-path={chat.path}
      title={chat.cwd ? `${chat.cwd}\n${chat.path}` : chat.path}
    >
      <Checkbox
        className='mt-2px'
        checked={checked && !listed}
        disabled={listed}
        onChange={() => onToggle(chat.path)}
        aria-label={chat.title || t('mu.importChats.dialog.noTitle')}
      />
      <div
        className={listed ? 'min-w-0 flex-1' : 'min-w-0 flex-1 cursor-pointer'}
        onClick={() => {
          if (!listed) onToggle(chat.path);
        }}
      >
        <div className='truncate text-14px leading-22px text-t-primary'>
          {chat.title || t('mu.importChats.dialog.noTitle')}
        </div>
        <div className='truncate text-12px leading-18px text-t-tertiary'>{details.join(' · ')}</div>
        {failure ? <div className='text-12px leading-18px text-t-secondary break-words'>{failure}</div> : null}
      </div>
      {listed && chat.conversationId ? (
        <span className='shrink-0 flex items-center gap-8px text-12px leading-22px text-t-tertiary'>
          {t('mu.importChats.dialog.inList')}
          {onOpen ? (
            <Button
              type='text'
              size='mini'
              className='!px-0'
              onClick={() => onOpen({ conversationId: chat.conversationId as string, native: chat.native })}
            >
              {t('mu.importChats.dialog.open')}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
};

/** Where a conversation that holds an import opens: a native one by its session's id, an app one by its own. */
const routeOf = ({ conversationId, native }: { conversationId: string; native?: true }): string =>
  native ? nativeConversationPath(conversationId) : `/conversation/${conversationId}`;

const ImportChatsModal: React.FC<Props> = ({ visible, onClose, stay = false }) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  // With the native host on, the session an import writes is the conversation: no app conversation is made for it.
  const native = useNativeEnabled() === true;
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const [importing, setImporting] = useState(false);
  // Only the latest list answers: one asked for before a close or a reload is dropped.
  const request = useRef(0);

  const load = useCallback(async () => {
    const asked = ++request.current;
    setState({ phase: 'loading' });
    try {
      const { conversations } = unwrap(await kyrnBridge.importList.invoke({ native }));
      if (asked === request.current) setState({ phase: 'ready', chats: conversations });
    } catch (error) {
      if (asked === request.current)
        setState({ phase: 'failed', error: muErrorText(t, i18n.language, toMuError(error)) });
    }
  }, [t, i18n.language, native]);

  useEffect(() => {
    if (!visible) {
      request.current++;
      return;
    }
    setQuery('');
    setSelected(new Set());
    setFailures(new Map());
    void load();
    // A language switch while it is open words the reasons again on the next load, not now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const groups = useMemo(() => (state.phase === 'ready' ? groupChats(state.chats, query) : []), [state, query]);

  const toggle = useCallback((path: string) => {
    setSelected((before) => {
      const next = new Set(before);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const open = useCallback(
    (target: { conversationId: string; native?: true }) => {
      onClose();
      void navigate(routeOf(target));
    },
    [navigate, onClose]
  );

  const start = async () => {
    if (selected.size === 0 || importing) return;
    setImporting(true);
    try {
      const outcomes = unwrap(
        await kyrnBridge.importRun.invoke({ paths: [...selected], locale: i18n.language, native })
      );
      const done = outcomes.filter((outcome): outcome is Done => outcome.status !== 'failed');
      const failed = outcomes.filter((outcome): outcome is Failed => outcome.status === 'failed');
      if (done.length > 0) {
        // The sessions were written by `mu import`, not by the app: the native list is read again to show them.
        if (native) rereadNativeConversations();
        else emitter.emit('chat.history.refresh');
        Message.success(t('mu.importChats.done', { count: done.length }));
      }
      if (failed.length === 0) {
        onClose();
        if (done.length === 1 && !stay) void navigate(routeOf(done[0]));
        return;
      }
      Message.warning(t('mu.importChats.someFailed', { count: failed.length }));
      setFailures(new Map(failed.map((outcome) => [outcome.source, failureText(t, outcome)])));
      setSelected(new Set());
      void load();
    } catch (error) {
      Message.error(muErrorText(t, i18n.language, toMuError(error)).text);
    } finally {
      setImporting(false);
    }
  };

  // Instead of the list, one line where the description starts: what is happening, or why there is nothing to choose.
  const status = (() => {
    if (state.phase === 'loading')
      return (
        <div className='flex items-center gap-8px py-8px text-13px leading-20px text-t-secondary'>
          <Spin size={16} />
          {t('mu.importChats.dialog.loading')}
        </div>
      );
    if (state.phase === 'failed')
      return (
        <div className='flex flex-col items-start gap-8px py-8px' role='alert'>
          <span className='text-13px leading-20px text-t-primary'>{state.error.text}</span>
          {state.error.detail ? (
            <pre className='m-0 max-w-full whitespace-pre-wrap break-words text-12px text-t-tertiary'>
              {state.error.detail}
            </pre>
          ) : null}
          <Button size='small' onClick={() => void load()}>
            {t('mu.importChats.dialog.retry')}
          </Button>
        </div>
      );
    if (state.chats.length === 0)
      return <p className='m-0 py-8px text-13px leading-20px text-t-secondary'>{t('mu.importChats.dialog.empty')}</p>;
    if (groups.length === 0)
      return <p className='m-0 py-8px text-13px leading-20px text-t-secondary'>{t('mu.importChats.dialog.noMatch')}</p>;
    return null;
  })();
  // A search box only once there is something to search.
  const searchable = state.phase === 'ready' && state.chats.length > 0;

  return (
    <AionModal
      variant='standard'
      header={{ title: t('mu.importChats.dialog.title'), showClose: true }}
      visible={visible}
      onCancel={onClose}
      style={{ width: 720 }}
      footer={{
        render: () => (
          <div className='flex items-center justify-between gap-12px'>
            <span className='text-13px text-t-secondary'>
              {selected.size > 0 ? t('mu.importChats.dialog.selected', { count: selected.size }) : ''}
            </span>
            <span className='flex gap-10px'>
              <Button onClick={onClose} className='px-20px min-w-80px' style={{ borderRadius: 8 }}>
                {t('common.cancel')}
              </Button>
              <Button
                type='primary'
                loading={importing}
                disabled={selected.size === 0}
                onClick={() => void start()}
                className='px-20px min-w-80px'
                style={{ borderRadius: 8 }}
                data-testid='import-chats-start'
              >
                {importing ? t('mu.importChats.dialog.importing') : t('mu.importChats.dialog.import')}
              </Button>
            </span>
          </div>
        ),
      }}
    >
      <div className='flex flex-col gap-12px' data-testid='import-chats-body'>
        <p className='m-0 text-13px leading-20px text-t-secondary' style={{ textWrap: 'balance' }}>
          {t('mu.importChats.dialog.hint')}
        </p>
        {searchable ? (
          <Input allowClear value={query} onChange={setQuery} placeholder={t('mu.importChats.dialog.search')} />
        ) : null}
        {status ?? (
          // The rows reach 8px past the column on both sides: their hover fills a little beyond the words, which line
          // up with the description.
          <div className='max-h-[52vh] overflow-y-auto -mx-8px' data-testid='import-chats-list'>
            {groups.map((group) => (
              <section
                key={group.tool}
                className='flex flex-col'
                data-testid='import-chat-group'
                data-tool={group.tool}
              >
                <h3 className='m-0 px-8px pt-12px pb-4px text-12px font-600 leading-18px text-t-secondary'>
                  {IMPORT_TOOL_NAMES[group.tool]}
                  <span className='ms-6px font-400 text-t-tertiary'>{group.chats.length}</span>
                </h3>
                {group.chats.map((chat) => (
                  <ChatRow
                    key={chat.path}
                    chat={chat}
                    checked={selected.has(chat.path)}
                    failure={failures.get(chat.path)}
                    onToggle={toggle}
                    onOpen={stay ? undefined : open}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </AionModal>
  );
};

export default ImportChatsModal;
