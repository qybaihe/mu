/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';

import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';

// Import KaTeX CSS to make it available in the document
import 'katex/dist/katex.min.css';

import { openExternalUrl } from '@/renderer/utils/platform';
import { parseHttpUrl } from '@/renderer/utils/url';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import classNames from 'classnames';
import React, { useCallback, useContext, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { convertLatexDelimiters } from '@renderer/utils/chat/latexDelimiters';
import LocalImageView from '@renderer/components/media/LocalImageView';
import CodeBlock from './CodeBlock';
import LocalFileLink from './LocalFileLink';
import ShadowView from './ShadowView';
import { MARKDOWN_REMARK_PLUGINS, MarkdownFileSlotsContext, MarkdownTable, MarkdownTd } from './markdownComponents';
import {
  resolveLocalFileLinkPath,
  resolveLocalFileLinkReference,
  resolveRelativeFileLinkReference,
  resolveWebLinkHref,
} from './markdownUtils';
import type { LocalFileLinkReference } from './markdownUtils';

const isLocalFilePath = (src: string): boolean => {
  if (src.startsWith('http://') || src.startsWith('https://')) return false;
  if (src.startsWith('data:')) return false;
  return true;
};

const transformUrl = (url: string) => (resolveLocalFileLinkPath(url) ? url : defaultUrlTransform(url));

type MarkdownViewProps = {
  children: string;
  hiddenCodeCopyButton?: boolean;
  codeStyle?: React.CSSProperties;
  className?: string;
  onRef?: (el?: HTMLDivElement | null) => void;
  onLocalFileLink?: (path: string, reference?: LocalFileLinkReference) => void | Promise<void>;
  /** Enable raw HTML rendering in markdown content. Use with caution — only for trusted sources. */
  allowHtml?: boolean;
};

const MarkdownView: React.FC<MarkdownViewProps> = React.memo(
  ({ hiddenCodeCopyButton, codeStyle, className, onRef, onLocalFileLink, allowHtml, children: childrenProp }) => {
    const { t } = useTranslation();
    // The preview panel changes whenever a tab opens, loads or updates, and every message in the conversation reads
    // this context. A link only needs the panel at the moment it is clicked, so the handler reads the latest one from
    // a ref: the markdown below is not parsed and its code highlighted again for a change in the panel.
    const preview = useOptionalPreviewContext();
    const previewRef = useRef(preview);
    previewRef.current = preview;
    // A reply draws the file links it can check its own way (renderer/components/media/FileRefs/).
    const fileSlots = useContext(MarkdownFileSlotsContext);

    const normalizedChildren = useMemo(() => {
      if (typeof childrenProp === 'string') {
        let text = childrenProp.replace(/file:\/\//g, '');
        text = convertLatexDelimiters(text);
        return text;
      }
      return childrenProp;
    }, [childrenProp]);

    const handleLinkClick = useCallback(
      (e: React.MouseEvent<HTMLAnchorElement>, rawHref: string) => {
        e.preventDefault();
        e.stopPropagation();
        // The address as written, never the anchor's resolved `href`: resolved against the app's own page, a
        // relative or fragment link IS the app, and the app must not open inside its own browser tab (no desktop
        // bridge there, so it shows the web sign-in) nor in the system browser.
        const href = resolveWebLinkHref(rawHref);
        if (!href) return;
        // Prefer the built-in browser tab for http(s) links; fall back to the
        // system browser for other schemes or when no Preview panel is available.
        const httpUrl = parseHttpUrl(href);
        const panel = previewRef.current;
        if (httpUrl && panel) {
          panel.openBrowserTab(httpUrl);
          return;
        }
        openExternalUrl(href).catch((error: unknown) => {
          console.error(t('messages.openLinkFailed'), error);
        });
      },
      [t]
    );

    // Memoize components so React preserves component identity across re-renders.
    // Without this, every streaming update creates new function references → React
    // unmounts/remounts all custom components → hooks & DOM state are lost.
    const components = useMemo(
      () => ({
        span: ({ node: _node, className: cn, children: ch, ...rest }: Record<string, unknown>) => (
          <span {...(rest as React.HTMLAttributes<HTMLSpanElement>)} className={cn as string}>
            {ch as React.ReactNode}
          </span>
        ),
        code: (props: Record<string, unknown>) => (
          <CodeBlock
            {...(props as Parameters<typeof CodeBlock>[0])}
            codeStyle={codeStyle}
            hiddenCodeCopyButton={hiddenCodeCopyButton}
            diagramPanZoom
          />
        ),
        a: ({ node: _node, ...rest }: Record<string, unknown>) => {
          const anchorProps = rest as React.AnchorHTMLAttributes<HTMLAnchorElement>;
          const rawHref = typeof anchorProps.href === 'string' ? anchorProps.href : '';
          // A path, absolute or relative to the workspace, opens as a file in the app.
          const localFileReference =
            resolveLocalFileLinkReference(rawHref) ?? resolveRelativeFileLinkReference(rawHref);
          if (localFileReference) {
            const link = (
              <LocalFileLink reference={localFileReference} onOpen={onLocalFileLink}>
                {anchorProps.children}
              </LocalFileLink>
            );
            return fileSlots ? (
              <fileSlots.LocalFileLink reference={localFileReference} fallback={link}>
                {anchorProps.children}
              </fileSlots.LocalFileLink>
            ) : (
              link
            );
          }
          return (
            <a
              {...anchorProps}
              href={anchorProps.href}
              target='_blank'
              rel='noreferrer'
              onClick={(event) => handleLinkClick(event, rawHref)}
            />
          );
        },
        table: MarkdownTable,
        td: MarkdownTd,
        img: ({ node: _node, ...rest }: Record<string, unknown>) => {
          const imgProps = rest as React.ImgHTMLAttributes<HTMLImageElement>;
          if (isLocalFilePath(imgProps.src || '')) {
            const src = decodeURIComponent(imgProps.src || '');
            return <LocalImageView src={src} alt={imgProps.alt || ''} className={imgProps.className} />;
          }
          return <img {...imgProps} alt={imgProps.alt || ''} />;
        },
      }),
      [codeStyle, hiddenCodeCopyButton, handleLinkClick, onLocalFileLink, fileSlots]
    );

    const rehypePlugins = useMemo(() => (allowHtml ? [rehypeRaw, rehypeKatex] : [rehypeKatex]), [allowHtml]);

    // The same element while the text and the components are the same, so React skips the markdown when this view
    // renders for anything else (the preview panel above, a new translation function).
    const rendered = useMemo(
      () => (
        <ReactMarkdown
          remarkPlugins={MARKDOWN_REMARK_PLUGINS}
          rehypePlugins={rehypePlugins}
          components={components}
          urlTransform={transformUrl}
        >
          {normalizedChildren}
        </ReactMarkdown>
      ),
      [components, normalizedChildren, rehypePlugins]
    );

    return (
      <div className={classNames('relative w-full', className)}>
        <ShadowView>
          <div ref={onRef} className='markdown-shadow-body'>
            {rendered}
          </div>
        </ShadowView>
      </div>
    );
  }
);

MarkdownView.displayName = 'MarkdownView';

export default MarkdownView;
