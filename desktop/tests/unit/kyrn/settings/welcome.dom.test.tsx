import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { KyrnSettings, Result, SaveSettings } from '@/common/kyrn/types';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import enSettings from '@/renderer/services/i18n/locales/en-US/settings.json';
import SettingsArea from '@/renderer/pages/settings/KyrnSettings/SettingsArea';
import Welcome from '@/renderer/pages/welcome';
import { ONBOARDING_KEY } from '@/renderer/pages/welcome/onboarding';
import { useFirstRunWelcome } from '@/renderer/pages/welcome/useFirstRunWelcome';
import { SETTLE_MS } from '@/renderer/pages/welcome/useKeySetup';

const bridge = vi.hoisted(() => ({
  settings: vi.fn(),
  save: vi.fn(),
  availableModels: vi.fn(),
  recheck: vi.fn(),
  testProvider: vi.fn(),
  loginStatus: vi.fn(),
  loginState: vi.fn(),
  loginStart: vi.fn(),
  loginAnswer: vi.fn(),
  loginCancel: vi.fn(),
  loginLogout: vi.fn(),
  localJudgeState: vi.fn(),
  localJudgeRun: vi.fn(),
}));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: {
    settings: { invoke: bridge.settings },
    save: { invoke: bridge.save },
    availableModels: { invoke: bridge.availableModels },
    recheck: { invoke: bridge.recheck },
    testProvider: { invoke: bridge.testProvider },
    loginStatus: { invoke: bridge.loginStatus },
    loginState: { invoke: bridge.loginState },
    loginStart: { invoke: bridge.loginStart },
    loginAnswer: { invoke: bridge.loginAnswer },
    loginCancel: { invoke: bridge.loginCancel },
    loginLogout: { invoke: bridge.loginLogout },
    localJudgeState: { invoke: bridge.localJudgeState },
    localJudgeRun: { invoke: bridge.localJudgeRun },
  },
  // As the real one: a failure keeps the code the store gave it.
  unwrap: <T,>(result: Result<T>) => {
    if (!result.ok) throw Object.assign(new Error(result.error), result);
    return result.data;
  },
}));
// The guide's code, which the first-run check loads before it opens the guide.
const guideCode = vi.hoisted(() => ({ preload: vi.fn() }));
vi.mock('@/renderer/pages/welcome/page', () => ({ WelcomePage: { preload: guideCode.preload } }));
// A page the guide opens in the browser: here, only which one.
const external = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/platform')>()),
  openExternalUrl: external.open,
}));
// The real switcher changes the app's own i18next and writes the setting; here it only has to be there.
vi.mock('@/renderer/components/settings/LanguageSwitcher', () => ({
  default: () => <div data-testid='language-switcher' />,
}));

/** Someone who just installed mu: the built-in judges, no provider, no startup model, no key. */
function newUser(patch: Partial<KyrnSettings> = {}): KyrnSettings {
  return {
    revision: 'r1',
    tiers: ['laya'],
    judges: {
      jev: { type: 'jev', model: 'jev-latest', baseUrl: '', apiKeyEnv: 'TYPESAFE_API_KEY', timeoutMs: 10000 },
      laya: { type: 'local', model: '', baseUrl: 'http://127.0.0.1:47823', apiKeyEnv: '', timeoutMs: 4000 },
    },
    mode: 'shadow',
    betaCompression: false,
    autoCompaction: true,
    maxContextTokens: 0,
    keys: { TYPESAFE_API_KEY: false },
    harness: { status: 'missing' },
    decisionModes: {},
    features: {},
    models: {
      providers: [],
      foreign: [],
      defaults: { provider: '', model: '', thinkingLevel: '' },
      commented: false,
      problem: '',
    },
    permissions: { mode: '', from: 'default' },
    boardModel: { supported: false, model: '' },
    ...patch,
  } as KyrnSettings;
}

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { common: enCommon, mu: enMu, settings: enSettings } } },
    interpolation: { escapeValue: false },
  });
});

