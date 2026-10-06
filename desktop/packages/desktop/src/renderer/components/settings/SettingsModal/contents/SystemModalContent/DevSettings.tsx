/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { globalNavigate } from '@/renderer/utils/navigation';
import { Button, Collapse, Message, Tooltip } from '@arco-design/web-react';
import { Copy, Down, Link } from '@icon-park/react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import PreferenceRow from './PreferenceRow';

/**
 * The developer page: the developer tools and the details of the agent's connection to the in-app browser (its address
 * and the MCP configurations that reach it), in a build run from its sources only; an installed app says so instead.
 * Whether that connection runs at all is the in-app browser page's switch, the one switch for it, which every build
 * shows.
 */
const DevSettings: React.FC = () => {
  const { t } = useTranslation();
  const { data: cdpStatus, isLoading } = useSWR('cdp.status', () => ipcBridge.application.getCdpStatus.invoke());
  const [isDevToolsOpen, setIsDevToolsOpen] = useState(false);
  const [expandedMcpKeys, setExpandedMcpKeys] = useState<string[]>([]);
  const hasManualDevToolsToggleRef = useRef(false);

  const status = cdpStatus?.data;

  // Initialize DevTools state from Main Process
  useEffect(() => {
    if (isLoading || status?.isDevMode !== true) return;

    ipcBridge.application.isDevToolsOpened
      .invoke()
      .then((isOpen) => {
        // Avoid overwriting a user-triggered toggle with a stale initial read.
        if (!hasManualDevToolsToggleRef.current) {
          setIsDevToolsOpen(isOpen);
        }
      })
      .catch((error) => console.error('Failed to get DevTools state:', error));

    const unsubscribe = ipcBridge.application.devToolsStateChanged.on((event) => {
      setIsDevToolsOpen(event.isOpen);
    });

    return () => unsubscribe();
  }, [isLoading, status?.isDevMode]);

  const handleToggleDevTools = () => {
    hasManualDevToolsToggleRef.current = true;
    ipcBridge.application.openDevTools
      .invoke()
      .then((isOpen) => setIsDevToolsOpen(Boolean(isOpen)))
      .catch((error) => console.error('Failed to toggle dev tools:', error));
  };

  const openCdpUrl = () => {
    if (status?.port) {
      const url = `http://127.0.0.1:${status.port}/json`;
      ipcBridge.shell.openExternal.invoke(url).catch(console.error);
    }
  };

  const copyCdpUrl = () => {
    if (status?.port) {
      const url = `http://127.0.0.1:${status.port}`;
      void navigator.clipboard.writeText(url).then(() => {
        Message.success(t('common.copySuccess'));
      });
    }
  };

  const copyMcpConfig = () => {
    if (status?.port) {
      const config = `{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@0.16.0",
        "--browser-url=http://127.0.0.1:${status.port}"
      ]
    }
  }
}`;
      void navigator.clipboard.writeText(config).then(() => {
        Message.success(t('common.copySuccess'));
      });
    }
  };

  const copyPlaywrightMcpConfig = () => {
    if (status?.port) {
      const config = `{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--cdp-endpoint",
        "http://127.0.0.1:${status.port}"
      ]
    }
  }
}`;
      void navigator.clipboard.writeText(config).then(() => {
        Message.success(t('common.copySuccess'));
      });
    }
  };

  // A build run from its sources only. While the status is loading or cannot be read nothing is shown; an installed app,
  // which lists no developer page but can still be sent to it by a link, says why the page is empty.
  if (status?.isDevMode === false) {
    return <div className='text-13px leading-20px text-t-secondary'>{t('settings.developer.devOnly')}</div>;
  }
  if (status?.isDevMode !== true) {
    return null;
  }

  return (
    // The same quiet lists as the rest of the page: dev builds only, but no boxes there either.
    <div className='flex flex-col gap-16px' data-testid='dev-settings'>
      {/* DevTools toggle */}
      <div className='settings-list'>
        <PreferenceRow label={t('settings.devTools')}>
          <Button size='small' type={isDevToolsOpen ? 'primary' : 'secondary'} onClick={handleToggleDevTools}>
            {isDevToolsOpen ? t('settings.closeDevTools') : t('settings.openDevTools')}
          </Button>
        </PreferenceRow>
      </div>

      {/* The agent's connection to the in-app browser: what it is, and its details while it runs. */}
      <section className='settings-group'>
        <h3 className='settings-group__title'>{t('settings.cdp.title')}</h3>
        <div className='settings-list'>
          <PreferenceRow label={t('settings.cdp.connection')} description={t('settings.cdp.about')}>
            <Button size='small' onClick={() => globalNavigate('/settings/browser')}>
              {t('settings.cdp.openBrowserSettings')}
            </Button>
          </PreferenceRow>

          {status.port ? (
            <div className='flex flex-col gap-8px py-12px'>
              <div className='flex items-center gap-8px'>
                <div className='flex-1'>
                  <div className='text-12px text-t-tertiary'>{t('settings.cdp.currentPort')}</div>
                  <div className='text-14px text-t-primary font-medium'>http://127.0.0.1:{status.port}</div>
                </div>
                <Tooltip content={t('settings.cdp.openInBrowser')}>
                  <Button
                    type='text'
                    size='small'
                    aria-label={t('settings.cdp.openInBrowser')}
                    icon={<Link theme='outline' size='16' />}
                    onClick={openCdpUrl}
                  />
                </Tooltip>
                <Tooltip content={t('common.copy')}>
                  <Button
                    type='text'
                    size='small'
                    aria-label={t('common.copy')}
                    icon={<Copy theme='outline' size='16' />}
                    onClick={copyCdpUrl}
                  />
                </Tooltip>
              </div>
              <div className='space-y-4px'>
                <div className='text-12px text-t-tertiary mb-4px'>{t('settings.cdp.mcpConfig')}</div>
                <Collapse
                  bordered={false}
                  onChange={(_, keys) => setExpandedMcpKeys(keys as string[])}
                  className='[&_.arco-collapse-item]:!border-none [&_.arco-collapse-item-header]:!px-0 [&_.arco-collapse-item-header]:!py-6px [&_.arco-collapse-item-header]:!bg-transparent [&_.arco-collapse-item-header-title]:!flex-1 [&_.arco-collapse-item-content]:!bg-transparent [&_.arco-collapse-item-content-box]:!px-0 [&_.arco-collapse-item-content-box]:!pt-0 [&_.arco-collapse-item-content-box]:!pb-8px'
                >
                  <Collapse.Item
                    name='chrome-devtools'
                    showExpandIcon={false}
                    header={
                      <div className='flex flex-1 items-center justify-between gap-8px'>
                        <div className='flex-1 min-w-0'>
                          <div className='text-13px text-t-primary font-medium'>chrome-devtools</div>
                          <div className='text-11px text-t-tertiary truncate'>{t('settings.cdp.mcpConfigHint')}</div>
                        </div>
                        <Tooltip content={t('settings.cdp.copyMcpConfig')}>
                          <Button
                            type='text'
                            size='small'
                            aria-label={t('settings.cdp.copyMcpConfig')}
                            icon={<Copy theme='outline' size='16' />}
                            onClick={(e) => {
                              e.stopPropagation();
                              copyMcpConfig();
                            }}
                          />
                        </Tooltip>
                        <Down
                          size='14'
                          className={`text-t-tertiary shrink-0 transition-transform duration-200 ${expandedMcpKeys.includes('chrome-devtools') ? 'rotate-180' : ''}`}
                        />
                      </div>
                    }
                  >
                    <pre className='text-11px text-t-secondary font-mono overflow-x-auto whitespace-pre-wrap break-all m-0 leading-relaxed py-4px px-8px bg-[var(--fill-2)] rounded-6px'>
                      {`{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@0.16.0",
        "--browser-url=http://127.0.0.1:${status.port}"
      ]
    }
  }
}`}
                    </pre>
                  </Collapse.Item>
                  <Collapse.Item
                    name='playwright'
                    showExpandIcon={false}
                    header={
                      <div className='flex flex-1 items-center justify-between gap-8px'>
                        <div className='flex-1 min-w-0'>
                          <div className='text-13px text-t-primary font-medium'>playwright</div>
                          <div className='text-11px text-t-tertiary truncate'>
                            {t('settings.cdp.playwrightMcpConfigHint')}
                          </div>
                        </div>
                        <Tooltip content={t('settings.cdp.copyMcpConfig')}>
                          <Button
                            type='text'
                            size='small'
                            aria-label={t('settings.cdp.copyMcpConfig')}
                            icon={<Copy theme='outline' size='16' />}
                            onClick={(e) => {
                              e.stopPropagation();
                              copyPlaywrightMcpConfig();
                            }}
                          />
                        </Tooltip>
                        <Down
                          size='14'
                          className={`text-t-tertiary shrink-0 transition-transform duration-200 ${expandedMcpKeys.includes('playwright') ? 'rotate-180' : ''}`}
                        />
                      </div>
                    }
                  >
                    <pre className='text-11px text-t-secondary font-mono overflow-x-auto whitespace-pre-wrap break-all m-0 leading-relaxed py-4px px-8px bg-[var(--fill-2)] rounded-6px'>
                      {`{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--cdp-endpoint",
        "http://127.0.0.1:${status.port}"
      ]
    }
  }
}`}
                    </pre>
                  </Collapse.Item>
                </Collapse>
              </div>
            </div>
          ) : (
            <div className='text-12px text-t-tertiary py-12px'>{t('settings.cdp.disabledHint')}</div>
          )}
        </div>
      </section>
    </div>
  );
};

export default DevSettings;
