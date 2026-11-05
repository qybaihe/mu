---
name: ci-test-reliability
description: Write, review and fix tests that must hold on mu's CI, not only on a quiet laptop. Use for tests with child processes, temp folders, ports, timers, process.env or async cleanup, for Windows-only failures, and when a CI run fails and a rerun passes.
---

# Tests that hold on CI

A test that passes alone on a Mac can fail on CI because the CI machine is slower, shares a host with other jobs, or runs Windows. A rerun that passes proves nothing: find what the test waited for, or what it shared, and fix that.

## Where mu's tests run

- **Harness** (`ci.yml`, Ubuntu): `npm test` across the workspaces after `npm run build:pinned`.
- **Windows tests** (`windows-tests.yml`, windows-2022): the judgment layer's suite (`packages/kyrn-judge`, `npx vitest run`) and the desktop's `tests/unit/kyrn`.
- **Desktop** (`ci.yml` and `desktop.yml`): unit tests on Ubuntu, then the app built on six platforms, five of which hold a whole conversation end to end (`desktop/tests/e2e/mu-conversation`).
- Locally, `./test.sh` runs the non-e2e tests with an empty environment and a fresh HOME, so a test cannot lean on your sign-ins. Never run the whole vitest suite directly: it picks up e2e tests when keys are set.

The judgment layer's tests get 30 s each (`packages/kyrn-judge/vitest.config.ts`); other packages keep vitest's 5 s default.

## Resources a test owns

- **Folders**: one per test from `mkdtempSync(join(tmpdir(), "…-"))`, or the harness's `tempDir`. Never a fixed path under `/tmp` or the home folder: another file, or another job on the same runner, uses it too.
- **Ports**: `server.listen(0, "127.0.0.1")`, then read the address once it is listening. Never pick a free port first and bind it later.
- **Child processes**: await their exit before the test ends. `kill()` without awaiting `exit` leaves output and file handles for the next test.
- **Clean up where you acquire**: register the cleanup right after the resource exists (`afterEach`, or `try/finally` around the smallest scope), so a failed assertion still releases it.

## Shared state

`process.env`, `process.cwd()`, fake timers, `globalThis`, module mocks and global `fetch` belong to every test in the worker.

- For env, use `vi.stubEnv`. The judgment layer's config sets `unstubEnvs: true`, so vitest restores it. `test/golden/model-surface.test.ts` stubs `KYRN_SWARM_DEPTH` and `TAVILY_API_KEY` this way.
- Restore exactly what was there, absent included. Setting a variable back to `""` is not the same as deleting it.
- Prefer passing the dependency in (a `target`, a `probe`, a clock) to patching a global: `registerRejectionLog(pi, target)` takes a stand-in for `process`.

## Wait for state, not for time

- Wait for the event, the promise or the file the code produces. A sleep is not evidence that something finished.
- A test that waits for a poll waits at least one full poll interval. `panel.dom.test.tsx` (#167) waited 1 s for a re-read that follows a status poll running once a second, and lost on Windows. It now waits 3 s, like the file's other re-read checks.
- When time is the subject, fake the clock and restore real timers after.
- Do not assert on random data. An MCP test (#223) checked that later results never contain "zod", and a random tool call id (`c554ji0zod`) did. It now checks for the rule's sentence.

## Windows

- Handles close late. Removing a folder right after a process using it ends can fail with `EBUSY` or `EPERM`. `rmSync(dir, { recursive: true, force: true, maxRetries, retryDelay })` retries both: the harness's temp folder after a git process the session started (`test/suite/harness.ts`), the e2e profile after the app quits (#307).
- Environment variable names are case-insensitive. No POSIX file modes or signals: a test of `0o600` or `SIGTERM` gets `skipIf(process.platform === "win32")` with the reason in a comment, not a weaker assertion everywhere.
- The shell is PowerShell. `model-surface.test.ts` skips Windows because the prompt names the shell.

## Fixes that hide a flake

Not root-cause fixes: a longer timeout with no named wait, retries around the test, making a file serial, swallowing an error, a weaker assertion, a sleep before the assertion.

Sizing a budget to measured work is a fix. The chord kernel-lock test (#303) starts four child processes. It took about 1.1 s until GitHub's Ubuntu runners began starting processes 4 to 6 times slower (one start went from 302 ms to 1.7 s), and it hit the 5 s default. It got 20 s, with those numbers in the commit message. Raise the hook timeout with the test's when setup pays the same cost, or the failure moves into `afterEach`.

## Prove it

- See the test fail without the fix when you can: revert the fix locally, or reintroduce the slow or shared step.
- For a race, hold one side with a deferred promise so the overlap happens every run. A loop of a hundred runs is a stress test, not a regression test.
- For a CI-only failure, record the run id, job, platform and first failing line in the commit message, as #303 and #307 do. A later reader can then tell whether the same signature came back.
