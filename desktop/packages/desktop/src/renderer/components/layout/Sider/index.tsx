import classNames from 'classnames';
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePreviewContext } from '@renderer/pages/conversation/Preview/context/PreviewContext';
import { cleanupSiderTooltips, getSiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import { blurActiveElement } from '@renderer/utils/ui/focus';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';
import NativeSiderGroup from '@renderer/pages/native/components/NativeSiderGroup';
import { useNativeEnabled } from '@renderer/pages/native/hooks/useNativeConversations';
import { SETTINGS_HOME } from '@renderer/pages/settings/settingsNav';
import { SiderToolbar, SiderSearchEntry, SiderScheduledEntry } from './SiderNav';
import SiderFooter from './SiderFooter';
import CommandPalette from './CommandPalette';
import siderStyles from './Sider.module.css';

const WorkspaceGroupedHistory = React.lazy(() => import('@renderer/pages/conversation/GroupedHistory'));
const SettingsSider = React.lazy(() => import('@renderer/pages/settings/components/SettingsSider'));

interface SiderProps {
  onSessionClick?: () => void;
  collapsed?: boolean;
}

/**
 * The sidebar: three ways in — a new conversation, search, scheduled tasks — and then the
 * conversations themselves. Settings and the theme are in the footer. Nothing else lives here:
 * assistants are settings (技能与工具), and so is everything that used to have its own row.
 */
const Sider: React.FC<SiderProps> = ({ onSessionClick, collapsed = false }) => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const location = useLocation();
  const { pathname, search, hash } = location;

  const navigate = useNavigate();
  const { closePreview } = usePreviewContext();
  const { theme, setTheme } = useThemeContext();
  const [isBatchMode, setIsBatchMode] = useState(false);
  const isSettings = pathname.startsWith('/settings');
  const lastNonSettingsPathRef = useRef('/guid');

  useEffect(() => {
    if (!pathname.startsWith('/settings')) {
      lastNonSettingsPathRef.current = `${pathname}${search}${hash}`;
    }
  }, [pathname, search, hash]);

  const handleNewChat = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    setIsBatchMode(false);
    Promise.resolve(navigate('/guid', { state: { resetAssistant: true } })).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleSettingsClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    if (isSettings) {
      const target = lastNonSettingsPathRef.current || '/guid';
      Promise.resolve(navigate(target)).catch((error) => {
        console.error('Navigation failed:', error);
      });
    } else {
      Promise.resolve(navigate(SETTINGS_HOME)).catch((error) => {
        console.error('Navigation failed:', error);
      });
    }
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleConversationSelect = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    // Do NOT call closePreview() here. conversation/index.tsx calls
    // closePreviewIfScopeChanged() once the conversation data loads, which
    // keeps the preview open when switching between conversations of the same
    // scope and closes it only when the scope (today = workspace) actually changes.
    setIsBatchMode(false);
  };

  // The palette moved to a conversation or a settings page: tidy up as a click in the list would.
  const handlePaletteNavigate = () => {
    handleConversationSelect();
    onSessionClick?.();
  };

  const handleScheduledClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    setIsBatchMode(false);
    Promise.resolve(navigate('/scheduled')).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleQuickThemeToggle = () => {
    void setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  const tooltipEnabled = collapsed && !isMobile;
  const siderTooltipProps = getSiderTooltipProps(tooltipEnabled);
  // Collapsed on a desktop, the sidebar is a rail: its ways in and its footer, each an icon with a tooltip, and no
  // conversations (a column of first letters says too little to pick one by).
  const rail = collapsed && !isMobile;

  const nativeOn = useNativeEnabled() === true;
  const workspaceHistoryProps = {
    collapsed,
    tooltipEnabled,
    onSessionClick,
    batchMode: isBatchMode,
    onBatchModeChange: setIsBatchMode,
    // Conversations on the native host, while it is on: nothing otherwise. The list under it has no conversations of
    // its own then (a new install never has any), and its placeholder would say there are none above it.
    afterPinnedContent: <NativeSiderGroup onSessionClick={onSessionClick} />,
    hideEmptyState: nativeOn,
  };

  return (
    <div className='size-full flex flex-col'>
      {/* Main content area */}
      <div className='flex-1 min-h-0 overflow-hidden'>
        {isSettings ? (
          <Suspense fallback={<div className='size-full' />}>
            <SettingsSider collapsed={collapsed} tooltipEnabled={tooltipEnabled} />
          </Suspense>
        ) : (
          <div className='size-full flex flex-col gap-2px'>
            {/* 1 — a new conversation */}
            <SiderToolbar
              isMobile={isMobile}
              isBatchMode={isBatchMode}
              collapsed={collapsed}
              siderTooltipProps={siderTooltipProps}
              onNewChat={handleNewChat}
              onToggleBatchMode={() => setIsBatchMode((prev) => !prev)}
            />
            {/* 2 — search, in the sidebar on every size: it is one of the three ways in. It opens the palette. */}
            <SiderSearchEntry isMobile={isMobile} collapsed={collapsed} siderTooltipProps={siderTooltipProps} />
            {/* 3 — scheduled tasks */}
            <SiderScheduledEntry
              isMobile={isMobile}
              isActive={pathname === '/scheduled'}
              collapsed={collapsed}
              siderTooltipProps={siderTooltipProps}
              onClick={handleScheduledClick}
            />
            {rail ? null : (
              <>
                {/* The one hairline in the sidebar: above it the ways in, below it the conversations. */}
                <div className='shrink-0 mt-8px mb-2px mx-8px h-1px bg-[var(--color-border-2)]' />
                {/* Scrollable content: pinned → projects → conversations */}
                <div className={classNames('flex-1 min-h-0 overflow-y-auto', siderStyles.scrollArea)}>
                  <Suspense fallback={<div className='min-h-200px' />}>
                    <WorkspaceGroupedHistory {...workspaceHistoryProps} />
                  </Suspense>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {/* Cmd/Ctrl+K on every page, the settings included, which is why it lives here and not in the search entry. */}
      <CommandPalette onNavigate={handlePaletteNavigate} />
      {/* Footer: settings (or back out of them), and the theme. */}
      <SiderFooter
        isMobile={isMobile}
        isSettings={isSettings}
        collapsed={collapsed}
        theme={theme}
        siderTooltipProps={siderTooltipProps}
        onSettingsClick={handleSettingsClick}
        onThemeToggle={handleQuickThemeToggle}
      />
    </div>
  );
};

export default Sider;
