/**
 * The harness's side of the check: its OWN client (`CdpConnection`), session (`BrowserSession`), loop
 * (`runBrowserTask`) and app handshake (`EmbeddedBrowser`), loaded from the harness checkout and pointed at the
 * bridge running in a real Electron. Only the judge is scripted (`MockJudgeProvider`): no model is called.
 *
 * Started by run.mjs with Node's own type stripping and the harness's source resolver. Prints one JSON report; exit
 * code 0 when all pass.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startSite } from './site.mjs';

const harness = process.env.MU_HARNESS_ROOT ?? '';
const controlFile = process.env.MU_CHECK_CONTROL_FILE ?? '';
const verbose = process.env.MU_CHECK_VERBOSE === '1';
const judgeMs = Number(process.env.MU_CHECK_JUDGE_MS ?? 150);
const from = (path: string) => import(join(harness, 'packages/kyrn-judge/src', path));

const { runBrowserTask } = await from('browser/agent.ts');
const { CdpConnection } = await from('browser/cdp.ts');
const { EmbeddedBrowser, findEmbeddedEndpoint } = await from('browser/embedded.ts');
const { BrowserSession } = await from('browser/session.ts');
const { DecisionEngine } = await from('decision.ts');
const { Judge } = await from('judge.ts');
const { MemoryLedger } = await from('ledger.ts');
const { MockJudgeProvider } = await from('providers/mock.ts');

type Json = Record<string, any>;
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, detail: ok && !verbose ? undefined : detail });
  if (verbose) console.error(`[check] ${ok ? 'ok  ' : 'FAIL'} ${name}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const control = JSON.parse(readFileSync(controlFile, 'utf8')) as {
  port: number;
  advert: string;
  pid: number;
  electron: string;
};
async function ask(action: string, body: Json = {}): Promise<Json> {
  const response = await fetch(`http://127.0.0.1:${control.port}/${action}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${action}: ${response.status} ${await response.text()}`);
  return (await response.json()) as Json;
}
async function until<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const eventsOf = async (tabId: string, type?: string): Promise<Json[]> =>
  ((await ask('state')).events as Json[]).filter((event) => event.tabId === tabId && (!type || event.type === type));
const runningTab = async (): Promise<string> =>
  until(
    'a running tab',
    async () => ((await ask('state')).runs as Json[]).findLast((run) => run.phase === 'running')?.tabId
  );

/** A judge that follows a script: which operation on which labelled element, given the page it is shown. */
type Move = { op: string; label?: RegExp };
function scriptedEngine(plan: (page: { url: string; elements: Json[] }) => Move) {
  const provider = new MockJudgeProvider(async (request: Json) => {
    // No judge answers in no time. The fastest real one takes a few hundred milliseconds.
    await sleep(judgeMs);
    const state = request.state as { page: { url: string }; elements: Json[] };
    const move = plan({ url: state.page.url, elements: state.elements });
    const answers: Json = { operation: { type: 'choice', choice: move.op, probabilities: { [move.op]: 0.97 } } };
    if (move.label) {
      const element = state.elements.find(
        (row) => row.operations.includes(move.op) && move.label?.test(`${row.label} ${row.role ?? ''}`)
      );
      if (verbose && !element) console.error('[check] no element for', move, JSON.stringify(state.elements));
      const key = `${move.op.toLowerCase()}_target`;
      answers[key] = {
        type: 'choice',
        choice: element?.index ?? 'none',
        probabilities: { [element?.index ?? 'none']: 0.92 },
      };
    }
    return answers;
  });
  const engine = new DecisionEngine({
    judge: new Judge({ provider }),
    ledger: new MemoryLedger(),
    defaultMode: 'active',
  });
  return { engine, provider };
}

const search = ({ url, elements }: { url: string; elements: Json[] }): Move => {
  if (url.includes('/results')) return { op: 'DONE' };
  const field = elements.find((row) => row.operations.includes('TYPE_TEXT'));
  return field?.value
    ? { op: 'CLICK', label: /^search\b.*button|^search$/i }
    : { op: 'TYPE_TEXT', label: /catalogue|title or author/i };
};