beforeEach(() => {
  localStorage.clear();
  guideCode.preload.mockResolvedValue({ default: Welcome });
  bridge.settings.mockResolvedValue({ ok: true, data: newUser() });
  bridge.availableModels.mockResolvedValue({ ok: true, data: { providers: [], thinkingLevels: [] } });
  bridge.recheck.mockResolvedValue({ ok: true, data: undefined });
  bridge.loginStatus.mockResolvedValue({ ok: true, data: { signedIn: [] } });
  bridge.loginState.mockResolvedValue({ ok: true, data: { id: 0, phase: 'idle' } });
  bridge.localJudgeState.mockResolvedValue({
    ok: true,
    data: { support: 'ok', installed: true, running: true, url: 'http://127.0.0.1:47823' },
  });
  bridge.save.mockImplementation(async ({ models, credentials: _credentials, ...input }: SaveSettings) => {
    const base = newUser();
    return { ok: true, data: { ...base, ...input, revision: 'r2', models: { ...base.models, ...models } } };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function at(path: string, element: React.ReactElement) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={path} element={element} />
          <Route path='/guid' element={<div>landing page</div>} />
          <Route path='/welcome' element={<div>the guide</div>} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>
  );
}

describe('a settings section as its own page', () => {
  it('has no second menu, and one click on a judge choice is saved as the one judge', async () => {
    at('/settings/judges', <SettingsArea section='judges' />);
    fireEvent.click(await screen.findByTestId('mu-judge-choice-jev'));
    expect(screen.queryByTestId('mu-nav-judges')).not.toBeInTheDocument();
    expect(screen.getByTestId('mu-judge-choice-jev')).toHaveAttribute('aria-checked', 'true');
    // The chosen one asks for its service and that service's key, and only that.
    expect(within(screen.getByTestId('mu-judge-choice-jev')).getByLabelText('Service')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('TypeSafe API key'), { target: { value: 'jev-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
    const saved = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(saved.tiers).toEqual(['jev']);
    expect(saved.credentials).toEqual([{ name: 'TYPESAFE_API_KEY', value: 'jev-key' }]);
  });

  it('installs Laya with one click, only after the person agrees to the download, and ends with it running', async () => {
    const url = 'http://127.0.0.1:47823';
    const task = {
      id: 1,
      action: 'setup',
      phase: 'running',
      output: ['Resolved 26 packages', 'Downloading coremltools'],
    };
    bridge.localJudgeState.mockResolvedValue({
      ok: true,
      data: { support: 'ok', installed: false, running: false, url },
    });
    bridge.localJudgeRun.mockResolvedValue({
      ok: true,
      data: { support: 'ok', installed: false, running: false, url, task },
    });
    at('/settings/judges', <SettingsArea section='judges' />);
    const panel = await screen.findByTestId('mu-laya');
    await waitFor(() => expect(panel).toHaveTextContent('Not installed yet.'));
    fireEvent.click(within(panel).getByTestId('mu-laya-install'));
    // Nothing is downloaded before the person says yes, and they are told how much.
    expect(await screen.findByText(/downloads about 800 MB from PyPI and Hugging Face/)).toBeInTheDocument();
    expect(bridge.localJudgeRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download and install' }));
    await waitFor(() => expect(bridge.localJudgeRun).toHaveBeenCalledWith({ action: 'setup', consent: true }));
    expect(await within(panel).findByTestId('mu-laya-output')).toHaveTextContent('Downloading coremltools');
    expect(panel).toHaveTextContent('Installing Laya…');
    // Its state is read while it works; the setup goes on to start it.
    bridge.localJudgeState.mockResolvedValue({
      ok: true,
      data: { support: 'ok', installed: true, running: true, url, task: { ...task, action: 'start', phase: 'done' } },
    });
    await waitFor(() => expect(panel).toHaveTextContent('Running on this machine'), { timeout: 3000 });
    expect(within(panel).getByTestId('mu-laya-stop')).toBeInTheDocument();
    expect(within(panel).queryByTestId('mu-laya-output')).not.toBeInTheDocument();
  });

  it('says why Laya cannot be installed on this machine, and where uv comes from', async () => {
    const url = 'http://127.0.0.1:47823';
    bridge.localJudgeState.mockResolvedValue({
      ok: true,
      data: { support: 'uv', installed: false, running: false, url },
    });
    const { unmount } = at('/settings/judges', <SettingsArea section='judges' />);
    const panel = await screen.findByTestId('mu-laya');
    await waitFor(() => expect(panel).toHaveTextContent('Installing needs uv'));
    expect(within(panel).getByTestId('mu-laya-uv')).toBeInTheDocument();
    expect(within(panel).queryByTestId('mu-laya-install')).not.toBeInTheDocument();
    unmount();
    bridge.localJudgeState.mockResolvedValue({
      ok: true,
      data: { support: 'platform', installed: false, running: false, url },
    });
    at('/settings/judges', <SettingsArea section='judges' />);
    const other = await screen.findByTestId('mu-laya');
    await waitFor(() => expect(other).toHaveTextContent('or a Mac with Apple Silicon'));
    expect(within(other).queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the order of several judges under the choice, in the open, each judge by its name', async () => {
    at('/settings/judges', <SettingsArea section='judges' />);
    const tiers = await screen.findByTestId('mu-judge-tiers');
    expect(screen.getByRole('heading', { name: 'Judge tiers' })).toBeInTheDocument();
    expect(within(tiers).getByRole('combobox', { name: 'Order' })).toBeInTheDocument();
    // Its typing input, which takes the focus, says the same.
    expect(within(tiers).getByRole('textbox', { name: 'Order' })).toBeInTheDocument();
    // Laya, the one judge here, needs nothing in the tiers: the choice above installs and starts it.
    const laya = within(tiers).getByTestId('mu-judge-tier-0');
    expect(laya).toHaveTextContent('Tier 1: Local Laya');
    expect(within(laya).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(tiers).queryByTestId('mu-judge-tier-1')).not.toBeInTheDocument();
  });
});

describe('the first-run guide', () => {
  it('tags only the most common way in: the Anthropic tile’s description already names Claude', async () => {
    at('/welcome', <Welcome />);
    fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
    expect(within(await screen.findByTestId('mu-welcome-way-openai')).getByText('Most common')).toBeInTheDocument();
    const anthropic = screen.getByTestId('mu-welcome-way-anthropic');
    expect(anthropic).toHaveTextContent('Claude, and services that speak the Messages format');
    expect(within(anthropic).queryByText('Claude')).not.toBeInTheDocument();
  });

  it('says what mu is, connects an API model, takes a judge key, saves once at the end, and is not shown again', async () => {
    at('/welcome', <Welcome />);
    expect(await screen.findByText('Welcome to mu')).toBeInTheDocument();
    expect(screen.getByText('A check at every step')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-welcome-begin'));
    fireEvent.click(await screen.findByTestId('mu-welcome-way-openai'));
    // Nothing filled in: the step stays and says why, and the field in question is marked.
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    expect(screen.getByTestId('mu-welcome-step-model')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('https://');
    expect(screen.getByLabelText('Base URL')).toHaveClass('arco-input-error');

    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://relay.example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-relay' } });
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'relay-large' } });
    fireEvent.click(screen.getByTestId('mu-welcome-next'));

    await screen.findByTestId('mu-welcome-step-judge');
    fireEvent.click(screen.getByTestId('mu-judge-choice-jev'));
    fireEvent.change(screen.getByLabelText('TypeSafe API key'), { target: { value: 'jev-key' } });
    fireEvent.click(screen.getByTestId('mu-welcome-next'));

    await screen.findByTestId('mu-welcome-step-done');
    expect(screen.getByText('relay / relay-large')).toBeInTheDocument();
    expect(bridge.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mu-welcome-start'));

    expect(await screen.findByText('landing page')).toBeInTheDocument();
    expect(bridge.save).toHaveBeenCalledTimes(1);
    // The home page it lands on offers the model just connected, not 默认模型 until the app starts again.
    await waitFor(() => expect(bridge.recheck).toHaveBeenCalledTimes(1));
    const saved = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(saved.models?.providers).toMatchObject([
      {
        id: 'relay',
        api: 'openai-completions',
        baseUrl: 'https://relay.example.com/v1',
        models: [{ id: 'relay-large' }],
      },
    ]);
    expect(saved.models?.defaults).toMatchObject({ provider: 'relay', model: 'relay-large' });
    expect(saved.tiers).toEqual(['jev']);
    expect(saved.credentials?.map((credential) => credential.name).toSorted()).toEqual([
      'MU_PROVIDER_RELAY_API_KEY',
      'TYPESAFE_API_KEY',
    ]);
    expect(localStorage.getItem(ONBOARDING_KEY)).toBeTruthy();
  });

  it('fills in the one model a connection test found, and leaves a model typed first alone', async () => {
    bridge.testProvider.mockResolvedValue({
      ok: true,
      data: { ok: true, code: 'ok-models', status: 200, latencyMs: 7, detail: '', models: ['relay-large'] },
    });
    at('/welcome', <Welcome />);
    fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
    fireEvent.click(await screen.findByTestId('mu-welcome-way-openai'));
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://relay.example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-relay' } });
    fireEvent.click(screen.getByText('Test connection'));
    await waitFor(() => expect(screen.getByLabelText('Model name')).toHaveValue('relay-large'));

    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'my-model' } });
    fireEvent.click(screen.getByText('Test connection'));
    await waitFor(() => expect(bridge.testProvider).toHaveBeenCalledTimes(2));
    await screen.findByTestId('mu-test-result');
    expect(screen.getByLabelText('Model name')).toHaveValue('my-model');
  });

  it('sets Laya up without its address or a Stop: those are for the settings', async () => {
    at('/welcome', <Welcome />);
    fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
    fireEvent.click(await screen.findByTestId('mu-welcome-skip'));
    await screen.findByTestId('mu-welcome-step-judge');
    // A new user's order starts with Laya: its tile is the chosen one, open.
    const tile = screen.getByTestId('mu-judge-choice-local');
    const panel = await within(tile).findByTestId('mu-laya');
    expect(await within(panel).findByTestId('mu-laya-status')).toHaveTextContent(enMu.judges.laya.running);
    expect(within(panel).queryByTestId('mu-laya-stop')).not.toBeInTheDocument();
    expect(tile).not.toHaveTextContent('127.0.0.1');
  });

  it('picks the service Jev is reached through, and keeps its key under that service’s own name', async () => {
    at('/welcome', <Welcome />);
    fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
    fireEvent.click(await screen.findByTestId('mu-welcome-skip'));
    await screen.findByTestId('mu-welcome-step-judge');
    fireEvent.click(screen.getByTestId('mu-judge-choice-jev'));
    fireEvent.click(screen.getByLabelText('Service'));
    fireEvent.click(await screen.findByText('Vercel AI Gateway', { selector: '.arco-select-option' }));
    fireEvent.change(await screen.findByLabelText('Vercel AI Gateway API key'), { target: { value: 'gateway-key' } });
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    await screen.findByTestId('mu-welcome-step-done');
    fireEvent.click(screen.getByTestId('mu-welcome-start'));
    expect(await screen.findByText('landing page')).toBeInTheDocument();
    const saved = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(saved.tiers).toEqual(['jev-gateway']);
    expect(saved.judges['jev-gateway']).toMatchObject({ type: 'gateway', apiKeyEnv: 'AI_GATEWAY_API_KEY' });
    expect(saved.credentials).toEqual([{ name: 'AI_GATEWAY_API_KEY', value: 'gateway-key' }]);
  });

  it('speaks OpenAI Responses when that is chosen', async () => {
    at('/welcome', <Welcome />);
    fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
    fireEvent.click(await screen.findByTestId('mu-welcome-way-openai'));
    fireEvent.click(screen.getByText('Responses'));
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://relay.example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-relay' } });
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'relay-large' } });
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    fireEvent.click(await screen.findByTestId('mu-welcome-next'));
    fireEvent.click(await screen.findByTestId('mu-welcome-start'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
    const saved = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(saved.models?.providers?.[0]).toMatchObject({ id: 'relay', api: 'openai-responses' });
  });

  it('names a service on this machine by its address, not by the English word of its id', async () => {
    at('/welcome', <Welcome />);
    fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
    fireEvent.click(await screen.findByTestId('mu-welcome-way-openai'));
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'qwen3' } });
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    fireEvent.click(await screen.findByTestId('mu-welcome-next'));
    await screen.findByTestId('mu-welcome-step-done');
    expect(screen.getByText('localhost:11434 / qwen3')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-welcome-start'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
    const saved = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(saved.models?.providers?.[0]).toMatchObject({ id: 'local', name: 'localhost:11434' });
  });

  it('offers the language before the first question, and on every step after it', async () => {
    at('/welcome', <Welcome />);
    const language = await screen.findByTestId('mu-welcome-language');
    expect(language).toHaveTextContent('Language');
    expect(within(language).getByTestId('language-switcher')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-welcome-begin'));
    await screen.findByTestId('mu-welcome-step-model');
    expect(screen.getByTestId('mu-welcome-language')).toBeInTheDocument();
  });

  it('says in the reader’s words why the settings did not load, and why saving did not work', async () => {
    bridge.settings.mockResolvedValueOnce({
      ok: false,
      code: 'unreadable',
      params: { file: '/home/me/.mu/agent/settings.json' },
      error: "EACCES: permission denied, open '/home/me/.mu/agent/settings.json'",
    });
    at('/welcome', <Welcome />);
    expect(await screen.findByText('The settings could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('/home/me/.mu/agent/settings.json could not be read.')).toBeInTheDocument();
    expect(screen.getByTestId('mu-error-detail')).toHaveTextContent('EACCES: permission denied');
    fireEvent.click(screen.getByText('Reload'));

    fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
    fireEvent.click(await screen.findByTestId('mu-welcome-way-openai'));
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://relay.example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk relay' } });
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'relay-large' } });
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    fireEvent.click(await screen.findByTestId('mu-welcome-next'));
    bridge.save.mockResolvedValueOnce({ ok: false, code: 'credential', error: 'Invalid credential' });
    fireEvent.click(await screen.findByTestId('mu-welcome-start'));
    expect(
      await screen.findByText(
        'Saving did not work: The key contains characters a key cannot have, such as spaces, quotes or line breaks. Paste it again.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Invalid credential/)).not.toBeInTheDocument();
  });

  it('skips a step with a quiet text button, even after a way is picked', async () => {
    at('/welcome', <Welcome />);
    fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
    fireEvent.click(await screen.findByTestId('mu-welcome-way-openai'));
    // The way on is the primary button; skipping is not.
    expect(screen.getByTestId('mu-welcome-next')).toHaveClass('arco-btn-primary');
    expect(screen.getByTestId('mu-welcome-skip')).not.toHaveClass('arco-btn');
    fireEvent.click(screen.getByTestId('mu-welcome-skip'));
    expect(await screen.findByTestId('mu-welcome-step-judge')).toBeInTheDocument();
    expect(bridge.save).not.toHaveBeenCalled();
  });

  it('can be skipped from the first page without saving anything', async () => {
    at('/welcome', <Welcome />);
    fireEvent.click(await screen.findByText('Skip setup'));
    expect(await screen.findByText('landing page')).toBeInTheDocument();
    expect(bridge.save).not.toHaveBeenCalled();
    expect(bridge.recheck).not.toHaveBeenCalled();
    expect(localStorage.getItem(ONBOARDING_KEY)).toBeTruthy();
  });

  it('opens by itself only for someone without a startup model', async () => {
    function Landing() {
      useFirstRunWelcome();
      return <div>landing</div>;
    }
    at('/guid', <Landing />);
    expect(await screen.findByText('the guide')).toBeInTheDocument();
    cleanup();
    guideCode.preload.mockClear();

    bridge.settings.mockResolvedValue({
      ok: true,
      data: newUser({
        models: { ...newUser().models, defaults: { provider: 'relay', model: 'relay-large', thinkingLevel: '' } },
      }),
    });
    at('/guid', <Landing />);
    await waitFor(() => expect(localStorage.getItem(ONBOARDING_KEY)).toBeTruthy());
    expect(screen.getByText('landing')).toBeInTheDocument();
    expect(screen.queryByText('the guide')).not.toBeInTheDocument();
    expect(guideCode.preload).not.toHaveBeenCalled();
  });

  it('opens the guide only once its code is in, so no route loader shows before it', async () => {
    const code = Promise.withResolvers<{ default: typeof Welcome }>();
    guideCode.preload.mockReturnValue(code.promise);
    function Landing() {
      useFirstRunWelcome();
      return <div>landing</div>;
    }
    at('/guid', <Landing />);
    await waitFor(() => expect(guideCode.preload).toHaveBeenCalled());
    expect(screen.getByText('landing')).toBeInTheDocument();
    code.resolve({ default: Welcome });
    expect(await screen.findByText('the guide')).toBeInTheDocument();
    cleanup();

    // Code that did not load is no reason to skip the guide: its route loads it again.
    guideCode.preload.mockRejectedValue(new TypeError('Failed to fetch dynamically imported module'));
    at('/guid', <Landing />);
    expect(await screen.findByText('the guide')).toBeInTheDocument();
  });

  it('leaves a page other than home alone: a reload or a link opened it', async () => {
    function Elsewhere() {
      useFirstRunWelcome();
      return <div>scheduled tasks</div>;
    }
    at('/scheduled', <Elsewhere />);
    await waitFor(() => expect(guideCode.preload).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText('scheduled tasks')).toBeInTheDocument();
    expect(screen.queryByText('the guide')).not.toBeInTheDocument();
    // Not seen: the guide still opens from home.
    expect(localStorage.getItem(ONBOARDING_KEY)).toBeNull();
  });
});

describe('signing in with a subscription', () => {
  const running = { id: 1, provider: 'openai-codex', phase: 'running', url: 'https://auth.openai.com/oauth/authorize' };
  const toSubscriptions = async () => {
    at('/welcome', <Welcome />);
    fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
    fireEvent.click(await screen.findByTestId('mu-welcome-way-signedIn'));
  };
  const toSummary = async () => {
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    fireEvent.click(await screen.findByTestId('mu-welcome-next'));
    await screen.findByTestId('mu-welcome-step-done');
  };

  it('signs in in the browser, takes a pasted code only when asked for it, and starts on that account', async () => {
    await toSubscriptions();
    bridge.loginStart.mockResolvedValue({ ok: true, data: running });
    bridge.loginState.mockResolvedValue({
      ok: true,
      data: { ...running, prompt: { type: 'manual_code', message: 'Paste the code' } },
    });
    fireEvent.click(await screen.findByTestId('mu-login-openai-codex'));
    expect(bridge.loginStart).toHaveBeenCalledWith({ provider: 'openai-codex' });
    expect(await screen.findByTestId('mu-login-waiting')).toHaveTextContent('ChatGPT');

    // The browser finishes it by itself; the code field is the way out, not the first thing shown.
    fireEvent.click(await screen.findByTestId('mu-login-paste', {}, { timeout: 3000 }));
    fireEvent.change(screen.getByLabelText('Authorization code'), { target: { value: ' the-code ' } });
    bridge.loginAnswer.mockResolvedValue({ ok: true, data: running });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(bridge.loginAnswer).toHaveBeenCalledWith({ id: 1, value: 'the-code' }));

    bridge.loginState.mockResolvedValue({
      ok: true,
      data: {
        ...running,
        phase: 'done',
        models: [
          { id: 'gpt-5.5', name: 'GPT-5.5' },
          { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
        ],
      },
    });
    await waitFor(() => expect(screen.getByTestId('mu-login-openai-codex')).toHaveTextContent('Signed in'), {
      timeout: 3000,
    });
    expect(screen.queryByTestId('mu-login-waiting')).not.toBeInTheDocument();

    await toSummary();
    expect(screen.getByText('ChatGPT / gpt-5.5')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-welcome-start'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
    const saved = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(saved.models?.defaults).toMatchObject({ provider: 'openai-codex', model: 'gpt-5.5' });
    expect(saved.models?.providers ?? []).toEqual([]);
    expect(saved.credentials ?? []).toEqual([]);
  });

  it('offers an account signed in before at once, without a new sign-in', async () => {
    bridge.loginStatus.mockResolvedValue({
      ok: true,
      data: { signedIn: [{ provider: 'anthropic', models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }] }] },
    });
    await toSubscriptions();
    await waitFor(() => expect(screen.getByTestId('mu-login-anthropic')).toHaveTextContent('Signed in'));
    fireEvent.click(screen.getByTestId('mu-login-anthropic'));
    expect(bridge.loginStart).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    await toSummary();
    expect(screen.getByText('Claude / claude-opus-4-8')).toBeInTheDocument();
  });

  it('offers Google only when the harness does, and asks about the risk before anything opens', async () => {
    await toSubscriptions();
    await waitFor(() => expect(bridge.loginStatus).toHaveBeenCalled());
    expect(screen.getByTestId('mu-login-xai')).toHaveTextContent('Grok');
    expect(screen.queryByTestId('mu-login-google-gemini-cli')).not.toBeInTheDocument();
    cleanup();

    bridge.loginStatus.mockResolvedValue({
      ok: true,
      data: { signedIn: [], offered: ['openai-codex', 'anthropic', 'xai', 'google-gemini-cli', 'google-antigravity'] },
    });
    await toSubscriptions();
    const google = await screen.findByTestId('mu-login-google-gemini-cli');
    expect(google).toHaveTextContent('Gemini CLI');
    expect(google).toHaveTextContent('Experimental');
    expect(screen.getByTestId('mu-login-google-antigravity')).toHaveTextContent('Antigravity');

    const asking = {
      id: 3,
      provider: 'google-gemini-cli',
      phase: 'running',
      prompt: {
        type: 'select',
        message: 'Experimental: this signs in through Gemini CLI’s own login…',
        options: [
          { id: 'continue', label: 'I understand the risk, sign in' },
          { id: 'cancel', label: 'Cancel' },
        ],
      },
    };
    bridge.loginStart.mockResolvedValue({ ok: true, data: asking });
    bridge.loginState.mockResolvedValue({ ok: true, data: asking });
    fireEvent.click(google);
    const risk = await screen.findByTestId('mu-login-risk');
    expect(risk).toHaveTextContent('the login Google made for Gemini CLI itself');
    expect(risk).toHaveTextContent('Gemini API key');
    expect(screen.queryByTestId('mu-login-waiting')).not.toBeInTheDocument();
    // Nothing is answered for the person.
    expect(bridge.loginAnswer).not.toHaveBeenCalled();

    bridge.loginAnswer.mockResolvedValue({ ok: true, data: { ...asking, prompt: undefined } });
    fireEvent.click(screen.getByTestId('mu-login-risk-continue'));
    await waitFor(() => expect(bridge.loginAnswer).toHaveBeenCalledWith({ id: 3, value: 'continue' }));
  });

  it('turns a no to the risk into a cancelled sign-in', async () => {
    bridge.loginStatus.mockResolvedValue({
      ok: true,
      data: { signedIn: [], offered: ['openai-codex', 'anthropic', 'xai', 'google-antigravity'] },
    });
    const asking = {
      id: 4,
      provider: 'google-antigravity',
      phase: 'running',
      prompt: {
        type: 'select',
        message: 'Experimental…',
        options: [
          { id: 'continue', label: 'I understand the risk, sign in' },
          { id: 'cancel', label: 'Cancel' },
        ],
      },
    };
    bridge.loginStart.mockResolvedValue({ ok: true, data: asking });
    bridge.loginState.mockResolvedValue({ ok: true, data: asking });
    bridge.loginCancel.mockResolvedValue({ ok: true, data: { ...asking, phase: 'cancelled', prompt: undefined } });
    await toSubscriptions();
    fireEvent.click(await screen.findByTestId('mu-login-google-antigravity'));
    fireEvent.click(await screen.findByTestId('mu-login-risk-cancel'));
    await waitFor(() => expect(bridge.loginCancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('mu-login-risk')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(bridge.loginAnswer).not.toHaveBeenCalled();
  });

  it('shows Grok’s code while its page in the browser is waiting for it', async () => {
    const device = {
      id: 5,
      provider: 'xai',
      phase: 'running',
      url: 'https://accounts.x.ai/device?code=WDJB-MJHT',
      device: { userCode: 'WDJB-MJHT', verificationUri: 'https://accounts.x.ai/device?code=WDJB-MJHT' },
    };
    bridge.loginStart.mockResolvedValue({ ok: true, data: device });
    bridge.loginState.mockResolvedValue({ ok: true, data: device });
    await toSubscriptions();
    fireEvent.click(await screen.findByTestId('mu-login-xai'));
    expect(await screen.findByTestId('mu-login-device-code')).toHaveTextContent('WDJB-MJHT');
    expect(screen.getByTestId('mu-login-waiting')).toHaveTextContent('The Grok verification page is open');
    expect(screen.getByRole('button', { name: 'Open the page again' })).toBeInTheDocument();
  });

  it('says the account is signed in while its models are still being read', async () => {
    bridge.loginStatus.mockResolvedValue({
      ok: true,
      data: { signedIn: [], offered: ['openai-codex', 'anthropic', 'xai', 'google-antigravity'] },
    });
    const reading = {
      id: 6,
      provider: 'google-antigravity',
      phase: 'running',
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      stored: true,
    };
    bridge.loginStart.mockResolvedValue({ ok: true, data: reading });
    bridge.loginState.mockResolvedValue({ ok: true, data: reading });
    await toSubscriptions();
    fireEvent.click(await screen.findByTestId('mu-login-google-antigravity'));
    expect(await screen.findByTestId('mu-login-waiting')).toHaveTextContent(
      'Signed in to Antigravity. Reading the models this account can use'
    );
    expect(screen.queryByRole('button', { name: 'Open the page again' })).not.toBeInTheDocument();
  });

  it('says whose question it is above a question pi asks in its own words', async () => {
    await toSubscriptions();
    const asking = { ...running, prompt: { type: 'text', message: 'Enter your workspace id:' } };
    bridge.loginStart.mockResolvedValue({ ok: true, data: asking });
    bridge.loginState.mockResolvedValue({ ok: true, data: asking });
    fireEvent.click(screen.getByTestId('mu-login-openai-codex'));
    const waiting = await screen.findByTestId('mu-login-waiting');
    expect(waiting).toHaveTextContent('ChatGPT asks (in its own words):');
    expect(waiting).toHaveTextContent('Enter your workspace id:');
  });

  it('says when a sign-in did not finish, with the reason under it, and when none was chosen', async () => {
    await toSubscriptions();
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in to an account first');

    bridge.loginStart.mockResolvedValue({ ok: true, data: running });
    bridge.loginState.mockResolvedValue({
      ok: true,
      data: { ...running, phase: 'failed', error: 'Token exchange request failed' },
    });
    fireEvent.click(screen.getByTestId('mu-login-openai-codex'));
    const alert = await screen.findByText('Signing in did not finish. You can try again.', {}, { timeout: 3000 });
    expect(alert).toHaveTextContent('Token exchange request failed');
    expect(screen.getByTestId('mu-login-openai-codex')).not.toBeDisabled();
  });
});

/** A service's answer to the check: the models it lists for the key. */
const listing = (models: string[]) => ({
  ok: true,
  data: { ok: true, code: 'ok-models', status: 200, latencyMs: 9, detail: '', models },
});

describe('pasting an API key', () => {
  const glmKey = `${'0123456789abcdef'.repeat(2)}.AbCdEfGh12345678`;
  // DeepSeek and Qwen both make keys of this shape.
  const sharedShape = `sk-${'fedcba9876543210'.repeat(2)}`;
  const kimiKey = `sk-${'Ab1'.repeat(16)}`;
  const refused = {
    ok: true,
    data: { ok: false, code: 'auth', status: 401, latencyMs: 9, detail: 'Invalid Authentication', models: [] },
  };
  const toKeyTile = async () => {
    at('/welcome', <Welcome />);
    fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
    fireEvent.click(await screen.findByTestId('mu-welcome-way-key'));
  };
  const paste = (key: string) => fireEvent.change(screen.getByLabelText('API key'), { target: { value: key } });
  const said = (text: string) =>
    waitFor(() => expect(screen.getByTestId('mu-welcome-key-status')).toHaveTextContent(text), { timeout: 3000 });
  /** The hosts the key was sent to, in order. */
  const hosts = () =>
    bridge.testProvider.mock.calls.map(([input]: [{ baseUrl: string }]) => new URL(input.baseUrl).host);
  const toSummary = async () => {
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    fireEvent.click(await screen.findByTestId('mu-welcome-next'));
    await screen.findByTestId('mu-welcome-step-done');
  };
  const saved = async () => {
    fireEvent.click(screen.getByTestId('mu-welcome-start'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
    return bridge.save.mock.calls[0][0] as SaveSettings;
  };

  it('is the first way offered, above the ways that need an address typed in', async () => {
    at('/welcome', <Welcome />);
    fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
    const ways = within(await screen.findByRole('radiogroup')).getAllByRole('radio');
    expect(ways.map((way) => way.dataset.testid)).toEqual([
      'mu-welcome-way-key',
      'mu-welcome-way-signedIn',
      'mu-welcome-way-openai',
      'mu-welcome-way-anthropic',
    ]);
    expect(ways[0]).toHaveTextContent('Paste an API key');
    expect(screen.getByText('Another service (enter its address)')).toBeInTheDocument();
  });

  it('tells the service from the key, checks the key once with that service alone, and starts on its newest model', async () => {
    bridge.testProvider.mockResolvedValue(listing(['glm-4.5', 'glm-4.6-air', 'glm-4.6', 'embedding-3']));
    await toKeyTile();
    paste(` ${glmKey} `);
    expect(screen.getByTestId('mu-welcome-key-service')).toHaveTextContent('GLM (Zhipu AI)');
    expect(screen.getByTestId('mu-welcome-key-hint')).toHaveTextContent('Found from the key.');
    expect(screen.getByTestId('mu-welcome-key-status')).toHaveTextContent('Checking the key with GLM');
    await said('The key works.');
    expect(bridge.testProvider).toHaveBeenCalledTimes(1);
    // The model list alone (no model, so nothing billed), with the key as pasted, at GLM's own address.
    expect(bridge.testProvider).toHaveBeenCalledWith({
      id: '',
      api: 'openai-completions',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      authHeader: false,
      model: '',
      apiKey: glmKey,
    });
    expect(screen.getByTestId('mu-welcome-key-model')).toHaveTextContent('glm-4.6');
    // Where such keys are made opens in the browser.
    fireEvent.click(screen.getByTestId('mu-welcome-key-page'));
    expect(external.open).toHaveBeenCalledWith('https://open.bigmodel.cn/usercenter/apikeys');

    await toSummary();
    expect(screen.getByText('GLM / glm-4.6')).toBeInTheDocument();
    const settings = await saved();
    expect(settings.models?.providers).toMatchObject([
      {
        id: 'glm',
        name: 'GLM',
        api: 'openai-completions',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: [{ id: 'glm-4.6' }],
      },
    ]);
    expect(settings.models?.defaults).toMatchObject({ provider: 'glm', model: 'glm-4.6' });
    expect(settings.credentials).toEqual([{ name: 'MU_PROVIDER_GLM_API_KEY', value: glmKey }]);
    expect(bridge.testProvider).toHaveBeenCalledTimes(1);
  });

  it('asks which service a key DeepSeek and Qwen both make is from, and sends it nowhere until told', async () => {
    bridge.testProvider.mockResolvedValue(listing(['deepseek-chat', 'deepseek-v4-pro']));
    await toKeyTile();
    paste(sharedShape);
    expect(screen.getByTestId('mu-welcome-key-hint')).toHaveTextContent('Keys of more than one service look like this');
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 200));
    expect(bridge.testProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    expect(screen.getByText('Choose the service this key is from.')).toBeInTheDocument();

    // Only the two services the key can be from are offered.
    fireEvent.click(screen.getByLabelText('Service'));
    const deepseek = await screen.findByText('DeepSeek', { selector: '.arco-select-option' });
    expect([...document.querySelectorAll('.arco-select-option')].map((option) => option.textContent)).toEqual([
      'DeepSeek',
      'Qwen (Alibaba Cloud Model Studio)',
    ]);
    fireEvent.click(deepseek);
    await said('The key works.');
    expect(hosts()).toEqual(['api.deepseek.com']);

    await toSummary();
    expect(screen.getByText('DeepSeek / deepseek-v4-pro')).toBeInTheDocument();
    const settings = await saved();
    // pi has a provider called deepseek of its own: the guide's goes beside it.
    expect(settings.models?.providers).toMatchObject([
      { id: 'deepseek-custom', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
    ]);
    expect(settings.credentials).toEqual([{ name: 'MU_PROVIDER_DEEPSEEK_CUSTOM_API_KEY', value: sharedShape }]);
  });

  it('tries a Kimi key at Moonshot’s other address and nowhere else, and keeps the address that took it', async () => {
    bridge.testProvider.mockResolvedValue(refused);
    await toKeyTile();
    paste(kimiKey);
    await said('Kimi did not accept this key.');
    expect(hosts()).toEqual(['api.moonshot.cn', 'api.moonshot.ai']);
    expect(screen.getByText('The endpoint said: Invalid Authentication')).toBeInTheDocument();
    // A key that does not work is not written.
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    expect(screen.getByTestId('mu-welcome-step-model')).toBeInTheDocument();
    expect(screen.getByText(/The key does not work yet/)).toBeInTheDocument();

    // Made on the international site: it works there, and that address is the one kept.
    bridge.testProvider.mockReset();
    bridge.testProvider.mockImplementation(async ({ baseUrl }: { baseUrl: string }) =>
      baseUrl === 'https://api.moonshot.ai/v1' ? listing(['kimi-k2-turbo-preview', 'kimi-k2.6']) : refused
    );
    fireEvent.click(screen.getByTestId('mu-welcome-key-recheck'));
    await said('The key works.');
    expect(hosts()).toEqual(['api.moonshot.cn', 'api.moonshot.ai']);
    await toSummary();
    expect(screen.getByText('Kimi / kimi-k2.6')).toBeInTheDocument();
    const settings = await saved();
    expect(settings.models?.providers).toMatchObject([
      { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1', models: [{ id: 'kimi-k2.6' }] },
    ]);
  });

  it('looks for Ollama on this machine without a key, and keeps no key for it', async () => {
    bridge.testProvider.mockResolvedValue(listing(['qwen3:8b', 'llama3.3']));
    await toKeyTile();
    fireEvent.click(screen.getByLabelText('Service'));
    fireEvent.click(await screen.findByText('Ollama (this machine)', { selector: '.arco-select-option' }));
    await said('Ollama is running on this machine.');
    expect(bridge.testProvider).toHaveBeenCalledTimes(1);
    expect(bridge.testProvider.mock.calls[0][0]).toEqual({
      id: '',
      api: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1',
      authHeader: false,
      model: '',
    });
    expect(screen.queryByTestId('mu-welcome-key-page')).not.toBeInTheDocument();
    await toSummary();
    expect(screen.getByText('Ollama / qwen3:8b')).toBeInTheDocument();
    const settings = await saved();
    expect(settings.models?.providers).toMatchObject([
      { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
    ]);
    expect(settings.credentials ?? []).toEqual([]);
  });

  it('says Ollama is not ready when it does not answer, with no word about a key', async () => {
    bridge.testProvider.mockResolvedValue({
      ok: true,
      data: { ok: false, code: 'network', latencyMs: 3, detail: '', models: [] },
    });
    await toKeyTile();
    fireEvent.click(screen.getByLabelText('Service'));
    fireEvent.click(await screen.findByText('Ollama (this machine)', { selector: '.arco-select-option' }));
    await said('Ollama is not answering on this machine. Start it, then check again.');
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    expect(screen.getByTestId('mu-welcome-step-model')).toBeInTheDocument();
    expect(screen.getByText(/Ollama is not ready yet/)).toBeInTheDocument();
    expect(screen.queryByText(/The key does not work yet/)).not.toBeInTheDocument();
  });

  it('starts on the service’s usual model when it lists none for a key it took', async () => {
    bridge.testProvider.mockResolvedValue(listing([]));
    await toKeyTile();
    paste(kimiKey);
    await said('The key works, but Kimi lists no models for it.');
    // Asked once: a key .cn took is not tried at .ai.
    expect(hosts()).toEqual(['api.moonshot.cn']);
    expect(screen.getByLabelText('mu will start with')).toHaveValue('kimi-k2.6');
    await toSummary();
    expect(screen.getByText('Kimi / kimi-k2.6')).toBeInTheDocument();
  });

  it('asks for the key when Next is pressed before one is pasted', async () => {
    await toKeyTile();
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    expect(screen.getByText('Paste the API key first.')).toBeInTheDocument();
    expect(screen.getByTestId('mu-welcome-step-model')).toBeInTheDocument();
    expect(bridge.testProvider).not.toHaveBeenCalled();
  });
});
