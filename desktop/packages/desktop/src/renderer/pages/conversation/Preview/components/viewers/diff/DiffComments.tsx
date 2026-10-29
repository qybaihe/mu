/**
 * Comments on the lines of a diff, for the next message (docs/native-host-ui.md). The line under the pointer offers a
 * button; it opens a box under the line, and what the person writes there is added to the send box as a chip, with
 * the file, the line and the line itself. Every comment the send box holds for a file of this diff shows under its
 * line, and can be taken back there. Sending the message sends them all, and they leave the diff with it.
 *
 * The diff is diff2html's markup (line by line), not React's: the rows for comments are added to its table here, and
 * the comments drawn into them, again whenever the diff is drawn again.
 */
import { Button, Input } from '@arco-design/web-react';
import { Close, Comment } from '@icon-park/react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import { isPlatformPrimaryModifier } from '@/renderer/utils/ui/keyboardShortcuts';
import { useOptionalPreviewContext, type DomSnippet } from '../../../context/PreviewContext';
import {
  describeDiffComment,
  lastNoteUnder,
  lineOfRow,
  NOTE_ROW_CLASS,
  rowOfLine,
  sameLine,
  type DiffLineAt,
} from './diffLines';
import styles from './DiffComments.module.css';

type Hovered = { line: DiffLineAt; top: number; height: number };
type Slot = { key: string; cell: HTMLTableCellElement };

const EDITOR = 'editor';

export type DiffCommentsProps = {
  /** The element diff2html's markup is drawn in; its parent is where the add button is placed (positioned). */
  diff: HTMLElement | null;
  /** The markup drawn, to know when it was drawn again. */
  drawn: string;
  /** Comments can go on lines (the line-by-line view); off, nothing is added to the diff. */
  enabled: boolean;
};

function CommentEditor({
  line,
  onSave,
  onCancel,
}: {
  line: DiffLineAt;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const save = () => {
    if (draft.trim()) onSave(draft);
  };
  return (
    <div className={styles.note} data-testid='diff-comment-editor' data-line={`${line.file}:${line.line}`}>
      <Input.TextArea
        autoFocus
        autoSize={{ minRows: 2, maxRows: 8 }}
        value={draft}
        placeholder={t('preview.diffComment.placeholder')}
        aria-label={t('preview.diffComment.placeholder')}
        onChange={setDraft}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === 'Enter' && isPlatformPrimaryModifier(event.nativeEvent)) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className={styles.editorFooter}>
        <span className={styles.hint}>{t('preview.diffComment.hint')}</span>
        <div className={styles.actions}>
          <Button size='mini' onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button size='mini' type='primary' disabled={!draft.trim()} onClick={save} data-testid='diff-comment-save'>
            {t('preview.diffComment.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CommentCard({ snippet, onRemove }: { snippet: DomSnippet; onRemove: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className={`${styles.note} ${styles.comment}`} data-testid='diff-comment'>
      <Comment className={styles.commentIcon} size={14} aria-hidden='true' />
      <span className={styles.commentText}>{snippet.comment?.text}</span>
      <Button
        type='text'
        size='mini'
        className={styles.remove}
        icon={<Close size={12} />}
        aria-label={t('preview.diffComment.remove')}
        title={t('preview.diffComment.remove')}
        onClick={() => onRemove(snippet.id)}
      />
    </div>
  );
}

export default function DiffComments({ diff, drawn, enabled }: DiffCommentsProps) {
  const { t } = useTranslation();
  const preview = useOptionalPreviewContext();
  const snippets = preview?.domSnippets;
  const addDomSnippet = preview?.addDomSnippet;
  const removeDomSnippet = preview?.removeDomSnippet;
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [editing, setEditing] = useState<DiffLineAt | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const on = enabled && Boolean(diff && addDomSnippet);

  // The comments the send box holds on lines of this diff, in the order they were written.
  const comments = useMemo(() => (snippets ?? []).filter((snippet) => snippet.comment), [snippets]);

  // The line under the pointer offers the button; over the button itself, it stays.
  useEffect(() => {
    const frame = diff?.parentElement;
    if (!diff || !frame || !on) {
      setHovered(null);
      return;
    }
    const onMove = (event: MouseEvent) => {
      const row = (event.target as Element | null)?.closest?.('tr');
      if (!row || !diff.contains(row)) return;
      const line = lineOfRow(row);
      if (!line) {
        setHovered(null);
        return;
      }
      const box = row.getBoundingClientRect();
      const top = box.top - frame.getBoundingClientRect().top;
      setHovered((old) =>
        old && sameLine(old.line, line) && old.top === top ? old : { line, top, height: box.height }
      );
    };
    const onLeave = () => setHovered(null);
    frame.addEventListener('mousemove', onMove);
    frame.addEventListener('mouseleave', onLeave);
    return () => {
      frame.removeEventListener('mousemove', onMove);
      frame.removeEventListener('mouseleave', onLeave);
    };
  }, [diff, on, drawn]);

  // Another diff: the comment being written goes with the old one.
  useEffect(() => setEditing(null), [drawn]);

  // A row under each commented line, and one for the comment being written, added to the diff as it is drawn now.
  useLayoutEffect(() => {
    const added: HTMLTableRowElement[] = [];
    const next: Slot[] = [];
    if (diff && on) {
      const place = (key: string, at: Omit<DiffLineAt, 'kind' | 'text'>) => {
        const row = rowOfLine(diff, at);
        if (!row) return;
        const after = lastNoteUnder(row);
        const note = document.createElement('tr');
        note.className = NOTE_ROW_CLASS;
        note.dataset.note = key;
        const cell = document.createElement('td');
        cell.colSpan = 2;
        note.append(cell);
        after.after(note);
        added.push(note);
        next.push({ key, cell });
      };
      for (const snippet of comments) if (snippet.comment) place(snippet.id, snippet.comment);
      if (editing) place(EDITOR, editing);
    }
    setSlots(next);
    return () => {
      for (const note of added) note.remove();
    };
  }, [comments, diff, drawn, editing, on]);

  const save = useCallback(
    (text: string) => {
      if (!editing || !addDomSnippet) return;
      const said = describeDiffComment(editing, text);
      addDomSnippet(said.label, said.code, said.about, {
        fence: 'diff',
        comment: { file: editing.file, side: editing.side, line: editing.line, text: text.trim() },
      });
      setEditing(null);
    },
    [addDomSnippet, editing]
  );

  if (!on) return null;
  const byId = new Map(comments.map((snippet) => [snippet.id, snippet]));
  return (
    <>
      {hovered && !(editing && sameLine(editing, hovered.line)) ? (
        <Button
          className={styles.add}
          size='mini'
          icon={<Comment size={12} />}
          style={{ top: hovered.top + Math.max(0, (hovered.height - 20) / 2) }}
          aria-label={t('preview.diffComment.add')}
          title={t('preview.diffComment.add')}
          data-testid='diff-comment-add'
          onClick={() => setEditing(hovered.line)}
        />
      ) : null}
      {slots.map((slot) => {
        if (slot.key === EDITOR && editing)
          return ReactDOM.createPortal(
            <CommentEditor line={editing} onSave={save} onCancel={() => setEditing(null)} />,
            slot.cell,
            slot.key
          );
        const snippet = byId.get(slot.key);
        return snippet && removeDomSnippet
          ? ReactDOM.createPortal(<CommentCard snippet={snippet} onRemove={removeDomSnippet} />, slot.cell, slot.key)
          : null;
      })}
    </>
  );
}
