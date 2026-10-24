# Changelog

## [Unreleased]

## [0.2.10] - 2026-10-24

**0.2.10 has no changes to the agent. It keeps the version in step with the 0.2.10 desktop app.**

## [0.2.9] - 2026-10-24

**0.2.9 is board v2.1: the writer gives each subagent a `label` in the board's language, kept per session and used wherever the board names it; delegate titles are asked for in the person's language.**

### Changed

- Board v2.1, subagent labels (`kyrn/docs/features/plain-language-board.md`, `presentation-codes.md`). The writer's `agents[]` entries take a `label`: a short name in the board's language (at most 10 CJK characters or 4 words). The prompt asks it to keep a label once given and to call subagents by their labels in `headline`, `now`, `blocked`, `next` and `note`. The parser keeps a label only for a name the request listed, strips filler, quotes and closing marks, and caps it. The board keeps a per-session map from name to label: a reply without a label keeps the old one, and a new delegation of the same name clears it. The request's SUBAGENTS lines show each label beside the name (`- name (label: …) (role)`). `board.update.agents[]` and `board.note` gain an optional `label`; `who` and the params keep the exact name. The fixed sentences that name a subagent (`helper_done`, `helper_failed`, `still_running`, the rules headline and `blocked`, `/board`, the terminal widget) use the label. The `delegate` tool's `title` description now asks for a short name in the language the person writes in; hive member names are unchanged.

## [0.2.8] - 2026-10-24

**0.2.8 is plain-language board v2: a teammate's update (`headline`, `blocked`, `next`, `agents`), subagent outcomes as they happen, a stall clock, the writer in the person's language, and two races fixed.**

### Changed

