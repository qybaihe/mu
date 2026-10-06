/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { useCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { ExplorerContainer, type ExplorerView } from '@/renderer/pages/conversation/explorer/ExplorerContainer';
import { KernelBody, useKyrnActivity, type KernelTab } from '@/renderer/pages/conversation/KyrnPanel';
import { PreviewPanel, usePreviewContext } from '@/renderer/pages/conversation/Preview';
import FolderFiles from '@/renderer/pages/conversation/explorer/FolderFiles';
import { useNativeActivity, useNativeFolder } from '@/renderer/pages/native/utils/nativeActivityStore';
import FirstHint from '@/renderer/components/base/FirstHint';
import BrowserPanel from '@/renderer/pages/conversation/Preview/browser/BrowserPanel';
import { setBrowserMaximized, useBrowserMaximized } from '@/renderer/pages/conversation/Preview/browser/browserStore';
import { panelGeometry } from './panelGeometry';
import { useWorkPanel } from './useWorkPanel';
import WorkPanelTabs, { workPanelBodyId, workPanelTabId } from './WorkPanelTabs';
import { WORK_PANEL_DEFAULT_WIDTH, WORK_PANEL_MIN_WIDTH, type WorkPanelTab } from './workPanelStore';
import styles from './WorkPanel.module.css';

export { MIN_TRANSCRIPT_PX, panelGeometry } from './panelGeometry';

/** One arrow key press on the resize handle. */
const KEY_STEP_PX = 16;

const useViewportWidth = (): number => {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return width;
};

/**
 * The drag handle between the transcript and the panel. It follows the pointer frame by frame and remembers the
 * width once, when the drag ends; a double click goes back to the default width; arrow keys move it in steps.
 */
function ResizeHandle({
  width,
  max,
  onLive,
  onCommit,
}: {
  width: number;
  max: number;
  onLive: (width: number | null) => void;
  onCommit: (width: number) => void;
}) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(WORK_PANEL_MIN_WIDTH, value)));
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' && event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    // The panel grows toward the transcript: leftward in a left-to-right page, rightward in a right-to-left one.
    const sign = getComputedStyle(handle).direction === 'rtl' ? 1 : -1;
    const from = event.clientX;
    let latest = width;
    let frame = 0;
    handle.setPointerCapture?.(event.pointerId);
    const cursor = document.body.style.cursor;
    const select = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setDragging(true);
    const move = (moveEvent: PointerEvent) => {
      latest = clamp(width + sign * (moveEvent.clientX - from));
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          onLive(latest);
        });
    };
    const end = () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = select;
      setDragging(false);
      onLive(null);
      onCommit(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
  };
  const nudge = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const grow = (event.key === 'ArrowLeft') !== rtl;
    onCommit(clamp(width + (grow ? KEY_STEP_PX : -KEY_STEP_PX)));
  };
  return (
    <div
      role='separator'
      aria-orientation='vertical'
      aria-label={t('common.workPanel.resize')}
      aria-valuemin={WORK_PANEL_MIN_WIDTH}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      className={styles.handle}
      data-dragging={dragging ? 'true' : undefined}
      data-testid='work-panel-resize'
      onPointerDown={start}
      onKeyDown={nudge}
      onDoubleClick={() => onCommit(clamp(WORK_PANEL_DEFAULT_WIDTH))}
    />
  );
}

/** The preview tab: the preview itself, or a line saying why there is none. */
function PreviewBody() {
  const { t } = useTranslation();
  const { isOpen, activeTab, tabs, showPreview } = usePreviewContext();
  // `data-project-preview-region` is the anchor the end-to-end preview tests find the preview by.
  if (isOpen && activeTab)
    return (
      <div className='h-full w-full overflow-hidden' data-project-preview-region>
        <PreviewPanel />
      </div>
    );
  return (
    <div className={styles.quiet}>
      {tabs.length ? (
        <>
          <span>{t('common.workPanel.previewHidden')}</span>
          <Button type='text' size='mini' className={styles.inlineAction} onClick={showPreview}>
            {t('common.show')}
          </Button>
        </>
      ) : (
        <span>{t('common.workPanel.previewEmpty')}</span>
      )}
    </div>
  );
}

const KERNEL_TABS: readonly KernelTab[] = ['board', 'judge', 'hive', 'lessons'];

/**
 * The conversation page's right side: one docked panel whose tabs hold the kernel's view of the conversation (the
 * plain-language board, the judge's log, the sub-agents, the lessons learned for the project), the project's files,
 * the preview, source control and the in-app browser. It sits beside the transcript and above the per-conversation
 * subtree, so switching conversations never remounts the explorer, the preview or the browser. Every tab stays
 * mounted while another is shown, and a closed panel keeps its width inside: nothing reloads, and a web page keeps
 * its size.
 */
