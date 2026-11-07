import { describe, expect, it } from 'vitest';
import {
  finalStatus,
  identifier,
  isSyntheticInput,
  needsKeyboard,
  parseRequest,
  pathCarriesToken,
  route,
  webAddress,
} from '@process/services/muBrowser/protocol';
import { FRESH, nextControl, personsInput, SYNTHETIC_INPUT_GRACE_MS } from '@process/services/muBrowser/control';
import { lockWebviewPreferences, navigationAllowed } from '@process/services/muBrowser/pageGuards';

describe('the token gate', () => {
  const token = 'a'.repeat(64);

  it('lets in exactly the path that is the token', () => {
    expect(pathCarriesToken(`/${token}`, token)).toBe(true);
    expect(pathCarriesToken(`/${token}?x=1`, token)).toBe(true);
  });

  it('refuses everything else', () => {
    expect(pathCarriesToken(undefined, token)).toBe(false);
    expect(pathCarriesToken('/', token)).toBe(false);
    expect(pathCarriesToken(`/${token}x`, token)).toBe(false);
    expect(pathCarriesToken(`/${token.slice(1)}`, token)).toBe(false);
    expect(pathCarriesToken(`/${'b'.repeat(64)}`, token)).toBe(false);
    expect(pathCarriesToken(`/prefix/${token}`, token)).toBe(false);
    expect(pathCarriesToken(`/?token=${token}`, token)).toBe(false);
    expect(pathCarriesToken('/anything', '')).toBe(false);
  });
});

describe('reading a request', () => {
  it('keeps id, method, params and the session it is addressed to', () => {
    expect(parseRequest('{"id":3,"method":"Page.navigate","params":{"url":"https://a.test"},"sessionId":"s"}')).toEqual(
      {
        id: 3,
        method: 'Page.navigate',
        params: { url: 'https://a.test' },
        sessionId: 's',
      }
    );
    expect(parseRequest('{"id":1,"method":"Mu.control"}')).toEqual({
      id: 1,
      method: 'Mu.control',
      params: {},
      sessionId: undefined,
    });
  });

  it('drops what is not a request', () => {
    for (const raw of ['', 'nope', '[]', 'null', '{"method":"x"}', '{"id":"1","method":"x"}', '{"id":1}']) {
      expect(parseRequest(raw)).toBeUndefined();
    }
    expect(parseRequest('{"id":1,"method":"x","params":[1]}')?.params).toEqual({});
  });
});

describe('the method router', () => {
  it('answers the three target methods itself, only at browser level', () => {
    expect(route('Target.createTarget', false)).toEqual({ kind: 'createTarget' });
    expect(route('Target.attachToTarget', false)).toEqual({ kind: 'attachToTarget' });
    expect(route('Target.closeTarget', false)).toEqual({ kind: 'closeTarget' });
  });

  it('has no browser behind it: other browser-level methods do not exist', () => {
    for (const method of ['Target.getTargets', 'Target.setDiscoverTargets', 'Browser.getVersion', 'Page.navigate']) {
      expect(route(method, false)).toEqual({ kind: 'refuse', message: `'${method}' wasn't found` });
    }
  });

  it('answers the Mu methods itself, with or without a session', () => {
    expect(route('Mu.hello', false)).toEqual({ kind: 'hello' });
    expect(route('Mu.control', false)).toEqual({ kind: 'control' });
    expect(route('Mu.control', true)).toEqual({ kind: 'control' });
    expect(route('Mu.confirm', false)).toEqual({ kind: 'confirm' });
    expect(route('Mu.step', false)).toEqual({ kind: 'step' });
    expect(route('Mu.run', false)).toEqual({ kind: 'run' });
    expect(route('Mu.somethingNew', false).kind).toBe('refuse');
  });

  it('passes page-level methods through, with the two documented exceptions', () => {
    for (const method of [
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
      'Input.dispatchKeyEvent',
      'Input.insertText',
      'DOM.getDocument',
      'Emulation.setFocusEmulationEnabled',
    ]) {
      expect(route(method, true)).toEqual({ kind: 'forward' });
    }
    expect(route('Page.navigate', true, { url: 'https://example.com/' })).toEqual({ kind: 'forward' });
    expect(route('Emulation.setDeviceMetricsOverride', true)).toEqual({ kind: 'swallow' });
  });

  it('never lets a page session reach past its page or undo the app’s refusals', () => {
    for (const method of [
      'Target.getTargets',
      'Target.attachToTarget',
      'Target.createTarget',
      'Target.sendMessageToTarget',
      'Browser.setDownloadBehavior',
      'Browser.grantPermissions',
      'Page.setDownloadBehavior',
      'DOM.setFileInputFiles',
      'SystemInfo.getInfo',
    ]) {
      expect(route(method, true).kind).toBe('refuse');
    }
  });

  it('knows which commands go to whoever holds the keyboard rather than to the page they name', () => {
    for (const method of ['Input.insertText', 'Input.dispatchKeyEvent', 'Input.imeSetComposition']) {
      expect(needsKeyboard(method)).toBe(true);
      expect(isSyntheticInput(method)).toBe(true);
    }
    for (const method of [
      'Input.dispatchMouseEvent',
      'Input.dispatchTouchEvent',
      'Runtime.evaluate',
      'Page.navigate',
    ]) {
      expect(needsKeyboard(method)).toBe(false);
    }
  });

  it('only navigates to web pages', () => {
    for (const url of ['file:///etc/passwd', 'chrome://gpu', 'javascript:alert(1)', 'app://x', '', undefined, 7]) {
      expect(route('Page.navigate', true, { url }).kind).toBe('refuse');
    }
    expect(webAddress('http://127.0.0.1:3000/a')).toBe(true);
    expect(webAddress('about:blank')).toBe(true);
    expect(webAddress('about:srcdoc')).toBe(false);
    expect(webAddress('data:text/html,hi')).toBe(false);
  });
});

