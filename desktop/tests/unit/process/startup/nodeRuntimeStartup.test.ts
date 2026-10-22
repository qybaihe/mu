import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  focus: vi.fn(),
  language: vi.fn(async (): Promise<string | undefined> => undefined),
  translatorFor: vi.fn(
    async (language: string) => (key: string, options?: Record<string, unknown>) =>
      `${language}:${key}${options ? ` ${JSON.stringify(options)}` : ''}`
  ),
}));

vi.mock('electron', () => ({
  app: { focus: mocks.focus },
  dialog: { showMessageBox: mocks.showMessageBox },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock('@process/services/i18n', () => ({ translatorFor: mocks.translatorFor }));
vi.mock('@process/utils/initStorage', () => ({ ProcessConfig: { get: mocks.language } }));

import { managedNodeRuntime, megabytes } from '@/process/startup/nodeRuntimeConsent';
import { planStartupNodeRuntime } from '@/process/startup/nodeRuntimeStartup';

const supported = managedNodeRuntime('/data', process.platform, process.arch) !== undefined;

describe.skipIf(!supported)('planStartupNodeRuntime', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-node-runtime-'));
    vi.stubEnv('MU_E2E_TEST', '');
    vi.stubEnv('MU_NODE_RUNTIME', '');
    mocks.showMessageBox.mockReset();
    mocks.focus.mockReset();
    mocks.language.mockReset();
    mocks.language.mockResolvedValue(undefined);
    mocks.translatorFor.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('says what comes from where, how large, and to which folder, with 下载 first', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });

    await expect(planStartupNodeRuntime({ dataDir, isPackaged: false, systemLocale: 'zh-CN' })).resolves.toBe(
      'download'
    );

    const runtime = managedNodeRuntime(dataDir, process.platform, process.arch)!;
    expect(mocks.focus).toHaveBeenCalledWith({ steal: true });
    expect(mocks.translatorFor).toHaveBeenCalledWith('zh-CN');
    const [options] = mocks.showMessageBox.mock.calls[0] as [Electron.MessageBoxOptions];
    expect(options.buttons).toEqual(['zh-CN:common.nodeRuntime.download', 'zh-CN:common.nodeRuntime.later']);
    expect(options).toMatchObject({ defaultId: 0, cancelId: 1, noLink: true });
    expect(options.detail).toBe(
      `zh-CN:common.nodeRuntime.detail ${JSON.stringify({
        version: runtime.version,
        size: megabytes(runtime.bytes),
        folder: runtime.dir,
      })}`
    );
  });

  it('starts without the runtime on 稍后 or when the dialog is dismissed', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    await expect(planStartupNodeRuntime({ dataDir, isPackaged: false, systemLocale: 'en-US' })).resolves.toBe('later');
  });

  it('asks in the app language saved on this computer', async () => {
    mocks.language.mockResolvedValue('ja-JP');
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    await planStartupNodeRuntime({ dataDir, isPackaged: false, systemLocale: 'en-US' });
    expect(mocks.translatorFor).toHaveBeenCalledWith('ja-JP');
  });

  it('asks nothing once the runtime is in place, or in a packaged app', async () => {
    const runtime = managedNodeRuntime(dataDir, process.platform, process.arch)!;
    const node = path.join(runtime.dir, process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'));
    await expect(planStartupNodeRuntime({ dataDir, isPackaged: true, systemLocale: 'en-US' })).resolves.toBe('ready');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '');
    await expect(planStartupNodeRuntime({ dataDir, isPackaged: false, systemLocale: 'en-US' })).resolves.toBe('ready');
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('downloads nothing in an automated run unless MU_NODE_RUNTIME says so', async () => {
    vi.stubEnv('MU_E2E_TEST', '1');
    await expect(planStartupNodeRuntime({ dataDir, isPackaged: false, systemLocale: 'en-US' })).resolves.toBe('later');
    vi.stubEnv('MU_NODE_RUNTIME', 'download');
    await expect(planStartupNodeRuntime({ dataDir, isPackaged: false, systemLocale: 'en-US' })).resolves.toBe(
      'download'
    );
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });
});