- Plain-language board v2 (`kyrn/docs/features/plain-language-board.md`; contract with the desktop app in §4, codes in `presentation-codes.md`). The writer's prompt now asks for a teammate's spoken update, in this JSON: `headline`, `now`, `blocked`, `next`, `progress`, `agents: [{who, doing}]`, `confirm`, `note`. Its first sentence, "You are the voice of a coding session's status board.", is the new routing marker for tests and the desktop's e2e fake model. Only the example in the board's language is included. The request starts with `FACTS`: the task (clipped to 600 characters), the frame's `currentSubgoal`, the checklist, the stage, the run's and the previous board's age, the permission being waited for, the previous board, what is in flight (the main agent's call and how long since its last output, background jobs, the judge's permission review, the goal check), each subagent on its own line (elapsed time, silence, failed steps, retry, the report's first line, the error), the news (a failed step carries the first error-like lines of its output, redacted with `redactSecrets`), the frame's open questions, the account and the latest steps.
- The reply parser still reads the four-field reply (its headline is then the first sentence of `now`). It caps the headline at 14 words or 24 CJK characters and every other field at 2 sentences, strips filler in Chinese and English, and keeps `agents` only for names the request listed. A board whose headline equals the one shown, with no news, no note and no pending permission, is not published. Mid-run replies are capped at 600 tokens (`runtime.llm` takes `maxTokens`).
- `board.update` gains `headline` (with `headlineCode` and `headlineParams` on rules headlines: `now_<phase>`, `still_running`, `helpers_working`, `waiting_permission`), `blocked` (with `blockedCode` and `blockedParams` when filled by rules), `next`, `agents` (built by rules from `activeRuns()`: `who`, `role`, `state`, `doing`, `sinceMs`; the writer's `doing` replaces the rules' summary only for an exact name) and `updatedAt`. `phase` gains `blocked`. `board.note` gains `who`, and the codes `helper_done`, `helper_failed` and `still_running`; `helpers_back` gains `failed`.
- `board.read` v5: the phase `blocked` ("Waiting on something other than the user"), an `in_flight` state key, failure excerpts in `steps` and `events`, and subagents back, failed or stuck in the `changed` question. Without a judge, a stall reads as `blocked`.
- A subagent's end is an event and an account line as it happens: the board diffs bee statuses from the swarm tool's streamed snapshots, a one-second tick over the live runs, and the call's final snapshot. `helpers_back` counts the subagents that did not end `done`.
- Stall clock: while a run is on, an unref'd interval (every `stallMs`/4, 1 to 15 s) finds a main-agent call running, or a subagent's call silent, for 1, 3 and 10 times `stallMs` (default 60000; 0 turns it off). Each crossing replaces one `still_running` line in place (same `sequence` and `at`) and schedules one look. A call waiting for permission doesn't count.
- When a look decides to update and the stage changed, something is stuck or a permission is pending, a rules headline is presented (not stored) before the writer's board replaces it.
- The writer writes in the language the person writes in (`writingLanguage` in `src/language.ts`, from their last 1 to 3 messages: kana, Hangul, Han; Latin letters are the app's language only when it is a Latin-script one other than English; a message that tells nothing defers to the one before it, then to `MU_LANG`). Fixed sentences keep following `MU_LANG`. The `language` option's help says so.
- The terminal widget is at most three lines: `μ <headline>`, then what needs the person or what is blocked, then the latest account line. `/board` shows now, blocked, next, progress, subagents, what waits on the person and the account.

### Fixed

- A look that started before a permission request no longer publishes over it: while `pendingAsk` is set, the board keeps the permission line in `confirm`, `needsUser: true`, `phase: "waiting"` and a `waiting_permission` headline. The board shown when permission is asked now has `phase: "waiting"`; the headline and phase from before come back once it's answered.
- Writer starvation: a look overtaken by a newer trigger while the judge read skipped the writer even when no board had been written yet. It now writes anyway when there is no board or the shown board is older than `maxStaleMs` (default 15000). The writer's timeout is split: 20 s mid-run, `narrateTimeoutMs` (60 s) at the end.

## [0.2.7] - 2026-10-24

**0.2.7 adds OpenAI's decision model (`gpt-6-luna`, through the Decisions API) as a judge, and makes `gpt-6.1-sol` the `openai` provider's default model.**

### Added

- The `openai` judge (type and built-in name): OpenAI's decision model, `gpt-6-luna`, through `POST /v1/decisions` ([Decisions API](https://developers.openai.com/api/docs/guides/decisions)). Yes/no questions go out as predicates with their criteria in the instructions, choices as choices and scores as levels; answers come back with their probabilities and confidence, and usage with the cached and cache-write input tokens (`cachedInputTokens`, `cacheWriteTokens` in the ledger). A refusal or a missing answer fails the call as with TypeSafe, so the next judge or the fallback answers, and HTTP 401, 403, 429 and 5xx are classified the same way. The key is `MU_JUDGE_OPENAI_KEY`. Without it, at OpenAI's own address, the judge takes the key of the `openai` model provider (auth.json or `OPENAI_API_KEY`), but not a Sign in with ChatGPT token, nor the key of an `openai` provider that models.json points elsewhere. With a `baseUrl` (a relay or proxy that serves the same Decisions endpoint), only the judge's own key goes there. The keys of other judge services are never sent to it, and `MU_JUDGE_OPENAI_KEY` and `OPENAI_API_KEY` never to TypeSafe.
- The `openai` judge checks a request against the API's limits before sending it (1–400 questions, 2–255 choices, 2–10 levels; `bad_request` otherwise, so the next judge answers), and exports the models the API serves (`OPENAI_DECISIONS_MODELS`, today `gpt-6-luna`). When it has no key (`missing`: signed out of OpenAI, or the key removed) or OpenAI answers 401, or a 403 not about billing (`rejected`), the session says so once: `judge.notice` with `code: "openai_key"` and `reason`, then the line.
- `mu setup` offers OpenAI's decision model in its judge step, and scripts use `--judge openai`: the OpenAI key mu has, or a key on stdin's second line, written to the .env as `MU_JUDGE_OPENAI_KEY`. `mu doctor` reports where its key comes from, and `/mu judge` lists `openai`.

### Changed

- The `openai` provider's default model is `gpt-6.1-sol` (was `gpt-5.5`), as `openai-codex` and `github-copilot` already were; `mu setup` names it for an OpenAI key.

## [0.2.6] - 2026-10-24

**0.2.6 shows the note that Laya was replaced when a person sends a message, keeps mude 1.0 local only when it's installed again, and stops `mu doctor` failing on a machine without Chrome.**

### Fixed

- The `laya_removed` notice waits for a person. In 0.2.5 the desktop backend's health check of mu (a session that never gets a prompt) was the first session with a UI: it took Laya out of mu.json and got the notice about 3 s after the app started, so nobody saw it. mu.json still loses Laya at the first session start with a terminal or the desktop app, but the notice is now kept in `<agentDir>/mu/notices.json` (`layaRemoved: { judge, from }`) and said at the first message a person sends, in that session or a later one: `judge.notice`, then the line, and the entry is removed. pi's `input` event is that message; mu's own commands (`/goal`, `/permissions`, `/mu …`), which pi runs before it, and messages an extension sends don't count. A session that gets no message leaves the notice where it is, and `mu --print` and json mode still change nothing. `MU_JUDGE=laya` leaves the same notice at the start of each session that has it. The free Jev notice now writes its day beside other entries in notices.json instead of replacing the file. A mu.json that 0.2.5 already updated has no notice left to show.
- `mu judge mude install` without `--local-only` or `--with-fallback` keeps the current setting when mude 1.0 is already the judge (as `enable` does), instead of putting Jev back behind it.
- `mu judge model add`: a 401 without `HF_TOKEN` says the model doesn't exist or is private or gated, and to check the name, since Hugging Face answers both the same way.
- `mu doctor` and `/doctor` mark a missing Chrome, Chromium, Edge or Brave as optional (`--`) instead of something to fix, so `mu doctor` exits 0 when everything else is set up. `mu --help` lines fit in 100 columns.

## [0.2.5] - 2026-10-24

**0.2.5 removes Laya from mu's built-in judges. A configuration that still names it switches to mude 1.0 or Jev on its own.**

### Changed

- A configuration that still names Laya keeps working. `laya` in `tiers` or a route, and a judge of type `local`, are read without it: mude 1.0 takes its place when it is installed on this Mac and its key (`MU_JUDGE_MUDE_KEY`) is set, otherwise the judges left do, or Jev when none is left. A route left with no judge goes back to `tiers`. The first session with a terminal or the desktop app (not `mu --print` or json mode) writes that to mu.json once. It changes only those values, keeps a copy in `~/.mu/backups`, and says so once: `judge.notice` with the code `laya_removed` and the `judge`, then the line itself. A mu.json that isn't plain JSON is left alone. `MU_JUDGE=laya` is skipped in every session that has it. For such a configuration the launcher starts mude's server in the background, as it does for `mude`.
- `/mu judge laya` and `/mu route <point> laya` say that Laya is no longer built in. An `http` judge needs a `baseUrl`; its client is `HttpJudgeProvider` (it was `LocalJudgeProvider`).

### Removed

- Laya, the third-party local judge, is no longer built in: the `laya` judge, the `local` judge type, its sidecar (`kyrn/bin/kyrn-judge-local`, `kyrn/local-judge/server.py` and its lock, no longer in the package) and `mu judge setup | start | stop | status | run`. Those commands now say so and point to `mu judge mude install` and `mu judge model add <link>`; `mu judge` alone prints the judge commands. The launcher no longer starts a sidecar, and `mu doctor` drops its rows.
- `continuation.localPromised`, which only Laya used, and the one-question-at-a-time path of a `local` judge: `tool.admission` and `tool.injection` always ask in batches, and the questions about a message start together.

## [0.2.4] - 2026-10-24

**0.2.4 brings Gemini 4 Argon through Google Antigravity and fixes third-party OpenAI-compatible providers that turned away the `developer` role.**

### Fixed

- Signed in with Google Antigravity, mu now lists Gemini 4 Argon (`gemini-4-argon-low`, `-medium` and `-high`) and the Gemini 3.8 Flash tiers, and can use them. mu introduced itself to Antigravity as its IDE, version 1.107.0 (`antigravity/1.107.0 darwin/arm64`). Google lists and serves those models only to the Antigravity command line from 1.3.0, and answered 404 for them. mu now introduces itself as the command line (`antigravity/cli/1.4.0`; `MU_ANTIGRAVITY_VERSION` still raises the version). Gemini 4 Argon thinks at low, medium or high, never off. A placeholder for a model the account may not use, such as `gemini-4-argon-disabled`, is left out. The context Antigravity gives a model (1 million tokens for Claude Opus and Sonnet 5.5) is now used.
- An account that was already signed in to Antigravity gets the new models without signing in again. Its list was read only at sign-in; now the terminal and the desktop app also read it in the background as a session starts. Print and JSON runs don't, nor does `PI_OFFLINE`. Signing out still drops the account's models, these included.
- A custom OpenAI-compatible provider (`"api": "openai-completions"` in `models.json`) no longer fails with "unknown role developer" for a thinking model. Only `api.openai.com`, Azure OpenAI and Xiaomi MiMo get `developer` messages and `max_completion_tokens`; other endpoints get `system`, `max_tokens` and no `store`. When an endpoint still rejects the `developer` role, the max tokens field, `reasoning_effort`, `stream_options`, `store` or the prompt cache fields with a 400 (or a gateway's 5xx wrapping one), mu sends the request once more without it, before any output, and remembers that for the model until it restarts. `compat` in `models.json` overrides the defaults.

## [0.2.3] - 2026-10-24

**0.2.3 adds `mu judge model` for decision models from Hugging Face, makes mu decide when a mid-run message reaches the work, and makes Sign in with ChatGPT cope with a busy port 1455.**

### Added

- `mu judge model`: other decision models from Hugging Face, next to mude 1.0. `mu judge model add <link or owner/name>[@revision]` looks the model up on Hugging Face and pins the commit and every file (sha256 for files in LFS, the git hash for the others). It then downloads the model with progress and checks every file, resuming after a stop like `mu judge mude install`. It sets the model up in mude's Python environment, starts its server on 127.0.0.1 and makes it the judge, with the judges from before behind it unless `--local-only`. `list`, `use <name>` (`use mude` switches back), `start`, `stop`, `status`, `disable` and `remove` manage them, and `--json` gives one JSON object per line, as for `mu judge mude`. A model must be packaged like mude 1.0's MLX edition, with its own `d3_server_mac.py`; a repository without one is refused before anything is downloaded. One decision model runs at a time: switching stops the other's server, and mu starts the one that is the judge before a session, as it does mude.
- `mu judge mude uninstall` keeps the Python environment when models added with `mu judge model` still use it.
- `mu auth login <provider> --paste` signs in without listening on the callback port: you sign in in the browser, then paste the address it ends on. That works whichever program holds the port.

### Changed

- Less small print: `mu --help` no longer says "Formerly KYRN", `mu setup` drops its header line, the sign-in location sentence and the closing footer, and its judge question fits on one line; `mu ledger` drops its help footer, and the kernel part of the in-session `/help` keeps only the Esc and expand keys.
- mu now decides when a message you send during a run reaches the work: `input.interjection` is active by default (it was in shadow). Enter still sends a steer and Alt+Enter a follow-up, and the judge can move the message. A correction reaches the model at its next step, even when you queued it. Extra work and unrelated questions wait until the run is done, even when you sent them with Enter. Anything else goes the way you sent it. The message waits up to 1.5 s for the verdict (`features.interjection.waitMs`). It goes as sent when the verdict is late, when the judge fails or is off, and when the run ends during the wait. Messages you send in quick succession arrive in the order you sent them, however long each verdict takes. 34 of the 40 decision points now act from the start. To keep the old behavior, put `"input.interjection": "shadow"` under `modes` in `~/.mu/agent/mu.json`.

### Fixed

- Sign in with ChatGPT (`/login` and `mu auth login openai`, which the desktop app runs) no longer fails with "Port 1455 is in use" when the port is held by another sign-in of mu or pi. Port 1455 is fixed by OpenAI, and a sign-in keeps it until it ends. Before, a second sign-in started while the first still waited (two in a row from the app, a `/login` left open in a terminal) failed with that message. Now the new sign-in asks the earlier one to let go: the earlier one stops with "Sign-in stopped: a newer sign-in started and took over port 1455", and the new one listens. The Codex CLI's own login takes the port over the same way, with the request it already sends to an older login server.
- When another program keeps port 1455 (the Codex CLI or the Codex app, while its own login waits), the sign-in now names it: "Port 1455 is in use by codex (process 4321), probably for its own sign-in … Finish or cancel that sign-in, then try again". That program is left alone. `mu auth` passes this on with `code: "port_in_use"`, the port and the program, so the app can say it in its own words. The program is looked up with `lsof` (or `ss`, or `netstat` on Windows); where none answers, the message says "another program".
- Every way a ChatGPT sign-in ends now gives port 1455 back at once: success, an error, a cancel (Escape in `/login`, `cancel` or the input closing for `mu auth`), SIGTERM to `mu auth` (the app quitting or ending it), and a prompt that never answers. A sign-in nobody finishes stops listening after 15 minutes. The older ChatGPT sign-in through the Codex login (`openai-codex`) takes the port over from an earlier sign-in of mu the same way. When another program keeps the port, it still falls back to the pasted address, and now says which program it is.
- A mid-run message that the judge moves to the other queue is now expanded like any other: a prompt template or a skill (`/name …`) reaches the model expanded, not as you typed it.
- A session in RPC mode (each conversation of the desktop app) now checks `get_available_models` and `set_model` against the credential store, so a sign-in or sign-out made by another process counts at once: `mu auth logout`, or `/logout` in another terminal. Before, a signed-out subscription's models stayed listed until the session restarted.
- `/logout` moves the session off the signed-out provider's model, to the default model (else a provider's default, else the first model available), and says so: "Logged out of ChatGPT. Switched to openai/gpt-5.5." Before, the next prompt failed with "No API key". With no model left, it says to use `/login`.
- `mu auth logout google-antigravity` also drops the list of models the account gave from `models-store.json`, so the next sign-in starts from its own.

## [0.2.2] - 2026-10-24

**0.2.2 makes `mu judge mude install` cope with a full disk, a stop at any step and two installs at once.**

### Changed

- English pass on the strings added since 0.1.10, against `docs/writing-style.md`: `mu judge mude` messages say how to resume ("Run mu judge mude install to resume"); errors say what happened and what to do next ("Couldn't create the Python environment (uv venv)", "Hugging Face returned 404 for …", the disk-space error); the kernel's settings descriptions read naturally (their translations kept); `mu --help` describes `mu judge mude install` as "install mude 1.0, mu's own decision model for coding, and make it the judge on this Mac".

### Fixed

- `mu judge mude install`: Ctrl-C (or SIGTERM) during the wait between tries after a dropped connection now stops the download at once. It prints "Stopped with X of 1.8 GB downloaded. Run mu judge mude install to resume". Before, the wait (up to 30 s) ran on, and the command ended 5 s later with no message. What was downloaded was kept either way.
- `mu judge mude install`, disk space and stops:
  - A full disk (ENOSPC or EDQUOT) during the download now ends the install at once with "The disk is full: couldn't write <file>. Free up some space, then run mu judge mude install to resume". Before, it was retried as a network error for about two minutes, and the desktop app said it couldn't reach Hugging Face.
  - The free-space check before a download counts only the bytes still to come. Before, it counted the whole of every unfinished file, even when most of it was on the disk already.
  - Ctrl-C (or SIGTERM) while the Python environment is being set up now says "Stopped while setting up the Python environment. Run mu judge mude install to resume", instead of "mude's Python packages could not be installed".
- `mu judge mude install` on a Mac without uv: downloading the pinned uv (about 20 MB, from GitHub) had no time limit and ignored a stop. It now ends after 5 minutes with "uv could not be downloaded from GitHub (no answer in 300 s): run mu judge mude install again", and Ctrl-C or the app's Cancel ends it at once ("Stopped while setting up the Python environment").
- `mu judge mude install` (also from `mu setup` and the desktop app) takes `local-judge/mude/install.lock`. A second install while one runs now stops at once with "Another mude 1.0 install is running (process N). Wait for it to finish, or stop it, then run mu judge mude install again". Before, both downloaded into the same `.part` files, and the second failed with `ENOENT … .part` when the first renamed a finished file. The lock records the process's pid and start time, so a lock left by a power cut or a kill is taken over, even if the pid has since been reused.
- `mu judge mude install`, `enable` and `start`: a stop (Ctrl-C, or SIGTERM from the app's Cancel) while waiting for the server's `/health` now ends the wait at once. It also stops the server if this command started it, with "Stopped while the mude 1.0 server was starting, and stopped the server too. Run mu judge mude install again to finish". Before, the wait ran on until the CLI's 5 s exit timer, with no message. The server is started `detached`, so it survived both that exit and the app's process-group kill, and kept about 4 GB of memory while mude was not the judge. A server that was already running before the command is left running: "Stopped waiting for the mude 1.0 server, which is still starting…".

## [0.2.1] - 2026-10-24

**0.2.1 makes mude 1.0 the recommended judge on a Mac, set up from `mu setup`, and its install survives a power cut.**

### Added

- `mu setup` offers mude 1.0 in its judge step on a Mac that can run it (Apple silicon, macOS 14 or later, 8 GB of memory or more). It is the first choice and the recommended one, so pressing Enter picks it; the Jev that was recommended before follows it and stays a choice. Picking it writes Jev as the judge, then installs mude 1.0 in front of it in the same terminal, with its progress. If the install doesn't finish, Jev stays the judge and `mu judge mude install` goes on from where it stopped. Scripts use `--judge mude`. On other machines the judge step is as before: free Jev is first and recommended.

### Fixed

- `mu judge mude install` survives a power cut in the middle of the download. Every 32 MiB the partly downloaded file is synced to the disk and the amount on disk is recorded in `<file>.part.saved`. The next install goes on from there, so it never builds on an end the disk didn't keep. A part left by mu 0.2.0, which has no record, goes on from 32 MiB before its end.
- A resumed file that fails its sha256 check is downloaded once more from the start, instead of ending the install.
- The download rides out a lost connection: a try that gets some of the file starts the count of failed tries again. Tries that get nothing wait 2, 5, 10, 20 and then 30 s, about two minutes in all, before the install stops.
- Ctrl-C, or the desktop app ending an install, stops the download where it is, keeps what it got and says how much: "Stopped with 0.9 of 1.8 GB downloaded: mu judge mude install goes on from there". An install that goes on says how much is already there.
- An install that goes on from one that stopped keeps that one's `--local-only`: it is recorded in `install.json` until the install finishes. Before, running it again without the flag left the hosted judges behind mude.

## [0.2.0] - 2026-10-23

**0.2.0 starts the era of mu's own models: `mu judge mude install` turns on mude 1.0 in one command.**

### Added

- `mu judge mude install` makes mude 1.0, mu's own decision model optimized for coding, the judge on a Mac with Apple silicon (macOS 14 or later, 8 GB of memory or more). The steps:
  - It downloads the MLX 8-bit edition from huggingface.co/qybaihe/mude-1.0-mlx-8bit at a pinned revision: 31 files, 1.8 GB. Every file is checked against the sha256 pinned in `src/mude/manifest.ts`, and an interrupted download resumes with a range request.
  - It makes a Python 3.13 environment with uv: the machine's own, or a pinned release mu downloads. The packages come from `kyrn/local-judge/mude-requirements.lock.txt` with `--require-hashes`.
  - It starts the package's own System One server on 127.0.0.1:8790 (another free port when that one is taken) with a random key.
  - It puts `mude` first in `tiers`. The key goes in the .env as `MU_JUDGE_MUDE_KEY`.
- What happens when mude can't answer:
  - By default, a decision it can't answer (its server is down, or a yes/no between 0.2 and 0.8) goes to the judges that were there before. Those are hosted, so what they read leaves the machine. `tool.description` and `tool.injection` also keep going to them (`routes`): mude did worse than Jev on the first in mu's internal benchmark, and the second was not measured.
  - With `--local-only`, mude is the only judge.
- Other commands: `enable [--local-only | --with-fallback]`, `disable` (back to the judges from before), `start`, `stop`, `status` and `uninstall`. `--json` prints one JSON object per line, for the desktop app.
- A session starts the server in the background when `tiers`, a route or `MU_JUDGE` names mude, on macOS only; the desktop app's host does too, with Electron as Node. It is shared by every session like Laya's, and uses about 4 GB of memory until stopped.
- The built-in judge `mude`: `typesafe` at 127.0.0.1:8790, key `MU_JUDGE_MUDE_KEY` (never sent to TypeSafe), 4 s timeout, trusted on every capability.
- `mu doctor` checks the mude server's `/health` and its key.

## [0.1.14] - 2026-10-23

### Added

- Spend that no message of a session carries is recorded as a `kyrn.usage` session entry (a custom entry: kept in the file, never sent to the model; format in `kyrn/docs/features/usage-accounting.md`). A reply the watchdog cuts: the aborted request reports no usage, so its output is estimated from the reasoning that had streamed at 3.5 characters per token (the median over 164 reasoning-only MiMo replies on Terminal-Bench 2.1), less any output the provider did report, and priced at the model's output rate (`source: "watchdog-cut"`, `estimated: true`). Each `delegate` or `hive` sub-agent, verifiers included, when it ends: the sums of its messages' usage and cost as it streamed them, plus its own watchdog's estimates, `partial: true` when it was stopped or failed (`source: "subagent"`, with `kind`, `name`, `role`, `status`). On Terminal-Bench 2.1, 9 cuts of about 27k reasoning tokens and one hive at three times its parent's cost were in no session file. The `watchdog.cut` presentation event's `thoughtChars` is now the whole reasoning, not the end kept for the retry.
- With `"recordState": true`, a decision whose questions are built from its input (one per skill in `skills.disclosure`, per capability, per memory in `memory.worth`, and so on) also keeps those questions in its ledger row (`questions`, redacted like the request). Without them such a row could not be replayed or used to train a judge. Decisions with fixed questions are named by `specId` and `specVersion`, and keep nothing more.

### Changed

- An interactive turn waits less before the model starts. `skills.disclosure` is asked the moment the message arrives, alongside preflight, as `runtime.atTurnStart` meant it to be: the early question never went out, because an `input` event's context has no `getSystemPromptOptions`, so the skills question waited for preflight's verdict and then for its own. The list now comes from the last turn, or before the first from pi's `/skill:` commands (`features.skills.askEarly`, default true). Every wait before a turn ends 3 s after the message arrived instead of 4 s (`preflight.waitMs`, `catalog.waitMs`, `skills.waitMs`, `memory.waitMs`; the frame's was 3 s already). `tool.admission` holds a long result at most 2 s instead of 4 s (`admission.waitMs`). Measured in the owner's 49 interactive sessions (Jev, reached from China): the skills question added a median 0.7 s to every message; no preflight or skills verdict came between 3 and 4 s (past 3 s they came after 4.3 s and 5.2 s or not at all), and the one capability verdict that did opened nothing (none of 34 did); and 19 of 57 admission calls waited the full 4 s, while the 3 verdicts that came between 2 and 4 s dropped nothing. Replayed on those 67 turns, the wait before the model starts goes from a median 2.7 s to 1.7 s (mean 2.8 s to 2.0 s), and at most 3 s instead of 4 s. Approval, risk, constraint and injection checks wait as before.
- `turn.continue` in an unattended run (`mu --print`, json mode): a "you said you would" verdict (`promised`) sends the agent back at most once per user message (`features.continuation.unattendedPromised`, default 1; `maxNudges` still caps all nudges together), and not at all when the run that just ended was the agent's answer to a nudge and called no tool (`promisedAfterToolless`, default false). The ending-with-no-message rule and go-ahead nudges are unchanged, and so is an interactive session. `promised` needs a new judge capability, `intent`, which the built-in `laya` profile sets to false: with `laya,jev` it goes to Jev, and with Laya alone no `promised` nudge is sent (`continuation.localPromised: true` asks Laya again). On Terminal-Bench 2.1 (constraints-scheduling) Laya read "Done. Created `/app/meeting_scheduled.ics` …" as a promise twice; the second nudge sent the model searching `/` for test files: 4 extra requests and 51k input tokens.
- `capability.disclosure` is off by default (`DEFAULT_CONFIG.modes`; the manifest's `defaultMode` is `off`, and the desktop settings show it off). On Terminal-Bench 2.1 it was asked 162 times and never had an effect ("never open" was more accurate than the judge); in 49 interactive sessions it was asked 34 times and opened nothing, while each turn waited for it beside preflight (p50 0.91 s, p90 8.9 s; 6 of 34 answers late or failed). `off` now means: no judge call and no wait at the start of a turn, and packs and MCP servers stay hidden exactly as when the judge opens none. The model opens one with `find_capability`, the user with `/capabilities open`, a pack's command (`/review`, `/commit`) opens its own, and a sub-agent opens what its parent has open (`KYRN_CAPABILITIES_OPEN`, now passed with the decision off too, so a child asks nothing). Before, `off` hid nothing; that is `features.catalog: false` now, which also hands every MCP server to pi at session start (before, it only started the packs). `"modes": { "capability.disclosure": "active" }` in `mu.json`, or the desktop settings, bring the judge's choice back. So that the model knows what it can open without the judge, `find_capability`'s description lists the judged capabilities installed when the session's first turn starts, hidden or open, by id and kind, MCP servers first (`Installed: mcp:linear (MCP server), pack:ast-grep (pack), …`; at most 20, then "and N more"). It is taken once and kept for the session, so opening one never changes the description or the cached prefix; with nothing judged installed the description is as before, and an unattended run still leaves `find_capability` out (`catalog.unattendedHidden`).
- In the terminal and the desktop app, a call that changes files no longer waits for the checkpoint's scan after it (about 0.1 s a change on a Mac, 0.2 s in a container): the scan runs in the background, and the run ends once the last one has, waiting at most 3 s more. A rewind still waits for it, so a file changed by hand after the run is still told apart from the agent's changes.
- In the terminal and the desktop app, a chain of read-only shell commands (`pwd && find src -name '*.ts' | head`, `git status --short; git log --oneline -5`) no longer counts as a call that can change files, so a turn that only looks takes no checkpoint snapshot (in a container the first snapshot took a median 0.75-1.7 s). The permission gate and the constraint gate already read such chains as only looking (`isReadOnlyChain`); a chain with any other program, a redirection that writes, or `cd` before `git` still counts as a change.
- `turn.rewind` waits at most 3 s for its verdict (`features.checkpoint.rewindWaitMs`), not the judge's own timeout (10 s for a hosted judge, 30 s for an `llm:` one). A late verdict carries on, as the fallback did. On Terminal-Bench 2.1 every verdict came in 0.2-1.6 s.
- With Laya alone, `turn.continue` is no longer asked at the end of a run. Laya is trusted on neither `promised` (`intent`) nor a go-ahead (`meta`, `relate`), so its verdict could only be "end", while the run waited for it up to 3 s (`continuation.waitMs`). Laya also reads these questions with a yes bias: in Terminal-Bench 2.1 it said yes to `asks_go_ahead` 18 of 29 times and to `irreversible` 15 times, where Jev and mude said no on almost every state. Probed with clear cases, it answers them the right way round ("I've completed the task" scores 0.01-0.1 on all three questions), so the answers aren't inverted; it is a weak reader of agent messages. `continuation.localPromised: true` still asks it. Routes set with `/mu route` now count when mu works out which judge answers a decision (also for the batching of `tool.admission` and `tool.injection`).

### Fixed

- `/login`: a sign-in cancelled with Escape goes back quietly also when the flow rejects with the dialog's abort (GitHub Copilot's), not only with "Login cancelled".
- An unattended run (`mu --print`, json mode; not a sub-agent) could not reach an MCP server that isn't `"exposure": "always"`: since #81 it leaves `find_capability` out (`catalog.unattendedHidden`) and asks no `capability.disclosure`, and #122 made that the case for `"modes": { "default": "off" }` too. Now `find_capability` stays in such a run when at least one judged MCP server is installed when its first turn starts (`features.catalog.unattendedFindWithMcp`, default true), with the installed list from #122 in its description (`mcp:linear (MCP server)`, …), so the model can open the server within the run. Packs alone don't keep it: a run without a server (Terminal-Bench has none) sends the same first request as before, and no prompt or tool description names `find_capability` there.
- `mu "- Fix the parser"` (a message that starts with a list item) runs instead of ending with "Unknown option: - Fix the parser". On Terminal-Bench 2.1 one task's instruction starts that way (pytorch-model-recovery), and Harbor's pi command, which mu's bench adapter builds on, puts no `--` before it: that task ended with exit 1 before the agent ran, in pi and in every mu config.
- With Laya first and a hosted judge behind it (`/mu judge laya,jev`), a long tool output (`tool.admission`) and fetched content (`tool.injection`) went to Jev one chunk or passage per request, as if Laya answered them, though Laya is not trusted on screening and the cascade passes them on. They go in batches now, as with Jev alone: measured on Jev, 16 chunks took 0.44 s and 7.6k tokens in one request, against 1.4 s and 11.6k as 16. Which judge answers comes from the first judge trusted on the question, and `/mu judge` changes it for the rest of the session; before, the setting at start-up stayed.
- `tool.risk` and the permission confirmation read a flagged command with its line breaks (`riskExcerpt`). Every run of whitespace used to become one space, so in a script `echo done` and an `rm -rf build` on the next line read as one echo. Spaces and tabs still collapse, and blank lines go. A flagged command longer than 1,500 characters (`RISK_COMMAND_CHARS`, 8,000 before) reaches the judge as the excerpt the confirmation shows: the start of the command and every flagged part with the text around it. Each rule that matched keeps at least one part. Whole scripts up to 8,000 characters read worse: on 36 dev `tool.risk` scenarios hidden among read-only commands from real sessions (144 long variants), the cost (10 per false allow, 1 per needless confirmation) went from 87 to 64 with the shipped judge model.
- `mu setup`'s subscription hint no longer says to start mu and type `/login`: when setup starts mu, `/login` is already open.
- With the judge off (`"modes": { "default": "off" }`, setup's "Not now"), nothing asks it and nothing names it. The footer status after a message is left out, where it named the judge set up ("Jev 1.13 (free): chat · answer directly · off"). `/status` says `judge: off` and no longer lists `notify.routing`, `input.interjection` and `turn.drift` as `shadow`, since a built-in mode gives way to a default of off (`DecisionEngine.overrides()`). `/doctor` no longer probes the judge with a question, which sent a request to OpenCode and brought up the free Jev's notice. It and `mu doctor` say the judge is off, leave out the Jev key row, and show `browse` as off. A first `mu setup` no longer reports a backup when the only file was the empty `auth.json` pi writes at its first start.
- A judge provider that ignores the `AbortSignal` can no longer hold a decision past `timeoutMs`. `Judge.evaluate` races the provider's requests against the deadline and fails with a `timeout` `JudgeError`, so the decision takes its fallback as with any late verdict. The built-in providers already stopped at the signal.

## [0.1.13] - 2026-10-22

### Added

- A run deadline: `MU_TIME_BUDGET_S` (or `features.deadline.budgetS`) is the run's time budget in seconds, counted from when the mu process started. With a budget, the watchdog cuts a reply that has only been thinking after `min(thinkingMs, max(60 s, half the time left when the reply started))` instead of after `thinkingMs`, and the model gets a one-line steer when 50% and 80% of the budget have passed: the minutes left and, at 80%, to get the requested result in place (files written, services running) before polishing (`features.deadline.notices`). No judge is asked, a sub-agent ignores the budget, and without one nothing changes. On Terminal-Bench 2.1 all 3 watchdog cuts came 788-886 s into a 900 s budget, too late for the retry to finish.

### Changed

- `mu setup` lists services by language (`servicesInOrder`): in English OpenAI, Anthropic, Google, xAI, OpenRouter and OpenCode Zen come first, then the table's order; in Chinese the table's order. Ollama and `other` stay last. The same goes for "Choose a service from the list" and the picker for a key mu doesn't recognize; `--service` ids are unchanged.
- `quietStartup` defaults to `"header"` under mu's name (pi keeps `false`): the welcome header shows, the startup listing of loaded resources doesn't; diagnostics still do. A value in settings.json, `false` included, holds; `--verbose` overrides it.
- `/login` offers no Claude subscription sign-in under mu's name (Anthropic doesn't allow other apps to offer one); an Anthropic API key is still offered, and an earlier sign-in stays until `/logout`. `mu setup` refuses a Claude subscription token (`sk-ant-oat…`) given as a key, pasted or with `--key-stdin`, and sends it nowhere.
- The plain-language board runs only where someone watches it, the terminal and the desktop app, not in `mu --print` or json mode (`features.board.unattended` brings it back). While subagents work, it looks again only when one of them starts, finishes or fails, not every 20 seconds (`followAlways`). An unsure "has anything changed?" with nothing new no longer rewrites the board, and "is it waiting for you?" is asked only once the agent stopped. Replayed on 82 judged looks, the change gate alone cuts the writer calls from 82 to 29.
- `delegate` and `hive` ask the judge how hard a task is only when a model ladder is set (`features.swarm.models`) or a role pins a model of its own: without one, a delegation that names every role asks nothing, and one that doesn't asks only which role. Hive bees get their thinking level the way delegate's subagents do: on the session's model, the session's level, which keeps the parent's prompt cache warm.
- Hive: what a bee says starting with `FOUND:` or `DEAD END:` goes on the board without asking the judge (`features.hive.publishMarked`), and tool output is no longer put to the judge as a possible note (`publishToolOutputs`). When the judge can't answer, notes go to every bee up to `maxDeliveriesPerBee` instead of to none. A new note is held against at most 2 earlier ones (`maxRelatedPerNote`, was 6).
- `swarm.patch` is off by default: the delegate result already lists every changed file with its line counts. `"modes": { "swarm.patch": "active" }` in `mu.json` turns it back on.
- `browse` with a goal refuses up front when the judge for `browser.step` can't relate a goal to a page (Laya alone), and says how to route it to another judge; before, it opened the page and blocked after the first look.
- In shadow mode, the decisions mu acts on anyway (`browser.step`, `swarm.routing`, `judge.items`) are recorded as the judge's, not as the fallback's (`actsInShadow`).
- `notify.routing` and `input.interjection` are in shadow by default: the verdict is recorded and nothing waits for it. Without a verdict, a background job's end or watched line and the 70% and 85% context-budget notices reach the model at once, as a steer (`features.background.unjudged` and `features.notify.unjudged`: `now`, `next_turn` or `drop`); before, a job's end waited for a next turn that a one-shot run never has, and the budget notice was dropped. A watched line is not routed while `bg_output` waits on its job. A message sent mid-run goes on at once instead of after up to 1.5 s.
- `turn.continue` (v2) asks whether what the closing message offers is more than the user asked for (`beyond_request`). Only a go-ahead on the requested work sends the agent back; an offer of extra work no longer does. The local judge (Laya) is not asked this question, so on Laya alone no stop counts as a go-ahead.
- `cache.warming` is asked only while the agent is idle and waits at most 3 s (`features.warming.waitMs`). During a run pi's own decision stands, so a message that reads like a sign-off can no longer stop warming in the middle of the run.
- `skills.disclosure`: a verdict on the session's first message that arrives after the 4 s wait is applied from the next turn, instead of the session keeping every skill description (`features.skills.applyLate`).
- `tool.injection` asks the judge only about passages with prose in them: six words in a row on a line, or eight characters in a row of a script written without spaces (`features.injection.proseWords`, 0 judges every passage). Directory listings, link lists, response headers and short grep hits get the rules alone. On Terminal-Bench 2.1 that is about half of all screened passages, and half of the screened results need no request at all.
- `tool.injection` and `tool.admission` ask for a new judge capability, `screen`, which the built-in `laya` profile sets to false. With `laya,jev` they go straight to Jev; with Laya alone, injection is left to the rules and long output goes in whole. On Terminal-Bench 2.1 every passage Laya withheld was clean, its one admission drop was wrong, and most of its calls on both failed or came too late.
- A cascade's stand-in answer (`judge: "untrusted"` or `"unavailable"`, a probability of 0.5 nobody gave) is no verdict for `tool.injection`: the rules read the passage, where before it passed unread. Such a call, and an admission call answered only by stand-ins, is recorded as a fallback (`abstain`).
- `tool.admission` no longer judges `web_fetch` results (added to `passThrough`, whose listed default now also shows `delegate` and `hive`) or a bash or PowerShell command that only prints files (`features.admission.printCommands`: `cat`, `sed -n`, `head`, `tail`, `nl`, `less`, `bat`, `grep`, `rg`, `od`, `xxd`, `git show`, `git diff`, `readelf`, `objdump`, with `cd` and `echo` between them). A redirect, a here document, `$(…)`, `&&` into another program or `tail -f` makes it more than a print. On Terminal-Bench 2.1 this skips 46 of 89 admission calls; every drop the judge got right there was in background-job or script output, which is still judged.
- An unattended run (`mu --print`, json mode) runs a lean profile. Preflight, capability disclosure and the drift check are not asked; no skill is drafted and no lesson is learned, while kept lessons are still read; and `delegate`, `apply_patch_from`, `browse`, `locate`, `remember`, `find_skill`, `find_capability`, `hive` and the bundled `mu-browser` skill are left out of the request, so its first request is about 1.9k tokens smaller (17.8k to 10.5k characters on a faux-provider session). Packs stay hidden as before. A tool called for by its command stays (`mu -p "/hive …"`). Sub-agents, which run in json mode too, are not affected. Each part has an option: `preflight.unattended`, `catalog.askUnattended`, `catalog.unattendedHidden`, `monitor.unattended`, `procedures.unattended`, `memory.unattendedWrites`.
- `turn.drift` only records by default (`modes: { "turn.drift": "shadow" }`): in benchmark runs Jev never flagged drift, and about 9 in 10 of another judge's drift steers were wrong. Set it to `active` to have it steer again.
- `skill.capture` drafts a skill only when the judge is at least 90% sure the run was a procedure (was 70%).
- `memory.outcome` learns only from a loop the turn got out of, not from drift, which names no failing call.
- Permission modes: a command made only of read-only commands joined by `;`, `&&`, `||` or `|` (`pwd && find . -name '*.ts' | sort | head`, `git status --short; git log --oneline -5`), throwing output away with `2>/dev/null` or `2>&1`, runs without asking the judge or you, like a single read-only command, and the constraint gate no longer checks it. A redirect that writes a file, `sed -i`, `tee`, `find` with `-exec`, `-delete` or `-fprint`, a substitution, or `cd` followed by `git` still asks. Quoting is read the way the shell reads it, so `rg '--pre=./x'` and `sort --out=f` no longer pass as read-only (`features.permissions.readOnlyChains`, `features.constraints.skipReadOnly`).
- The risk rules flag `rm` only when it deletes recursively (`-r`, `-R`, `-rf`, `--recursive`, also after a file name); `rm -f file` and `docker run --rm` are not flagged. `curl … | python3 -c '…'` (and `node -e`, `perl -e`, `ruby -e`) reads the download as data and is no longer "runs a downloaded script", unless the code runs what it reads (`exec`, `eval`, `system`, …). A download saved and then run in the same command (`curl -o i.sh … && sh i.sh`) is flagged now.
- `tool.risk` (v2) asks only whether you asked for the command. Its "destructive" question never changed a verdict in Judge mode; with permission modes off, a "not destructive" no longer lets the guard run a flagged command.
- `tool.description` (v2) keeps the judge's verdicts in `~/.mu/agent/mu/tool-descriptions.json`, so the next `mu --print`, subagent or restart doesn't screen an unchanged MCP server again or wait up to 8 seconds for it. A call to an MCP tool taken off the list is refused before anyone is asked to allow it, and a cascade's stand-in answer is no verdict here either: the rules read that passage, and nothing is kept.
- `turn.drift` (v2) is reworked, and stays in shadow until a benchmark validates it. The judge sees the task frame's goal and first open acceptance item; the last 8 actions as `bash: make -> exit 2 in 14s; last line: …`; the minutes since the last sign of progress (a file written for the first time, more tests passing or fewer failing, an error not seen before, a failing call passing, a call of a minute or more that succeeds, a ticked item) and since the start; and how often one call came back the same. It is asked after 6 tool results once 3 minutes have passed since the last check, or 10 minutes after it whatever happened, on a timer that never keeps the process alive (`features.monitor`: `every`, `minMinutes`, `maxMinutes`). A steer needs drift at p ≥ 0.9 on two checks in a row and 10 minutes without progress (`stuckMinutes`), or a loop reading at p ≥ 0.8, named once per call like the loop rule; at most one steer per 15 minutes, the loop rule's included (`cooldownMinutes`). It names what looks stuck and asks for a different approach. In shadow, the steer it would have sent is recorded as a `kyrn.monitor` entry with `shadow: true`. Replayed over the 109 Terminal-Bench 2.1 sessions of 0.1.11 with their recorded answers, it asks about 30% less often, leaves less of a timed-out run unchecked, and sends none of the 29 drift steers v1 sent: 1 of them came after 10 minutes without progress, and it followed an `on_track` reading.
- An unattended run takes no checkpoints (`features.checkpoint.unattended`): no snapshot before the first call that can change files, and no blocking rescan after each one, where nobody can confirm a rewind and no file was ever put back. In Terminal-Bench 2.1 trials the snapshot and rescans cost a median 4-7.5 s a trial; on a Mac, 20 file-changing calls in a 2,000-file folder spent 2.5-3.0 s in git, and now spend none. A dead end is still asked about (`turn.rewind`), in a turn that ran such a call, and the model is told to step back. Sub-agents took none already. Nothing changes in the terminal or the desktop app.
- Judge warm-up (`features.warmup`) sends no probe in an unattended run (`unattended`), to a judge at a loopback, private-network or `host.docker.internal` address (`nearby`), or while a real question used the connection within the last `intervalMs`. A probe still on its way is cancelled when the session ends, and `/status` counts probes and their input tokens. Unattended Jev runs sent about 19 probes a trial (5.2k input tokens), more than their logged judge traffic.
- `notify.routing` is not asked in an unattended run (`features.notify.unattended`), like the drift check: in shadow, its default, the verdict changes nothing there.
- Sub-agents (`delegate`, hive bees) take their parent's settled `skills.disclosure` and `capability.disclosure` answers instead of asking the judge again: the parent passes the skills it hides and the capabilities it has open (`KYRN_SKILLS_HIDDEN`, `KYRN_CAPABILITIES_OPEN`), and the child hides and opens exactly those, whatever its own mode, and asks nothing. That saves about 0.8k judge tokens and up to 4 s at every child's start, and with 4 or more skills a further 6.5-11k tokens; a child whose own skills verdict came late used to carry every skill description on every request. While the parent's first skills verdict is still on its way, a child asks for itself as before. `features.skills.subagentsInherit` and `features.catalog.subagentsInherit` turn it off.
- In `mu --print`, json mode and sub-agents the system prompt is about 375 tokens shorter per request (9.1k to 7.7k characters on a faux-provider print session): pi's `<docs>` list of its guides becomes one line with the path to the docs, and the `<mu>` section leaves out the commands to type, the reply to act on, the hints before a turn and the `browse` tool. In Terminal-Bench runs the docs were never read in 286 trials. Interactive and desktop sessions keep both (`features.welcome.unattended` brings them back elsewhere).
- `web_fetch`'s description, its note on a page that needs JavaScript and `web_search`'s advice when no source answers name the `browse` tool only when the model has it; before, an unattended run, which leaves `browse` out, was told to use it.
- The settings texts added in this release for the drift monitor's timing options, sub-agents taking the session's skills and capabilities, and the unattended-run options of checkpoints, notification routing, judge warm-up and the welcome note are in all eleven extra languages.
- The judgment layer's bundle is split: code it imports only when used (the Google sign-in providers' request code with Google's SDK, 1.2 MB) moves from `judge/mu/index.js` (3.5 MB to 2.4 MB) to chunks beside it, which Node reads and compiles only on first use. Importing the extension takes about 9 ms less on a cold compile cache (48 to 40 ms on an Apple M6), at every start and in every sub-agent. The build imports every chunk once to check that Node can.

### Fixed

- `mu doctor` (kyrn-doctor) prints "mu doctor found N things to fix" or "mu doctor: everything is set up" first when stdout is a terminal; piped output is still one row per line.
- `/login` hides the `openai-codex` sign-in under mu's name, as `mu auth` and the desktop app do; `openai` (Sign in with ChatGPT) replaces it. A stored `openai-codex` sign-in still works and shows in `/logout`. The first `/login` menu leaves out the "Sign in with Radius" shortcut under mu's name; Radius is still under Sign in with an account. `mu setup`'s subscription hint names `/login`'s actual entries.
- The footer shows "no model" for the agent's `unknown/unknown` placeholder.
- `mu setup` ends with exit code 4 (`SETUP_EXIT.signIn`) when a subscription was chosen and a session follows; the launcher then starts the session with `/login` as its first message, which opens the sign-in like the typed command (`afterSetup`). Inside a session, "No models available" leads with `/login` (`formatNoModelsAvailableMessage({ inSession: true })`).
- `mu judge` (kyrn-judge-local): `help`/`--help` prints a usage, an unknown command prints it to stderr and exits 2, `status` prints one readable line (`status --json` the server's JSON), and its messages are sentence case. `mu ledger --help` prints a usage instead of reading the sessions. `mu auth --help` (or a bare `mu auth`) prints mu's `status | login | logout` before pi's auth help. `mu import --help` names `MU_AGENT_DIR`, the variable the docs use. `mu link --help` / `mu unlink --help` print a usage (they linked and unlinked); unlink's messages are sentences. The launcher answers `mu --version` and `-v` itself with mu's bare version: in a checkout from kyrn/npm/package.template.json (pi's own answer there was pi's version), in the package from its package.json; the smoke test checks it; the launch-chain tests start pi with `--help` instead.
- `mu setup`'s "Not now" judge writes `"modes": { "default": "off" }` (before: nothing, so the default `jev` tier with no key used the free Jev on OpenCode Zen); a judge picked later removes that "off". `mu setup --judge off` writes the same for scripts; `--judge none` still leaves the judge unchanged. The engine takes `builtInModes` (DEFAULT_CONFIG.modes): with the default "off", a point whose mode is only its built-in one is off too, so no judge is asked; a mode set to another value holds. With every point off, the welcome line shows the judge as off and neither it nor the warm-up probes the judge.
- The loop rule ("the same call 3 times with the same outcome") compares the whole input and the result text. Paging through a file with `read` at different offsets, or two scripts whose first 300 characters match, no longer counts as a loop.
- The end-of-run checks (`turn.completion`, `turn.continue`) cancel their judge call when their 3 s wait runs out. A late verdict no longer keeps `mu --print` from exiting until the judge's own timeout: with a slow local judge, runs ended 7-13 s after their last message. Notification verdicts still on their way are cancelled when the session ends.
- The `remember` tool dropped a lesson when the judge gave no verdict (a timeout, no judge, shadow mode) or could not tell. It now stores it; only a judge that reads it as one-off or known already turns it down. Sub-agents' `Lesson:` lines still need a verdict.
- `manifest.json` gives a decision point its built-in mode (`defaultMode`) when `DEFAULT_CONFIG.modes` sets one for it: `swarm.patch` off, `notify.routing`, `input.interjection` and `turn.drift` in shadow. Without it the desktop app's settings and kernel bar showed these points at the default mode, as active, and usemu.dev counted 38 of the 40 points as acting from the start instead of 34. `scripts/write-docs-reference.mjs` reads the modes from the manifest too.
- The local judge (Laya) no longer crashes when the disk runs low. Core ML keeps its compiled copy of the model in `~/Library/Caches/python/com.apple.e5rt.e5bundlecache`, marked purgeable, and macOS deletes it to free space; each change of input length read it back, so the next one recompiled the model (3-36 s) or aborted the sidecar inside MetalPerformanceShadersGraph (`failed assertion shape.count = 0 != strides.count = 2`), five times in one night of Terminal-Bench. The sidecar now pads every request to the checkpoint's whole window (1024 tokens), so after warm-up the length never changes: about 10 ms more a question at a steady length, and no more 0.4-1 s switches. `MU_LOCAL_JUDGE_MIN_LENGTH=256` brings the shorter buckets back. Warm-up skips the lengths no request can reach and no longer logs `warm-up for length 16 failed: StopIteration`.

## [0.1.12] - 2026-10-22

### Added

- A long-thinking watchdog: a reply that has only been thinking for 10 minutes, with no text and no tool call yet, is cut and asked again at the same reasoning effort, with the end of its reasoning so far and a request to act on it first. The retry is never cut. At most 3 cuts per message (`features.watchdog`: `thinkingMs`, `maxCuts`).
- `mu import` reads ZCode conversations too (`~/.zcode/cli/db/db.sqlite`), beside Claude Code and Codex, with rewinds, compactions, sub-agent threads and forks.
- Imported conversations keep their whole history: thinking (shown, never sent to the new model) and images, as well as messages and tool calls. A Claude Code conversation keeps the title Claude Code shows for it.
- Importing a conversation again brings over what's new in it, into the same conversation; if you also went on in mu, the new import is a conversation of its own. `mu import --list` marks conversations that changed since.

### Changed

- The permission mode `jev` ("Jev approves") is now `judge` ("Judge mode"): `/permissions full | judge | ask`, `MU_PERMISSIONS=judge`. A saved `jev` falls back to the default, which is judge mode. The kernel's and the command line's messages say "the judge" where they meant mu's judge in general, and keep "Jev" for TypeSafe's hosted model.
- Background jobs started with `bg_start` keep running after an unattended run (`mu --print`, json mode) ends, so a server a task asked for is still up afterwards. Such jobs write to their log file instead of a pipe to mu. Interactive and desktop sessions still stop their jobs at the end (`features.background.keepOnExit`: `headless`, `always` or `never`).
- A failed model request is retried up to 8 times instead of 3 (`retry.maxRetries`). With the 60-second cap on each wait, a provider that stops answering for about four minutes no longer ends the run.

### Fixed

- A run that ended on a reply with only thinking in it, no text and no tool call, stopped there without a word. mu now sends the agent back to the task, up to the same limit as its other nudges.
- A reply cut by the provider's content filter (`finish_reason: content_filter`) ended the run. It is now asked again, twice at most.
- A Claude Code conversation compacted more than once is imported whole; before, the import stopped at the latest compaction.
- An imported conversation goes on with mu's model, not the one Claude Code, Codex or ZCode answered with, so `mu` no longer warns that it can't restore that model.

## [0.1.11] - 2026-10-21

### Changed

- The package's keywords add `pi-coding-agent`, `mcp` and `prompt-injection`, so directories that index pi coding agents and MCP clients find it.
- English: a copy edit of what the command line and the kernel show, after `docs/writing-style.md`: "subagent" as one word, "canceled", "session" for what is allowed until the session ends ("Allow for this session"), and clearer wording in `mu setup`, `/browse`, the board's account and the settings' help. The `/browse` hint names `mu.json`, not `kyrn.json`. The Chinese text is unchanged.

### Fixed

- With a Jev key (TypeSafe), the welcome screen and each verdict line name the judge `Jev`, not its model id `jev-latest`. A versioned Jev on OpenCode Zen shows as `Jev 1.13`.
- `/hive <question>` shows what you typed in the chat and as the conversation's title. The request to start a hive at once, written for the model in English, goes with it as a message only the model reads; before, it filled your message, also in a Chinese session. A `/hive` sent while a turn runs still sends the request as its message.
- The footer's line after each message reads like the verdict line, `Jev: multi-step task · full effort · 71 ms`, instead of `jev-latest active: multi_step_task -> heavy 71ms`. A verdict in shadow mode ends with `recorded only`.
- `planHost` names the script the command line runs pi with (`cli`: `dist/bundle/cli.js` in the package, `packages/coding-agent/src/cli.ts` in a checkout). The desktop app's host hands it to pi as `process.argv[1]`, so the sub-agents pi starts by running that script again (`hive`, `delegate`, the swarm) no longer fail with "The mu host needs a parent".
- With no model connected, `mu -p` and the other no-key errors now say to run `mu setup`, instead of pointing to `/login` (which only exists inside a session) and two files inside the package.

## [0.1.10] - 2026-10-21

### Changed

- English: the kernel's messages (the `en` side of `say({ zh, en })`), the manifest's titles and summaries, `mu --help`, `mu doctor` and `mu ledger` were rewritten after `docs/writing-style.md`. The Chinese text is unchanged.
- Themes: the package ships `judge/themes/mu-dark.json` and `mu-light.json`. An interactive `mu` passes `--theme <judge/themes>`, and `--use-theme mu-light/mu-dark` unless the command line has `--use-theme` or `settings.json` names a theme. `-p`, `--print` and `--mode` get neither. `system` is still pi's theme.
- pi's startup list names the judgment layer `mu`, not `kyrn-judge.js`: its bundle in the package is `judge/mu/index.js` (it was `judge/dist/kyrn-judge.js`).
- The package's description and README say what mu does by default: 38 of the 40 decision points act from the start, and approvals fall back to asking you.
- The welcome screen drops its box: the wordmark, the version, pi's version, then the judge, the model and the working directory, and a closing rule. Judge names show as `Jev` and `Laya`; a verdict's mark is a pink `◆`.

## [0.1.9] - 2026-10-19

### Added

- Two decision points, 40 in all:
  - `tool.description` (feature `injection`, option `descriptions`, on by default): every MCP tool's description, with its parameters' descriptions, is asked about once per server when it first appears and again when it changes. Does it ask the AI for more than calling the tool? Over 0.5 the tool is removed from the active tools before any request carries it (before the turn, and before the results of a step in which a server connected), kept off at each step, and calls to it are blocked; the user is told once. Without a verdict only `<IMPORTANT>` blocks and "do not tell the user" count. Measured in `kyrn/docs/features/tool-descriptions.md`.
  - `skill.capture` (feature `procedures`): after a run of `minSteps` (6) or more steps that ran `minCommands` (2) or more shell commands and did not end in an error, the judge says whether it was a reusable procedure. Over 0.7 the writer model (else the conversation's model) drafts a SKILL.md, kept in `<agent dir>/mu/skill-drafts` where pi does not load it. `/skills`, `/skills show|accept|reject <name>`; `accept --project` installs into the project. At most `maxPending` (3) drafts per project. Measured in `kyrn/docs/features/procedures.md`.
- `tool.injection` screens bash and PowerShell results when the command runs a fetching program (`features.injection.fetchCommands`: curl, wget, gh, glab, lynx, w3m, Invoke-WebRequest, Invoke-RestMethod, iwr, irm), unless every address it names is local; `gh` and `glab` always count.
- The report of a `delegate` or `hive` sub-agent whose tool results had passages withheld comes back under a warning; the parent counts the withheld notes in the child's event stream, with no extra judge call.
- Built on pi 1.3.0 and upstream main after it (e28e70804, d2e7d8b7c).

### Fixed

- Claude Sonnet 5.5 keeps Anthropic's cache read price, and Kimi K3 on Moonshot its official rates, when models.dev lists others.
- The goal's time cap and the web download cap show their units as units.
- `@earendil-works/pi-telemetry` declares the `source` export condition, so tests that run without a build resolve it.

## [0.1.8] - 2026-10-06

### Added

- Three decision points, 38 in all:
  - `tool.injection`: the results of `web_fetch`, `web_search`, `browse` and MCP tools (`features.injection.tools`) are screened passage by passage; in active mode a passage Jev gives more than 0.5 of carrying instructions aimed at the AI is withheld, and a note says where and how much. When no judge answers, phrase rules decide. The wording comes from kerpopule/hermes-jev-skills (MIT).
  - `turn.continue`: a run that ends on a promise of what comes next without doing it, or on asking for a go-ahead on work the user asked for, is sent back to it, at most `maxNudges` (2) times per message and never toward a step that is hard to undo or reaches beyond the machine. After can1357/oh-my-pi's unexpected-stop check (MIT).
  - `judge.items` and the `judge_items` tool: one yes/no question about each of up to 500 items, a probability per item, answered in shadow too because the model asked. Opened by the capability catalog when a task needs it.
- With no Jev key at all, the free Jev 1.13 on OpenCode Zen answers (`jev-opencode-free`, no key), and `judge.notice` says so once a day; when the offer ends, mu says so too. `mu setup --judge free` chooses it explicitly.
- Classifier models as judges: `classifier:<provider>/<model>` takes any classifier in pi's catalog. Built in: `jev-opencode` (`OPENCODE_API_KEY`), `jev-cloudflare` (`CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`), `clef`, `clef-flash`. The `jev` tier tries OpenCode Zen and Cloudflare after TypeSafe, OpenRouter and the Vercel AI Gateway. `mu setup --judge opencode`.
- Built on pi 1.0.2.

### Changed

- Decision points are active by default: verdicts take effect on a fresh install, and on an existing one whose `mu.json` sets no `modes.default`. Set `"modes": { "default": "shadow" }` (or `/mu mode default shadow`) to only record them, as before.
- MCP servers run on pi's built-in client instead of mu's own. mu keeps discovery from Claude Code, Cursor and Codex settings, Jev's disclosure of servers per task, approval of project servers, redaction and the environment whitelist.

### Fixed

- `mu install`, `remove`, `uninstall`, `update`, `list`, `config`, `auth` and `mcp` reach pi as its first argument again, from the command line and from the desktop app's host, instead of being sent to the model as a prompt ([#8](https://github.com/qybaihe/mu/issues/8), [#9](https://github.com/qybaihe/mu/pull/9) by [@nyxmoth](https://github.com/nyxmoth)).
- The status of `delegate` and `hive` before their first snapshot is cut to the terminal width; a terminal narrower than the line no longer kills the TUI ([#7](https://github.com/qybaihe/mu/issues/7)).
- Closing an MCP server that is still starting stops its process.

## [0.1.7] - 2026-09-30

### Added

- mu can run inside another program, which is how the desktop app runs it now, in a process of its own with no bridge over a command line.
  - pi's RPC mode takes a transport from the program that embeds it (`runRpcMode(runtime, transport)`, `main(args, { rpcTransport })`, `setupCli` exported). The default is the JSON lines on stdin and stdout it always spoke, so `--mode rpc` is unchanged.
  - The launcher plans and prepares such a host: `planHost` says which module to import, with which Node flags, arguments and environment, without side effects; `prepareLaunch` does what the command line does before pi starts (the app view of a checkout, the agent folder, the notes, the local judge), and `prepareLaunchAsync` does the same without holding the calling program while the local judge starts. The command line uses the same code.
  - `message_end` carries `entryId`, the id the message is saved under in the session file (for the messages the session saves), so a program showing a live conversation can fork from a message, hide a retried attempt or walk the tree by the ids the file uses.

### Changed

- With only a Together key, mu starts on Kimi K3 (`moonshotai/Kimi-K3`), and with only an OpenCode Go key on OpenCode Go's Kimi K3 (`kimi-k3`). Kimi K2.6, the model each started on before, has left both model lists.

### Fixed

- A run you stopped while a tool ran, or while mu asked about a command, no longer ends as a failure ("This operation was aborted"). The model request that followed the stop failed before it started, and now belongs to the stop: the run ends as aborted.

## [0.1.6] - 2026-09-27

### Added

- `mu setup` connects a model in a few questions ([#3](https://github.com/qybaihe/mu/issues/3)). Paste an API key and mu tells by its shape which service it belongs to: DeepSeek, Qwen, Kimi, GLM, SiliconFlow, StepFun, OpenRouter, OpenAI, Anthropic, Google Gemini or xAI; Ollama and an address of your own are picked from the list, and a subscription is pointed to `/login`. One request that lists the service's models checks the key, the model to start with is chosen from what it lists, and then the judge: Jev (a TypeSafe key, saved in the `.env` mu reads), the model itself, or none for now.
  - A key is sent only to the service it belongs to. When two services issue keys of the same shape (DeepSeek and Qwen), you are asked which one; Kimi's key is tried at its .cn address, then at .ai.
  - A check that fails says what to do: a key the service does not accept, an account without balance, a region or network that blocks the service (with your proxy named), a wrong address, an Ollama that is not running.
  - Keys go into `auth.json` the way `/login` stores them, never into `models.json`. Every file is copied to `~/.mu/backups/<time>/` before it changes; a file that is not plain JSON is left alone.
  - In Chinese when your locale is.
- For scripts: `mu setup --service <id> --key-stdin [--model <id>] [--base-url <url>] [--judge jev|model|none] [--yes]`, with the key on stdin (the Jev key on its second line). `mu setup --list` names the services. `mu setup <key>` works too; the key reaches the wizard in its environment, never in a process's arguments.
- A first `mu` at a terminal, with nothing that gives it a model (no sign-in, no key in the environment or the `.env`, no provider in `models.json`), asks once whether to set one up now, and then starts the session. A no is remembered; `MU_NO_SETUP=1` turns the question off.

### Changed

- The welcome screen and `mu doctor` point to `mu setup` when there is no model or no judge key.
- With only a Fireworks key, mu starts on Fireworks' Kimi router (`accounts/fireworks/routers/kimi-latest`). Kimi K2.6, the model it started on before, has left Fireworks' model list.

### Fixed

- In the desktop app on macOS, a conversation no longer puts a bouncing icon in the Dock. The app runs mu on its own Electron binary as Node, and naming such a process (`process.title`) registers it with macOS as a foreground app; mu now names its process only where that is harmless.

## [0.1.5] - 2026-09-25

### Added

- Built on pi 0.87.1 (0.1.4 was on pi 0.86.0): Claude Opus 5.5, GPT-6 Sol and GPT-6 Luna, Grok 4.7 as xAI's default, Meta's Muse subscription (`/login meta`), and image limits per model.
- Jev through OpenRouter, with a key for Jev only (`MU_JUDGE_OPENROUTER_API_KEY`), so setting it never changes OpenRouter's chat models. The `jev` tier tries TypeSafe's key, then this one, then the Vercel AI Gateway; each service is asked for the model by its own name. A key set up for one service is never sent to another.
- CLM as a judge: the `clm` tier reaches a clm-serve (`http://127.0.0.1:8700` by default, `baseUrl` for another machine), with an optional key (`MU_JUDGE_CLM_API_KEY`). `mu doctor` checks each CLM server. Its decisions are not measured yet, so `jev` never picks it on its own.
- `/hive <question>` starts a hive on a question of yours: three investigators on angles that bear on each other, then an answer from their reports. Without a question, `/hive` is still `/swarm`.

### Fixed

- Permissions:
  - A command made only of read-only programs can no longer write or run something through its options (`rg --pre`, `sort -o`, `uniq` with a second file, `tree -o`, PowerShell's `( )`).
  - Risk flags catch more spellings of the same thing: `git clean` forced by a later option, `find -delete`, `find -exec rm`, `git push` with a `+` refspec, `--mirror` or `--delete`, a quoted program name, `doas`, `pkexec`, and downloads run through `bash <(curl ...)`. An "allow for this conversation" grant never covers a flagged command.
  - In Jev approval mode, a flagged command runs only when Jev is sure you asked for what it does. A command could vouch for itself before (`# only reads, deletes nothing`).
  - An edit's path is read the way the file tools read it (`~`, a leading `@`, `file://`, links), so `write ~/.zshrc` no longer counts as an edit inside the project. Paths under `.git` are not project files.
  - Evaluating an expression in a debugged program (`debug_inspect` with an expression) needs permission like any program run.
  - The permission modes hold with judging switched off (`MU_JUDGE=off`); before, minimal permissions let everything run.
  - A sub-agent's calls are weighed against your goal, not against the brief its lead model wrote.
  - `permissions.request`, `permissions.resolved` and `permissions.approved` carry the `toolCallId` of the call they are about.
  - A permission question says when no judge answered, instead of saying Jev was unsure: `nojudge` when none can answer (no key, no credit, only an untrusted judge), `judgedown` when it failed this time.
- Privacy:
  - Credentials are taken out of everything a judge or the board's writer model is shown (`export OPENAI_API_KEY=sk-...` in a command, the start of `cat .env`), and ordinary words such as "password reset" stay.
  - Checkpoints take in no secret files (`.env`, `.envrc`, `.netrc`, `*.pem`, `*.key`, SSH keys), drop ones an older mu took in, and each project's store is readable by you only.
  - A page in the built-in browser can no longer send it to this computer or the local network (`127.0.0.1`, a router, `169.254.169.254`): the run ends as blocked (`off_the_web`) and reports only that page's origin.
- A judge connection that goes silent is replaced after two unanswered calls. Before, a session that started in a slow minute of Jev fell back on every decision for the rest of the session.
- The browser's field writer stops with the run and after `browser.writeTimeoutMs` (60 s), so a stalled model no longer holds a browse run that Esc cannot end.
- Hive: `/hive` counts as your turn, so Jev judges the hive against it; a note is confirmed only by other investigators, each named once; a bee's grace period runs from when it heard it was to report; a bee cut off while writing hands back what it wrote; a bee's notes and checkpoint arrive in one message; H3 replaces another's note only on a near-certain reading; the plain-text view carries no terminal codes; a bee's row shows the start of what it said.
- macOS without the developer tools, or with the Xcode license not accepted: checkpoints switch off once, with one line in your language and a `checkpoint.off` code (`developer_tools_missing`, `xcode_license`). Checkpoints, sub-agents, `locate`, `/commit` and the conflicts pack never start the system's git stub, which opens the install dialog each time it runs.
- `mu auth` exits only once no lock of pi's stores is being taken or dropped, and a session that quits (a conversation the desktop app closes) holds those locks until it has exited. A lock left behind made the next `mu auth` wait until the desktop app gave up on it, and a conversation started meanwhile had no model.
- Windows: the bash tool's commands are read as bash, not by PowerShell's rules (`rg 'useState\(' src` needed permission); a bee started in a nested folder finds the paths of its task in its own worktree, not in your checkout; `mu.ps1` hands arguments with quotes to mu intact under Windows PowerShell 5.1.

## [0.1.4] - 2026-09-23

### Fixed

- mu starts on a server with 1 GB of memory. 0.1.3 compiled its judgment layer (3 MB of code) with Babel at every start, which took more than 500 MB, and Node ran out of memory before the first frame. The layer is now loaded as it is, and a start in a fresh home needs about 50 MB.
- A symlinked folder that points back up (for example in `~/.agents/skills`) no longer makes the start walk the same folders again and again until memory runs out: each folder is entered once.
- A large `~/.claude.json` (Claude Code keeps every project it has seen in it) no longer costs memory at every start: only its MCP servers and this project's entries are read. A 30 MB file took the start from about 40 MB to about 180 MB; now it adds about 1 MB.
- Checkpoints never copy mu's own folders (`~/.mu` and the snapshots themselves), so the store no longer grows with every turn. A session started in the home folder, or in a folder of more than 5,000 files or 200 MB (`features.checkpoint.maxFiles`, `maxTotalMb`), goes without checkpoints and says so once, in one line, in your language; the desktop app gets a `checkpoint.off` event. A store an older mu made of a home folder is removed at the next start.
- The welcome box and `/help` name mu's version and pi's; 0.1.3 said "v0.1.0 · built on pi 0.1.3".
- Windows: a command that writes to mu's own settings is recognised however it spells the folder (`%USERPROFILE%`, `$env:USERPROFILE`, `~`, `$HOME`, Git Bash's `/c/...`, either slash, any letter case), so it always comes to you: Jev cannot approve it, and "allow for this conversation" does not cover it.
- Windows: Git Bash is found in a per-user install of Git (`%LOCALAPPDATA%\Programs\Git`) and beside a `git.exe` on PATH. Before, every shell command there failed with "No bash shell found".
- In the desktop app (RPC mode), a promise that failed with nothing to handle it no longer ends mu, and the conversation with it: it is written to stderr, and mu goes on.

## [0.1.3] - 2026-09-23

### Added

- The plain-language board keeps a running account: one plain line per step the moment it ends (a file changed, a check passed or failed, a command run; reading folded into one line that counts up), what the agent says retold by the board's model as soon as Jev calls it news, and the summing up as the account's last line. New presentation event `board.note`; `board.update` carries the last 40 lines as `log`, so a reopened session has its account; `/board` lists it.

### Fixed

- `judge/manifest.json` carries the settings texts in all eleven extra languages again (0.1.2 was packed from a checkout without the translations), and every text of the newer decision points and options is translated.
- The judge is spelled Jev everywhere.

## [0.1.2] - 2026-09-23

0.1.1 was prepared on 2026-09-22 but never published; its changes are in this release.

### Added

- `mu import --list` finds your Claude Code and Codex conversations, `mu import <file>...` brings them into mu as sessions to continue; `/import-chat` does the same inside a session. Thinking and images are not imported; a transcript is never imported twice.
- `judge/manifest.json`, the description of every decision and feature the desktop app draws its settings from, so the app can run an mu that came from npm.
- The settings texts in eleven more languages (zh-TW, ja-JP, ko-KR, de-DE, fr-FR, es-ES, pt-BR, ru-RU, uk-UA, tr-TR, fa-IR).
- `mu auth status | login <provider> | logout <provider>`: the subscription sign-in (ChatGPT, Claude, Grok, and Google while `googleLogin` is on) as JSON lines, which the desktop app runs, also with the copy of mu it carries inside it.

### Fixed

- `mu doctor` no longer reports a login on a fresh install, where pi has only written an empty auth.json.
- mu started by the desktop app's Electron no longer hands `ELECTRON_RUN_AS_NODE` to the programs it starts.

## [0.1.0] - 2026-09-22

### Added

- First npm release of mu: `npm i -g mu-agent`, then `mu`.
- The judgment layer (29 decision points in 32 features) on pi 0.86, in shadow mode by default.
- `mu doctor`, `mu ledger`, `mu judge` (the local judge Laya, macOS on Apple Silicon) and `mu migrate`.