describe('how a run ended', () => {
  const quiet = { stopRequested: false, confirmationRefused: false };

  it('believes the harness when it says so', () => {
    expect(finalStatus({ ...quiet, reported: 'done' })).toBe('done');
    expect(finalStatus({ ...quiet, reported: 'blocked' })).toBe('blocked');
    expect(finalStatus({ ...quiet, reported: 'budget' })).toBe('budget');
    expect(finalStatus({ ...quiet, reported: 'needs_confirmation' })).toBe('needs_confirmation');
    expect(finalStatus({ ...quiet, reported: 'aborted' })).toBe('stopped');
    expect(finalStatus({ ...quiet, reported: 'read' })).toBe('read');
    expect(finalStatus({ stopRequested: true, confirmationRefused: true, reported: 'done' })).toBe('done');
  });

  it('otherwise says only what the bridge saw itself, and never guesses done', () => {
    expect(finalStatus({ ...quiet, stopRequested: true })).toBe('stopped');
    expect(finalStatus({ ...quiet, confirmationRefused: true })).toBe('needs_confirmation');
    expect(finalStatus(quiet)).toBe('ended');
    expect(finalStatus({ ...quiet, reported: 'made-up' })).toBe('ended');
    expect(finalStatus({ ...quiet, reported: { status: 'done' } })).toBe('ended');
  });
});

describe('identifiers from the harness', () => {
  it('are plain tokens or nothing', () => {
    expect(identifier('conv_1-A')).toBe('conv_1-A');
    expect(identifier('../etc')).toBeUndefined();
    expect(identifier('<b>x</b>')).toBeUndefined();
    expect(identifier('')).toBeUndefined();
    expect(identifier('x'.repeat(81))).toBeUndefined();
    expect(identifier(12)).toBeUndefined();
  });
});

describe('the control state machine', () => {
  it('pauses and resumes', () => {
    const paused = nextControl(FRESH, 'pause');
    expect(paused).toEqual({ paused: true, stop: false, pausedBy: 'user' });
    expect(nextControl(paused, 'pause')).toBe(paused);
    expect(nextControl(paused, 'resume')).toEqual(FRESH);
    expect(nextControl(FRESH, 'resume')).toBe(FRESH);
  });

  it('takes over: paused, and says why', () => {
    expect(nextControl(FRESH, 'takeover')).toEqual({ paused: true, stop: false, pausedBy: 'takeover' });
    expect(nextControl(nextControl(FRESH, 'pause'), 'takeover').pausedBy).toBe('takeover');
  });

  it('pauses by itself when the person touches the page, once', () => {
    const touched = nextControl(FRESH, 'interaction');
    expect(touched).toEqual({ paused: true, stop: false, pausedBy: 'interaction' });
    expect(nextControl(touched, 'interaction')).toBe(touched);
    // Typing during a take-over is the point of a take-over, not a new reason.
    const takenOver = nextControl(FRESH, 'takeover');
    expect(nextControl(takenOver, 'interaction')).toBe(takenOver);
  });

  it('stops for good', () => {
    const stopped = nextControl(nextControl(FRESH, 'pause'), 'stop');
    expect(stopped).toEqual({ paused: false, stop: true });
    for (const input of ['pause', 'resume', 'takeover', 'interaction', 'stop'] as const) {
      expect(nextControl(stopped, input)).toBe(stopped);
    }
  });

  it('tells the person’s input from the loop’s own by time', () => {
    const idle = { inFlight: 0, lastFinishedAt: Number.NEGATIVE_INFINITY };
    expect(personsInput(idle, 1000)).toBe(true);
    expect(personsInput({ inFlight: 1, lastFinishedAt: 0 }, 1000)).toBe(false);
    expect(personsInput({ inFlight: 0, lastFinishedAt: 1000 }, 1000 + SYNTHETIC_INPUT_GRACE_MS)).toBe(false);
    expect(personsInput({ inFlight: 0, lastFinishedAt: 1000 }, 1001 + SYNTHETIC_INPUT_GRACE_MS)).toBe(true);
  });
});

describe('what an agent page may do', () => {
  it('goes to web pages only at the top, and lets frames be the documents pages build for themselves', () => {
    expect(navigationAllowed('https://example.com/', true)).toBe(true);
    expect(navigationAllowed('about:blank', true)).toBe(true);
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'data:text/html,x', 'blob:https://a/b', 'mu://x']) {
      expect(navigationAllowed(url, true)).toBe(false);
    }
    expect(navigationAllowed('about:srcdoc', false)).toBe(true);
    expect(navigationAllowed('data:text/html,x', false)).toBe(true);
    expect(navigationAllowed('blob:https://a/b', false)).toBe(true);
    expect(navigationAllowed('file:///etc/passwd', false)).toBe(false);
    expect(navigationAllowed('chrome://gpu', false)).toBe(false);
  });

  it('strips every privilege a webview tag may have asked for', () => {
    const preferences: Record<string, unknown> = {
      preload: '/somewhere/preload.js',
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      webviewTag: true,
    };
    const params: Record<string, string> = {
      partition: 'persist:mu-browser',
      src: 'about:blank',
      preload: 'file:///somewhere/preload.js',
      allowpopups: '',
      nodeintegration: '',
      disablewebsecurity: '',
    };
    lockWebviewPreferences(preferences, params);
    expect(preferences).toEqual({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
    });
    expect(params).toEqual({ partition: 'persist:mu-browser', src: 'about:blank' });
  });
});
