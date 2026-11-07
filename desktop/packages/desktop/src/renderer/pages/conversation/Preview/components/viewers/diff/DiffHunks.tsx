/**
 * The hunks of a source-tab diff, staged or taken out of the index one at a time (docs/native-host-ui.md): each hunk's
 * header row offers to stage it (an unstaged diff) or to unstage it (a staged one). The main process reads the diff
 * again and applies the hunk only if it is still in it (common/kyrn/gitBridge.ts `hunk`); the diff it answers, as the
 * file is now, takes this one's place. A hunk that is gone (the file changed since) changes nothing: the diff is read
 * again and the person is told. Nothing is discarded: the working tree is never touched.
 *
 * The diff is diff2html's markup (line by line), not React's: the buttons are drawn into its hunk header rows, again
 * whenever the diff is drawn again.
 */
import { Button, Message } from '@arco-design/web-react';
import { Minus, Plus } from '@icon-park/react';
import type { TFunction } from 'i18next';
import React, { useLayoutEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import { kyrnGitBridge, type FolderGitDiff } from '@/common/kyrn/gitBridge';
import type { PreviewMetadata } from '../../../context/PreviewContext';
import styles from './DiffComments.module.css';

export type DiffHunkSource = NonNullable<PreviewMetadata['gitHunks']>;

/** A file's diff as the preview shows it: the patch, or a line that says why there is none, or that it was cut. */
export function diffBody(diff: FolderGitDiff, t: TFunction): string {
  if (diff.binary) return t('conversation.explorer.scm.diff.binary');
  if (!diff.patch) return t('conversation.explorer.scm.diff.empty');
  // A diff the cap cut ends with a line that says so, where the reader's eye stops.
  return diff.truncated ? `${diff.patch} ${t('conversation.explorer.scm.diff.truncated')}\n` : diff.patch;
}

/** A patch's hunks, each from its `@@` line, every line with its end, in the order diff2html draws them. */
export function hunksOfPatch(patch: string): string[] {
  const hunks: string[] = [];
  for (const line of patch.split(/(?<=\n)/)) {
    if (line.startsWith('@@')) hunks.push(line);
    else if (hunks.length) hunks[hunks.length - 1] += line;
  }
  return hunks;
}

/** The header rows of the hunks diff2html drew (line by line), top to bottom. */
const headerRows = (diff: HTMLElement): HTMLTableRowElement[] =>
  Array.from(diff.querySelectorAll<HTMLTableRowElement>('tr')).filter((row) => {
    const code = row.querySelector('td.d2h-code-linenumber')?.nextElementSibling;
    return Boolean(code?.classList.contains('d2h-info') && code.textContent?.trim().startsWith('@@'));
  });

export type DiffHunksProps = {
  /** The element diff2html's markup is drawn in. */
  diff: HTMLElement | null;
  /** The markup drawn, to know when it was drawn again. */
  drawn: string;
  /** The line-by-line view of a diff whose hunks can be staged; off, nothing is added to the diff. */
  enabled: boolean;
  /** The diff's text, whose hunks the buttons send. */
  patch: string;
  source?: DiffHunkSource;
  /** The file's diff as it is now, after a hunk was staged or unstaged, or read again. */
  onChanged: (diff: FolderGitDiff) => void;
};

export default function DiffHunks({ diff, drawn, enabled, patch, source, onChanged }: DiffHunksProps) {
  const { t } = useTranslation();
  const [message, messageHolder] = Message.useMessage();
  const [holders, setHolders] = useState<HTMLElement[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const hunks = useMemo(() => hunksOfPatch(patch), [patch]);
  const on = enabled && Boolean(diff && source);

  // A place for the button at the end of each hunk's header row, in the diff as it is drawn now. Drawn otherwise than
  // the patch reads (another count of hunks): no buttons, rather than one on the wrong hunk.
  useLayoutEffect(() => {
    if (!diff || !on) {
      setHolders([]);
      return undefined;
    }
    const rows = headerRows(diff);
    if (rows.length !== hunks.length) {
      setHolders([]);
      return undefined;
    }
    const made = rows.map((row) => {
      const holder = document.createElement('span');
      holder.className = styles.hunkActions;
      (row.querySelector('td.d2h-info .d2h-code-line') ?? row.querySelector('td.d2h-info'))?.append(holder);
      return holder;
    });
    setHolders(made);
    return () => {
      for (const holder of made) holder.remove();
    };
  }, [diff, drawn, hunks, on]);

  const act = async (index: number) => {
    if (!source || busy !== null) return;
    setBusy(index);
    try {
      const done = await kyrnGitBridge.hunk.invoke({ ...source, hunk: hunks[index] });
      if (!('error' in done)) {
        onChanged(done.data);
        return;
      }
      if (done.code !== 'stale') {
        message.error?.(t('preview.diffHunk.failed', { reason: done.error }));
        return;
      }
      // The file changed since: show it as it is now, and say why nothing was staged.
      message.warning?.(t('preview.diffHunk.stale'));
      const now = await kyrnGitBridge.diff.invoke({ ...source });
      if (!('error' in now)) onChanged(now.data);
    } catch (failure) {
      message.error?.(
        t('preview.diffHunk.failed', { reason: failure instanceof Error ? failure.message : String(failure) })
      );
    } finally {
      setBusy(null);
    }
  };

  if (!source) return null;
  const staging = source.area === 'unstaged';
  const label = staging ? t('preview.diffHunk.stage') : t('preview.diffHunk.unstage');
  return (
    <>
      {messageHolder}
      {holders.map((holder, index) =>
        ReactDOM.createPortal(
          <Button
            type='text'
            size='mini'
            className={styles.hunkAction}
            icon={staging ? <Plus size={12} /> : <Minus size={12} />}
            loading={busy === index}
            disabled={busy !== null && busy !== index}
            title={label}
            data-testid='diff-hunk-action'
            data-hunk={index}
            data-action={staging ? 'stage' : 'unstage'}
            onClick={() => void act(index)}
          >
            {label}
          </Button>,
          holder,
          `hunk-${index}`
        )
      )}
    </>
  );
}
