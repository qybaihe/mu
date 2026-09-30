/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { TEAM_MODE_ENABLED } from '@/common/config/constants';
import Titlebar from '@/renderer/components/layout/Titlebar';
import MuMark from '@renderer/components/brand/MuMark';
import { Layout as ArcoLayout, Message, Tooltip } from '@arco-design/web-react';
import classNames from 'classnames';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { setGlobalNavigate } from '@/renderer/utils/navigation';
import { usePreviewContext } from '@renderer/pages/conversation/Preview';
import WorkPanelHost, { panelGeometry } from '@renderer/components/layout/WorkPanel';
import { useWorkPanelMemory } from '@renderer/components/layout/WorkPanel/workPanelStore';
import {
  isSiderCrowded,
  isSiderFolded,
  SIDER_RAIL_WIDTH,
  siderChoiceAfterRoomChange,
  type SiderChoice,
} from '@renderer/components/layout/Sider/siderRoom';
import { useBrowserMaximized } from '@renderer/pages/conversation/Preview/browser/browserStore';
import { setCurrentProject } from '@renderer/pages/conversation/explorer/currentProjectStore';
import {
  setCurrentConversation,
  useCurrentConversation,
} from '@renderer/pages/conversation/explorer/currentConversationStore';
import { useContainerWidth } from '@renderer/pages/conversation/hooks/useContainerWidth';
import { useResizableSplit } from '@renderer/hooks/ui/useResizableSplit';
import { LayoutContext } from '@renderer/hooks/context/LayoutContext';
import { NavigationHistoryProvider } from '@renderer/hooks/context/NavigationHistoryContext';
import { useDeepLink } from '@renderer/hooks/system/useDeepLink';
import { useNotificationClick } from '@renderer/hooks/system/notification/useNotificationClick';
import { useDesktopTurnNotification } from '@renderer/hooks/system/notification/useDesktopTurnNotification';
import { useNativeAttention } from '@renderer/pages/native/hooks/useNativeAttention';
import { cleanupSiderTooltips } from '@renderer/utils/ui/siderTooltip';
import { useConversationShortcuts } from '@renderer/hooks/ui/useConversationShortcuts';
import { isElectronDesktop } from '@renderer/utils/platform';
import { deferredRuntimeNeeds } from '@renderer/services/runtime/deferredNodeRuntime';
import { SETTINGS_HOME } from '@renderer/pages/settings/settingsNav';
import '@renderer/styles/layout.css';

const SidebarIcon: React.FC<{ size?: number; strokeWidth?: number }> = ({ size = 18, strokeWidth = 4 }) => (
  <svg
    width={size}
    height={size}
    viewBox='0 0 48 48'
    fill='none'
    stroke='currentColor'
    strokeWidth={strokeWidth}
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
    focusable='false'
    style={{ display: 'inline-block', verticalAlign: 'middle' }}
  >
    <rect x='6' y='10' width='36' height='28' rx='5' />
    <line x1='18' y1='10' x2='18' y2='38' />
  </svg>
);

const useDebug = () => {
  const [count, setCount] = useState(0);
  const timer = useRef<any>(null);
  const onClick = () => {
    const open = () => {
      ipcBridge.application.openDevTools.invoke().catch((error) => {
        console.error('Failed to open dev tools:', error);
      });
      setCount(0);
    };
    if (count >= 3) {
      return open();
    }
    setCount((prev) => {
      if (prev >= 2) {
        open();
        return 0;
      }
      return prev + 1;
    });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      clearTimeout(timer.current);
      setCount(0);
    }, 1000);
  };

  return { onClick };
};

const DEFAULT_SIDER_WIDTH = 260;
// 桌面侧栏连续可调：下限 200；低于此值拖拽即吸附收起（消灭旧 130 死区）。
// 上限 = 窗口宽 50%（动态随窗口）。
const SIDER_MIN_WIDTH = 200;
const MOBILE_SIDER_WIDTH_RATIO = 0.67;
const MOBILE_SIDER_MIN_WIDTH = 260;
const MOBILE_SIDER_MAX_WIDTH = 420;