const site = await startSite();
let exitCode = 1;
try {
  // ── discovery, exactly as the harness does it: the advert in the (throw-away) mu home ──────────────────────────
  const endpoint = findEmbeddedEndpoint();
  check(
    'the harness finds the app through the advert file',
    endpoint?.pid === control.pid,
    endpoint && { pid: endpoint.pid }
  );
  if (process.platform !== 'win32') {
    check('the advert is readable by the user only (0600)', (statSync(control.advert).mode & 0o777) === 0o600);
  }
  const refused = await CdpConnection.connect(`ws://127.0.0.1:${new URL(endpoint.url).port}/not-the-token`, 1500).then(
    () => false,
    () => true
  );
  check('a connection without the token is refused', refused);

  const cdp = await CdpConnection.connect(endpoint.url, 2000);
  const app = await EmbeddedBrowser.handshake(cdp);
  check('Mu.hello: the app is recognised as the embedded browser', app !== undefined);

  const browse = async (options: {
    url: string;
    plan: Parameters<typeof scriptedEngine>[0];
    goal: string;
    beforeStep?: (tabId: string, asked: number) => Promise<void>;
    report?: boolean;
  }) => {
    const { engine, provider } = scriptedEngine(options.plan);
    const session = await BrowserSession.open(cdp, options.url);
    const tabId = await runningTab();
    if (options.report) await cdp.send('Mu.run', { state: 'started', goal: options.goal, url: options.url });
    let asked = 0;
    let status = 'failed';
    try {
      const result = await runBrowserTask({
        session,
        engine,
        goal: options.goal,
        writeText: async () => 'weakmap',
        confirm: (label: string, url: string) => app.confirm(label, url),
        beforeStep: async () => {
          await options.beforeStep?.(tabId, ++asked);
          return app.mayContinue();
        },
        onStep: (record: Json) =>
          app.step({
            step: record.step,
            kind: record.kind,
            action: record.action,
            url: record.url ?? '',
            probability: record.probability,
            pageChanged: record.page_changed,
          }),
      });
      status = result.status;
      return { result, tabId, judgeCalls: provider.calls.length as number, session };
    } finally {
      if (options.report) await cdp.send('Mu.run', { state: 'finished', status });
      await session.close();
    }
  };

  // ── A. a whole task: type, click, done ────────────────────────────────────────────────────────────────────────
  const a = await browse({ url: `${site.origin}/`, goal: 'search the catalogue for weakmap', plan: search });
  check('A. the task finishes as done', a.result.status === 'done', a.result);
  check(
    'A. it typed into the search box and clicked the button',
    a.result.history.map((entry: Json) => entry.kind).join(',') === 'fill,click' &&
      a.result.page.url === `${site.origin}/results?q=weakmap` &&
      a.result.page.text.includes('Results for weakmap'),
    { history: a.result.history, url: a.result.page.url }
  );
  const aSteps = await until('the steps at the bridge', async () => {
    const steps = await eventsOf(a.tabId, 'step');
    return steps.length >= 2 && steps;
  });
  check(
    'A. the step events arrived at the bridge with kind, label and probability',
    aSteps.length === 2 &&
      aSteps[0].step.kind === 'fill' &&
      aSteps[1].step.kind === 'click' &&
      aSteps[1].step.probability === 0.92,
    aSteps.map((event) => event.step)
  );
  check(
    "A. the loop's own clicks and keys did not count as the person touching the page",
    (await eventsOf(a.tabId, 'control')).length === 0
  );
  const afterA = await ask('state');
  const aTab = (afterA.tabs as Json[]).find((tab) => tab.tabId === a.tabId);
  check(
    'A. the tab is still open afterwards, on the final page, with the debugger let go',
    aTab?.url === `${site.origin}/results?q=weakmap` && aTab?.debuggerAttached === false,
    aTab
  );
  check(
    'A. a harness that does not report its verdict gets an honest "ended", not a guessed "done"',
    (afterA.runs as Json[]).find((run) => run.tabId === a.tabId)?.status === 'ended'
  );

  // ── K. the finished tab is handed out again: the next run starts from a blank page and an empty bar ───────────
  await ask('reuse', { tabId: a.tabId });
  const k = await browse({ url: `${site.origin}/`, goal: 'search the catalogue for weakmap', plan: search });
  const kRun = ((await ask('state')).runs as Json[]).find((run) => run.tabId === k.tabId);
  check(
    'K. a tab handed out again runs the next task to done, with only its own steps on the bar',
    k.tabId === a.tabId && k.result.status === 'done' && k.result.history.length === 2 && kRun?.steps.length === 2,
    { sameTab: k.tabId === a.tabId, status: k.result.status, steps: kRun?.steps.length }
  );

  // ── the device-metrics override is not applied: the page has the panel's real width ───────────────────────────
  {
    const session = await BrowserSession.open(cdp, `${site.origin}/`);
    const tabId = await runningTab();
    const page = await session.observe();
    const width = ((await ask('state')).tabs as Json[]).find((tab) => tab.tabId === tabId)?.width;
    const reported = Number(/viewport (\d+) x/.exec(page.text)?.[1]);
    check(
      'the page reports the real width of its webview, not the 1120 the loop asks for',
      reported === width && reported !== 1120,
      {
        reported,
        width,
      }
    );
    await session.close();
  }

  // ── B. pause holds the loop, resume continues it ──────────────────────────────────────────────────────────────
  let heldMs = 0;
  let pausedSeen: Json | undefined;
  const b = await browse({
    url: `${site.origin}/`,
    goal: 'search the catalogue for weakmap',
    plan: search,
    beforeStep: async (tabId, asked) => {
      if (asked !== 2) return;
      await ask('control', { tabId, action: 'pause' });
      const since = Date.now();
      setTimeout(async () => {
        pausedSeen = ((await ask('state')).runs as Json[]).find((run) => run.tabId === tabId);
        heldMs = Date.now() - since;
        await ask('control', { tabId, action: 'resume' });
      }, 1300);
    },
    report: true,
  });
  check(
    'B. pause holds the loop (no judge call for 1.3 s) and resume continues it to done',
    b.result.status === 'done' && heldMs >= 1200 && b.result.elapsedMs >= 1300,
    {
      status: b.result.status,
      heldMs,
      elapsedMs: b.result.elapsedMs,
    }
  );
  check(
    'B. while held, the bridge says paused by the person, with one step done',
    pausedSeen?.paused === true && pausedSeen?.pausedBy === 'user' && pausedSeen?.steps.length === 1,
    pausedSeen
  );
  const bRun = ((await ask('state')).runs as Json[]).find((run) => run.tabId === b.tabId);
  check(
    'B. with Mu.run (proposed) the bar gets the goal and the real verdict',
    bRun?.status === 'done' && bRun?.goal === 'search the catalogue for weakmap',
    bRun && { status: bRun.status, goal: bRun.goal }
  );

  // ── C. the person touches the page: the loop pauses by itself ─────────────────────────────────────────────────
  let touchedState: Json | undefined;
  const c = await browse({
    url: `${site.origin}/`,
    goal: 'search the catalogue for weakmap',
    plan: search,
    beforeStep: async (tabId, asked) => {
      if (asked !== 2) return;
      await sleep(400);
      await ask('touch', { tabId });
      touchedState = await until('the automatic pause', async () => {
        const run = ((await ask('state')).runs as Json[]).find((entry) => entry.tabId === tabId);
        return run?.paused && run;
      });
      setTimeout(() => void ask('control', { tabId, action: 'resume' }), 600);
    },
  });
  check(
    'C. a mouse press by the person pauses the run (paused by interaction), resume finishes it',
    touchedState?.pausedBy === 'interaction' && c.result.status === 'done',
    {
      pausedBy: touchedState?.pausedBy,
      status: c.result.status,
    }
  );

  // ── D. stop ends the run as aborted ───────────────────────────────────────────────────────────────────────────
  const d = await browse({
    url: `${site.origin}/`,
    goal: 'search the catalogue for weakmap',
    plan: search,
    beforeStep: async (tabId, asked) => {
      if (asked === 2) await ask('control', { tabId, action: 'stop' });
    },
  });
  const dRun = ((await ask('state')).runs as Json[]).find((run) => run.tabId === d.tabId);
  check(
    'D. stop ends the run as aborted, and the bar says stopped',
    d.result.status === 'aborted' && d.result.history.length === 1 && dRun?.status === 'stopped',
    {
      status: d.result.status,
      steps: d.result.history.length,
      shown: dRun?.status,
    }
  );

  // ── E. an irreversible-looking button: the app is asked, and a refusal stops the run ──────────────────────────
  const danger = ({ url }: { url: string }): Move =>
    url.includes('/deleted') ? { op: 'DONE' } : { op: 'CLICK', label: /delete account/i };
  const answerWith = (allowed: boolean) => async (tabId: string, asked: number) => {
    if (asked !== 1) return;
    void until(
      'the confirmation',
      async () => ((await ask('state')).runs as Json[]).find((run) => run.tabId === tabId)?.confirm,
      8000
    ).then((confirm) => ask('confirm', { tabId, id: (confirm as Json).id, allowed }));
  };
  const e = await browse({
    url: `${site.origin}/danger`,
    goal: 'delete the account',
    plan: danger,
    beforeStep: answerWith(false),
  });
  const eConfirm = (await eventsOf(e.tabId, 'confirm'))[0]?.confirm;
  const eRun = ((await ask('state')).runs as Json[]).find((run) => run.tabId === e.tabId);
  check(
    'E. Mu.confirm is asked for "Delete account", with the page address',
    eConfirm?.label === 'Delete account' && eConfirm?.url === `${site.origin}/danger`,
    eConfirm
  );
  check(
    'E. a refusal stops the run with needs_confirmation, and the button was not pressed',
    e.result.status === 'needs_confirmation' &&
      e.result.page.url === `${site.origin}/danger` &&
      eRun?.status === 'needs_confirmation',
    {
      status: e.result.status,
      url: e.result.page.url,
      shown: eRun?.status,
    }
  );
  const e2 = await browse({
    url: `${site.origin}/danger`,
    goal: 'delete the account',
    plan: danger,
    beforeStep: answerWith(true),
  });
  check(
    'E. an allowed confirmation lets the click through',
    e2.result.status === 'done' && e2.result.page.url.startsWith(`${site.origin}/deleted`),
    {
      status: e2.result.status,
      url: e2.result.page.url,
    }
  );

  // ── J. the keyboard: what the loop types must never land in the app's own message box ────────────────────────
  {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tabId = await runningTab();
    const evaluate = async (expression: string) =>
      ((await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)) as Json).result?.value;
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    await cdp.send('Page.navigate', { url: `${site.origin}/` }, sessionId);
    await until('the page', async () => (await evaluate('document.readyState')) === 'complete');
    const at = await evaluate(
      `(() => { const r = document.getElementById('q').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
    );
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 }, sessionId);
    }
    // The person clicks back into their own draft, between the loop's click and its typing.
    const before = await ask('host', { tabId, focusDraft: true });
    const modifiers = process.platform === 'darwin' ? 4 : 2;
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'a', code: 'KeyA', modifiers, commands: ['selectAll'] },
      sessionId
    );
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers }, sessionId);
    await cdp.send('Input.insertText', { text: 'weakmap' }, sessionId);
    await sleep(150);
    const after = await ask('host', { tabId });
    const field = await evaluate('document.getElementById("q").value');
    check(
      "J. typed text reaches the page and never the app's own message box, even right after the person clicked into it",
      before.active === 'draft' && after.draft === '' && field === 'weakmap',
      { focusBefore: before.active, draft: after.draft, field }
    );
    await cdp.send('Target.closeTarget', { targetId });
  }

  // ── F. isolation, against the real Electron ───────────────────────────────────────────────────────────────────
  {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tabId = await runningTab();
    const evaluate = async (expression: string) =>
      ((await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)) as Json)
        .result?.value;
    await cdp.send('Page.navigate', { url: `${site.origin}/` }, sessionId);
    await until('the page', async () => (await evaluate('document.readyState')) === 'complete');

    check(
      'F. the page has no Node (the webview asked for nodeintegration and did not get it)',
      (await evaluate('typeof require + "," + typeof process')) === 'undefined,undefined'
    );
    const fileRefused = await cdp.send('Page.navigate', { url: 'file:///etc/hosts' }, sessionId).then(
      () => false,
      () => true
    );
    const chromeRefused = await cdp.send('Page.navigate', { url: 'chrome://gpu' }, sessionId).then(
      () => false,
      () => true
    );
    check('F. file: and chrome: navigations are refused', fileRefused && chromeRefused);
    await evaluate(`location.href = 'file:///etc/hosts'; 1`);
    await sleep(300);
    check(
      'F. a page cannot take itself to file: either',
      String(await evaluate('location.href')).startsWith(site.origin),
      await evaluate('location.href')
    );
    await ask('load', { tabId, url: 'file:///etc/hosts' });
    await sleep(400);
    check(
      'F. nor can the address bar above the page (a navigation the app itself starts)',
      String(await evaluate('location.href')).startsWith(site.origin) &&
        (await eventsOf(tabId, 'notice')).some((event) => event.notice.kind === 'navigation'),
      await evaluate('location.href')
    );
    const reach = await Promise.all(
      ['Target.getTargets', 'Browser.getVersion', 'Page.setDownloadBehavior'].map((method) =>
        cdp.send(method, { behavior: 'allow' }, sessionId).then(
          () => false,
          () => true
        )
      )
    );
    check(
      'F. a page session cannot list targets, reach the browser or switch downloads on',
      reach.every(Boolean),
      reach
    );
    check(
      'F. permissions are denied (geolocation, notifications, camera)',
      (await evaluate(
        `Promise.all(['geolocation','notifications','camera'].map(name => navigator.permissions.query({name}).then(s => s.state))).then(s => s.join(','))`
      )) === 'denied,denied,denied'
    );
    await evaluate(`location.href = '/download'; 1`);
    const notice = await until('the download notice', async () =>
      (await eventsOf(tabId, 'notice')).find((event) => event.notice.kind === 'download')
    ).catch(() => undefined);
    check(
      'F. a download is cancelled and the step bar is told',
      notice?.notice.kind === 'download' && notice?.notice.detail === 'report.bin',
      notice
    );

    const intruder = await CdpConnection.connect(endpoint.url, 2000);
    const stolen = await intruder.send('Target.attachToTarget', { targetId, flatten: true }).then(
      () => false,
      () => true
    );
    const peeked = await intruder.send('Runtime.evaluate', { expression: '1' }, sessionId).then(
      () => false,
      () => true
    );
    intruder.close();
    check('F. another connection cannot attach to or drive this tab', stolen && peeked);

    // ── G. the debugger is taken away from outside (as AionUi's own single-target bridge does on a tab switch) ───
    // Informational first: on current Electron, DevTools attaches beside the debugger instead of replacing it.
    await ask('devtools', { tabId });
    await sleep(600);
    const besideDevtools = await Promise.race([evaluate('1 + 1'), sleep(3000).then(() => 'no answer')]);
    await ask('devtools', { tabId, open: false });
    checks.push({
      name: "G. (informational) with DevTools open on the page, the loop's session still answers",
      ok: true,
      detail: { answer: besideDevtools },
    });

    const slow = cdp
      .send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }, sessionId)
      .then(
        () => 'answered',
        (error: Error) => error.message
      );
    await sleep(200);
    await ask('detachDebugger', { tabId });
    const outcome = await Promise.race([slow, sleep(4000).then(() => 'hung')]);
    const gRun = await until('the detached run', async () => {
      const run = ((await ask('state')).runs as Json[]).find((entry) => entry.tabId === tabId);
      return run?.phase === 'finished' && run;
    }).catch(() => undefined);
    check(
      'G. when the debugger is taken away, the waiting call fails instead of hanging',
      outcome !== 'hung' && outcome !== 'answered',
      outcome
    );
    check(
      'G. the run is shown as detached and the loop is told to stop',
      gRun?.status === 'detached' && (await app.control()).stop === true,
      gRun && { status: gRun.status, reason: gRun.reason }
    );
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);

    // ── H. the person closes a tab mid-run ───────────────────────────────────────────────────────────────────────
    const second = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attachedSecond = await cdp.send('Target.attachToTarget', { targetId: second.targetId, flatten: true });
    const secondTab = await runningTab();
    await ask('closeTab', { tabId: secondTab });
    await until(
      'the closed tab to leave the store',
      async () => !((await ask('state')).runs as Json[]).some((run) => run.tabId === secondTab)
    );
    const afterClose = await cdp.send('Runtime.evaluate', { expression: '1' }, attachedSecond.sessionId).then(
      () => 'answered',
      () => 'error'
    );
    check('H. closing the tab removes it from the store and later calls get an error', afterClose === 'error');
  }

  // ── I. informational: the loop scrolls with a wheel event at a fixed (550, 650) ───────────────────────────────
  {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tabId = await runningTab();
    const evaluate = async (expression: string) =>
      ((await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)) as Json).result?.value;
    await cdp.send('Page.navigate', { url: `${site.origin}/long` }, sessionId);
    await until('the long page', async () => (await evaluate('document.readyState')) === 'complete');
    const wheel = async () => {
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: 550, y: 650, deltaX: 0, deltaY: 560 },
        sessionId
      );
      await sleep(400);
      return { viewport: await evaluate('innerWidth + "x" + innerHeight'), scrollY: await evaluate('scrollY') };
    };
    const wide = await wheel();
    await evaluate('scrollTo(0, 0)');
    await ask('resize', { tabId, width: 480, height: 420 });
    await sleep(400);
    const narrow = await wheel();
    checks.push({
      name: 'I. (informational) wheel at the fixed point (550, 650): full-size panel vs a 480x420 panel',
      ok: true,
      detail: { wide, narrow },
    });
    await cdp.send('Target.closeTarget', { targetId });
  }

  cdp.close();
  exitCode = checks.every((entry) => entry.ok) ? 0 : 1;
} catch (error) {
  check('the check ran to its end', false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  site.close();
  console.log(JSON.stringify({ electron: control.electron, passed: exitCode === 0, checks }, null, 2));
  process.exit(exitCode);
}
