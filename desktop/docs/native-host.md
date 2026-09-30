# Native host

Status: milestone 1 (2026-09-27) and milestone 2 (2026-09-29: the main process's side here, the renderer's in
`docs/native-host-ui.md`), branch `claude/mu-native-host`. On by default since 2026-09-30 (see "On by default"
below): the sidebar has a "Native" group whose conversations run on a host in a utility process of their own, with no
AionCore and no ACP in their path; the main process answers the native conversation bridge (list, history, hosts on
demand). With `MU_NATIVE_HOST=0`, every conversation goes through AionCore and the ACP adapter, as before. Checked in the
real app by `node scripts/kyrn/e2e-conversation.mjs --native` (see "In the running app" in `docs/native-host-ui.md`).

## On by default

The native host is what a new conversation runs on. `MU_NATIVE_HOST` has three settings (`nativeHostSetting`,
`…/nativeHost/index.ts`):

| Setting                                     | The native host                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `0`, `false`, `off`, `no` (the kill switch) | Off. Every provider of the bridge but `enabled` answers `off`; every conversation is AionCore's.            |
| unset (`auto`)                              | On when the mu found on this machine can run inside the app (`nativeHostReady`), else off, with a log line. |
| `1`, `true`, `on`, `yes`                    | On whatever mu is found. A mu too old for it fails where it is used, with its own error (`old-harness`).    |

Problem: the packaged app carries its own mu (`<resources>/harness/mu-agent`), and until a mu with the native seam
(`planHost`, `prepareLaunch`, `entryId` on messages) is released and bundled, that copy cannot run a host. With the
host on by default, every conversation of such an app would have started, then failed with `old-harness`. Solution: in
`auto`, the main process asks once at start-up whether a host could start (`checkHost`: the launcher loads, has both
functions, and accepts a plan; nothing is written and no judge starts), and answers `enabled` from that. An older mu
leaves the sidebar without the native group and the home page on AionCore, with `[mu] the native host stays off: …` in
the log. This is not optional complexity: without it the default would break every packaged app that is not rebuilt in
step with the harness.

