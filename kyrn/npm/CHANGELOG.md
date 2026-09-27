# Changelog

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
