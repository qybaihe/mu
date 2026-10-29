/**
 * File references in a reply, drawn as links (docs/native-host-ui.md, "File references in a reply"). The reply's
 * markdown is read for path-like inline code and local links (findFileRefs.ts); the main process says which name a
 * regular file (fileRefStore.ts). Until it answers, the reply is drawn as it always was; then:
 *
 * - an image opens in the preview panel, which steps through every image this reply names;
 * - a file the panel draws well (code, text, Markdown, HTML, PDF) opens there too, beside the reply;
 * - any other file opens in the system's default app; every file's folder icon shows it in Finder (File Explorer, the
 *   file manager), and a program is only ever shown there;
 * - a clear path that names nothing is greyed out, with why on hover; a reference that may be code stays plain.
 *
 * A link to a file that is not an image keeps the link the app always drew (it opens in the preview panel).
 */
import { Button, Message } from '@arco-design/web-react';
import { FolderOpen } from '@icon-park/react';
import React, { createContext, useContext, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileRefAnswer } from '@/common/chat/fileRefs/fileRefBridge';
import { baseName, type FileRefStrength } from '@/common/chat/fileRefs/pathLike';
import type { KyrnResult } from '@/common/kyrn/errors';
import type { LocalFileLinkReference } from '@/renderer/components/Markdown/markdownUtils';
import { MarkdownFileSlotsContext, type MarkdownFileSlots } from '@/renderer/components/Markdown/markdownComponents';
import { openGalleryImage } from '@/renderer/pages/conversation/Preview/components/ImageGallery/galleryTab';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { isPanelPreviewable } from '@/renderer/pages/conversation/Preview/fileUtils';
import { useOptionalLocalFilePreview } from '@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview';
import { openFileRef, requestFileRefs, revealFileRef, revealPlatform, useFileRefAnswers } from './fileRefStore';
import { findFileRefs } from './findFileRefs';

type ReplyFileRefsValue = {
  cwd: string;
  /** A reference of this reply that the main process has answered, with how surely it is a path. */
  lookup: (ref: string) => { strength: FileRefStrength; answer: FileRefAnswer } | undefined;
  openImage: (path: string) => void;
  /** Opens a file in the preview panel; undefined where there is no panel. */
  openFile?: (path: string) => void;
};

const ReplyFileRefsContext = createContext<ReplyFileRefsValue | null>(null);
/** Set inside a link: inline code in a link's text is part of the link, never a link of its own. */
const InsideLinkContext = createContext(false);

const REVEAL_KEYS = {
  mac: 'messages.fileRef.reveal.mac',
  windows: 'messages.fileRef.reveal.windows',
  linux: 'messages.fileRef.reveal.linux',
} as const;

/** Says why opening or showing a file did not work: gone since the reply named it, or the system refused. */
function useFailureNotice(): (result: KyrnResult<unknown>, name: string) => void {
  const { t } = useTranslation();
  return (result, name) => {
    if (result.ok !== false) return;
    if (result.code === 'notFound') Message.warning(t('messages.fileRef.gone', { name }));
    else Message.error(t('messages.fileRef.openFailed', { name }));
  };
}