Conversations AionCore already holds stay on the classic page; they are not migrated (the native list hides only the
sessions AionCore's ACP adapter runs, so nothing shows twice). A browser on the WebUI is not offered the native host
(`bridgeClient.enabled` answers false without asking when there is no `window.electronAPI`): the native screens use
the desktop's folder dialog, notifications and bin, and nothing has tested them over the WebUI. There is no settings
switch: the variable is for a developer who needs the old path, and a person who never heard of it gets the native
host.

## Why

The app should run the agent itself, the way the Claude and Codex apps do, instead of bridging a command line. Today
one message crosses four processes and three protocols:

```text
renderer ⇄ AionCore (Rust, owns conversations) ⇄ ACP adapter (process/agent/kyrn) ⇄ mu --mode rpc (pi + Jev)
                                                                     events.jsonl ⇠ status piggyback (Jev)
```

What that costs, concretely:

- Jev's judgments travel a side channel: a status line → `events.jsonl` → the panel polls it every second.
- ACP has no "thinking ended" and no "turn settled", so the adapter and the message list guess where a turn ends
  (`MessageList.tsx` keeps "stale" thoughts and calls for turns that ended without their end).
- Extension dialogs of type `input` and `editor` are cancelled.
- pi's tree, fork, steer and follow-up never reach the app.

The target:

```text
renderer ⇄ Electron main (NativeHost) ⇄ one utility process per session: pi + Jev, pi's own RPC protocol
```

One ordered stream per session carries pi's events, Jev's frames and the dialogs; the main process pairs commands with
responses; one reducer turns the stream, or a session file read back, into what the screen shows. AionCore and ACP
leave the conversation path.

## Milestone 1: the headless host, the reducer, tests

### Pieces

| File                                                        | Role                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop/src/process/services/nativeHost/entry.ts` | The host process: build input `nativeHost` → `out/main/nativeHost.js`. Runs as an Electron utility process (`process.parentPort`) and under Node's `child_process.fork` (`process.send`), for tests and scripts. |
| `…/nativeHost/protocol.ts`                                  | The envelope: main → host `init` / `in` / `end`, host → main `ready` / `out` / `failed`. pi's RPC records travel inside it unchanged, one JSON text per message.                                                 |
| `…/nativeHost/launch.ts`                                    | `prepareHost`: imports the harness's launcher (`<harness>/kyrn/bin/mu.mjs`) at run time, calls `planHost` and `prepareLaunch`; `checkHost`: the same up to the plan, preparing nothing.                          |
| `…/nativeHost/NativeHost.ts`                                | The manager: start, typed requests, the ordered subscription, dialogs, dispose, states and errors. No Electron import: it takes a `fork` function.                                                               |
| `…/nativeHost/index.ts`                                     | The Electron part: the `MU_NATIVE_HOST` setting and `nativeHostReady`, `findHarness`, `utilityProcess.fork` with the system proxy (`startNativeHost`).                                                           |
| `…/nativeHost/nodeFork.ts`                                  | The same host under `child_process.fork`.                                                                                                                                                                        |
| `packages/desktop/src/common/utils/nativeHost/`             | No Node APIs, for main now and the renderer later: `records.ts` (pi's RPC types and readers), `presentation.ts` (Jev's frames), `view.ts`, `reducer.ts`.                                                         |

The ACP adapter's `telemetry.ts` and `permissions.ts` now decode Jev's frames with the same `readPresentation`; their
behavior is unchanged.

### How a host starts

1. `startNativeHost({ cwd, session? })` checks the flag, finds the harness as the rest of the app does
   (`KYRN_ROOT` / `MU_ROOT` / `../KYRN` in dev, `resources/harness/mu-agent` packaged), and runs `prepareHost`. The
   launcher plans `{ module, execArgv, args, env }` exactly as for the command line: same files, settings, sign-ins,
   `.env` keys. `argv` is `--mode rpc` plus `--session <file or id>` to resume.
2. `utilityProcess.fork(entry, [], { env: { ...systemProxyEnv(), ...plan.env }, cwd, stdio: 'pipe', serviceName: 'mu' })`.
3. The manager posts `init { module, args, execArgv }`, then a `get_state` (id `h1`). Records that arrive before pi
   listens wait in the host.
4. The host applies `execArgv` itself (see below), imports pi's module, calls `setupCli()`, posts `ready { importMs }`
   and runs `main(args, { rpcTransport })`. The transport is the parent port.
5. pi answers `get_state`: the host is `running`, or `needs-model`.

`dispose()` posts `end`, which is pi's stdin closing: pi shuts its session down and exits with 0. A host still there
after 3 s is killed.

**Why `execArgv` travels in `init`.** An Electron 44 utility process lists the options it was started with in
`process.execArgv` but does not act on them: `--import`, `--disable-warning` and `--no-warnings` all had no effect
(measured). A checkout's plan is
`--disable-warning=ExperimentalWarning --import kyrn/bin/compile-cache.mjs --import <pi>/src/experimental/source-resolver.ts`;
without the resolver, pi's import failed (`@earendil-works/pi-ai` resolved to a `dist` that a checkout does not have).
`NODE_OPTIONS` would work, but every Node process the agent starts (the bash tool's, sub-agents) would inherit it. So
the host silences the named warnings and imports each `--import` module in order before pi; any other option is
reported on stderr and left out. The Node fork starts the host without options too, so both run the same path. A
package's plan has no options.

### The manager

- `request(command)` sends a command with an id and resolves with its response's `data`, typed per command; pi's error
  rejects it (`kind: 'command'`, pi's words). Deadlines: 30 s once pi wrote its first record, 180 s before that.
  `prompt`, `steer`, `follow_up`, `compact`, `bash` and the session changes are never timed out; `prompt` resolves when
  pi accepted it, and the run is over at `agent_settled`.
- `subscribe(listener)`: every record in arrival order (responses, events, `extension_ui_request`), plus the app's own
  `extension_ui_response`, so a view closes the dialog it answered.
- `respondToDialog(id, { value } | { confirmed } | { cancelled: true })`.
- `state`: `idle → starting → running | needs-model → stopped`, or `failed` with a `NativeHostError` whose `kind` says
  why: `no-models`, `failed` (stopped before pi wrote anything) or `crashed` (stopped after). Its exit code and the last
  8 KB of the host's output come with it; pi's `[mu] …` log lines go to the app's log as they come. Commands reject
  with `closed`, `timeout` or `command`; `startNativeHost` throws `off`, `no-harness`, `old-harness` (a launcher
  without `planHost`) or `plan` before there is a host.
- `timings`: fork, pi imported (and the host's own `importMs`), first record, first `get_state` answer.

**No model is not a crash.** pi's start exits with "No models available" outside interactive mode when the session has
no model (`main.ts`). With nothing set up, though, the session carries pi's placeholder model `unknown/unknown`, so that
exit never fires: pi runs and refuses each prompt ("No API key found for the selected model …"). So the manager asks
`get_state` as it starts and says `needs-model`; commands still work, and a `get_state`, `set_model` or `cycle_model`
that names a model makes it `running`. A pi that does exit with "No models available" before its first record ends as
`failed`, kind `no-models`.

### The view

`reduce(view, record)` for a live stream, `fromEntries(entries, leafId?)` for a session file, `reduceAll(records)` for
a recorded stream. Pure: no I/O, no clock, the view passed in is never changed. For the same content, live and reload
give equal views (the fixture test checks it with `toStrictEqual`).

```ts
type NativeView = {
  messages: ViewMessage[]; // user (+ Jev's verdict line), assistant (text, thinking, tool calls with results), custom, compaction (where pi compacted: a `compaction` entry in a file, `compaction_end` with a result live)
  status: 'idle' | 'working' | 'thinking' | 'settled' | 'aborted' | 'error';
  error?: string;
  judgments: { id: string; turn?: number; record: JsonObject }[]; // Jev's ledger records, by the turn that asked
  dialogs: ViewDialog[]; // select / confirm / input / editor that pi waits on
  live: ViewLive; // classifying, progress, retry, compacting: only while a run goes, none after a reload
};
```

- A message counts once it is complete (`message_end`, a `message` entry). A live assistant message exists from its
  `message_start` and fills with its deltas. A tool call goes from `streaming` to `pending`, `running` (with its partial
  output), then `done` or `error`, with the result its `toolResult` message gives. Message ids count messages (`m1`,
  `m2`, …), because a live record carries no session entry id.
- The status comes from pi's events only: `agent_start` … `agent_settled` is a run, a thinking block is `thinking`, and
  how the run ended is its last assistant message's stop reason. A prompt pi refused (no model, no key) runs nothing;
  only its response says so, and the view shows it as a failed run.
- Jev's judgments are the ledger's `kyrn.decision` records: live they arrive twice (the entry and the `decision`
  frame), in the file once; they count once by record id and are filed under `origin.turn`, so a verdict that lands
  during turn 4 still says turn 3 asked. `kyrn.verdict` attaches to the user message it follows.
- A dialog closes when the app answers it (the manager hands the answer to the subscribers) or, if pi opened it during
  a run, when that run settles.

### Tests

| Test                                                          | What it covers                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/process/services/nativeHost/reducer.test.ts` (27) | The recorded conversation, plus hand-written records for what the fake model cannot produce (thinking, redacted thinking, errors, retries, compaction, late judgments, dialogs outside a run, custom messages, branches).                                                                     |
| `…/fixtures/record.mjs`                                       | Records the fixtures from a real host (Node fork, mu checkout, E2E fake model, mock judge in shadow mode): `E2E:PLAIN`, `E2E:WRITE`, `E2E:BASH`, a bash command mu asks about (answered "Allow once"), and `E2E:SLOW` aborted mid-stream. 211 records, a 46-entry session file, 20 judgments. |
| `…/nativeHost.test.ts` (25), `…/launch.test.ts` (8)           | The manager against a child the test plays: pairing, order, deadlines, crash and early-exit errors with the output's tail, `needs-model`, dispose and kill; the launcher calls and the utility-process fork.                                                                                  |
| `tests/integration/nativeHost/nativeHost.test.ts` (3)         | A real host under Node: a turn whose live view equals its session file's view, a host without a model, dispose mid-turn. Skips without a harness that plans hosts, on Windows, and without Node ≥ 22.19.                                                                                      |
| `scripts/kyrn/host-spike/measure-host.mjs`                    | Real Electron utility processes, below.                                                                                                                                                                                                                                                       |

Every run uses a throwaway home, a short environment instead of the caller's, a launcher file system without
`<harness>/.env`, the E2E fake model and the offline mock judge.

### Measured

2026-09-27, dev, harness checkout `ca50a34fb`, Electron 44.4.3 (Node 24.21.0) on macOS, `measure-host.mjs`, one run of
three hosts per entry. Times in ms from `startNativeHost`; "cold" is the first host with an empty compile cache,
"warm" the two after it. Dispose is timed from the call.

| Entry forked             | Host | pi imported | First record | First `get_state` answer | PLAIN turn | Host memory after it | Dispose (its exit) | Process gone |
| ------------------------ | ---- | ----------- | ------------ | ------------------------ | ---------- | -------------------- | ------------------ | ------------ |
| `entry.ts` (source)      | cold | 590         | 1862         | **1944**                 | 1164       | 335 MB               | 320                | 335          |
| `entry.ts` (source)      | warm | 339–365     | 472–492      | **553–563**              | 1156–1159  | 199 MB               | 3–4                | 16–17        |
| `out/main/nativeHost.js` | cold | 587         | 1816         | **1893**                 | 1160       | 336 MB               | 300                | 317          |
| `out/main/nativeHost.js` | warm | 306–335     | 434–464      | **504–537**              | 1151–1158  | 184–185 MB           | 3–4                | 16–17        |

- Across all runs that day the first `get_state` answer came at 1.83–1.94 s cold and 0.50–0.58 s warm.
- Finding the harness, planning and preparing take 1–7 ms before the fork. Between the import and the first record, pi
  starts (extensions, settings, models, session): about 1.25 s cold, 130 ms warm. The fake model streams 7 chunks
  150 ms apart, so a PLAIN turn cannot be much faster than 1.05 s.
- Dispose resolves at the exit Electron reports; the process is still exiting then (`ps` state `E`) and gone about
  13 ms later. Before `d055c048` every dispose also waited the 500 ms the manager keeps for a crash's last output,
  because a utility process's output streams stay open past its exit.
- For comparison, under Node's fork the cold path was: pi imported 0.9 s, first `get_state` answer 2.7 s.
- **Dock:** LaunchServices listed 271 apps before, 272 with Electron's main process (listed as `Foreground`, the
  control), still 272 while each host ran, 271 after. The host (`Electron Helper --type=utility`, a helper app with
  `LSUIElement`) was never listed. Earlier runs the same day gave the same +1 / +0 pattern.
