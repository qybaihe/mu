/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsTabNavigateProvider } from '@/renderer/components/settings/SettingsModal/settingsViewContext';

const hooks = vi.hoisted(() => ({
  modelListWithImage: [] as unknown[],
  mcpServers: [] as unknown[],
  getClientBusinessSetting: vi.fn(() => Promise.resolve(undefined)),
  t: vi.fn((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: hooks.t }),
}));

vi.mock('@/renderer/components/base/MuScrollArea', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/base/MuSelect', () => {
  const Select = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { default: Object.assign(Select, { OptGroup: Select, Option: Select }) };
});

vi.mock('@/renderer/components/base/TalkToButlerButton', () => ({
  default: () => <div>TalkToButlerButton</div>,
}));

vi.mock('@/renderer/pages/settings/components/AddMcpServerModal', () => ({
  default: () => null,
}));

vi.mock('@/renderer/pages/settings/ToolsSettings/McpServerItem', () => ({
  default: () => null,
}));

vi.mock('@/renderer/hooks/agent/useConfigModelListWithImage', () => ({
  default: () => ({ modelListWithImage: hooks.modelListWithImage }),
}));

vi.mock('@/renderer/hooks/mcp', () => ({
  useMcpServers: () => ({
    mcpServers: hooks.mcpServers,
    extensionMcpServers: [],
    saveMcpServers: vi.fn(() => Promise.resolve()),
    setMcpServers: vi.fn(),
    isMcpServersLoading: false,
  }),
  useMcpConnection: () => ({ testingServers: {}, handleTestMcpConnection: vi.fn(), handleTestMcpConnections: vi.fn() }),
  useMcpModal: () => ({
    showMcpModal: false,
    editingMcpServer: undefined,
    deleteConfirmVisible: false,
    serverToDelete: undefined,
    mcpCollapseKey: [],
    showAddMcpModal: vi.fn(),
    showEditMcpModal: vi.fn(),
    hideMcpModal: vi.fn(),
    showDeleteConfirm: vi.fn(),
    hideDeleteConfirm: vi.fn(),
    toggleServerCollapse: vi.fn(),
  }),
  useMcpServerCRUD: () => ({
    handleAddMcpServer: vi.fn(),
    handleBatchImportMcpServers: vi.fn(),
    handleEditMcpServer: vi.fn(),
    handleDeleteMcpServer: vi.fn(),
  }),
  useMcpOAuth: () => ({
    oauthStatus: {},
    loggingIn: {},
    checkOAuthStatus: vi.fn(),
    markLoginRequired: vi.fn(),
    clearLoginRequired: vi.fn(),
    login: vi.fn(),
  }),
  useMountedMessage: (m: unknown) => m,
}));

vi.mock('@/renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: hooks.getClientBusinessSetting,
  setClientBusinessSetting: vi.fn(() => Promise.resolve()),
  removeClientBusinessSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: {},
}));

import ToolsModalContent from '@/renderer/components/settings/SettingsModal/contents/ToolsModalContent';
import { BUILTIN_MCP_SERVER_NAMES } from '@/common/platform/legacyNames';

describe('ToolsModalContent image model guide', () => {
  beforeEach(() => {
    hooks.modelListWithImage = [];
    hooks.mcpServers = [];
    hooks.getClientBusinessSetting.mockClear();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a "go to configure" text button that opens the providers page', async () => {
    const navigateToTab = vi.fn();
    render(
      <SettingsTabNavigateProvider value={navigateToTab}>
        <ToolsModalContent />
      </SettingsTabNavigateProvider>
    );

    // A text button, not an underlined link: it navigates. It is in the text colour and ends in a chevron, so it
    // does not read as more of the sentence before it.
    const button = await screen.findByRole('button', { name: 'settings.goToModelSettings' });
    expect(button.className).toContain('!text-t-primary');
    expect(within(button).getByTestId('go-to-model-settings-chevron')).toBeInTheDocument();
    fireEvent.click(button);

    await waitFor(() => expect(navigateToTab).toHaveBeenCalledWith('providers'));
  });

  it('names the image generation switch after its row', async () => {
    render(<ToolsModalContent />);
    expect(await screen.findByRole('switch', { name: 'settings.imageGeneration' })).toBeInTheDocument();
  });

  it('renders the guide text as plain text (no link) when no tab navigator is provided', async () => {
    const { container } = render(<ToolsModalContent />);

    // The empty-state hint still shows the go-to-configure wording, but nothing to click.
    await waitFor(() => expect(container.textContent).toContain('settings.goToModelSettings'));
    expect(screen.queryByRole('button', { name: 'settings.goToModelSettings' })).toBeNull();
  });
});

describe('ToolsModalContent image model that no longer resolves', () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.t.mockClear();
    hooks.modelListWithImage = [
      {
        id: 'provider-1',
        name: 'Gemini',
        platform: 'gemini',
        base_url: '',
        api_key: 'key',
        models: ['gemini-2.5-flash-image'],
      },
    ];
    hooks.mcpServers = [
      {
        id: 'builtin-image-gen',
        name: BUILTIN_MCP_SERVER_NAMES.imageGeneration,
        builtin: true,
        enabled: false,
        transport: { type: 'stdio', command: 'node', args: [], env: {} },
      },
    ];
    hooks.getClientBusinessSetting.mockResolvedValueOnce({
      id: 'provider-1',
      name: 'Gemini',
      platform: 'gemini',
      base_url: '',
      api_key: '',
      use_model: 'retired-image-model',
    } as never);
  });

  afterEach(() => {
    cleanup();
    consoleError.mockRestore();
  });

  it('fails with the translated reason, not the English log text', async () => {
    render(<ToolsModalContent />);

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to sync image generation MCP env after provider change:',
        expect.any(Error)
      )
    );
    const failure = consoleError.mock.calls.find(
      ([label]) => label === 'Failed to sync image generation MCP env after provider change:'
    )?.[1] as Error;
    expect(failure.message).toBe('settings.imageGenErrors.modelNotFound');
    expect(hooks.t).toHaveBeenCalledWith('settings.imageGenErrors.modelNotFound', {
      model: 'retired-image-model',
      provider: 'Gemini',
    });
  });
});