/** A reference that names no file, or more than one: its text greyed out, with the reason on hover. */
function Unavailable({
  refText,
  state,
  children,
}: {
  refText: string;
  state: 'missing' | 'ambiguous';
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const reply = useContext(ReplyFileRefsContext);
  return (
    <span
      className='markdown-file-ref'
      data-file-ref={state}
      aria-disabled='true'
      title={state === 'ambiguous' ? t('messages.fileRef.ambiguous') : t('messages.fileRef.missing')}
      // The model may write the file after naming it: a look at the reference asks again (at most every few seconds).
      onMouseEnter={() => reply && requestFileRefs(reply.cwd, [refText])}
    >
      {children}
    </span>
  );
}

/**
 * A reference to a file that is there. `label`: the reference as the reader sees it, for the control's accessible
 * name; a link's own text names it instead.
 */
function Found({
  answer,
  label,
  children,
}: {
  answer: Extract<FileRefAnswer, { state: 'found' }>;
  label?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const reply = useContext(ReplyFileRefsContext);
  const notice = useFailureNotice();
  const name = label ?? baseName(answer.path);
  const revealLabel = t(REVEAL_KEYS[revealPlatform()], { name });
  const reveal = (): void => {
    void revealFileRef(answer.path).then((result) => notice(result, name));
  };

  if (answer.kind === 'image') {
    return (
      <span className='markdown-file-ref' data-file-ref='image' title={answer.path}>
        <Button
          type='text'
          size='mini'
          className='markdown-file-ref-open'
          aria-label={label ? t('messages.fileRef.preview', { name: label }) : undefined}
          onClick={() => reply?.openImage(answer.path)}
        >
          {children}
        </Button>
      </span>
    );
  }
  if (answer.kind === 'program') {
    return (
      <span className='markdown-file-ref' data-file-ref='program' title={answer.path}>
        <Button type='text' size='mini' className='markdown-file-ref-open' aria-label={revealLabel} onClick={reveal}>
          {children}
        </Button>
      </span>
    );
  }
  const inPanel = reply?.openFile && isPanelPreviewable(answer.path) ? reply.openFile : undefined;
  return (
    <span className='markdown-file-ref' data-file-ref={inPanel ? 'preview' : 'file'} title={answer.path}>
      <Button
        type='text'
        size='mini'
        className='markdown-file-ref-open'
        aria-label={label ? t(inPanel ? 'messages.fileRef.preview' : 'messages.fileRef.open', { name: label }) : undefined}
        onClick={() => {
          if (inPanel) inPanel(answer.path);
          else void openFileRef(answer.path).then((result) => notice(result, name));
        }}
      >
        {children}
      </Button>
      <Button
        type='text'
        size='mini'
        className='markdown-file-ref-reveal'
        aria-label={revealLabel}
        title={revealLabel}
        icon={<FolderOpen theme='outline' size='14' fill='currentColor' />}
        onClick={reveal}
      />
    </span>
  );
}

/** An inline code span: a link when it names a file, greyed out when it clearly names one that is not there. */
function FileRefCode({ code, children }: { code: string; children: React.ReactElement }) {
  const reply = useContext(ReplyFileRefsContext);
  const insideLink = useContext(InsideLinkContext);
  const ref = code.trim();
  const known = !insideLink ? reply?.lookup(ref) : undefined;
  if (!known) return children;
  const { strength, answer } = known;
  if (answer.state === 'found')
    return (
      <Found answer={answer} label={ref}>
        {children}
      </Found>
    );
  if (strength === 'weak') return children;
  return (
    <Unavailable refText={ref} state={answer.state}>
      {children}
    </Unavailable>
  );
}

/**
 * A link to a local path: an image opens in the preview panel's image viewer, a clear path to nothing is greyed out,
 * and anything else keeps the app's own file link (`fallback`).
 */
function FileRefLink({
  reference,
  fallback,
  children,
}: {
  reference: LocalFileLinkReference;
  fallback: React.ReactElement;
  children?: React.ReactNode;
}) {
  const reply = useContext(ReplyFileRefsContext);
  const known = reply?.lookup(reference.filePath);
  let drawn: React.ReactNode = fallback;
  if (known?.answer.state === 'found' && known.answer.kind === 'image')
    drawn = (
      <Found answer={known.answer}>
        <span className='markdown-file-ref-label'>{children}</span>
      </Found>
    );
  else if (known && known.answer.state !== 'found' && known.strength === 'strong')
    drawn = (
      <Unavailable refText={reference.filePath} state={known.answer.state}>
        <span className='markdown-file-ref-label'>{children}</span>
      </Unavailable>
    );
  return <InsideLinkContext.Provider value>{drawn}</InsideLinkContext.Provider>;
}

const FILE_REF_SLOTS: MarkdownFileSlots = { InlineCode: FileRefCode, LocalFileLink: FileRefLink };

/**
 * Wraps a reply's markdown view. `cwd`: the conversation's folder, which relative references are read against; without
 * it, only absolute and `~/` paths are looked up.
 */
export function ReplyFileRefs({
  markdown,
  cwd = '',
  children,
}: {
  markdown: string;
  cwd?: string;
  children: React.ReactNode;
}) {
  const refs = useMemo(() => findFileRefs(markdown), [markdown]);
  const keys = useMemo(() => refs.map((item) => item.ref), [refs]);
  const answers = useFileRefAnswers(cwd, keys);

  // The preview changes whenever a tab opens or loads; a click only needs the latest, so it is read from a ref and a
  // change there draws nothing here.
  const preview = useOptionalPreviewContext();
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const openInPanel = useOptionalLocalFilePreview(cwd || undefined);
  const openInPanelRef = useRef(openInPanel);
  openInPanelRef.current = openInPanel;
  const hasPanel = Boolean(openInPanel);

  const value = useMemo<ReplyFileRefsValue>(() => {
    const strengths = new Map(refs.map((item) => [item.ref, item.strength]));
    // Every image the reply names, in order, once: the preview steps through them.
    const gallery: string[] = [];
    for (const { ref } of refs) {
      const answer = answers.get(ref);
      if (answer?.state === 'found' && answer.kind === 'image' && !gallery.includes(answer.path))
        gallery.push(answer.path);
    }
    return {
      cwd,
      lookup: (ref) => {
        const strength = strengths.get(ref);
        const answer = answers.get(ref);
        return strength && answer ? { strength, answer } : undefined;
      },
      openImage: (path) => {
        const openPreview = previewRef.current?.openPreview;
        if (openPreview) openGalleryImage(openPreview, path, gallery);
      },
      openFile: hasPanel ? (path) => void openInPanelRef.current?.(path) : undefined,
    };
  }, [answers, cwd, refs, hasPanel]);

  // Always both providers, references or not: a reply that streams its first one must not draw its markdown anew.
  return (
    <ReplyFileRefsContext.Provider value={value}>
      <MarkdownFileSlotsContext.Provider value={FILE_REF_SLOTS}>{children}</MarkdownFileSlotsContext.Provider>
    </ReplyFileRefsContext.Provider>
  );
}
