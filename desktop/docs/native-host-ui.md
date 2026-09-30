# Native conversation surface

2026-09-29, branch `claude/mu-native-ui` (base `62844b7d`). The renderer's half of milestone 2: the screens of a
conversation that runs on the native host. The main process's half, and the contract both build against
(`packages/desktop/src/common/kyrn/nativeBridge.ts`), are in `docs/native-host.md` ("Milestone 2, the main process's
side"). Nothing here shows unless the main process says the native host is on (`enabled`: the default, unless
`MU_NATIVE_HOST=0` or the mu on the machine is too old to run inside the app, `docs/native-host.md` "On by default").

## What a person sees

- **Sidebar.** A "Native" group under the pinned conversations: mu's sessions, newest first (the command
  line's included), a green dot on one whose host runs, the newest 8 and "Show all"; a pinned row stays above the
  others and in view; the list is read again when the window comes back to the front (at most once a second), so a
  session the command line made meanwhile shows. Its "+" opens a popover: the
  folders the latest conversations worked in, "Choose a folder…", and the permission mode mu starts in (mu's default,
  full access, Jev approves, minimal). The new conversation opens, empty, ready for its first message. A row's menu
  (its "…" button, shown while the row is hovered or focused, or a right click): pin, rename, in a dialog, and delete, after
  a confirmation (the session file goes to the bin; the page of a deleted conversation goes home). The row's tooltip:
  title, folder, how many messages, the conversation it was forked from. Sessions AionCore's conversations use are not
  listed (`docs/native-host.md`, M3). The classic list under the group, when it has no conversations, does not say
  "no conversation history" while the host is on (`hideEmptyState`): the group says so itself ("No conversations yet"),
  and a new install has no AionCore conversations at all.
- **A conversation that wants you.** When a run ends or fails, or pi asks a question, while another conversation is on
  screen, the conversation's sidebar row gets a dot until it is opened; while a run goes the row shows a spinner
  instead of the green dot of a running host. A system notification says it as well (the classic conversations'
  words: "… has finished responding", "… is waiting for your confirmation", and "… stopped with an error"), which the
  main process shows only when notifications are on and the window is not in front; a click on it opens the
  conversation on the native page. A run you stopped tells nothing, and neither does the conversation on screen mark
  its own row.
- **Home page.** While the host is on, its send starts a native conversation instead of an AionCore one: the folder
  picked there (its list takes in the native conversations' folders), the permission mode picked there, the model
  the pill picked (`set_model`), the thinking level picked (`set_thinking_level`), then the message. Images go as pi's `images` (png, jpeg, webp, gif, 16 MB at most);
  other files, and an image that cannot be read, as paths under the message. The page opens the conversation once pi
  took the message; a send that cannot start one says why and keeps the text (and leaves no empty conversation).
- **Command palette** (⌘K). Native conversations are found by title or folder name among AionCore's, newest first,
  and open their own page.
- **Page** (`/conversation/native/:id`). A header (title, folder, how mu is: not running, starting, running, no model,
  stopped), the transcript in the app's message list, and at the bottom: what pi holds in its queue,
  what the screen says about mu (no model, stopped, a command that failed), the dialog pi waits on, the status line,
  mu's goal and the send box. The title is renamed where it stands: a click (or Enter) makes it a field, Enter or
  leaving the field saves (`rename`), Esc leaves it as it was; the header and the sidebar row take the new name from the
  `changed` event. The person's row shows the images they sent (60 px, whole on a click), as a sent image file shows
  in mu's other conversations, live and when the conversation is read back from its file. While a run goes the send
  box steers mu (at its next step) or leaves a message for after the run, and offers to stop. The send box has what mu's other conversations have: a "+" for files and images (also dropped or
  pasted), the permission mode pill, the model · thinking level chip, pi's slash commands in the `/` menu and `@`
  mentions of the folder's files. Above it, the goal line of mu's other conversations (`GoalLine`): "Goal in progress"
  or "Goal paused" and the condition, with "End"; beside the send button, their context ring
  (`ContextUsageIndicator`): the context's fill against the model's window, the latest reply's counts and the session's
  cost when it cost anything. Under each message, with the copy button, the fork button of mu's other conversations
  (`message-fork-button`): "Fork from here" makes a new session of the conversation up to that point and goes on in it
  (below); it is not there while a run goes.
- **Work panel.** The Jev tabs (board, judge, sub-agents) read the page's view. The lessons tab lists the lessons of
  the conversation's folder (and those for everywhere), which can be reworded and retired as for any mu conversation;
  the files tab lists the folder, the model's new files included after each run, opens a file in the preview and gets its
  dot when the model finishes a write or an edit while another tab is in view; the
  source tab lists the changes of the folder's repository (to resolve, staged, changes, untracked) under its branch,
  again after each run, and a click shows a file's diff in the preview; when git cannot run or the folder is in no
  repository, it says so; the browser tab holds the tabs mu's browser tool opens for this conversation.

## How a message travels

Problem: the transcript has to be the main process's view, live, drawn by the app's own message list, in every
window that shows the conversation.

Trace of one message:

1. The person sends "fix the build". `useNativeConversation.send` asks `request(prompt)`, shows the message as on its
   way (`outgoing`), and holds the send box: pi takes no second prompt while Jev reads the first.
2. The judgment layer's `preflight.pending` frame arrives: `view.live.classifying` is set, the status line says "Jev is
   reading your message…".
3. pi takes the prompt: `message_end` of the user message replaces the message on its way; the verdict frame adds the
   `jev:` line under it.
4. `message_update` deltas grow the reply's text row; a tool call becomes a tool row, its `tool_execution_*` records
   its output and result.
5. `agent_settled`: `view.status` is `settled`, the status line goes.

Solution: every record reaches the window numbered (`seq`), and the window folds it with the reducer the main process
uses (`common/utils/nativeHost`), so both hold the same view. A snapshot (`open`) starts it; records that arrive while
it is answered are held and folded after it; a record that skips a number means some were missed, and the
conversation is opened again. A draft's id that its session's id replaces (`changed { replaces }`) is followed, not
reopened: the route follows it (`replace` navigation) and the text in the send box stays.

The view then becomes rows for the list (`toMessages`), the Jev panel's activity (`toActivity`), the status line
(`statusRow`) and the dialogs. Nothing is read from AionCore for a native conversation: a `MessageListRun` context
tells the list, its anchor rail and `MessageText` that the rows come from a host of their own.

## Pieces