const detectMobileViewportOrTouch = (): boolean => {
  if (typeof window === 'undefined') return false;
  // A desktop window is never a phone, however narrow: its sidebar folds to the rail and the work panel docks or takes
  // the row, with no overlay or scrim (the window's minimum width keeps a usable transcript beside the rail).
  if (isElectronDesktop()) return false;
  const width = window.innerWidth;
  const byWidth = width < 768;
  // 仅在小屏时才将 coarse/touch 视为移动端，避免触控笔记本被误判
  // Treat touch/coarse pointer as mobile only on smaller viewports
  const smallScreen = width < 1024;
  const byMedia = window.matchMedia('(hover: none)').matches || window.matchMedia('(pointer: coarse)').matches;
  const byTouchPoints = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  return byWidth || (smallScreen && (byMedia || byTouchPoints));
};

/** Whether the window a layout mounts in is already too narrow for the open sidebar (see `isSiderCrowded`). */
const startsCrowded = (): boolean =>
  typeof window !== 'undefined' &&
  isSiderCrowded(false, {
    viewportWidth: window.innerWidth,
    siderWidth: DEFAULT_SIDER_WIDTH,
    panelOpen: false,
    isMobile: detectMobileViewportOrTouch(),
  });

const Layout: React.FC<{
  sider: React.ReactNode;
  onSessionClick?: () => void;
}> = ({ sider, onSessionClick: _onSessionClick }) => {
  // The sidebar folds to its rail while the window has no room for it beside a readable conversation (and the work
  // panel, when that is open), and opens again once there is. The person's own choice stands over that: a sidebar they
  // folded stays folded however wide the window gets, and one they opened in a crowded window stays open until the room
  // changes.
  const [siderChoice, setSiderChoice] = useState<SiderChoice>(null);
  const [siderCrowded, setSiderCrowded] = useState(startsCrowded);
  const collapsed = isSiderFolded(siderChoice, siderCrowded);
  const [isMobile, setIsMobile] = useState(detectMobileViewportOrTouch);
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window === 'undefined' ? 390 : window.innerWidth
  );
  const { onClick } = useDebug();
  useDeepLink();
  useNotificationClick();
  useDesktopTurnNotification();
  useNativeAttention();
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceAvailable =
    location.pathname.startsWith('/conversation/') || (TEAM_MODE_ENABLED && location.pathname.startsWith('/team/'));
  // The person folding or opening the sidebar: the titlebar button, ⌘B, dragging or double-clicking its edge.
  const setSiderCollapsed = useCallback((next: boolean) => setSiderChoice(next ? 'folded' : 'open'), []);
  const toggleSider = useCallback(() => setSiderCollapsed(!collapsed), [collapsed, setSiderCollapsed]);
  // On a phone the sidebar is a sheet over the page, and putting it away after a pick is no wish to keep it folded.
  const putAwayPhoneSider = useCallback(() => setSiderChoice(null), []);
  useConversationShortcuts({ navigate, toggleSider });
  // Expose navigate to code running outside the Router tree (e.g. dialogs
  // mounted above the Router in the provider tree).
  useEffect(() => {
    setGlobalNavigate(navigate);
    return () => setGlobalNavigate(null);
  }, [navigate]);
  const { t } = useTranslation();
  // The mu wordmark acts as Home / Back-to-Chat, but only from settings routes.
  // In non-settings routes the user is already "home", so it is a no-op (and not actionable).
  const isSettingsRoute = location.pathname.startsWith('/settings');
  // The page the menu's commands arrive on, without re-subscribing to them on every navigation.
  const pathnameRef = useRef(location.pathname);
  useEffect(() => {
    pathnameRef.current = location.pathname;
  }, [location.pathname]);
  // Only wired to the wordmark in the isSettingsRoute branch below, so the
  // "no-op outside settings" contract is enforced structurally — no internal
  // route guard needed (the chat-route wordmark is a plain, inert div).
  const handleBrandHome = useCallback(() => {
    // Mirror Titlebar's handleBackToChat convention: return to the last non-settings path.
    let target: string | null = null;
    try {
      target = sessionStorage.getItem('aion:last-non-settings-path');
    } catch {
      // ignore
    }
    if (target && !target.startsWith('/settings')) {
      void navigate(target);
      return;
    }
    void navigate('/guid');
  }, [navigate]);
  // Close preview whenever the user leaves the conversation route entirely
  // (e.g. switches to a team, /guid, or settings). Within /conversation/:id
  // the finer-grained closePreviewIfScopeChanged in conversation/index.tsx
  // handles scope changes, so we only need to act here on route-type changes.
  // Use closePreview directly — closePreviewIfScopeChanged skips the call
  // when lastScopeRef is already null (e.g. on team routes where it was
  // never updated), which would leave the panel open.
  const { closePreview: closePreviewOnRouteChange, isMaximized: isPreviewMaximized } = usePreviewContext();
  // The work panel (preview, files, source control, kernel tabs) sits in the
  // measured [content | panel] row; the row's width bounds the panel so the
  // transcript keeps its room.
  const currentConversation = useCurrentConversation();
  const workPanel = useWorkPanelMemory(currentConversation);
  const { containerRef: mainRowRef, containerWidth: mainRowWidth } = useContainerWidth();
  // 最大化：隐藏聊天区、让工作面板的预览（或浏览器）铺满它腾出的空间；左侧边栏不动。
  // Maximized: hide the chat area and let the work panel's preview (or its
  // browser) fill the space it vacated; the left sidebar is left untouched.
  const browserMaximized = useBrowserMaximized();
  const previewMaximized =
    !isMobile &&
    Boolean(currentConversation) &&
    workPanel.open &&
    ((workPanel.tab === 'preview' && isPreviewMaximized) || (workPanel.tab === 'browser' && browserMaximized));
  const routeLayoutMountedRef = useRef(false);
  useEffect(() => {
    if (!routeLayoutMountedRef.current) {
      routeLayoutMountedRef.current = true;
      return; // skip initial mount — preview starts closed, don't wipe persisted tabs
    }
    if (!workspaceAvailable) {
      closePreviewOnRouteChange();
      // Leaving every project-bearing route (conversation + team) → no active
      // project → hide the Explorer host. Within /conversation/* and /team/* the
      // route itself publishes project_id, so we only clear when leaving both.
      setCurrentProject(null);
    }
    // The active-conversation target is published by the conversation route
    // (mounted conversation) and the team route (active member column). Clear it
    // only when leaving both, so a stale target can't leak to a non-chat route.
    if (!workspaceAvailable) {
      setCurrentConversation(null);
    }
  }, [location.pathname, workspaceAvailable, closePreviewOnRouteChange]);

  // 桌面侧栏连续可调宽 + 记忆宽度 + 收起吸附。复用 useResizableSplit
  // 的 pointer/rAF 拖拽管线：拖到 <200 吸附收起（onCollapsedChange→collapsed），
  // ≥200 跟手且写盘，双击分隔线恢复 260。上限动态跟随窗口 50%。移动端不使用。
  const { splitRatio: desktopSiderWidth, createDragHandle: createSiderDragHandle } = useResizableSplit({
    unit: 'px',
    defaultWidth: DEFAULT_SIDER_WIDTH,
    minWidth: SIDER_MIN_WIDTH,
    maxWidth: Math.max(SIDER_MIN_WIDTH, Math.round(viewportWidth * 0.5)),
    storageKey: 'sider-width-px',
    collapseThreshold: SIDER_MIN_WIDTH,
    collapsedWidth: SIDER_RAIL_WIDTH,
    collapsed,
    onCollapsedChange: setSiderCollapsed,
  });

  // The open sidebar's width as the person left it: read when the room changes, not while they drag its edge (a
  // sidebar dragged wider does not fold under the pointer).
  const siderWidthRef = useRef(desktopSiderWidth);
  useEffect(() => {
    siderWidthRef.current = desktopSiderWidth;
  }, [desktopSiderWidth]);
  const panelBeside = !isMobile && workspaceAvailable && Boolean(currentConversation) && workPanel.open;
  // Before the paint, so a window that opens narrow or a panel that opens in a narrow one shows the rail at once.
  useLayoutEffect(() => {
    const crowded = isSiderCrowded(siderCrowded, {
      viewportWidth,
      siderWidth: siderWidthRef.current,
      panelOpen: panelBeside,
      isMobile,
    });
    if (crowded === siderCrowded) return;
    setSiderCrowded(crowded);
    setSiderChoice(siderChoiceAfterRoomChange);
  }, [viewportWidth, isMobile, panelBeside, siderCrowded]);

  // 检测移动端并响应窗口大小变化
  useEffect(() => {
    const checkMobile = () => {
      const mobile = detectMobileViewportOrTouch();
      setIsMobile(mobile);
      setViewportWidth(window.innerWidth);
    };

    // 初始检测
    checkMobile();

    // 监听窗口大小变化
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // The phone layout's own styles (layout.css) hold under this mark only: a narrow desktop window keeps the desktop's.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute('data-phone-layout', isMobile);
    return () => root.removeAttribute('data-phone-layout');
  }, [isMobile]);

  // 清理侧栏 Tooltip 残留节点，避免移动端路由切换后浮层卡在左上角
  useEffect(() => {
    cleanupSiderTooltips();
  }, [isMobile, collapsed, location.pathname, location.search, location.hash]);

  // The Node.js download was put off at this start and something needed it: a conversation says so above its
  // composer (NodeRuntimeNote), the first place anywhere else (an MCP server, a custom agent) in one toast.
  useEffect(
    () =>
      ipcBridge.runtime.deferredFailure.on((event) => {
        if (deferredRuntimeNeeds.record(event.scope)) Message.info(t('common.nodeRuntime.toolNote'));
      }),
    [t]
  );

  // Bridge Main Process logs to F12 Console
  useEffect(() => {
    const unsubscribe = ipcBridge.application.logStream.on((entry) => {
      const prefix = `%c[Main:${entry.tag}]%c ${entry.message}`;
      const style = 'color:#7c3aed;font-weight:bold';
      if (entry.level === 'error') {
        console.error(prefix, style, 'color:inherit', ...(entry.data !== undefined ? [entry.data] : []));
      } else if (entry.level === 'warn') {
        console.warn(prefix, style, 'color:inherit', ...(entry.data !== undefined ? [entry.data] : []));
      } else {
        console.log(prefix, style, 'color:inherit', ...(entry.data !== undefined ? [entry.data] : []));
      }
    });
    return () => unsubscribe();
  }, []);

  // Handle tray events from main process / 处理来自主进程的托盘事件
  useEffect(() => {
    if (!isElectronDesktop()) return;

    // Navigate to guid page when requested from tray / 托盘请求导航到 guid 页面
    const handleNavigateToGuid = () => {
      void navigate('/guid');
    };

    // Navigate to conversation when requested from tray / 托盘请求导航到对话页面
    const handleNavigateToConversation = (event: CustomEvent<{ conversation_id: string }>) => {
      void navigate(`/conversation/${event.detail.conversation_id}`);
    };

    // Open about dialog when requested from tray / 托盘请求打开关于对话框
    const handleOpenAbout = () => {
      // Navigate to settings/about page / 导航到设置/关于页面
      void navigate('/settings/about');
    };

    // Handle pause all tasks request from tray / 托盘请求暂停所有任务
    const handlePauseAllTasks = async () => {
      const result = await ipcBridge.task.stopAll.invoke();
      if (result?.success) {
        // Navigate to settings page to show task status
        void navigate('/settings/system');
      }
    };

    // Listen for tray events / 监听托盘事件
    window.addEventListener('tray:navigate-to-guid', handleNavigateToGuid as EventListener);
    window.addEventListener('tray:navigate-to-conversation', handleNavigateToConversation as EventListener);
    window.addEventListener('tray:open-about', handleOpenAbout as EventListener);
    window.addEventListener('tray:pause-all-tasks', handlePauseAllTasks as EventListener);
    // The menu's and the tray's "check for updates": the update row of 关于 (About) shows the check and its answer.
    const removeUpdateOpenListener = ipcBridge.update.open.on(() => {
      void navigate('/settings/about');
      void ipcBridge.update.run.invoke({ action: 'check' });
    });
    // The application menu's 新会话 (⌘N), as the sidebar's button, and 设置… (⌘,), which stays on the settings page
    // already open.
    const removeMenuCommandListener = ipcBridge.application.menuCommand.on(({ command }) => {
      cleanupSiderTooltips();
      if (command === 'newChat') {
        void navigate('/guid', { state: { resetAssistant: true } });
      } else if (command === 'openSettings' && !pathnameRef.current.startsWith('/settings')) {
        void navigate(SETTINGS_HOME);
      }
    });

    return () => {
      window.removeEventListener('tray:navigate-to-guid', handleNavigateToGuid as EventListener);
      window.removeEventListener('tray:navigate-to-conversation', handleNavigateToConversation as EventListener);
      window.removeEventListener('tray:open-about', handleOpenAbout as EventListener);
      window.removeEventListener('tray:pause-all-tasks', handlePauseAllTasks as EventListener);
      removeUpdateOpenListener();
      removeMenuCommandListener();
    };
  }, [navigate]);

  const siderWidth = isMobile
    ? Math.max(
        MOBILE_SIDER_MIN_WIDTH,
        Math.min(MOBILE_SIDER_MAX_WIDTH, Math.round(viewportWidth * MOBILE_SIDER_WIDTH_RATIO))
      )
    : desktopSiderWidth;
  // The [content | panel] row: as measured, or as it is about to be while the sidebar's width is still easing toward
  // the rail, so a panel opened in a narrow window docks beside the conversation at once instead of first filling it.
  const panelRowWidth = isMobile
    ? mainRowWidth
    : Math.max(mainRowWidth, viewportWidth - (collapsed ? SIDER_RAIL_WIDTH : siderWidth));
  // A row too narrow for the panel beside a readable conversation: the panel takes the row, and the conversation is
  // set aside (mounted) until the panel is closed or the window is wide enough again. Nothing lies over its text.
  const panelFillsRow =
    panelBeside && panelGeometry(panelRowWidth, viewportWidth, isMobile, workPanel.width).mode === 'fill';

  const siderStyle = isMobile
    ? {
        position: 'fixed' as const,
        left: 0,
        zIndex: 100,
        transform: collapsed ? 'translateX(-100%)' : 'translateX(0)',
        transition: 'none',
        pointerEvents: collapsed ? ('none' as const) : ('auto' as const),
      }
    : {
        position: 'relative' as const,
        overflow: 'visible' as const,
      };

  return (
    <LayoutContext.Provider value={{ isMobile, siderCollapsed: collapsed, setSiderCollapsed }}>
      <NavigationHistoryProvider>
        <div className='app-shell flex flex-col size-full min-h-0'>
          <Titlebar workspaceAvailable={workspaceAvailable} />
          {/* 移动端左侧边栏蒙板 / Mobile left sider backdrop */}
          {isMobile && !collapsed && (
            <div className='fixed inset-0 bg-black/30 z-90' onClick={putAwayPhoneSider} aria-hidden='true' />
          )}

          <ArcoLayout className={'size-full layout flex-1 min-h-0'}>
            <ArcoLayout.Sider
              collapsedWidth={isMobile ? 0 : SIDER_RAIL_WIDTH}
              collapsed={collapsed}
              width={siderWidth}
              className={classNames('!bg-2 layout-sider', {
                collapsed: collapsed,
              })}
              style={siderStyle}
            >
              <ArcoLayout.Header
                className={classNames(
                  'flex items-center pt-8px pb-8px gap-12px layout-sider-header',
                  // The rail centres the mark over its icons.
                  collapsed && !isMobile ? 'justify-center px-0' : 'justify-start ps-18px pe-16px',
                  isMobile && 'layout-sider-header--mobile',
                  {
                    'cursor-pointer group ': collapsed,
                  }
                )}
              >
                {/* The mark keeps upstream's hidden devtools click; its size follows the collapsed rail. */}
                <div className='shrink-0 line-height-0' data-testid='sider-brand-mark' onClick={onClick}>
                  <MuMark size={collapsed ? 24 : 32} />
                </div>
                {isSettingsRoute ? (
                  <Tooltip content={t('common.back', { defaultValue: 'Back to Chat' })} position='bottom'>
                    <div
                      className='text-16px text-t-primary collapsed-hidden font-semibold cursor-pointer'
                      role='button'
                      tabIndex={0}
                      aria-label={t('common.back', { defaultValue: 'Back to Chat' })}
                      onClick={handleBrandHome}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          handleBrandHome();
                        }
                      }}
                    >
                      mu
                    </div>
                  </Tooltip>
                ) : (
                  <div className='text-16px text-t-primary collapsed-hidden font-semibold'>mu</div>
                )}
                {isMobile && !collapsed && (
                  <button
                    type='button'
                    className='app-titlebar__button app-titlebar__button--mobile'
                    onClick={putAwayPhoneSider}
                    title={t('common.collapseSidebar')}
                    aria-label={t('common.collapseSidebar')}
                  >
                    <SidebarIcon size={18} strokeWidth={2.5} />
                  </button>
                )}
                {/* 侧栏折叠改由标题栏统一控制 / Sidebar folding handled by Titlebar toggle */}
              </ArcoLayout.Header>
              <ArcoLayout.Content className='pt-0 px-8px pb-0 layout-sider-content'>
                {React.isValidElement(sider)
                  ? React.cloneElement(sider, {
                      onSessionClick: () => {
                        cleanupSiderTooltips();
                        if (isMobile) putAwayPhoneSider();
                      },
                      collapsed,
                    } as any)
                  : sider}
              </ArcoLayout.Content>
              {!isMobile &&
                createSiderDragHandle({
                  className: 'z-20',
                  style: { right: '-4px', width: '8px' },
                  linePlacement: 'start',
                })}
            </ArcoLayout.Sider>

            {/* The route content and the work panel share one measured flex row.
                `mainRowRef` gives the [content | panel] width that bounds the panel
                (independent of the panel's own width, so the clamp is non-circular).
                The panel is a sibling of the route content, above the
                per-conversation subtree, so it persists across conversation switches. */}
            <div ref={mainRowRef} className='relative flex flex-1 min-h-0 overflow-hidden'>
              <ArcoLayout.Content
                className={'bg-1 layout-content flex flex-col min-h-0 flex-1'}
                onClick={() => {
                  if (isMobile && !collapsed) putAwayPhoneSider();
                }}
                style={
                  isMobile
                    ? {
                        width: '100%',
                      }
                    : previewMaximized || panelFillsRow
                      ? // 最大化时聊天区隐藏（保持挂载不卸载，还原后即刻恢复）
                        // Hidden while maximized or while the panel fills the row (kept mounted so coming back is
                        // instant)
                        { display: 'none' }
                      : undefined
                }
              >
                <Outlet />
              </ArcoLayout.Content>
              {workspaceAvailable && <WorkPanelHost rowWidth={panelRowWidth} isMobile={isMobile} />}
            </div>
          </ArcoLayout>
        </div>
      </NavigationHistoryProvider>
    </LayoutContext.Provider>
  );
};

export default Layout;