- **Package layout** (`dist/bundle/index.js`): not checked. No staged mu-agent package with the new pi exists on this
  machine: the checkout has no bundle, there is no `resources/harness`, and the installed app's mu-agent 0.1.5 has no
  `planHost`.

## Milestone 2, the main process's side: native conversations

2026-09-29, same branch. The renderer's side (the conversation surface, the view's newer parts) is described in
`docs/native-host-ui.md`. Both build against `packages/desktop/src/common/kyrn/nativeBridge.ts`, the contract: what the
renderer asks (`enabled`, `list`, `create`, `open`, `request`, `respond`, `close`, `remove`, and since M3 `rename`)
and what the main process pushes (`records`, `status`, `replaced`, `changed`).

### Pieces

| File                                                         | Role                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop/src/process/bridge/nativeBridge.ts`        | `initNativeBridge` (in `initAllBridges`): the providers, what they refuse (`invalid`), failures as `{ ok: false, kind, message, stderr? }`, the quit.     |
| `…/services/nativeHost/conversations/NativeConversations.ts` | The registry: ids and drafts, the list, the idle policy and the host cap, removal, the quit.                                                              |
| `…/conversations/Conversation.ts`                            | One conversation: its host, the held view and `seq`, session changes, dialogs that time out, the model search, the locked-store retry.                    |
| `…/conversations/branch.ts`, `modelSearch.ts`, `hostEnv.ts`  | Whether pi's branch went on in a straight line; the CLI bridge's model search; mu's environment for a conversation.                                       |
| `…/services/nativeHost/sessions/`                            | Without pi: where the sessions are (`folders.ts`), the list from the files (`SessionStore.ts`, `summary.ts`), a file read into a view (`readSession.ts`). |

### Conversations and their ids

- A conversation is a pi session in a project folder; its id is the session's id. The list is read from pi's session
  files (`<agent dir>/sessions/--<project>--/<time>_<id>.jsonl`, plus a `sessionDir` the settings or
  `MU_CODING_AGENT_SESSION_DIR` name), the command line's sessions included, plus drafts made here. Reading starts no
  host and imports no pi.
- `create` makes a draft (`draft-<uuid>`) and starts nothing. When its host names the session (`get_state.sessionId`)
  the conversation takes that id: `changed { conversation, replaces: <draft id> }`. Calls with the draft id still reach
  it.
- When pi goes on in another session under a conversation (`/clear`, an import, `new_session`, `switch_session`,
  `fork`, `clone`) the conversation takes the new id the same way, and the session it left is announced as a
  conversation of its own (`changed`, from its file). The old id names the old session from then on.

**The list, cheaply.** A file of 256 KB or less is read whole; a larger one from its start until its first user
message (at most 1 MB) and its last 256 KB; a file that only grew is read from where the last read stopped. Summaries
are kept by path, size and time. Title: the latest `session_info` name, else the first user message's first line
(100 characters), else ''. `updatedAt` is the latest message's time, as pi's own list takes it.

**History without a host.** `open` of a conversation with no host reads its file in 1 MB chunks (other work runs
between them), leaves out lines that do not parse (a corrupt line, or the last one pi was still writing), and answers
`fromEntries` of the branch that ends at the file's last entry, as pi opens it, with `seq` 0. The last two views read
are kept by size and time, so an open followed by a start reads the file once.

### Hosts

- A command that needs pi starts the conversation's host (`startNativeHost({ cwd, session: <file> })`); two calls at
  once start one. `abort`, `abort_retry`, `abort_bash` and `clear_queue` with no host are answered here (nothing runs).
  `open`, `list` and `close` never start one.
- A start: make room under the cap, fork, subscribe, `get_state`, take the session's id and file, read the file's view
  when pi resumed it, fold the records that came meanwhile, then send the whole view (`replaced`) and the status
  (`running`, or `needs-model` and the model search). An `open` while a host starts waits for that view.
- The environment, as the CLI bridge gives it (`KyrnAgent.ts`): `MU_DESKTOP_SESSION` (an `n-<uuid>` per conversation,
  which never changes; mu's browser bridge looks the conversation up by it), `MU_LANG` (read at each start), and
  `MU_PERMISSIONS`: the mode `create` named, then the mode mu last announced (`permissions.mode`), for a restart. The
  system proxy is added by the utility-process fork, as in M1.
- **Lifetime.** A host ends after 10 minutes without a record or a call (`IDLE_MS`), never during a run, a dialog, a
  compaction, a command or a check. At most 4 run (`MAX_LIVE_HOSTS`); a start ends the least recently used idle ones
  first and never a busy one, so more run while more are busy. `close` ends one, `remove` ends it and moves the session
  file to the bin (only a file in mu's session folders; `invalid` otherwise), the app's quit ends all (it waits up to
  5 s). The next command starts it again with `--session <file>`.
- A host that stops unasked gives `status { failed, error: { kind: crashed | failed | no-models, message, stderr } }`,
  `changed` (`live: false`) and the saved session's view (`replaced`). A start that fails before there is a host
  (`off`, `no-harness`, `old-harness`, `plan`) fails the call and leaves the conversation `idle`.

### The stream

- Every record of the host folds into the held view (`reduce`) and goes out as `records { id, seq, record }`, `seq` one
  more each time and never reset, across restarts too. `open` of a live conversation answers the held view and its
  `seq`; the renderer folds only records above it.
- Left out: the answers of commands that only read (`get_entries`, `get_tree`, `get_messages`, `get_fork_messages`,
  `get_available_models`, `get_available_thinking_levels`, `get_commands`, `get_last_assistant_text`, `export_html`),
  whose data is the call's answer; and a prompt pi refused because another mu held the model store (proper-lockfile's
  `ELOCKED`), which is sent again after 1.5 s and 3 s. `get_state` answers do go out: the view reads the session's
  model and context from them.
- A dialog's answer goes to pi and out as an `extension_ui_response`, so every window closes it. pi stops waiting on a
  dialog when its `timeout` passes, takes the default and says nothing; the conversation then sends the same record
  with `cancelled: true`.
- mu's notices are pi's own records (`notify` requests, the `checkpoint.off` frame); the view folds them. The main
  process adds none (it did at first; the view's fold would have shown each twice).

### Session changes

pi can move to another session, or move the leaf of its branch, without a command from the app: mu's `/clear`, an
import, a checkpoint rewind. So after each run (`agent_settled`) and each prompt that starts with `/`, the conversation
asks `get_state` and `get_entries { since: <the leaf the view shows> }`:

- another session id, an entry pi does not have, or entries that do not lead in a straight line from the known leaf to
  pi's leaf (`followsBranch`): the view is rebuilt;
- otherwise the known leaf moves on.

After `new_session`, `switch_session`, `fork` and `clone` (unless pi says `cancelled`) it rebuilds at once. A rebuild
reads the session file and asks pi for what came after its last entry (pi writes a new session's file only with its
first reply), takes `fromEntries` of pi's branch, keeps the dialogs pi waits on and the live part of a run, and sends it
as `replaced` with the current `seq`. A check waits while a run goes on.

`switch_session` into a session another conversation runs is refused (`invalid`): two pis would write one file. If a
mu command switches into one anyway, the other conversation's host ends.

### Left out, compared with the CLI bridge

- `bash_missing`: the view shows pi's tool error ("No bash shell found…"); the CLI bridge added a line with the Git for
  Windows link. The view can derive it from that `tool_execution_end`.
- `stopped` and `answer_lost`: a stopped run ends `aborted` (harness `e4285a9c5`), and the app answers dialogs itself.
- The app's own permission switch (`/permissions <mode> --here` sent as a prompt): mu's "switched" notice now shows; the
  CLI bridge hid it while the app switched.

### Limits

- A view over 48 MB as JSON is not sent: `open` answers `failed` ("too large to show"). The IPC adapter drops any
  message over 50 MB (`common/adapter/main.ts`), which would leave the call unanswered. A `replaced` that large is
  dropped by the adapter (the renderer keeps its copy). A 50 MB session of tool output gives a 48 MB view.
- `fromEntries` runs in the main process and is quadratic in the number of messages (each message copies the list):
  see below.

### Tests

| Test                                                               | What it covers                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/process/services/nativeHost/sessions/` (22)            | Folders (the launcher's order, `sessionDir`, links), the list (titles, times, the cache, grown files, a corrupt last line, the recorded fixture), a file's view, a 20 MB read that stops the loop less than 150 ms.                                                                                                                                                              |
| `…/conversations/NativeConversations.test.ts` (21), `fakePi.ts`    | The registry on a stand-in pi: drafts and ids, one host for two calls, numbered records and the file's view, history without a host, restart with history, idle and cap (fake timers), `/clear`, a rewind, switch refused, locked store, crash, start failure, model search, dialogs and their timeout, permission mode, remove, quit.                                           |
| `…/conversations/nativeBridge.test.ts` (9), `parts.test.ts` (6)    | The providers over a JSON loopback, failure mapping, refusals, `initNativeBridge` with and without the flag, the size guard; `followsBranch`, the model search, the environment.                                                                                                                                                                                                 |
| `tests/integration/nativeHost/nativeConversations.test.ts` (1, +1) | The registry on a real host (Node fork, mu checkout, fake model, mock judge): create, `E2E:PLAIN`, numbered records, the held view equal to the file's, close (process gone), open from the file with no host, prompt again (resumed with history), mu's `/clear` (the conversation follows the new session, the old one is listed apart). `MU_MEASURE=1` adds the measurements. |

### Measured

2026-09-29, harness `1d80bd3a3`, macOS, hosts forked with Node 24.16.0 from `entry.ts` (sources), three runs.

| What                                                                    | Time                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| New conversation: prompt sent → host ready (`replaced`) → first record  | 2.47–2.71 s (a cold host; M1: 1.9 s in Electron)                                     |
| Running host: prompt sent → first record                                | 1 ms                                                                                 |
| Reopened conversation: prompt sent → host resumed the file (`replaced`) | 0.69–0.81 s                                                                          |
| Host memory after a PLAIN turn (RSS, Node fork, checkout sources)       | 450–456 MB (M1, Electron utility process: 184–199 MB warm)                           |
| `list` of 501 sessions of 24 KB                                         | 48–50 ms, then 5–8 ms (cached)                                                       |
| `open` of a 50 MB session (17,655 entries, 11,770 messages), no host    | 155–168 ms; the main process stopped 85–93 ms at most (`fromEntries`); 48 MB as JSON |

`fromEntries` alone (Node 24, one run):

| Session                   | Messages | Read (chunked) | `fromEntries` | View as JSON |
| ------------------------- | -------- | -------------- | ------------- | ------------ |
| 12 MB, 8 KB tool outputs  | 2,828    | 12 ms          | 15 ms         | 12 MB        |
| 25 MB, 8 KB tool outputs  | 5,886    | 24 ms          | 27 ms         | 24 MB        |
| 50 MB, 8 KB tool outputs  | 11,770   | 54 ms          | 82 ms         | 48 MB        |
| 100 MB, 8 KB tool outputs | 23,532   | 99 ms          | 657 ms        | 96 MB        |
| 25 MB, 512 B tool outputs | 42,410   | 67 ms          | 2.4 s         | 17 MB        |
| 50 MB, 512 B tool outputs | 84,656   | 146 ms         | 9.3 s         | 35 MB        |

The time grows with the square of the messages (2.4 s at 42,410, 9.3 s at 84,656): every message is added by copying
the list. The main process is stopped that long for an `open` without a host, for a host's start on a file it had not
just read, and for every rebuild.

### Learnings for M3 and M4

- `fromEntries` has to become linear (build the list in place, then hand it out) before sessions with tens of thousands
  of messages open in the main process; or fold in a worker.
- Views carry whole tool outputs. Large sessions reach the IPC cap: a snapshot should carry tool results cut to a
  size, with the rest fetched when shown.
- pi writes a new session's file only with its first reply. A conversation that never got one has no file; after its
  host ends, its next start makes a new session (and a new id, announced like a draft's).
- Session changes that mu makes itself are found by asking after each run and each slash command (one `get_state` and
  one `get_entries` since the known leaf, a few ms). An event from pi would be exact and cheaper (below).
- Hosts under Node use more memory than in a utility process; four hosts are 0.8–1.8 GB. The cap may need to follow
  the machine's memory.

## Next milestones

### M2: a native conversation surface, behind the flag

The main process's side is done (above): the bridge (`common/kyrn/nativeBridge.ts` rather than `ipcBridge.ts`), the
per-session parity with `KyrnAgent.ts`, session changes and host lifetime. What follows is the plan as written before
it; the renderer's part is in `docs/native-host-ui.md`.

- An IPC section (`common/adapter/ipcBridge.ts`): start / request / answer / dispose providers and a record emitter per
  conversation. The renderer keeps a `NativeView` per conversation by running `reduce` over the records.
- Map the view onto the existing `renderer/pages/conversation/Messages/` components instead of new ones: `MessageList`
  reads `TMessage[]` from `MessageListProvider`, so the view becomes text, thinking, tool-call and permission rows
  (`MessageText`, `MessageThinking`, `MessageToolCall` / `MessageToolGroup`, `MessagePermission`), the verdict line
  (`MessageJevLine`) and the status row. The list's guesses about stale thoughts and calls are not needed: the status
  is explicit.
- All four dialog types, `input` and `editor` included; steer and follow-up while a run goes (`queue_update` is not in
  the view yet).
- The judgment panel reads `view.judgments` instead of polling `events.jsonl`. The view covers decisions, verdicts,
  classifying and progress; the other frame kinds the adapter reads (`permissions.*`, `board.*`, memory, goal) are
  still to add.
- Carry over what the adapter does for each session today (`KyrnAgent.ts`): the environment (`MU_DESKTOP_SESSION` for
  the browser bridge, `MU_LANG`, `MU_PERMISSIONS`), the model search when pi starts without one because another mu held
  the model store (`lookForModel`, waits of 0.5–3 s), the prompt retry on a locked store (`STORE_LOCKED`), and its
  notices (bash missing, harness notices, checkpoints).
- Session changes (`new_session`, `switch_session`, `fork`, `clone`, tree navigation): rebuild the view from
  `get_entries` (`{ entries, leafId }`) with `fromEntries`.
- Host lifetime: one host per open conversation costs about 200 MB (measured above, fake model, no tools), so idle
  hosts need a policy (end after some idle time, start again on the next message).

### M3: the conversation list from pi's session files

- pi keeps each session as `<agent dir>/sessions/--<project path>--/<time>_<id>.jsonl`, and `SessionManager.list` /
  `listAll` read them (name, first message, message count, times, the session it was forked from). The list comes from
  there, not from AionCore's database. Done in M2 without pi (`sessions/SessionStore.ts`); the message count and the
  fork parent since (below); left: a name set in the middle of a large file (read only when the file is read afresh).
- mu conversations in AionCore already have pi session files: the adapter's record
  `<mu home>/acp-sessions/<ACP session id>.json` holds `{ cwd, file, permissions }`. Following AionCore conversation →
  its ACP session id → that record gives the file, which a native host opens with `--session`. Imported Claude Code and
  Codex chats are pi session files as well (`mu import` writes them; `importChats.ts` keeps its records in
  `acp-sessions/imports/`).
- What happens to AionCore's rows needs a decision: hide the mu ones once the native list shows them, keep them read
  only for a release, or leave them. Conversations with other agents (Claude Code, Codex, Gemini over ACP) stay in
  AionCore until M4 decides.

Done since (2026-09-29, branch `claude/mu-native-home`):

- **A session AionCore uses is not listed twice.** Problem: an AionCore mu conversation runs on a pi session file, so
  the native list would show it a second time. Example: `acp-sessions/0b5b…-1a01.json` holds
  `{ "cwd": "/work/app", "file": "…/sessions/--work-app--/2026…_0b5b….jsonl" }`; that file is AionCore's row already.
  Solution: `sessions/acpBindings.ts` reads the adapter's records (`<mu home>/acp-sessions/<uuid>.json`) and the
  imports' (`acp-sessions/imports/<id>.json`), each again only when its time or size changed, and the list leaves out
  the files they name (as listed or through a linked folder) unless their conversation runs here. Only the list:
  nothing is written, `open` by id still works, and a record that goes lets its file back in at the next list.
- **`messageCount` and `forkedFrom`** on each conversation: every `message` entry, as pi's own list counts them (left
  out for a large file read only in part), and the header's `parentSession`. The row's tooltip shows both.
- **`rename({ id, name })`.** With a host, pi's `set_session_name`. Without one, the main process appends the
  `session_info` entry pi would (`id`: 8 hex characters no entry of the file has; `parentId`: the last entry; an ISO
  `timestamp`; `name` with line breaks as spaces, trimmed), which pi reads back as the session's name. A draft with no
  file yet starts its host (pi keeps the name until it writes the file). Then `changed`. An empty name, or one over
  500 characters, is `invalid`.

Done since (2026-09-30, branch `claude/mu-native-polish`):

- **A conversation that wants its person says so** (`attention` event, `running` flag). Problem: a classic
  conversation tells the person when a reply has finished or a question waits (a system notification, a mark in the
  sidebar); a native one said nothing, so a long run left running while the person read another conversation, or another
  app, was never noticed. Example: a run of 10 s in conversation A, the person opens B at second 2; at second 10 A
  should be marked, and, with the window in the background, a notification says it finished. Solution: the main
  process, which folds every record of every host, says `attention` (`{ id, kind: 'done' | 'error' | 'question', title }`):
  `done` or `error` once a run has settled and nothing followed it for a moment (`ATTENTION_DELAY_MS`, 1.2 s: a goal's
  next step and a queued message start a run within it), never for a run the person stopped or one that produced
  nothing (a slash command); `question` at once for each dialog pi opens (`select`, `confirm`, `input`, `editor`; a
  `notify` is none). The timer is dropped when the host ends. What to do with it is the renderer's, which knows what is
  on screen (`useNativeAttention`, `docs/native-host-ui.md`). `NativeConversation.running` (left out when false) is
  true while a run goes; `changed` is sent when a run starts and when it settles, so the list shows it.

### M4: the default, then AionCore out of the path

- Turn the flag on by default, with the adapter as the fallback for one release; then take AionCore and ACP out of the
  conversation path.
- Packaging: pi then runs on Electron's Node, and pi needs Node ≥ 22.19. The app builds with `electron ^37.10.3` while
  dev runs 44.4.3; the shipped Electron's Node has to be checked or raised. The package layout has to be exercised in a
  utility process (bundle imported from `resources/harness/mu-agent`, outside `app.asar`).
- Windows: projects inside WSL run mu inside WSL today (`windows/wsl.ts`); a utility process cannot, so they keep the
  bridge or need a host inside WSL.

## Open questions

### What the harness would need (not changed in M1)

Done since, on the harness's `kyrn` branch: 1 (`message_end.entryId`, `2bca0ec91`), 4 (a run stopped mid-tool ends
`aborted`, `e4285a9c5`) and 5 (`prepareLaunchAsync`, `1d80bd3a3`, which `launch.ts` uses when the launcher has it).
7 is answered in the app: the main process reads the session files itself. For 3 the main process now ends a dialog
when its `timeout` passes; a dialog without a timeout that pi stops waiting on (an abort outside a run) still stays.

