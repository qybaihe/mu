# Runtime host spike

Question: can the desktop stop bridging a CLI and run the agent itself?

Today: renderer ⇄ AionCore (Rust) → ACP adapter → `kyrn --mode rpc` → pi + kyrn-judge, with judgment events
on a side channel (status piggyback → `events.jsonl` → 1 s cursor polling). Four processes, three protocols, two
channels that the front end re-joins by `runtimeId + turnId`.

This spike runs pi's SDK (`createAgentSession`) and the KYRN judgment extension (`createKyrnJudgeExtension` with
its in-process `onPresentation` hook) inside an Electron **utility process**, and sends the app ONE ordered,
typed stream over a `MessagePort`. Everything is synthetic: faux model, mock judge, temp directories. It reads no
real config, no credentials, and does not touch the running desktop app, AionCore or `~/.kyrn`.

## Files

| File             | Role                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.mts`       | The runtime host. Commands in (`open`, `prompt`, `abort`, `tree`, `navigate`, `reload`, `ui_response`, …), one event stream out (`session` / `kyrn` / `ui` sources, one sequence). |
| `host-entry.mjs` | Registers the loader the CLI launcher also uses (tsx + pi's tsconfig paths), then loads the host.                                                                                  |
| `scenario.mjs`   | The checks, transport-agnostic.                                                                                                                                                    |
| `main.mjs`       | Electron driver: no window, throw-away profile, `utilityProcess.fork`.                                                                                                             |
| `run-node.mjs`   | The same host under `child_process.fork`, as a baseline.                                                                                                                           |

## Run

```bash
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
export KYRN_ROOT=/path/to/mu                     # the checkout to load pi and kyrn-judge from
cd scripts/kyrn/host-spike
node run-node.mjs                                # baseline
../../../kyrn/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron main.mjs   # the real target
```

Exit code 0 means every check passed. `SPIKE_VERBOSE=1` prints progress, `SPIKE_REPORT=<file>` saves the JSON.
Electron needs the window server, so it cannot run inside a sandboxed shell.

## Result (2026-09-22, Electron 44.4.3, Node 24.21.0 inside the utility process)

9 of 9 checks pass in the Electron utility process and under plain Node.

| Check                                                                                       | Observed                                                                            |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| One gapless sequence for everything                                                         | 109 events: 78 session, 24 judgment, 7 UI                                           |
| Judgment events interleaved, ahead of the turn they gate                                    | `preflight.pending` → `decision` → `preflight.verdict` → `agent_start`              |
| `prompt` resolves after `agent_settled`                                                     | no `get_state` polling to find the end of a turn                                    |
| Thinking streams as typed deltas with an explicit `thinking_end`                            | the "thinking" view state can be derived, not stored                                |
| Abort is definitive                                                                         | `agent_settled` 10 ms after `abort`; the stored message has `stopReason: "aborted"` |
| A verdict arriving during turn 4 still says turn 3 asked                                    | needs the engine `origin` fix in the loaded checkout                                |
| `navigateTree` + prompt → second branch under the chosen entry, same session file           | the primitive judged rewind needs                                                   |
| An extension `input` dialog round-trips                                                     | the ACP adapter cancels `input` and `editor` today                                  |
| A fresh reader of the session file rebuilds messages, abort reason, judgments + asking turn | 22 entries, 5 judgments                                                             |

Delivery host → app: p50 0.04 ms, p95 0.11 ms, max 0.26 ms (the judgment panel polls every 1000 ms today).
Host boot 1.4 s when pi is compiled from source by tsx on the fly; opening a session 33 ms.

Control: with `KYRN_ROOT` pointing at a checkout WITHOUT the `origin` fix, the late verdict is filed under
turn 4 and the file holds no asking turn, so those two checks fail. That is the bug the bridge version works
around in the front end by comparing latencies.

### Packaging probe

A static-import version of the same session bundles with esbuild into one 13.8 MB ESM file in 0.9 s
(`--tsconfig <KYRN>/tsconfig.json`, alias for `@earendil-works/pi-coding-agent`, a `createRequire` banner).
The bundle runs a judged turn in 0.28 s wall time under plain Node 24.16 and under Electron's Node 24.21, with
no tsx and no loader. Not exercised: user extensions loaded from disk through jiti, skill/theme/prompt assets
resolved relative to source files, the photon WASM, and esbuild's warning that pi-ai's image provider
registration is dropped as side-effect free.

## What this does not show

- Real models, real Jev, real tools (`noTools: "builtin"`), long sessions, compaction, sub-agents (swarm / hive
  spawn child pi processes by default; `swarmRunner` is the seam for running them in-host).
- The renderer. The stream stops at Electron's main process; the reducer and the React surfaces are the next step.
- AionUi's side: its conversation DB and history list still think in ACP conversations.
- Several sessions in one host. `process.env` and other process-level state are shared; start with one host per
  session or audit first.
- Electron 37 (the version in the root `package.json`): dev runs on the 44.4.3 binary from `kyrn/node_modules`
  via `ELECTRON_EXEC_PATH`. pi needs Node ≥ 22.19; the packaged app's Electron has to satisfy that.
- Gotcha found here: in an ESM main entry, top-level `await app.whenReady()` never resolves on Electron 44.
  Use `app.whenReady().then(...)`.

## The native host, measured (`measure-host.mjs`)

The spike's successor is the app's native host ([docs/native-host.md](../../../docs/native-host.md)): pi's own RPC
mode inside a utility process, started by the launcher's plan. `measure-host.mjs` and its Electron main
`measure-host-main.mjs` start it through the app's code path (`startNativeHost`) in real utility processes, with the
E2E fake model and the mock judge in a throwaway home, and check LaunchServices' list (the Dock) while it runs.

```bash
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
node scripts/kyrn/host-spike/measure-host.mjs --rounds 3     # forks the entry's TypeScript source
node scripts/kyrn/host-spike/measure-host.mjs --built        # forks out/main/nativeHost.js (electron-vite build first)
```

One `[measure]` line per round: ms from `startNativeHost` to fork, pi imported, first record and first `get_state`
answer, a PLAIN turn, the host's resident memory after it, dispose (and when the process exited and was gone), and
whether the host was listed. Exit code 0 means no host was listed and each was gone within 2 s of its dispose. The results are in docs/native-host.md.