| File (under `packages/desktop/src/`)                                                                      | Role                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/utils/nativeHost/view.ts`, `reducer.ts`, `host.ts`                                                | The view (shared with the main process). Messages carry `entryId`; failed attempts pi retried fold into the reply after them; `host` keeps what only a live host says.                                                                                                                                      |
| `renderer/pages/native/index.tsx`                                                                         | The route: nothing until the main process says whether the host is on, home when it is off.                                                                                                                                                                                                                 |
| `…/native/components/NativeConversationScreen.tsx`                                                        | The page: list providers, rows into the list, the route following a draft, open failure and retry, the empty conversation.                                                                                                                                                                                  |
| `…/components/NativeHeader.tsx`, `NativeStatus.tsx`                                                       | Title, folder, host phase; the line above the send box (with `data-status`).                                                                                                                                                                                                                                |
| `…/components/NativeComposer.tsx`, `NativeHostNotice.tsx`                                                 | Queue, notices about mu, the first open dialog, status line, send box (steer / after the run, stop, take the queue back), a panel's `/board` command.                                                                                                                                                       |
| `…/components/composer/`, `…/hooks/useNativeModels.ts`, `useNativeCommands.ts`, `useNativeAttachments.ts` | The send box's controls (`NativeModelChip`, `NativePermissionPill`, `NativeAttachments`) and what they read (`composerModel.ts`): the models on offer and the switch, pi's slash commands, files and images read in the window (nothing is uploaded).                                                       |
| `…/components/NativeDialog.tsx`                                                                           | mu's permission question on the permission card; select and confirm as buttons; input and editor; the countdown.                                                                                                                                                                                            |
| `…/components/NativeSiderGroup.tsx`, `NativeNewConversation.tsx`                                          | The sidebar group and the new-conversation popover.                                                                                                                                                                                                                                                         |
| `…/hooks/useNativeConversation.ts`                                                                        | Snapshot plus numbered records, commands, dialogs answered or run out in this window, the message on its way.                                                                                                                                                                                               |
| `…/hooks/useNativeConversations.ts`                                                                       | The sidebar's list (kept by `changed`) and `useNativeEnabled` (unknown until the main process answers; a main process without the bridge never does).                                                                                                                                                       |
| `…/hooks/useNativePanel.ts`, `utils/nativeActivityStore.ts`, `utils/editNews.ts`                          | The page makes itself the current conversation and publishes its view's activity and its folder for the work panel, at most twice a second; another folder's preview closes; a finished `write` or `edit` is news for the files tab.                                                                        |
| `…/hooks/useNativeAttention.ts`                                                                           | The main process's `attention` for the whole app: a system notification (`notification.show` with `native: true`, so a click routes to the native page) and the row marks (`useNativeUnread`, `markNativeUnread`, `clearNativeUnread`; kept while the app runs; cleared when the conversation's page opens) |
| `…/hooks/useDialogDeadline.ts`                                                                            | Seconds left of a dialog with a `timeout`, counted from when this window first saw it.                                                                                                                                                                                                                      |
| `…/utils/toMessages.ts`, `toActivity.ts`, `statusRow.ts`                                                  | The view as list rows, as Jev panel activity, as one status.                                                                                                                                                                                                                                                |
| `…/utils/composerLines.ts`                                                                                | The goal the line above the send box shows (`goalOnScreen`) and the context ring's numbers (`contextUsageOf`).                                                                                                                                                                                              |
| `…/utils/forkPoint.ts`                                                                                    | Where a message's fork button goes in pi's terms (`forkPoint`): `fork` before the person's message, `fork` at the next one (or `clone`) for mu's reply.                                                                                                                                                     |
| `…/utils/dialogCard.ts`, `errorWords.ts`, `paths.ts`, `nativeClient.ts`                                   | Permission card words from mu's codes; a sentence per error kind; routes and folder names; the client over the bridge (a test hands in its own).                                                                                                                                                            |
| `…/pages/guid/hooks/useGuidNativeSend.ts`, `utils/nativeStart.ts`                                         | The home page's send on the native host: `create`, `set_model`, `prompt` with images and paths; the draft followed to its id, removed if the start fails.                                                                                                                                                   |
| `…/pages/guid/hooks/useNativeFolders.ts`                                                                  | The native conversations' folders for the home page's folder list.                                                                                                                                                                                                                                          |
| `…/native/components/NativeSource.tsx`, `…/hooks/useFolderGit.ts`, `…/utils/gitRows.ts`                   | The source tab: the folder's repository in sections with the classic source control's section and row, a row's diff in the preview; when it reads; a change as a classic row.                                                                                                                               |
| `common/kyrn/gitBridge.ts`, `process/services/folderGit/`                                                 | The contract and the main process's side: git run in the folder (root, status, one file's diff), read only.                                                                                                                                                                                                 |

Shared components changed, each only where a native conversation is concerned: `Messages/hooks.ts` (the
`MessageListRun` context), `MessageList.tsx` (run state and ids from it; native row test ids), `MessageAnchorRail.tsx`
(anchors from the loaded rows only, no search), `MessageText.tsx` (workspace from the run; a person's row with
`images`, through `MessageImages.tsx`, `IMessageText` having the optional field; a row without it is drawn as before;
the fork button through the run's `fork` when the host forks its own session),
`MessageToolGroupSummary.tsx` (native test ids), `SendBox/index.tsx` (optional `testIds`), `KyrnPanel/index.tsx`
(`lessons` and `cwd` props), `Lessons/useLessons.ts`, `Lessons/index.tsx` and `Judge/index.tsx` (read by `cwd` when
given), `WorkPanel/index.tsx` (native activity instead of polling; the folder's lessons and files), `layout/Router.tsx`
(the route), `layout/Sider/index.tsx` (the group; `GroupedHistory`'s `hideEmptyState`), `guid/GuidPage.tsx` (the native send while the host is on; `useGuidSend`
itself unchanged), `guid/components/GuidWorkspaceFootnote.tsx` (the native folders), `layout/Sider/CommandPalette/*`
(native rows; unchanged without them).

## The work panel beside a native conversation

Problem: the panel's lessons, files, source control and preview were keyed by AionCore: the lessons by the app
conversation's workspace (`kyrn.lessons { conversationId }` asks AionCore for it), the explorer by the AionCore project
(`GET /api/projects/{id}`, then the backend's `fs/*` monitor by project entry). A native conversation has neither, only
the folder its session works in (`cwd`), so its lessons tab said "not shown yet" and its files tab "no project".

Example: a conversation in `~/work/app` writes `notes/hello.txt`. mu keeps the lessons of that project in
`<agent dir>/mu/lessons.jsonl` with `scope.cwd` = `~/work/app` (its real path), the same file the classic tab reads.

Solution: the page publishes its folder with its activity (`useNativeFolder`), and the panel reads by it through three
providers keyed by a folder (`common/kyrn/folderBridge.ts`, answered in `process/bridge/kyrnBridge.ts`):

| Provider                     | What it answers                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `kyrn.folder.lessons`        | The folder's lessons (by the path as given and its real path) and those for everywhere, from the same `LessonsStore` as the classic tab.  |
| `kyrn.folder.lessons.change` | A new text or a retirement of one of them, one line appended, as `kyrn.lessons.change` does.                                              |
| `kyrn.folder.files`          | One directory of the folder (`path` relative, `''` for the folder): folders first, `.git` left out, at most 1000 entries, never above it. |
| `kyrn.folder.git.status`     | The folder's repository: root, branch (ahead/behind, detached, no commit yet), changes by area; or `no-git`, `not-repository`.            |
| `kyrn.folder.git.diff`       | One file's diff for its row's area: staged, unstaged, a new file against nothing, a conflict against HEAD.                                |

(`kyrn.folder.git.*` are declared in `common/kyrn/gitBridge.ts` and answered in `process/services/folderGit/`.)

- The files tab (`explorer/FolderFiles.tsx`) reads the folder when it comes into view, after every run (the view's
  `agent_settled`) and on its refresh button; a folder opens on a click; a file opens in the preview through
  `useLocalFilePreview`, as a file named in a message does (the preview reads it by its path, `local` file ref).
- The files tab's dot (`hooks/useNativePanel.ts`, `utils/editNews.ts`). Problem: the classic dot comes from AionCore's
  stream of file changes, which a native conversation does not have, so a file the model wrote while the person looked
  at another tab left no sign. Example: the person reads the board, the model finishes `write notes/hello.txt`, and the
  files tab should show it. Solution: the panel counts the view's finished `write` and `edit` calls (`finishedEdits`:
  not one that failed or is still running) and a count that goes up marks the tab (`bumpWorkPanelNews`, which does
  nothing while the tab is in view). The count is compared with the first read of the same view, not with 0: a
  conversation opened with three edits in it, or a fork that replaces the view, is where it stands and not news. The
  panel reads the view at most twice a second, so it reads it together with the epoch it is of
  (`NativeConversationState.epoch`) and skips a read that is of the view before; without that the snapshot, arriving
  half a second before the panel read it, was counted against the empty view the screen started with, and a
  conversation with edits opened with its dot on. A shell command that changes files says nothing of which, so it
  does not mark the tab (the folder is read again after every run in any case).
- The source tab (`native/components/NativeSource.tsx`): the classic source control is the backend's, by project entry,
  so the main process runs git itself in the folder (`process/services/folderGit/`): `rev-parse --show-toplevel`, then
  `status --porcelain=v2 -z --branch --untracked-files=all` (at most 1000 changes, the rest counted), and for a
  clicked row `diff` of that one file (`--cached` for a staged row, against `/dev/null` for a new file, against `HEAD`
  for a conflict; a binary file marked; over 256 KB cut at a line's end, the preview's last line says so). `execFile`
  with argument arrays, a timeout, `GIT_OPTIONAL_LOCKS=0` (a status never takes the index lock the model's git needs),
  `core.quotepath=false`, literal pathspecs, no fsmonitor, text conversion or external diff; the app's `GIT_*`
  variables are left out. Read only: no stage, unstage, discard or commit. The rows are the classic `ScmSection` and
  `ScmResourceRow` (letters, colours, `old → new` for a rename), unchanged; a click opens the diff with the classic
  tab's `openPreview(patch, 'diff')`. It reads when the tab comes into view, after each run, on the window's focus and
  on its refresh button: one read at a time, the ones it starts itself at least 2 s apart, never polled. The tab is
  made again each time the person comes back to it from the files, so it starts from the last answer for its folder
  (kept while the app runs) and shows that at once, with the button's spinner, until the new one comes; it is keyed
  by the folder, so another conversation's folder never shows this one's answer.
- Which git: the one on the main process's PATH, looked up at each run. Problem: the bridges are made while the main
  process's modules load (`process/utils/initBridge.ts`), before `fixPath()` gives it the login shell's PATH, and
  `execFile` searches the PATH of the environment it is passed. Example: a runner that copied `process.env` when made
  searched the launch PATH (`/usr/bin` first in a Finder launch), found the Xcode stub, and the tab said git could not
  run although the login shell had a git that runs (native-source.spec's first run). Solution: the environment is read
  at each run. When git cannot run (not found, or the stub without its licence, which also fails `--version`), the
  tab says so with git's own words (`no-git`); a folder in no repository says that (`not-repository`).
- The preview and the browser follow the folder as they follow a project: another folder's preview closes, this
  folder's tabs come back (`closePreviewIfScopeChanged(previewScopeKey(null, cwd))`).
- mu's browser tool: the page mounts the browser's host (`MuBrowserHost`) with the conversation's id, so the main
  process knows a panel is there and a run's tab opens beside the conversation mu names by `MU_DESKTOP_SESSION`
  (`process/services/muBrowser/conversationOf.ts`). Before this, only the classic layout mounted it, and mu's browser
  tool failed with "Open a conversation in the app" while a native conversation was on screen.

An app conversation reads by the conversation exactly as before: the work panel's test checks that no folder is read
for it, and a conversation with an AionCore project keeps the project explorer.

**The Jev tabs after a reopen.** The view's frames (`host.activity`) are live only; a conversation read back from its
session file has Jev's ledger (`view.judgments`) and no frames. `toActivity` turns a judgment no frame carries into a
decision at the time its record says, so the judge tab of a reopened conversation shows its judgments (it was empty).
What stays empty until the conversation's host runs again: the board (its updates are frames), the context gauge and
the judge tab's context line (pi's `get_state`), and mu's notices. The classic tabs read them from the telemetry file,
which a native conversation does not write.

## The view on screen

| View                                                                           | On screen                                                                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| A user message                                                                 | `text` row, right (`MessageText`), with its images (`content.images`); its Jev verdict as the `jev:` line under it (`MessageJevLine`) |
| `live.classifying`                                                             | A pending `jev:` line under the message on its way; the status line                                                                   |
| An assistant message's text and thinking                                       | `text` row, left; `thinking` row, live only while the model writes it                                                                 |
| A tool call with its output and result                                         | `acp_tool_call` row; the list groups a stretch of them into the tool box (`MessageToolGroupSummary`)                                  |
| A failed request                                                               | The `tips` error row, in the bridge's fixed English, which the row words in the reader's language                                     |
| `host.notices`, a stopped reply, a reply after retries                         | `mu:notice:` lines (`MessageMuNotice`), after the message that was last when the notice came                                          |
| `status`, `live.compacting`, `live.retry`, `live.progress`                     | The status line (`NativeStatus`) and its `data-status`                                                                                |
| `dialogs`                                                                      | The first open one above the send box, "Waiting after this one: N" for the rest                                                       |
| `host.queue`                                                                   | The queue above the send box; "Take back" asks `clear_queue` and puts the texts into the box                                          |
| `goal`                                                                         | The goal line above the send box while it runs or waits; none once it is met or cleared                                               |
| `host.session.contextUsage`, `cost`, the last reply's `usage`                  | The context ring beside the send button; none while pi has not said how full the context is                                           |
| Host status (`status` events)                                                  | Header phase; `needs-model` and `failed` as notices above the send box                                                                |
| `judgments`, `host.activity`, tool snapshots and images, usage, `host.session` | Jev panel activity (`toActivity`), shaped as the CLI bridge's telemetry writes it                                                     |

The view says how the run stands, so no row guesses: a thought is live only while the model writes it, and a call that
never ended in a run that is over reads as failed.

## A long conversation

Problem: the message list draws every row it is given, and each text row is a shadow tree that copies the page's
theme into itself. A session of 6,752 entries (5.4 MB, about 6,400 rows) took 24 seconds to open in the running app:
a CPU profile put 22 of them in `getPropertyValue`. Each row read the page's computed style, each read made the browser
bring the styles of the whole page up to date after the rows just mounted, so the cost grew with the square of the
rows. The same read is in the classic pages.

Two changes:

- **`ShadowView` reads the page's theme once per task**, not once per message, and watches it with one observer, not
  one each (`readTheme`, `subscribeToTheme`). Messages that mount together share the read; a change of theme drops it
  and reaches every message. This helps the classic pages too.
- **The screen gives the list only the latest rows.** `ROW_WINDOW` (120) of them, starting at the person's message that
  opens the turn the cut falls in (`windowStart`, `utils/rowWindow.ts`), so a turn never shows without its start (a
  turn longer than another window is cut where the cut falls). When the reader scrolls to the top of the list, it asks
  for the rows before (`MessageListRun.loadEarlier`, with `hasMoreBefore` in the pagination state the screen sets), and
  the screen shows another 120. The list keeps the reader's place: it notes where the row that was first is, and puts
  that row back there when the rows above it are drawn (in the render, before the paint) and each time the list's
  height changes for the next 1.5 seconds (their text is rendered in a second pass), unless the reader scrolls
  meanwhile (`KeptPlace` in `MessageList.tsx`).

The window is pinned to the row it starts at, so rows that arrive at the end do not push the first row out from under a
reader who is looking at it. A view that was replaced (another session, a rebuilt branch) is windowed anew: its row ids
(`m161`) repeat the old ones', so the pin belongs to one `epoch` of the view (`useNativeConversation`: a new number each
time the whole view is replaced, never for a record).

Kept out on purpose: a conversation that starts empty and grows in one sitting keeps every row it has drawn (the window
trims what is there when the conversation opens); the anchor rail lists the turns of the rows drawn, not of the whole
conversation; the browser's own find sees the drawn rows only.

## Commands the screens send

- `prompt` when no run goes; `prompt` with `streamingBehavior: 'steer' | 'followUp'` while one goes, so a run that
  ended just before the message arrived is started by it instead of leaving it queued.
- `abort` to stop; a prompt stopped while Jev still classified it is stopped again if pi takes it after the stop.
- `clear_queue` to take the queue back; `respond` for dialogs; a panel's `/board on|off` as a prompt.
- `get_state` only after a prompt that started no run (an extension command such as `/lessons`), to learn whether pi
  runs anything. Nothing is asked to show history: every command but `abort`, `abort_retry`, `abort_bash` and
  `clear_queue` starts a host.
- A prompt carries the attached images as pi's `images` (base64 and type, read in the window); files, attached or
  mentioned with `@`, go as full paths after `[[AION_FILES]]` at the end of the text, as AionCore adds them for mu's
  other conversations (the person's row shows them as files).
- The model chip, when it opens: `get_available_models` and `get_available_thinking_levels` (this starts a host); a pick
  sends `set_model`, then `set_thinking_level` when a level was picked. Only the person sets the thinking level. What
  the chip shows starts nothing: the view's `host.session` (pi's answers to `get_state` and `set_model`,
  `thinking_level_changed`), else the snapshot's `session` (what the session file says when no host runs: the latest
  `model_change` or reply, `thinking_level_change` and `mu.permissions` entry on the branch, as pi and mu read them when
  they resume it), else the model of the last reply.
- The permission pill: mu's `/permissions <mode> --here` as a prompt (this conversation only; the mode new
  conversations start in stays the settings'). The mode shown is mu's latest `permissions.mode` frame, else the
  snapshot's `session.permissions`, else "mu's default".
- The `/` menu: `get_commands` when a host is running (again after each start), or when the person types `/` first
  (which starts one). `/clear` and `/new` are not offered, as in mu's other conversations.
- `@` mentions: the send box searches the conversation's folder (it gets it as its conversation context's workspace).
- ↑/↓ history and `/copy`: the send box reads the view's text (the person's messages without their files, the
  replies' text) as its message list; nothing is asked of pi.
- `create(cwd, permissions?)`, `list`, `open`, `enabled`. The home page: `create`, then `set_model` when the pill
  picked a model, then `prompt`; `remove` of the draft when one of them fails.
- A row's menu: `rename(id, name)` and `remove(id)`; the header's title: `rename(id, name)`. `close` has no screen yet.
- The goal line's "End": mu's `/goal clear` as a prompt (pi runs an extension's command at once, a run going or not),
  then `abort` when a run goes, as the classic line stops it (a goal's run does not end by itself). Cleared first, so
  the stop does not pause the goal on the way. With no host, the command starts one.
- The context ring: `get_session_stats` once a host runs and after each run (`agent_settled`), from each window that
  shows the conversation; its answer reaches every window as a record (the view keeps `tokens`, `cost` and
  `contextUsage`). The main process's `get_state` after each run brings the context's fill as well. Nothing is asked
  while no host runs: the ring shows nothing then.
- A message's fork button (`forkPoint`): under the person's message pi's `fork` with the entry that message is saved as
  (the new session holds everything before it; pi answers with its text, which goes into the send box, added to what is
  there, through the app's `sendbox.fill`); under mu's reply `fork` at the person's next message (its text is not
  wanted), or `clone` when the reply is the last one. pi moves the conversation's host to the new session: the main
  process rebuilds the view and announces the new id (`changed` with `replaces`, then `replaced`), and the session the
  conversation left as a conversation of its own, from its file (`changed`). The page follows the new id and stays
  (the route changes with `samePage`); the old session is a row of the list, idle, and opens whole. The button is not
  offered while a run goes or a message is on its way (pi may not fork then), and a message without an entry id (a
  record of a harness that does not say it) says so in a toast. A fork pi refuses shows above the send box like any
  failed command; one an extension cancels (`cancelled`) does nothing.
- A prompt that runs a command an extension answers itself (`/goal …`, `/lessons`: pi's `get_commands` says
  `source: 'extension'`) adds no message of the person's: it is no longer on its way once pi took it, even when it
  starts a run (a goal does). A prompt template or a skill (`source: 'prompt' | 'skill'`) becomes a message and waits
  for it as any message does.

## Test ids

For the Playwright harness (`tests/e2e/mu-conversation/`). Stable; nothing else is exposed, in dev builds or not.

| Test id                                                                               | Element                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-sidebar-group`                                                                | The sidebar group                                                                                                                                                                                                                                  |
| `native-sidebar-item`                                                                 | A conversation row; `data-id` = the conversation's id                                                                                                                                                                                              |
| `native-sidebar-empty`, `native-sidebar-list-failed`, `native-sidebar-more`           | No conversations; the list could not be read; "Show all" / "Show fewer"                                                                                                                                                                            |
| `native-sidebar-item-menu`                                                            | A row's "…" button (shown while the row is hovered or focused); a right click on the row opens the same menu                                                                                                                                       |
| `native-sidebar-rename`, `native-sidebar-delete`                                      | The menu's rename and delete                                                                                                                                                                                                                       |
| `native-sidebar-pin`, `native-sidebar-pinned`                                         | The menu's pin / unpin (not offered before the session has a file); the pin marker of a pinned row (`data-pinned="true"` on the row)                                                                                                               |
| `native-sidebar-mark`                                                                 | The menu's mark unread / mark read (only for a conversation with a session file); the mark is kept in the window's storage (`mu.native.unread`) and outlives a restart                                                                             |
| `native-sidebar-archive`, `native-sidebar-restore`, `native-sidebar-archived-toggle`  | The menu's archive (the row leaves the list and unpins; `mu.native.archived` in the window's storage); the "Archived (n)" fold at the end of the list (`aria-expanded`), whose rows (`data-archived="true"`) offer restore instead of pin and mark |
| `native-sidebar-running`, `native-sidebar-unread`, `native-sidebar-live`              | The end of a row: a spinner while a run goes (`data-running="true"` on the row), the dot of a conversation that wanted its person (`data-unread="true"`), the green dot of a running host; only one shows, in that order                           |
| `native-rename-input`, `native-rename-save`                                           | The rename dialog's name field and save button                                                                                                                                                                                                     |
| `native-delete`, `native-delete-confirm`                                              | The delete confirmation's text; its delete button                                                                                                                                                                                                  |
| `native-new`                                                                          | The "+" that opens the new-conversation popover (`native-new-panel`)                                                                                                                                                                               |
| `native-project`                                                                      | "Choose a folder…": the folder dialog, then the new conversation                                                                                                                                                                                   |
| `native-recent-folder`                                                                | A recent folder (its path in `title`): the new conversation there                                                                                                                                                                                  |
| `native-permissions`                                                                  | The permission mode select (mu's default, full, jev, ask)                                                                                                                                                                                          |
| `native-create-failed`                                                                | Why a conversation could not be made                                                                                                                                                                                                               |
| `native-conversation`, `native-header`, `native-header-folder`, `native-header-phase` | The page; its header; the folder; the host phase (`data-phase`)                                                                                                                                                                                    |
| `native-empty`, `native-open-failed`, `native-open-retry`                             | An empty conversation; one that could not be opened; try again                                                                                                                                                                                     |
| `native-message-user`, `native-message-assistant`                                     | A row of the person's text; of mu's text                                                                                                                                                                                                           |
| `message-fork-button`                                                                 | The fork button in the hover row under a message (the classic id: the same button; shown while the pointer is over the message and no run goes)                                                                                                    |
| `native-tool-call`                                                                    | One call in the tool box; `data-tool` = pi's tool name, `data-status` = pending, running, completed, error, canceled or denied                                                                                                                     |
| `native-status`                                                                       | Always there; `data-status` = the view's status (idle, working, thinking, settled, aborted, error); `data-sending` = whether a message is on its way to pi; a line inside only while something happens                                             |
| `native-send-input`, `native-send`, `native-abort`                                    | The send box's text field, send button, stop button (while a run, a message on its way or a compaction goes)                                                                                                                                       |
| `native-send-mode`                                                                    | Steer / after the run, while a run goes                                                                                                                                                                                                            |
| `native-queue`, `native-queue-take-back`                                              | pi's queue; take it back into the box                                                                                                                                                                                                              |
| `native-dialog`                                                                       | The dialog pi waits on; `data-method` = select, confirm, input or editor                                                                                                                                                                           |
| `native-dialog-option`                                                                | Each option, in order: a select's options (`data-option-id` = its index), a confirm's yes and no (`yes`, `no`), mu's permission answers                                                                                                            |
| `native-dialog-input`, `native-dialog-submit`, `native-dialog-cancel`                 | The text of an input or editor; send or save; cancel (and "Dismiss" on a plain select)                                                                                                                                                             |
| `native-dialog-countdown`                                                             | The time left of a dialog with a timeout                                                                                                                                                                                                           |
| `native-needs-model`, `native-failed`                                                 | mu has no model; mu stopped (`data-kind` = the error kind)                                                                                                                                                                                         |
| `native-command-failed`                                                               | Why the last command failed                                                                                                                                                                                                                        |
| `native-files`                                                                        | The work panel's files tab for a native conversation (named "Files in <folder>")                                                                                                                                                                   |
| `native-file`                                                                         | A row of it: `data-path` = the path in the folder (`/` between names), `data-kind` = `dir` or `file`; a folder's row has `aria-expanded`                                                                                                           |
| `native-files-refresh`, `native-files-empty`, `native-files-failed`                   | Read the folder again; an empty folder; a directory that could not be read (its reason in `title`)                                                                                                                                                 |
| `native-source`                                                                       | The source tab of a native conversation ("Changes in <folder>"); `data-state` = loading, failed, no-git, not-repository, clean or changes; `aria-busy` while git is asked                                                                          |
| `native-source-branch`, `native-source-upstream`                                      | The branch ("Detached at …", "· No commits yet"; outside a repository the folder's name); ↑ahead ↓behind its upstream (in words in `title`)                                                                                                        |
| `native-source-refresh`                                                               | Read the repository again, at once (a read under way is followed by one more)                                                                                                                                                                      |
| `native-source-note`, `native-source-reason`                                          | What the tab says instead of a list (git cannot run, no repository, no changes, the read failed); git's own words or the failure's                                                                                                                 |
| `native-source-group`                                                                 | A section: `data-group` = conflicted, staged, unstaged or untracked                                                                                                                                                                                |
| `native-source-file`                                                                  | A changed file, around the classic row (a click opens its diff): `data-path` in the repository, `data-group`, `data-kind` (modified, added, deleted, renamed, …)                                                                                   |
| `native-source-more`, `native-source-diff-failed`                                     | Changes not listed (the count, or git wrote more than was read); a diff that could not be read (the path; its reason in `title`)                                                                                                                   |
| `kernel-no-lessons`                                                                   | The lessons tab's note while a native conversation's folder is not known (it could not be opened)                                                                                                                                                  |
| `native-model-chip`, `native-model-pill`                                              | The model · thinking level chip (`data-model` = `provider/id` or '' for none, `data-level`, `data-source` = host, file, reply or none); its button                                                                                                 |
| `composer-model-option`, `composer-level-option`, `composer-model-search`             | In the chip's menu (the menu of mu's other conversations): a model (`data-value` = `provider/id`), a level of it (`data-value`), the search box past five models                                                                                   |
| `native-model-loading`                                                                | The chip's menu while pi is asked for its models                                                                                                                                                                                                   |
| `native-permission-pill`, `native-permission`                                         | The permission mode (`data-mode` = full, jev, ask, or '' for mu's default); its button                                                                                                                                                             |
| `native-permission-option`                                                            | A mode in its menu (`data-mode`)                                                                                                                                                                                                                   |
| `native-attach`, `native-attach-input`                                                | The "+" for files and images; the file input it opens (hidden; a test sets its files)                                                                                                                                                              |
| `native-attachments`, `native-attachment`, `native-attachment-remove`                 | What is attached; one of them (`data-kind` = image or file, `data-name`); take it off                                                                                                                                                              |
| `native-header-title`, `native-header-title-input`                                    | The header's title (a click or Enter renames it); the field it becomes (Enter or leaving it saves, Esc cancels)                                                                                                                                    |
| `native-message-image`                                                                | An image the person sent, in their row (`data-mime` = its type); its `img` opens it whole                                                                                                                                                          |
| `native-context-usage`                                                                | The context ring (`data-tokens` = the context's tokens, `data-window` = the model's window, 0 when unknown); hover shows the numbers                                                                                                               |
| `composer-goal-line`, `composer-goal-text`, `composer-goal-end`                       | mu's goal line, as in mu's other conversations (`data-status` = active or paused); its condition; "End"                                                                                                                                            |

Three things to know when driving it:

- **Waiting for a run.** A sent message shows at once as a `native-message-user` row, but its run starts only once
  Jev has read it and pi took it; until then `data-status` still says how the last run ended. So after sending: wait
  for one more `native-message-user` row, then for `data-sending="false"`, then for `data-status` to be `settled`,
  `aborted` or `error`.
- **Folded tool calls.** Several calls in one stretch fold into one line (`tool-activity-group`); their
  `native-tool-call` rows exist once its header is clicked. Failed and refused calls keep a line of their own under
  the closed header.
- **mu's permission question** is a `select` whose options answer on one click; no submit.

## Tests

| Test (under `tests/unit/process/services/nativeHost/`)                                                                                                                                                 | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reducer.test.ts`, `view/entries.test.ts`, `view/host.test.ts`                                                                                                                                         | Entry ids, retried attempts folded, context edits, the live-only part, permission questions tied to their dialogs, live and reloaded views equal on the durable part.                                                                                                                                                                                                                                                                                                                                                                                             |
| `surface/toMessages.test.ts`, `toActivity.test.ts`                                                                                                                                                     | Rows for each part of the view, reuse of unchanged rows; the panel's activity as the telemetry writes it.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `surface/useNativeConversation.dom.test.tsx`, `useNativeConversations.dom.test.tsx`                                                                                                                    | Snapshot and records, held and missed records, draft ids, commands, dialogs; the list and the flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `surface/dialogs.dom.test.tsx`                                                                                                                                                                         | The permission card from mu's codes, a failed answer, select, confirm, input, editor, the countdown.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `surface/composer.dom.test.tsx`                                                                                                                                                                        | The send box held while Jev reads, stop, steer and after the run, the queue taken back, a panel's command, the notices, the status line and `data-status`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `surface/composerControls.dom.test.tsx`, `view/settings.test.ts`                                                                                                                                       | The model, level and mode shown without a host (from the file, the last reply), the model menu and switch, the mode switch, the `/` menu, `@` mentions, attachments picked, dropped and pasted, the text ↑/↓ and `/copy` read; a session file's settings.                                                                                                                                                                                                                                                                                                         |
| `surface/screen.dom.test.tsx`                                                                                                                                                                          | Page states, transcript rows, open failure and retry, flag off, a draft followed (the browser's host too), the panel feed and folder, the lessons note; sidebar list, new conversation (picked folder, recent folder, permission mode), create failure, show all.                                                                                                                                                                                                                                                                                                 |
| `panels/folder.test.ts`, `panels/browser.test.ts`                                                                                                                                                      | A folder's listing (order, links, limit, never above it) and its lessons by real path; the browser's lookup by `MU_DESKTOP_SESSION` on native conversations and the panel host.                                                                                                                                                                                                                                                                                                                                                                                   |
| `panels/git.test.ts` (15)                                                                                                                                                                              | Repositories made in the test with the git on PATH (skipped without one): no git, no repository, clean, every area, renames, odd names, a subfolder, the branch line, the cap, diffs by area, binary, cut, refused paths; PATH read at each run.                                                                                                                                                                                                                                                                                                                  |
| `surface/source.dom.test.tsx` (14)                                                                                                                                                                     | The source tab's states and words, sections and classic rows without actions, a row's diff in the preview (a rename with its old path), binary, cut and failed diffs, folding, the cap, the branch line, when it reads, the kept answer.                                                                                                                                                                                                                                                                                                                          |
| `tests/unit/renderer/layout/workPanel/WorkPanel.dom.test.tsx` ("beside a native conversation")                                                                                                         | Lessons read and retired by the folder, the note while it is unknown, the files tab read again after a run and a file opened, the source tab by the folder, a project's explorer kept (files, source); no folder read for an app conversation.                                                                                                                                                                                                                                                                                                                    |
| `surface/smoke.dom.test.tsx`                                                                                                                                                                           | The conversation recorded from a real host (`fixtures/record.mjs`) played record by record into the page, with the real list and tool box.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `surface/home.dom.test.tsx`                                                                                                                                                                            | The home page's native send (folder, mode, model, images and file paths, empty text), its failures, the folder list with the host on and off.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `surface/screen.dom.test.tsx` (row menu)                                                                                                                                                               | The tooltip (messages, fork parent), rename (and a refused one), delete after a confirmation (and cancelled), the right click.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `surface/goalAndUsage.dom.test.tsx`, `view/goal.test.ts`                                                                                                                                               | The goal line from mu's frames and from the file with no host (paused), ended with `/goal clear` (then `abort` while a run goes), a refused end; the ring's numbers, none before pi says them or after a compaction, `get_session_stats` after each run; a command an extension answers not left on its way; the view's goal from entries and frames.                                                                                                                                                                                                             |
| `surface/headerRename.dom.test.tsx`                                                                                                                                                                    | The header's title renamed on Enter and on leaving the field, Esc, an unchanged or empty name (nothing asked), a refused name (the field stays).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `surface/sentImages.dom.test.tsx`                                                                                                                                                                      | The person's images in their row (with text, alone), a classic row unchanged (files by path, an empty row, mu's side); the row's images live, from the file and on the message on its way.                                                                                                                                                                                                                                                                                                                                                                        |
| `surface/forkPoint.test.ts`, `screen.dom.test.tsx` (fork), `useNativeConversation.dom.test.tsx` (a fork), `tests/unit/chat/messageText.dom.test.tsx` (host fork)                                       | The fork point of a person's message, of a reply and of the last reply, none without an entry or while it is written; the button on each message while nothing runs, `fork` and `clone` asked, the message back in the box, the route following the fork, a refusal above the box; the page following a fork's id, not brought back by the announcement of the session it left, and opening that session afresh; the row's button through the host and not AionCore's                                                                                             |
| `surface/editNews.dom.test.tsx`                                                                                                                                                                        | The files tab's dot: `finishedEdits` counts finished writes and edits only; the dot comes when one finishes, not for what the view held when it came (the snapshot read half a second late included), a call still running, failed or not an edit, a fork's smaller view, another conversation with more edits, or while the tab is in view                                                                                                                                                                                                                       |
| `surface/attention.dom.test.tsx`, `conversations/NativeConversations.test.ts` (attention), `tests/unit/process/notificationBridge.test.ts`, `tests/unit/renderer/notificationClickNative.dom.test.tsx` | The main process says a run ended after a moment (once, with the title), failed, or that a question came, and nothing for a stopped run, a run another follows, or a host that ended; `running` in the list; the notification body per kind, marks only for a conversation not on screen, none while notifications are off, cleared on opening; the row's end (spinner over mark over green dot); a click routes to the native page                                                                                                                               |
| `native-attention.spec.mjs`                                                                                                                                                                            | In the real app: a run's spinner, the dot once it ended while another conversation was on screen (painted, not only there), the notification the main process showed, a click opening the conversation and clearing the dot, a stopped run telling nobody, a question telling the system at once                                                                                                                                                                                                                                                                  |
| `sessions/summary.test.ts`, `sessions/SessionStore.test.ts` (titles), `reducer.test.ts` (the person's words)                                                                                           | A title is the person's words: AionUi's `[Assistant Rules]` block and leading `@` attachments left out, tokens, keys and PEM private keys masked (`ghp_••••`), from the first message and from a name; the first row of a transcript without the rules block                                                                                                                                                                                                                                                                                                      |
| `view/entries.test.ts` (compaction), `surface/toMessages.test.ts` (compaction line)                                                                                                                    | A `compaction` entry in a file and a live `compaction_end` with a result give the same `compaction` message; a stopped or failed one gives none; a retry still folds into its failed attempt across the line; the line is a mu notice in the app's words                                                                                                                                                                                                                                                                                                          |
| `conversations/NativeConversations.test.ts` (no-folder), `surface/composer.dom.test.tsx` (no-folder)                                                                                                   | A message to a session whose project folder is gone fails as `no-folder` before any host is ended or started, and stays in the send box                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `native-rows.spec.mjs`                                                                                                                                                                                 | In the real app: the row menu marks a conversation unread (painted in the theme colour) and read, archives and restores it, and a restart keeps both                                                                                                                                                                                                                                                                                                                                                                                                              |
| `native-real.spec.mjs` (opt-in: `MU_E2E_REAL_SESSIONS=<a sessions folder>`)                                                                                                                            | In the real app over a COPY of real session files (never the originals; delete a kept profile afterwards): every session listed, twelve of every kind opened, the longest read back to its first message with a real wheel (every compaction has its line), a session whose folder is gone, the palette by title start, and a message sent to one session of each kind (imported from Codex, from Claude Code, made by AionCore, the biggest), pointed at the test's own folder, that must reach the fake model with its history and be answered in the same file |
| `tests/unit/renderer/layout/SiderEntries.dom.test.tsx` (placeholder), `nativeWorld.mjs` (`reachSidebar`)                                                                                               | The classic list keeps its placeholder while the host is off and hides it while it is on; in the running app no `.arco-empty` sits in the sidebar of a world with no AionCore conversations                                                                                                                                                                                                                                                                                                                                                                       |

`surface/fakeClient.ts` is an in-memory host: it folds records with the same reducer, numbers them, and answers `open`.
Elsewhere: `tests/unit/renderer/hooks/guidPage.dom.test.tsx` (the classic send while the host is off),
`tests/unit/renderer/layout/commandPalette/` (native rows, and the rows unchanged without them).

## Left out, and why

- **Tree, rewind, export**: each needs a command that starts a host and a control that does not exist yet (fork and
  clone are the button under a message). A fork takes the person's message back into the box as text only: the images
  it had do not come back (pi's `fork` answers with the text).
- **The goal line's reason**: the classic line shows the status and the condition only, and so does this one; mu's
  pause reason (`reasonCode`) and its continuations are in its notices and the board.
- **The context ring with no host**: the context window is the model's, which only pi knows; a conversation read
  from its file shows the ring once a host has run.
- **Close and remove**: the bridge has them; a remove moves the session file to the bin and wants a confirmation.
- **Source control actions**: the source tab is read only (no stage, unstage, discard or commit, no tree view, no
  history or graph); a repository nested inside the folder's own is not looked for. The files tab is a plain tree: no search, no rename or new file, no drag and drop, no "add to chat"; its dot
  comes from the model's own `write` and `edit` calls, not from a file a shell command changed.
- **Pin** is kept in the window's storage (`mu.native.pinned`, a list of session ids), not with the session: another
  window shares it, the command line and a new install do not. A conversation with no session file yet cannot be
  pinned (its id changes when pi names it).
- **The home page's level**: it sends the thinking level only when one was picked on it (with a model, or on the model
  the pill showed). The pill shows a level (the model's first) even when none was picked; mu keeps its own until the
  person picks one, and a level picked for one model is dropped when another model is picked.
- **Search and the anchor rail's history**: they read AionCore's database; native anchors come from the loaded rows.
- **Hive notes, deliveries, relations, gates, bee transcripts**: files beside a hive run; the renderer reads no files,
  so the sub-agents tab shows the snapshots only.
- **The WebUI**: the native bridge is Electron IPC; there the flag stays unknown and nothing native shows.
- **The home page's images** are read through the backend's file reader (`fs.readContent`); one it cannot read goes
  as its path.

## What the view's live-only part asks of the main process

`host` (the Jev panel's activity, mu's notices, pi's queue, the session as pi described it) is in no session file. A
rebuild from the file (`Conversation.rebuild`, after `/clear`, a rewind, a session switch) should keep it as it keeps
`dialogs` and `live`; otherwise the panel's activity and the notices clear at every rebuild. Comparisons of a held view
with a file's view compare `durable(view)`.

## What M3 and M4 need from the screens

- **One list.** The native group sits apart from AionCore's conversations. M3 lists mu's AionCore conversations from
  their session files: the sidebar then needs one list, and AionCore's mu rows need a route to the native page (by
  session file or id), with rename, close and remove.
- **The full explorer by folder**: the backend serves it by project; a native conversation has only its `cwd` (the
  files tab, the lessons and, read only, source control read by it now).
- **Large sessions.** The page maps the whole view to rows (unchanged messages reuse their rows). Views near the IPC
  cap need cut tool outputs fetched when shown, and a list that does not hold every row.
- **The home page**: done (its send creates a native conversation; its folder list takes in the native folders).
  Left: the sidebar popover's recent folders do not take in the home page's recent workspaces.
- **Fork and tree controls**, and the WebUI path (M4). The model, thinking level, permission mode and attachments are
  in the native send box.

## Open questions

- Should the tool box fold for native conversations as it does elsewhere? A lone call is a row of its own; several
  calls fold under `tool-activity-group`, and end-to-end tests must open the fold to see each.
- The countdown counts from when a window first saw the dialog: a window opened later shows more time than is left.
  A start time on the dialog request (from pi, or stamped by the main process) would fix it.
- Notices sit after the message that was last when they came, by view id. After a rebuild ids start again, so a kept
  notice may sit after another message (or at the end when its message is gone); anchoring by `entryId` would hold.
- The sidebar group: apart (as it is, beside AionCore's conversations), or one list with them by project once
  AionCore's conversations are read too.

## In the running app

`node scripts/kyrn/e2e-conversation.mjs --native` (`bun run e2e:conversation --native`; `--skip-build` reuses `out/`;
`MU_E2E_KEEP=1` keeps the throwaway profile and the screenshots in its `logs/`) builds the app and runs
`tests/e2e/mu-conversation/native.spec.mjs` on Electron with the default (nothing names `MU_NATIVE_HOST`), the fake model and the offline mock
judge. Seven steps, about 30 seconds: a conversation made from the sidebar's popover (the folder picker answered by the
test, 最小权限), a streaming reply (three or more partial states), one permission question answered "allow once" (the
file is written; the call's row is `completed`), one answered "don't allow" (the model is told, the row is `denied`,
the conversation goes on), a window reload in the middle of a run (the main process's view brings the run back, still
growing), a stop (`aborted`), a quit (no process left) and a reopen from the session file (the same messages and calls,
no host until a message needs pi, a new message starts one), and no ACP record naming the folder. On failure the test
says mu's last output when the host stopped.

Looked at in the real window (macOS, Electron 44): the popover next to the sidebar group and the permission select's
list inside it, the reply, the permission card, the tool row and mu's checkpoint notice, the failure card, the same
conversation in the dark theme and in a 760 px window (nothing overflows).

The run found that the host's entry path was relative (`require.main.filename` is "electron" in Electron 44); see
`nativeHostEntry` in `process/services/nativeHost/index.ts`.

`tests/e2e/mu-conversation/native-large.spec.mjs` writes a session file of 3,000 turns (6,752 entries, 5.4 MB; the
`MU_E2E_TURNS` variable sets the size), opens it from the sidebar, resumes it with a message, and reads it back to its
first message by scrolling to the top (`MU_E2E_PROFILE=1` prints a CPU profile of the open). On the author's Mac
(Electron 44): opened in 1.4 seconds with 122 rows in the page (it was 24 seconds, every row), a new message answered
in 1 to 2 seconds with the host started, a reply that streams in seven pieces raises no task over 50 ms and no gap
between frames over 18 ms, a step up shows 120 more rows and the row that was first stays within 0 px of where it was,
at once and a second later, and the first message of the session is reached in 52 steps, about 32 seconds in all, with
6,377 rows in the page at the end.

`tests/e2e/mu-conversation/native-panels.spec.mjs` (`--native -- native-panels.spec.mjs` runs it alone; `--native`
runs both files) checks the work panel in the same world with three changes: the mock judge in shadow mode (it judges;
what it says changes nothing pi does), the board on for the project with the fake model writing it (`mu/board.json`),
and three lessons in `mu/lessons.jsonl` (the project's, one for everywhere, another project's). A write with full
access, then every tab: 文件 lists the folder and the written file, a click opens it in 预览, 经验 lists the project's
lesson and the one for everywhere (not the other), 判定 shows the turn's lines, 看板 the fake model's board, 蜂群, 源码
and 浏览器 open; the same tabs in the dark theme. A second write shows in 文件 with nothing clicked (the run's end read
the folder again). After a quit and a new start, the conversation opened from its file shows its judgments, lessons and
files with no host running. Looked at: every tab's picture, light and dark. The run before the ledger fix showed the
reopened judge tab empty ("本会话还没有判定记录"), which is what the fix is for.

`node scripts/kyrn/e2e-conversation.mjs --native -- native-composer.spec` runs
`tests/e2e/mu-conversation/native-composer.spec.mjs` in the same world. Eight steps, about 20 seconds: a new
conversation shows the default model (nothing started) and the mode it was made in; typing `/` starts mu and lists its
commands; the second model picked on the chip answers the next message (the fake model's request names it); the level
"high" picked on the model that reasons reaches the request as `reasoning_effort`; a write asks in 最小权限 and, after
the pill's switch to 完全访问, a second write asks nothing and the file is written; an image and a file attached from
the picker reach the request (the image as an `image_url` part, the file by its full path), and ↑ brings the last
message back without its files; a file mentioned with `@` reaches it by its full path; the quit leaves nothing running.

Looked at (macOS, Electron 44, light and dark): the idle send box, the `/` menu, the model menu and its level submenu,
the permission menu, the attachment chips, the person's row after the send (the file as a card, no image: see "Left
out") and the `@` menu. The menus were pictured while they faded in. In its picture the level submenu ended at the
window's bottom edge with its last levels out of sight: Arco caps a dropdown menu at 200 px and scrolls the rest, and
the note above the levels (mu's) took a fifth of that, so a model with five levels showed the note and four (the test
clicked "high", the fourth). The flyout is no longer capped (`.model-level-note` in `arco-override.css`, which the
classic conversation's chip shares), and the step checks that every level is inside the window; run at 1440×900 and
1100×640 (`MU_E2E_WINDOW`).

`tests/e2e/mu-conversation/native-home.spec.mjs` runs with it (`--native` runs every `native*.spec.mjs`): seven steps,
about 15 seconds. Before the start it writes three finished sessions and two AionCore records (an adapter record, an
import record) into the profile; the native list shows only the free session, its tooltip ending in `消息数：2`. The
home page's folder menu offers that session's folder; a message typed on the home page opens a native conversation
there, with its reply. A row's menu renames it (the row, the header and pi's session file take the name, through
`set_session_name`) and deletes it: in the main process `shell.trashItem` is replaced by a bin in the profile, which is
handed exactly the conversation's session file; the other sessions and both records are unchanged, and the page goes
home. Before the delete a row's menu pins the older row above the newer one, the pin survives a reload, and unpinning
puts it back. Looked at (macOS, Electron 44): the home page with the folder and the typed message, a row's menu, an
idle row hovered (the "…" button in the dot's slot, over no text), the rename and delete dialogs, a pinned row, home
after the delete. The last step writes a session file into the profile while the app runs (as `mu` in a terminal does)
and brings the window to the front: the row shows, newest first.

`native-home-level.spec.mjs` (two steps, about 10 seconds): mu's default model is the one that reasons, the home page's
pill opens it to its levels, "high" picked there is the level the conversation's chip shows and the model is asked with
`reasoning_effort: high`. The levels the pill lists are the ones mu's default model reported to the classic home page;
another model's levels are not known there, so on the home page only the current model opens to levels.

`native-firstrun.spec.mjs` (three steps, about 20 seconds): a start with no provider and no default model (the guide
shows over the app). A conversation is made and a message sent: mu starts, has no model, and the screen shows the
"no model" card and the header's 没有模型 while the message row stays; the model is not asked; the send box is ready
again after about eight seconds (mu looks for a model that a locked model store may free, `MODEL_WAITS_MS`), and the
card's button opens the providers page.

`native-steer.spec.mjs` (three steps, about 45 seconds): interjecting in a run. Against the fake model's slow reply
(`E2E:SLOW`, 150 chunks 200 ms apart) a message sent while the run goes waits in pi's queue above the send box (a steer
"next step", a follow-up "after this round", by the switch beside the box) and shows no row of the person's yet; "Take
back" empties the queue into the box and the run goes on; a run stopped, nothing that was taken back is ever sent; a
steer left in the queue when the run ends by itself is delivered as the person's next row and answered. Looked at: the
queue with both kinds, and the answered steer.

`native-parallel.spec.mjs` (three steps, about 40 seconds): two conversations at once. The slow reply runs in the first
while a second conversation is made in the same window and answered; the second's page shows its own messages only, the
sidebar lists both with a host's green dot; the first, opened again from its row, has streamed on meanwhile (well past
its third chunk), shows none of the second's messages, and runs to its last chunk; the second is as it was.

`tests/e2e/mu-conversation/native-source.spec.mjs` (`--native -- native-source.spec`): five steps, about 15 seconds.
The project is made a repository with one commit by the test's own git (name and address on the command line, the
profile's home, no system config). The app takes its PATH from the login shell (`fix-path`), which in the profile's
home is the system's, where a Mac has the Xcode stub first; so the profile's home gets a `.zprofile` and a
`.bash_profile` that put a folder holding only a link to a git that runs here first. The fake model writes
`notes/hello.txt`: 源码 lists it under 未跟踪 below the branch `main`, README.md not. It then overwrites README.md with
the tab in view: the row shows under 变更 with nothing clicked (the run's end read the repository again), and a click
opens its diff in 预览 (the removed and the added lines). A file the test stages shows under 已暂存的变更 after the
refresh button. Dark theme: the list and the diff. Skipped without a git that runs, and on Windows. Its first run found
that the runner searched the launch PATH (see the work panel above). `native-panels.spec.mjs`'s source step now
expects the tab to say the folder is in no repository, or, with the stub first on PATH, that git cannot run (with
the stub's words).

Looked at (macOS, Electron 44): the untracked row, the changed and staged sections, the diff in 预览, both in light
and dark; the "git cannot run" note with the Xcode stub's sentence, light and dark.

`node scripts/kyrn/e2e-conversation.mjs --native -- native-goal.spec` runs `tests/e2e/mu-conversation/native-goal.spec.mjs`:
an image attached with a message shows in the person's row (and reaches the model as itself), the context ring shows
after the run (tokens and window above 0); the header renames the conversation (Esc first leaves
it as it was; the sidebar row and pi's session file, `session_info`, take the name); `/goal <condition>` shows the goal
line (active, the command not left on its way), the stop button pauses it (mu's `kyrn.goal` entry says `paused`);
after a quit and a new start, the conversation opened from the sidebar shows the image, the name and the goal paused
with no host, and no ring; "End" starts mu, which clears the goal (the line goes, the entry says `cleared`). Where the
goal comes from: a conversation read from its file shows its goal from the file's `kyrn.goal` entries, no host needed.
Six steps, about 22 seconds. Looked at (macOS, Electron 44, light and dark): the image in the row, the ring and its
numbers on hover, the title's field, the goal while it runs, paused, after the reopen and after its end. The pictures
of the running goal showed the line missing: it sat between the status line and the send box, and the status line
(`ThoughtDisplay`, which tucks 20 px under the send box, `z-1`) covered it. The line now sits above the status line
(`fc351d99`); that order is checked by the DOM test, and the merged build's run pictured it: the line above the
status line ("Working… 5 s") while the run goes. The classic send box (`AcpSendBox.tsx`) had the same order, status
line first, so its goal line was covered the same way; it now puts the goal line above the status line too (DOM test
`AcpSendBox.dom.test.tsx`; not pictured in a classic conversation).

`node scripts/kyrn/e2e-conversation.mjs --native -- native-fork.spec` runs `tests/e2e/mu-conversation/native-fork.spec.mjs`:
six steps, about 12 seconds. Two turns are asked (`E2E:ECHO`). The button under the second message (it shows while the
pointer is over the message, beside the copy button) forks: the route changes to the fork's id, the page stays with the
second message in the box and the first turn only in the transcript, the sidebar has two rows, and pi wrote two files:
the whole session, and the fork of its first turn with the whole one as its `parentSession`. The old session opens
whole from its row. The button under the last reply clones the branch (a third file with the same messages, the session
on screen as its parent) and puts nothing in the box. While a run goes there is no button. Its first run found a
defect in the page's hook: the page followed the fork's id, and then the announcement of the session it left (a
`changed` from that file) brought it back to that id, so the route stayed on the old session while the page showed the
fork; and the old id, kept as one of the conversation's own, made opening the old session from the list show the
fork's view. The hook now treats a session id the conversation moved from as another conversation once the route has
followed (the same defect would have shown after mu's own `/new`). Looked at (macOS, Electron 44): the button in the
hover row, the page and the sidebar after the fork.

## Not verified

- The classic send box's goal line above its status line was checked by a DOM test only, not in a classic
  conversation's window with a goal running.
- Fork and clone ran in the app with the fake model only: a fork of a session of thousands of entries, a fork of a
  message that had images (only its text comes back), and a fork an extension cancels ran in unit tests or not at all.
- Right-to-left (fa-IR), windows narrower than 760 px, and Windows and Linux layouts were not looked at.
- Fork and tree are not on the screen yet, so nothing tests them. The composer's controls are checked by the DOM
  tests and `native-composer.spec.mjs`.
- Removing a conversation ran in the app against the test's own bin; the system's bin was not used. Quitting with a run
  in progress ran in unit and integration tests only. The browser tab was opened by hand beside a native conversation; a run
  of mu's browser tool (its tab opened by the lookup) ran in unit tests only.
- The files tab with a large folder (1000 entries and more) and a folder that cannot be read were checked in unit tests
  only. The source tab with a conflict, a rename, a repository of more than 1000 changes, a cut or a binary diff, and
  on Windows and Linux: unit and DOM tests only.
- In the running app: the command palette's native rows, images and files sent from the home page, a rename without a
  host (the `session_info` entry the main process appends), and a model picked on the home page (the pill's default is
  mu's default model, so the run cannot tell whether `set_model` was sent).