1. **Entry ids on live messages.** `message_end` carries no session entry id, so view ids are counters. Forking from a
   message, tree navigation and pi's own `context_edit` entries need them. Example: after a failed request pi retries
   (3 attempts, 2 / 4 / 8 s) and appends a `context_edit` that hides each failed attempt from the model, but live and
   reloaded views alike still show all four error messages, because the edits name entry ids the live messages do not
   have. Ask: the persisted entry's id on `message_end` (or an `entry_appended` for message entries).
2. **Which message a Jev turn belongs to, in the file.** Judgments carry `origin.turn` and live frames carry
   `correlation.turnId`, but `kyrn.verdict` entries have no turn number, so a reloaded view can file judgments by turn
   but cannot tie turn N to the message that started it (goal continuations and follow-ups make "Nth user message"
   wrong). Ask: `turn` in `kyrn.verdict`, or an entry at each judged turn's start.
3. **A dialog that ends without an answer.** On its timeout or on abort pi takes the default and says nothing
   (`createDialogPromise` in `rpc-mode.ts`). The view drops a run's dialogs when it settles, but a dialog opened
   outside a run stays until answered. Ask: a record when pi stops waiting on a dialog.
4. **Abort during a tool reads as an error.** Aborting while mu asked about a bash command gave a tool result
   "Operation aborted", then an assistant message with stop reason `error` and "This operation was aborted". The view
   reports what pi says, so the run shows as failed, not stopped. Ask: stop reason `aborted` there.
