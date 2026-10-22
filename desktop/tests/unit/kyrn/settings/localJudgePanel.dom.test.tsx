import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { LAYA_ONNX_PAGE, LAYA_ONNX_REVISION } from '@/common/kyrn/layaOnnx';
import type { LocalJudgeState } from '@/common/kyrn/localJudge';
import type { Result } from '@/common/kyrn/types';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import LocalJudgePanel from '@/renderer/pages/settings/KyrnSettings/sections/LocalJudgePanel';

const bridge = vi.hoisted(() => ({ localJudgeState: vi.fn(), localJudgeRun: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: {
    localJudgeState: { invoke: bridge.localJudgeState },
    localJudgeRun: { invoke: bridge.localJudgeRun },
  },
  unwrap: <T,>(result: Result<T>) => {
    if (!result.ok) throw Object.assign(new Error(result.error), result);
    return result.data;
  },
}));
const outside = vi.hoisted(() => ({ open: vi.fn(), copy: vi.fn(), copied: vi.fn() }));
vi.mock('@/renderer/utils/platform', () => ({ openExternalUrl: outside.open }));
vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: outside.copy }));
// The real toast renders with the legacy ReactDOM.render, which this React has not.
vi.mock('@arco-design/web-react', async (actual) => ({
  ...(await actual<typeof import('@arco-design/web-react')>()),
  Message: { success: outside.copied, error: vi.fn() },
}));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { common: enCommon, mu: enMu } } },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const JUDGE_URL = 'http://127.0.0.1:47823';
const FOLDER = '/home/someone/.mu/local-judge/laya-multilingual-onnx';
const ALL = [
  'model.onnx',
  'onnx_config.json',
  'rl_agent_config.json',
  'tokenizer/tokenizer.json',
  'tokenizer/tokenizer_config.json',
];

function onnx(patch: Partial<LocalJudgeState> = {}): { ok: true; data: LocalJudgeState } {
  return {
    ok: true,
    data: {
      support: 'ok',
      runtime: 'onnx',
      installed: false,
      running: false,
      url: JUDGE_URL,
      model: { folder: FOLDER, missing: ALL, wrong: [] },
      ...patch,
    },
  };
}

function panel() {
  render(
    <I18nextProvider i18n={i18n}>
      <LocalJudgePanel />
    </I18nextProvider>
  );
  return screen.findByTestId('mu-laya');
}

describe('Laya on Windows and Linux, where the app runs the ONNX model itself', () => {
  it('never downloads the model: it links to Hugging Face, names the folder and the command', async () => {
    bridge.localJudgeState.mockResolvedValue(onnx());
    const view = await panel();
    await waitFor(() => expect(view).toHaveTextContent('about 681 MB'));
    expect(view).toHaveTextContent("mu doesn't download it for you");
    expect(view).toHaveTextContent(`Model folder: ${FOLDER}`);
    // Every file is missing: no list of five names, the folder says it.
    expect(view).not.toHaveTextContent('Still missing');
    const command = within(view).getByTestId('mu-laya-command');
    expect(command).toHaveTextContent(`--revision ${LAYA_ONNX_REVISION}`);
    expect(command).toHaveTextContent(`--local-dir "${FOLDER}"`);
    expect(within(view).queryByTestId('mu-laya-install')).not.toBeInTheDocument();

    fireEvent.click(within(view).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(outside.copied).toHaveBeenCalledWith('Copied'));
    expect(outside.copy).toHaveBeenCalledWith(command.textContent);
    fireEvent.click(within(view).getByTestId('mu-laya-page'));
    expect(outside.open).toHaveBeenCalledWith(LAYA_ONNX_PAGE);

    bridge.localJudgeRun.mockResolvedValue(onnx());
    fireEvent.click(within(view).getByTestId('mu-laya-locate'));
    await waitFor(() => expect(bridge.localJudgeRun).toHaveBeenCalledWith({ action: 'locate', consent: false }));
    expect(bridge.localJudgeRun).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'setup' }));
  });

  it('names the files still missing and the ones to download again', async () => {
    bridge.localJudgeState.mockResolvedValue(
      onnx({ model: { folder: FOLDER, missing: ['model.onnx'], wrong: ['tokenizer/tokenizer.json'] } })
    );
    const view = await panel();
    await waitFor(() => expect(view).toHaveTextContent('Still missing: model.onnx'));
    expect(view).toHaveTextContent('Download them again: tokenizer/tokenizer.json');
  });

  it('checks and starts the model, can stop a start that takes long, and words why it failed', async () => {
    bridge.localJudgeState.mockResolvedValue(onnx({ model: { folder: FOLDER, missing: [], wrong: [] } }));
    const task = { id: 1, action: 'start' as const, phase: 'running' as const, output: [] };
    bridge.localJudgeRun.mockResolvedValue(onnx({ task }));
    const view = await panel();
    fireEvent.click(await within(view).findByTestId('mu-laya-check'));
    await waitFor(() => expect(bridge.localJudgeRun).toHaveBeenCalledWith({ action: 'start', consent: false }));
    await waitFor(() => expect(view).toHaveTextContent('Checking the model and starting Laya.'));
    expect(within(view).getByTestId('mu-laya-stop')).toBeInTheDocument();

    bridge.localJudgeState.mockResolvedValue(onnx({ task: { ...task, phase: 'failed', problem: 'port' } }));
    await waitFor(() => expect(within(view).getByTestId('mu-laya-failed')).toHaveTextContent('port (47823)'), {
      timeout: 3000,
    });
  });

  it('says a checked model that is not running starts by itself when Laya is the judge', async () => {
    bridge.localJudgeState.mockResolvedValue(
      onnx({ installed: true, model: { folder: FOLDER, missing: [], wrong: [] } })
    );
    const view = await panel();
    await waitFor(() => expect(view).toHaveTextContent('mu starts it automatically when the app opens'));
    expect(within(view).getByTestId('mu-laya-start')).toBeInTheDocument();
    expect(within(view).queryByTestId('mu-laya-model')).not.toBeInTheDocument();
  });
});
