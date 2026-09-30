/**
 * The files tab of a native conversation: the folder it works in, as a tree read through the main process one
 * directory at a time (common/kyrn/folderBridge.ts). A native conversation has no AionCore project, so the project
 * explorer cannot show it. The tree is read when the tab comes into view, after every run of the conversation
 * (`refresh` changes) and when asked; a file opens in the preview, as a file named in a message does. The source
 * control view is the folder's repository, read with git by the main process (`NativeSource`).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@arco-design/web-react';
import { Down, Refresh, Right } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { unwrap } from '@/common/kyrn/bridge';
import { kyrnFolderBridge, type FolderEntry } from '@/common/kyrn/folderBridge';
import { useLocalFilePreview } from '@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview';
import NativeSource from '@/renderer/pages/native/components/NativeSource';
import FileTypeIcon from './fileIcon/FileTypeIcon';
import type { ExplorerView } from './ExplorerContainer';

type Listing = { entries: FolderEntry[]; more: number } | { error: string };

const INDENT_PX = 14;

/** The last name of a path, `/` or `\` between names. */
const folderName = (path: string): string =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) || path;

/** A path inside the folder as a full path, with the folder's own separator. */
const fullPath = (folder: string, path: string): string => {
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${separator}${path.split('/').join(separator)}`;
};

export default function FolderFiles({
  cwd,
  view,
  visible,
  refresh,
}: {
  cwd: string;
  view: ExplorerView;
  /** The tab is the one the open panel shows: nothing is read while it is not. */
  visible: boolean;
  /** Changes when the tree should be read again (a run of the conversation ended). */
  refresh: string;
}) {
  const { t } = useTranslation();
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(() => new Map());
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const openRef = useRef(open);
  openRef.current = open;
  const preview = useLocalFilePreview(cwd);

  const read = useCallback(
    async (path: string) => {
      let listing: Listing;
      try {
        listing = unwrap(await kyrnFolderBridge.files.invoke({ cwd, path }));
      } catch (error) {
        listing = { error: error instanceof Error ? error.message : String(error) };
      }
      setListings((old) => new Map(old).set(path, listing));
    },
    [cwd]
  );

  // The folder and every open directory, afresh.
  const readAll = useCallback(() => {
    void read('');
    for (const path of openRef.current) void read(path);
  }, [read]);

  useEffect(() => {
    if (visible && view === 'files') readAll();
  }, [readAll, refresh, view, visible]);

  const toggle = (path: string) => {
    const opening = !open.has(path);
    setOpen((old) => {
      const next = new Set(old);
      if (!next.delete(path)) next.add(path);
      return next;
    });
    if (opening) void read(path);
  };

  if (view === 'changes') return <NativeSource key={cwd} cwd={cwd} visible={visible} refresh={refresh} />;

  const rows = (path: string, depth: number): React.ReactNode => {
    const listing = listings.get(path);
    const pad = { paddingInlineStart: 8 + depth * INDENT_PX };
    if (!listing) return null;
    if ('error' in listing)
      return (
        <li
          className='py-4px text-12px text-t-tertiary'
          style={pad}
          data-testid='native-files-failed'
          title={listing.error}
        >
          {t('mu.native.panel.files.failed')}
        </li>
      );
    if (!listing.entries.length && depth === 0)
      return (
        <li className='py-4px text-12px text-t-tertiary' style={pad} data-testid='native-files-empty'>
          {t('mu.native.panel.files.empty')}
        </li>
      );
    return (
      <>
        {listing.entries.map((entry) => {
          const expanded = entry.kind === 'dir' && open.has(entry.path);
          return (
            <React.Fragment key={entry.path}>
              <li>
                <button
                  type='button'
                  className='w-full flex items-center gap-4px h-26px pe-8px border-none bg-transparent rd-4px text-13px text-t-primary text-start cursor-pointer hover:bg-fill-2'
                  style={pad}
                  title={entry.path}
                  aria-expanded={entry.kind === 'dir' ? expanded : undefined}
                  data-testid='native-file'
                  data-kind={entry.kind}
                  data-path={entry.path}
                  onClick={() => (entry.kind === 'dir' ? toggle(entry.path) : void preview(fullPath(cwd, entry.path)))}
                >
                  <span className='inline-flex w-12px flex-shrink-0 text-t-tertiary'>
                    {entry.kind === 'dir' ? (
                      expanded ? (
                        <Down size={12} />
                      ) : (
                        <Right size={12} className='rtl-mirror' />
                      )
                    ) : null}
                  </span>
                  <FileTypeIcon
                    node={{ name: entry.name, relativePath: entry.path, isFile: entry.kind === 'file' }}
                    expanded={expanded}
                  />
                  {/* File names are code-like; bidi-neutral leading dots (.claude) must not flip under RTL. */}
                  <span dir='ltr' className='min-w-0 overflow-hidden text-ellipsis whitespace-nowrap'>
                    {entry.name}
                  </span>
                </button>
              </li>
              {expanded ? rows(entry.path, depth + 1) : null}
            </React.Fragment>
          );
        })}
        {listing.more > 0 ? (
          <li className='py-4px text-12px text-t-tertiary' style={pad}>
            {t('mu.native.panel.files.more', { count: listing.more })}
          </li>
        ) : null}
      </>
    );
  };

  return (
    <section
      className='h-full min-h-0 flex flex-col'
      data-testid='native-files'
      aria-label={t('mu.native.panel.files.label', { folder: folderName(cwd) })}
    >
      <div
        className='flex items-center gap-6px px-12px h-32px flex-shrink-0'
        style={{ borderBottom: '1px solid var(--color-border-2)' }}
      >
        <span
          className='min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-12px font-500 text-t-secondary'
          dir='ltr'
          title={cwd}
        >
          {folderName(cwd)}
        </span>
        <Button
          type='text'
          size='mini'
          icon={<Refresh size={14} />}
          aria-label={t('mu.native.panel.files.refresh')}
          title={t('mu.native.panel.files.refresh')}
          data-testid='native-files-refresh'
          onClick={readAll}
        />
      </div>
      <ul className='m-0 p-4px list-none flex-1 min-h-0 overflow-y-auto'>{rows('', 0)}</ul>
    </section>
  );
}
