# Changelog

## [Unreleased]

## [0.1.12] - 2026-10-22

### Changed

- The permission mode `jev` ("Jev approves") is now `judge` ("Judge mode"): `/permissions full | judge | ask`, `MU_PERMISSIONS=judge`. A saved `jev` falls back to the default, which is judge mode. The kernel's and the command line's messages say "the judge" where they meant mu's judge in general, and keep "Jev" for TypeSafe's hosted model.

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