5. **`prepareLaunch` blocks the main process when it starts the local judge** (`spawnSync kyrn-judge-local start`).
   Ask: an asynchronous variant, or a way for the app to start the judge itself (it already runs the ONNX judge).
6. **Progress frames have no end.** `live.progress` stays until the run settles. Ask: an end marker, if the surface
   wants to clear it sooner.
7. **A session list without importing pi into the main process**: `SessionManager.listAll` needs pi. Options: an RPC
   command, or a short-lived host that lists and exits.
8. **The "No models available" exit never fires** when nothing is set up (the placeholder model above). The manager
   handles both; `needs-model` is the friendlier one (the guide can set a model without a new host), so the harness
   should keep it deliberately rather than by accident.

9. **An event when the session or the leaf changes.** mu's `/clear`, an import and a checkpoint rewind change pi's
   session without an RPC command; the main process finds out by asking after every run and slash command
   (`get_state` + `get_entries`). A record such as `session_changed { sessionId, sessionFile, leafId }` would be
   exact, and would also cover a change during a run.
10. **The file a new session will have, written with its header at once.** pi writes a new session's file only with
    its first reply, so a conversation that ends before it has none, and its next start makes another session.

### For the desktop

- M2 decisions to confirm: 10 idle minutes and 4 hosts (`IDLE_MS`, `MAX_LIVE_HOSTS`); a removed conversation's file
  goes to the bin, not deleted; after `/clear` the conversation window follows the new session and the old one is
  listed apart; the app's own permission switch now shows mu's "switched" notice; `bash_missing` is left to the view.
- The session store sees the sessions of this computer's mu home only; a project whose sessions pi keeps elsewhere
  (`--session-dir` on the command line) is not listed.

- One host per session or several sessions per host: pi keeps process-wide state (`process.env`, the working
  directory), so M1 starts one per session.
- Presentation frames of kinds the view does not read yet (see M2) and pi events it ignores (`queue_update`,
  `session_info_changed`, `thinking_level_changed`, compaction results).
- The WebUI and the web host reach AionCore over REST and WebSocket (`common/adapter/httpBridge.ts`), not Electron's
  main process: native conversations need a path there too, or the WebUI keeps AionCore.
- Where this document lives: the docs index (`docs/README.md`) puts design docs under `docs/architecture/`, which this
  tree does not have yet.