export default function WorkPanelHost({ rowWidth, isMobile }: { rowWidth: number; isMobile: boolean }) {
  const { t } = useTranslation();
  const conversationId = useCurrentConversation();
  const projectId = useCurrentProject();
  // A native conversation's Jev tabs read its view, which its page publishes; any other conversation's are polled. It
  // has no AionCore project: its lessons and files are read by the folder it works in.
  const native = useNativeActivity(conversationId);
  const nativeFolder = useNativeFolder(conversationId);
  const polled = useKyrnActivity(native ? null : conversationId);
  const activity = native ?? polled;
  // The last run's end: the folder is read again after it, so what the model wrote shows.
  const lastRun = native?.events.findLast((event) => event.kind === 'agent_settled')?.id ?? '';
  const { memory, unread, used, focus, select, close, resize } = useWorkPanel(conversationId, activity);
  const { isMaximized } = usePreviewContext();
  const browserMaximized = useBrowserMaximized();
  const viewportWidth = useViewportWidth();
  const [live, setLive] = useState<number | null>(null);
  const geometry = panelGeometry(rowWidth, viewportWidth, isMobile, live ?? memory.width);
  const { open, tab: active } = memory;
  // Too narrow for both: the panel has the row, and the Layout sets the transcript aside until it closes.
  const fill = open && geometry.mode === 'fill';
  // Docked, the preview and the browser can each fill the page (the transcript hidden), each by its own button.
  const maximized =
    open &&
    geometry.mode === 'dock' &&
    ((active === 'preview' && isMaximized) || (active === 'browser' && browserMaximized));
  // 文件 and 源码 are one explorer: it keeps the view last asked for while another tab is shown.
  const [explorerView, setExplorerView] = useState<ExplorerView>('files');
  const wantedView: ExplorerView = active === 'source' ? 'changes' : active === 'files' ? 'files' : explorerView;
  if (wantedView !== explorerView) setExplorerView(wantedView);

  if (!conversationId) return null;

  const explorerActive = active === 'files' || active === 'source';
  const body = (
    key: WorkPanelTab | 'explorer',
    shown: boolean,
    labelledBy: WorkPanelTab,
    children: React.ReactNode
  ) => (
    <div
      key={key}
      role='tabpanel'
      id={workPanelBodyId(labelledBy)}
      aria-labelledby={workPanelTabId(labelledBy)}
      className={styles.body}
      data-active={shown ? 'true' : 'false'}
      data-body={key}
      inert={!shown}
    >
      {children}
    </div>
  );

  return (
    <>
      {geometry.mode === 'sheet' && open ? (
        <div className={styles.backdrop} onClick={close} aria-hidden='true' />
      ) : null}
      <aside
        className={styles.host}
        data-testid='work-panel'
        data-mode={geometry.mode}
        data-open={open ? 'true' : 'false'}
        data-maximized={maximized ? 'true' : undefined}
        aria-label={t('common.workPanel.label')}
        inert={!open}
        style={{
          width: maximized || fill ? undefined : open || geometry.mode === 'sheet' ? geometry.width : 0,
        }}
      >
        {open && geometry.mode === 'dock' && !maximized ? (
          <ResizeHandle width={geometry.width} max={geometry.max} onLive={setLive} onCommit={resize} />
        ) : null}
        <div className={styles.frame} style={{ width: maximized || fill ? '100%' : geometry.width }}>
          <WorkPanelTabs
            active={active}
            unread={unread}
            used={used}
            onSelect={select}
            onClose={close}
            onBack={fill ? close : undefined}
          />
          {/* The first time the panel opens, one sentence on what its tabs are. */}
          <div className={styles.firstHint}>
            <FirstHint id='workPanel' wants={open} text={t('common.workPanel.firstHint')} />
          </div>
          <div className={styles.bodies}>
            {KERNEL_TABS.map((tab) =>
              body(
                tab,
                active === tab,
                tab,
                <KernelBody
                  key={conversationId}
                  tab={tab}
                  conversationId={conversationId}
                  activity={activity}
                  focus={focus}
                  visible={open && active === tab}
                  lessons={!native || nativeFolder !== undefined}
                  cwd={nativeFolder}
                />
              )
            )}
            {body(
              'explorer',
              explorerActive,
              active === 'source' ? 'source' : 'files',
              projectId ? (
                <ExplorerContainer
                  key={projectId}
                  projectId={projectId}
                  view={wantedView}
                  onViewChange={(view) => select(view === 'changes' ? 'source' : 'files')}
                />
              ) : nativeFolder ? (
                <FolderFiles
                  key={nativeFolder}
                  cwd={nativeFolder}
                  view={wantedView}
                  visible={open && explorerActive}
                  refresh={lastRun}
                />
              ) : (
                <p className={styles.quiet}>{t('common.workPanel.noProject')}</p>
              )
            )}
            {body('preview', active === 'preview', 'preview', <PreviewBody />)}
            {body(
              'browser',
              active === 'browser',
              'browser',
              <BrowserPanel
                maximized={maximized}
                onToggleMaximize={geometry.mode === 'dock' ? () => setBrowserMaximized(!browserMaximized) : undefined}
              />
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
