/**
 * Quick open (Cmd/Ctrl+P): a file of the open conversation's folder by its name, into the work panel's preview. The
 * folder is the native conversation's (its `cwd`) or the classic one's workspace. Its files are read each time the
 * box opens (common/kyrn/folderBridge.ts `find`: git's list in a repository, else a bounded walk), and a query ranks
 * them as it is typed (quickOpenModel.ts). Enter or a click opens the file and closes the box; Esc closes it.
 */
import { Input, Modal } from '@arco-design/web-react';
import { Search } from '@icon-park/react';
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { kyrnFolderBridge, type FolderFiles } from '@/common/kyrn/folderBridge';
import { useIndexedItemRefs } from '@/renderer/hooks/ui/useIndexedItemRefs';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { useOptionalLocalFilePreview } from '@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { useNativeFolder } from '@/renderer/pages/native/utils/nativeActivityStore';
import { emitter, useAddEventListener } from '@/renderer/utils/emitter';
import { usePaletteNavigation } from './usePaletteNavigation';
import styles from './CommandPalette.module.css';
import { rankFiles, type QuickOpenRow } from './quickOpenModel';

/** The same veil as the command palette's. */
const MASK_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--mu-scrim, color-mix(in srgb, var(--color-mask-bg) 30%, transparent))',
};

/** Characters of `text` the query matched, underlined as the palette underlines them. */
const Underlined: React.FC<{ text: string; hits: number[] }> = ({ text, hits }) => {
  if (!hits.length) return <>{text}</>;
  const marked = new Set(hits);
  return (
    <>
      {Array.from(text).map((char, index) =>
        marked.has(index) ? (
          <span key={index} className={styles.hit} data-hit=''>
            {char}
          </span>
        ) : (
          <React.Fragment key={index}>{char}</React.Fragment>
        )
      )}
    </>
  );
};

type Listing = { state: 'loading' } | { state: 'ready'; files: FolderFiles } | { state: 'failed' };

/** The folder of the conversation on screen: a native one's `cwd`, else the classic one's workspace, once read. */
function useConversationFolder(open: boolean): string | undefined {
  const conversationId = useCurrentConversation();
  const nativeFolder = useNativeFolder(conversationId);
  // The same key as the conversation page's, so an open conversation is read from its cache.
  const { data } = useSWR(open && conversationId && !nativeFolder ? `conversation/${conversationId}` : null, () =>
    getConversationOrNull(conversationId as string)
  );
  const workspace = (data?.extra as { workspace?: string } | undefined)?.workspace;
  return nativeFolder ?? (workspace || undefined);
}

const QuickOpenPanel: React.FC<{ folder: string; onPick: (path: string) => void }> = ({ folder, onPick }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  const listId = useId();

  useEffect(() => {
    let current = true;
    setListing({ state: 'loading' });
    kyrnFolderBridge.find
      .invoke({ cwd: folder })
      .then((result) => {
        if (current) setListing(result.ok ? { state: 'ready', files: result.data } : { state: 'failed' });
      })
      .catch(() => {
        if (current) setListing({ state: 'failed' });
      });
    return () => {
      current = false;
    };
  }, [folder]);

  const paths = listing.state === 'ready' ? listing.files.paths : undefined;
  const rows = useMemo(() => (paths ? rankFiles(paths, query) : []), [paths, query]);
  const run = useCallback((row: QuickOpenRow) => onPick(row.path), [onPick]);
  const { activeIndex, setActiveIndex, onKeyDown } = usePaletteNavigation(rows, query, run);
  const { itemRefs, setItemRef } = useIndexedItemRefs<HTMLDivElement>(rows.length);
  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, itemRefs]);

  const title = t('common.quickOpen.title');
  const note =
    listing.state === 'loading'
      ? t('common.quickOpen.loading')
      : listing.state === 'failed'
        ? t('common.quickOpen.failed')
        : rows.length === 0
          ? t('common.commandPalette.empty')
          : undefined;

  return (
    <div data-testid='quick-open'>
      <div className={styles.field}>
        <Input
          autoFocus
          value={query}
          onChange={setQuery}
          onKeyDown={onKeyDown}
          placeholder={t('common.quickOpen.placeholder')}
          prefix={<Search theme='outline' size='16' fill='currentColor' />}
          role='combobox'
          aria-label={title}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete='list'
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        />
      </div>
      <div id={listId} role='listbox' aria-label={title} className={styles.list}>
        {rows.map((row, index) => (
          <div
            key={row.path}
            ref={setItemRef(index)}
            id={`${listId}-${index}`}
            role='option'
            aria-selected={index === activeIndex}
            title={row.path}
            className={styles.row}
            data-path={row.path}
            onMouseMove={() => {
              if (index !== activeIndex) setActiveIndex(index);
            }}
            // The input keeps the focus, so the keys keep working after a click.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(row)}
          >
            <span className={styles.label} dir='ltr'>
              <Underlined text={row.name} hits={row.nameHits} />
            </span>
            {row.dir ? (
              <span className={styles.detail} dir='ltr'>
                <Underlined text={row.dir.replace(/\/$/, '')} hits={row.dirHits} />
              </span>
            ) : null}
          </div>
        ))}
        {note ? <div className={styles.empty}>{note}</div> : null}
        {listing.state === 'ready' && listing.files.more ? (
          <div className={styles.hint}>{t('common.quickOpen.more')}</div>
        ) : null}
      </div>
    </div>
  );
};

/** Open the box, or close it when it is open. */
export const toggleQuickOpen = (): void => {
  emitter.emit('quickOpen.toggle');
};

const QuickOpen: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const folder = useConversationFolder(open);
  const openFile = useOptionalLocalFilePreview(folder);

  useAddEventListener('quickOpen.toggle', () => setOpen((value) => !value), []);

  const pick = useCallback(
    (path: string) => {
      setOpen(false);
      void openFile?.(path);
    },
    [openFile]
  );

  return (
    <Modal
      visible={open}
      onCancel={() => setOpen(false)}
      title={null}
      footer={null}
      closable={false}
      alignCenter={false}
      unmountOnExit
      className={styles.palette}
      wrapClassName={styles.wrap}
      maskStyle={MASK_STYLE}
    >
      {folder ? (
        <QuickOpenPanel folder={folder} onPick={pick} />
      ) : (
        <div className={styles.empty} data-testid='quick-open-no-folder'>
          {t('common.quickOpen.noFolder')}
        </div>
      )}
    </Modal>
  );
};

export default QuickOpen;
