# Fork ledger

mu is a fork of [pi](https://github.com/earendil-works/pi) and merges pi's `main` every week (`.github/workflows/upstream-sync.yml`). This ledger lists every file in pi's folders where mu differs from pi, and why. Whoever resolves a merge conflict can then see what mu's side is for before choosing a side.

mu's own folders (`packages/kyrn-judge`, `kyrn/`, `desktop/`, `site/`, `bench/`, `docs/`) are not listed. Upstream has no such folders, so a merge never conflicts there.

`node scripts/fork-ledger.mjs` checks the ledger against the last upstream commit merged into `HEAD`, and CI runs it on every pull request. It fails when a file of pi's differs and no entry names it, or when an entry names a file that no longer differs. `node scripts/fork-ledger.mjs list` shows each changed file with its entries. When a merge conflicts, the sync workflow's issue quotes the entries for the conflicting files.

## How to write an entry

- **Number.** Take the next free `M<n>`. A number is never reused. When an entry's change is gone, because upstream took it or mu dropped it, move the entry under Retired with one line on why.
- **Files.** List every file the change touches in pi's folders, mu's new files there included. `*` matches within one folder name, and `**` matches across folders.
- **Why.** Say what mu needs that pi does not do.
- **In a merge.** Say what to keep when upstream changes the same lines.
- **Tests.** List the tests that hold the change. Tests in pi's folders count as files of the change.

A `// mu:` comment next to a change in code says the same thing in place.

## Entries

### M1 A model request that fails after the run is aborted ends the run aborted

- **Files**
  - `packages/agent/src/agent-loop.ts`
- **Why**: A run stopped while a tool executes goes on to one more model request on the aborted signal, which fails in setup and comes back with `stopReason: "error"`, so the person who stopped the run sees a failure. `settleAbort()` turns an error that arrives after the signal aborted into `"aborted"` and keeps the error text.
- **In a merge**: Keep `settleAbort()` and both of its calls in `streamAssistantResponse()`: on the `done`/`error` event and after the event loop. If upstream reads the final message somewhere else, wrap the `result()` there.
- **Tests**
  - `packages/agent/test/agent-loop.test.ts`

### M2 Nebius Token Factory provider

- **Files**
  - `packages/ai/catalog/providers/nebius.ts`
  - `packages/ai/catalog/providers/index.ts`
  - `packages/ai/src/providers/nebius.ts`
  - `packages/ai/src/providers/nebius.models.ts`
  - `packages/ai/src/providers/all.ts`
  - `packages/ai/src/models.generated.ts`
  - `packages/ai/src/env-api-keys.ts`
  - `packages/ai/src/types.ts`
  - `packages/ai/src/api/openai-completions.ts`
  - `packages/ai/README.md`
  - `packages/coding-agent/docs/providers.md`
  - `packages/coding-agent/src/cli/args.ts`
  - `packages/coding-agent/src/core/model-resolver.ts`
- **Why**: mu offers Nebius Token Factory's OpenAI-compatible API as a built-in `nebius` provider (`NEBIUS_API_KEY`), for agent models and for mu's Nemotron judges. Its compat follows pi's `nvidia` provider (no developer role, no `store`, `max_tokens`, no long cache retention), and `reasoning_effort` goes only to models with known effort values, including the values measured on Token Factory for Nemotron 3 Super. The default model is `nvidia/Nemotron-3.5-Super-VL`, which Token Factory names as Nemotron 3 Super's replacement.
- **In a merge**: `nebius.models.ts` and `models.generated.ts` are written by `catalog/generate.ts`: regenerate them rather than resolve them by hand. Keep `nebius` in `PROVIDERS`, `builtinProviders()`, `KnownProvider`, the env-key map, the `--help` key list and `defaultModelPerProvider`, and `isNebius` in `detectCompat()` (`supportsReasoningEffort`, `supportsLongCacheRetention`). If upstream changes how a provider is defined, move `catalog/providers/nebius.ts` to the new shape and check that the generated Nebius models stay the same.
- **Tests**
  - `packages/ai/test/nebius-models.test.ts`

### M3 openai-completions sends other endpoints a shape they take, and resends what they reject

- **Files**
  - `packages/ai/src/api/openai-completions.ts`
  - `packages/ai/src/providers/compat-schema.ts`
  - `packages/ai/README.md`
  - `packages/coding-agent/docs/models.md`
  - `packages/coding-agent/docs/models-configuration.md`
  - `packages/coding-agent/schemas/models.schema.json`
- **Why**: pi sends OpenAI's newer request shape to every base URL that is not on a short list, so a custom provider's reasoning model fails every request on gateways that reject `developer` messages. `detectCompat()` sends `developer` messages and `max_completion_tokens` only to `api.openai.com`, Azure OpenAI and Xiaomi MiMo (`store` only to the first two), and every other endpoint gets `system`, `max_tokens` and no `store`. `withCompatFallback()` resends a request once per field when a 400 or 422 (or a 5xx wrapping one) rejects the developer role or names an optional field, and remembers the change per provider, base URL and model; `api.openai.com` requests are never changed.
- **In a merge**: Keep `withCompatFallback()` around `client.chat.completions.create()`, `getCompat()` laying `learnedCompat` over `getConfiguredCompat()`, and `takesOpenAIRequestShape` in place of upstream's `isNonStandard` and `useMaxTokens` lists (and `isCerebras`, which only those lists read). A host upstream adds to those lists needs nothing unless it documents the OpenAI shape. `models.schema.json` is generated from `compat-schema.ts` (`npm run generate:schemas`): keep mu's descriptions in `compat-schema.ts` and regenerate.
- **Tests**
  - `packages/ai/test/openai-completions-compat-fallback.test.ts`

### M4 Claude Sonnet 5.5's cache reads cost what Anthropic bills

- **Files**
  - `packages/ai/catalog/providers/anthropic.ts`
  - `packages/ai/catalog/providers/cloudflare-ai-gateway.ts`
- **Why**: The catalog's source data prices `claude-sonnet-5-5` cache reads at $0.10/MTok, and Anthropic bills $0.20, a tenth of the $2 input. `CLAUDE_SONNET_55_COST` sets Anthropic's price on the Anthropic model and on the Cloudflare AI Gateway's Anthropic passthrough, which bills at Anthropic's rates.
- **In a merge**: Keep `CLAUDE_SONNET_55_COST` and its use in both `map` functions, and `cacheRead: 0.2` in the test. When upstream's catalog prices Sonnet 5.5 cache reads at 0.2 itself, drop all three and retire this entry.
- **Tests**
  - `packages/ai/test/supports-xhigh.test.ts`

### M5 CI builds from a model catalog snapshot made by mu's generator

- **Files**
  - `packages/ai/model-catalog.json`
  - `scripts/update-model-catalog.mjs`
  - `package.json`
  - `.github/workflows/model-catalog.yml`
  - `.github/workflows/ci.yml`
  - `.github/workflows/env.yml`
- **Why**: A build that generates the catalog from live sources fails unrelated pull requests whenever a model is dropped upstream, and pi's published catalog comes from upstream's generator, without mu's Nebius provider and Sonnet 5.5 price. mu commits `packages/ai/model-catalog.json`, written by `catalog/generate.ts` through `npm run update:model-catalog`, and CI builds with `npm run build:pinned` (hydrate that snapshot, then `build:offline`). The weekly `model-catalog.yml` workflow regenerates the snapshot in a pull request of its own.
- **In a merge**: Never resolve the snapshot by hand. After a merge that changes `packages/ai/catalog/` or tests that name models the snapshot lacks, run `npm run update:model-catalog` and commit the result. Keep `build:pinned`, `hydrate:model-catalog` and `update:model-catalog` in `package.json`; upstream's build order changes go into `build` and `build:offline`, which `build:pinned` runs. Keep `npm run build:pinned` where upstream's workflows run `npm run build`.

### M6 pi's ai tests keep cases on models the catalog lists

- **Files**
  - `packages/ai/test/baseten-models.test.ts`
  - `packages/ai/test/github-copilot-anthropic.test.ts`
  - `packages/ai/test/image-tool-result.test.ts`
- **Why**: These cases cover behavior whose original models left the catalog: a Baseten model whose reasoning is an off/on toggle without an effort (built from GLM 5.2, since Kimi K2.6 is gone), Copilot's Claude Opus 4.8 with `xhigh` and `max`, and a live image tool-result test on Baseten's Kimi K3.
- **In a merge**: Take upstream's model swaps where mu's snapshot has the model, and keep mu's added cases as long as the snapshot lists their models. Each case keeps the imports it needs, such as `getSupportedThinkingLevels` in the Baseten test.

### M7 Sign in with ChatGPT hands its callback port over between sign-ins

- **Files**
  - `packages/ai/src/auth/oauth/callback-port.ts`
  - `packages/ai/src/auth/oauth/callback-server.ts`
  - `packages/ai/src/auth/oauth/openai-chatgpt.ts`
  - `packages/ai/src/auth/oauth/openai-codex.ts`
  - `packages/ai/src/auth/types.ts`
- **Why**: Sign in with ChatGPT listens on 127.0.0.1:1455, a port OpenAI fixes and its own sign-in tool shares, so a second sign-in started while the first still waits fails with "Port 1455 is in use". A sign-in of pi's or mu's answers `GET /pi-login` and lets go on `POST /pi-login/take-over` or on the bare `GET /cancel` that OpenAI's tool sends; a new sign-in asks such a holder to let go, and another program on the port gets a `CallbackPortInUseError` that names it. `LoginOptions.pasteOnly` starts no server and takes only the pasted redirect address.
- **In a merge**: Keep `sharedPort` in `startOAuthCallbackServer()` and `sharedPort: true` in the `openai-codex` flow, the `answerLoginControl()`, `listenOnLoginPort()` and `closeCallbackServer()` calls in `callback-server.ts` and in `startCallbackServer()` of `openai-chatgpt.ts`, and `pasteOnly` in `LoginOptions`. If upstream rewrites `startCallbackServer()`, rebuild mu's calls on upstream's version. Upstream's test of the pasted fallback in `openai-codex-oauth.test.ts` lives in `oauth-login-port.test.ts`, which runs the fixed-port tests one after another; keep it out of `openai-codex-oauth.test.ts`, whose servers listen on port 0.
- **Tests**
  - `packages/ai/test/oauth-callback-port.test.ts`
  - `packages/ai/test/oauth-login-port.test.ts`
  - `packages/ai/test/openai-codex-oauth.test.ts`
  - `packages/coding-agent/test/interactive-mode-login-port.test.ts`
  - `packages/kyrn-judge/test/auth.test.ts`

### M8 The sign-in result page shows mu's mark

- **Files**
  - `packages/ai/src/utils/oauth-page.ts`
  - `packages/ai/src/index.ts`
- **Why**: The page a browser sign-in ends on (ChatGPT, Claude, OpenRouter, Radius) shows mu's tile and glyph, also as the tab icon, white in light mode and black in dark mode, headed "Signed in" or "Sign-in did not complete". pi-ai's index exports `oauthSuccessHtml` and `oauthErrorHtml`, so mu's Google sign-ins render the same page.
- **In a merge**: Keep mu's `renderPage()` and `MU_MARK_SVG`, and take upstream's changes to the messages the flows pass in. If upstream moves the file, move mu's page with it and point the export in `src/index.ts` at the new place.
- **Tests**
  - `packages/ai/test/oauth-page.test.ts`
  - `packages/ai/test/oauth-callback-server.test.ts`

### M9 Final tool_call handlers read the call as it will run

- **Files**
  - `packages/coding-agent/src/core/extensions/loader.ts`
  - `packages/coding-agent/src/core/extensions/runner.ts`
  - `packages/coding-agent/src/core/extensions/types.ts`
  - `packages/coding-agent/docs/extensions.md`
- **Why**: `tool_call` handlers run in extension load order and may change `event.input` in place, and mu's extension loads first, so a user's extension can change a call after mu's permission gate approved it (`npm test` becomes `npm test && npm publish`). `pi.on("tool_call", handler, { final: true })` runs the handler after every other `tool_call` handler, on a deep-frozen copy of the input they left, so it can block the call but not change it. Every `tool_call` handler of mu is final.
- **In a merge**: Keep the `FINAL_TOOL_CALL_HANDLERS` key in `createExtensionAPI()`'s `on()`, the final pass at the end of `emitToolCall()` with `frozenCopy()`, its check in `hasHandlers()`, and the `options` parameter of `on("tool_call", …)` in `ExtensionAPI`. If upstream reworks tool_call dispatch, the final pass still runs after the last other handler.
- **Tests**
  - `packages/coding-agent/test/extensions-runner.test.ts`
  - `packages/kyrn-judge/test/permissions.test.ts`

### M10 The agent's commands run without the credentials in mu's environment

- **Files**
  - `packages/coding-agent/src/utils/shell.ts`
  - `packages/coding-agent/src/core/tools/bash.ts`
  - `packages/coding-agent/src/index.ts`
- **Why**: mu's process holds the model providers' keys, the judge's keys and whatever mu's `.env` defines, and the bash and PowerShell tools give commands that environment, so `echo $OPENAI_API_KEY`, or a script the agent wrote, reads every one in any permission mode. `withoutCredentials()` leaves out each variable whose name says it holds a credential and whose value looks like one; `MU_PASS_ENV` (`ENV_PASS_ENV`) names those to keep. Commands the user types with `!` keep everything.
- **In a merge**: Keep `withoutCredentials(getShellEnv())` in `resolveSpawnContext()`, ahead of spawn hooks, and the `ENV_PASS_ENV` and `withoutCredentials` exports in `index.ts`, which mu's background jobs and debugger use. If upstream builds the agent's command environment somewhere else, apply `withoutCredentials()` there.
- **Tests**
  - `packages/coding-agent/test/shell-credentials.test.ts`
  - `packages/kyrn-judge/test/background.test.ts`

### M11 Git Bash is found in a per-user install and beside git on PATH

- **Files**
  - `packages/coding-agent/src/utils/shell.ts`
- **Why**: On Windows pi looks for bash only under the two Program Files folders and then on PATH, so a per-user Git for Windows install (`%LOCALAPPDATA%\Programs\Git`), or a Git whose `cmd` folder is on PATH, is missed and every shell call fails with "No bash shell found". `gitBashCandidates()` lists both Program Files installs, the per-user install, then the `bin` folder beside each `git.exe` on PATH.
- **In a merge**: Keep `gitBashCandidates()` and its use in `getShellConfig()`, which checks each candidate with upstream's `shellPathExists()`. Keep `existsSync` as the default check for `git.exe`: with `shellPathExists` there, upstream's test that mocks `accessSync` finds a Git Bash beside a made-up `git.exe`.
- **Tests**
  - `packages/coding-agent/test/git-bash-lookup.test.ts`

### M12 RPC mode over a transport the embedder passes

- **Files**
  - `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-transport.ts`
  - `packages/coding-agent/src/modes/index.ts`
  - `packages/coding-agent/src/main.ts`
  - `packages/coding-agent/src/index.ts`
- **Why**: The desktop app runs pi in a process of its own and speaks RPC over that process's message port, without a pipe. `runRpcMode(runtime, transport)` and `main(args, { rpcTransport })` take an `RpcTransport` (JSON records in and out, plus `start`, `drained`, `flush`, `listen` and `close`), and the default `stdioRpcTransport()` is the JSONL on stdin and stdout, so `--mode rpc` is unchanged. `index.ts` exports the transport and `setupCli`, which such a host runs before `main()`.
- **In a merge**: In `rpc-mode.ts` every write, backpressure wait, flush, input line and input end goes through `transport`. Route upstream's new output or input handling there through it, not through `writeRawStdout()` or `process.stdin`, and put what stdio itself needs (such as `takeOverStdout()`) in `stdioRpcTransport()`.
- **Tests**
  - `packages/coding-agent/test/rpc-transport.test.ts`

### M13 pi's processes in the desktop app get no Dock icon

- **Files**
  - `packages/coding-agent/src/cli/setup.ts`
  - `packages/coding-agent/src/rpc-entry.ts`
- **Why**: The desktop app runs pi on its own app binary as Node (`ELECTRON_RUN_AS_NODE`), and on macOS setting `process.title` in such a process registers it as a foreground app, so every session shows a Dock icon that bounces until it ends. `nameProcess()` skips the title in exactly that case (`canNameProcess()`), and `setupCli()` and `rpc-entry.ts` name the process through it.
- **In a merge**: Keep `nameProcess()` in place of `process.title =`, also in any new place upstream sets the title.
- **Tests**
  - `packages/coding-agent/test/process-title.test.ts`

### M14 A sign-out in another process counts at once

- **Files**
  - `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - `packages/coding-agent/src/index.ts`
- **Why**: The desktop app signs an account out with `mu auth logout`, another process, while running sessions answer `get_available_models` and `set_model` from the snapshot they took at start, so they keep listing the signed-out account's models. RPC mode checks the credential store again for both (`availableModels()`, no network, the snapshot when the check fails), and after `/logout` the TUI's `leaveLoggedOutModel()` moves the session to the model a new session would start on and says so. `index.ts` exports `FileModelsStore`, through which `mu auth logout` drops the model list an account gave.
- **In a merge**: Keep `availableModels()` in place of `getAvailableSnapshot()` in `set_model` and `get_available_models`, and the `leaveLoggedOutModel()` call in the logout handler's success path.
- **Tests**
  - `packages/coding-agent/test/suite/rpc-models-signed-out-elsewhere.test.ts`
  - `packages/coding-agent/test/interactive-mode-logout-model.test.ts`

### M15 compaction.maxContextTokens caps the context, and RPC get_state reports it

- **Files**
  - `packages/coding-agent/src/core/compaction/compaction.ts`
  - `packages/coding-agent/src/core/settings-manager.ts`
  - `packages/coding-agent/src/core/settings-schema.ts`
  - `packages/coding-agent/schemas/settings.schema.json`
  - `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- **Why**: mu's desktop settings let a person compact before the model's window is full. With `compaction.maxContextTokens`, `shouldCompact()` triggers at the lower of the cap and the window minus the reserve, as an early trigger rather than a hard ceiling, and `getCompactionSettings()` keeps `keepRecentTokens` to half the cap so compaction has room to work. RPC `get_state` returns `contextUsage` and the effective `compactionSettings`, which the app shows.
- **In a merge**: Keep the cap in `shouldCompact()` and `getCompactionSettings()`, `maxContextTokens` in `CompactionSettings` and `CompactionSettingsSchema`, and the two optional fields of `RpcSessionState`. `settings.schema.json` is generated from `settings-schema.ts` (`npm run generate:schemas`): regenerate it instead of resolving it by hand.
- **Tests**
  - `packages/coding-agent/test/config-schemas.test.ts`
  - `packages/kyrn-judge/test/context-budget.test.ts`

### M16 message_end carries the id of the entry the message is saved as

- **Files**
  - `packages/coding-agent/src/core/agent-session.ts`
  - `packages/coding-agent/src/core/session-manager.ts`
  - `packages/coding-agent/docs/json.md`
- **Why**: `message_end` fires before its message is saved, so an app showing a live conversation cannot name a message by its entry id, which forking from a message, hiding a retried attempt and tree navigation need. `SessionManager.reserveEntryId()` hands out an id ahead of the entry, `appendMessage()` and `appendCustomMessageEntry()` write the entry under it, and `_handleAgentEvent()` puts it on `message_end` as `entryId` and writes the entry after the listeners, in pi's order.
- **In a merge**: Keep the `message_end` member of `AgentSessionEvent`, the `reservedId` in `_handleAgentEvent()`, `_savesMessage()`, and `newId()`, which avoids reserved ids, wherever the manager makes an id: a `generateId(this.byId)` that upstream adds becomes `this.newId()`.
- **Tests**
  - `packages/coding-agent/test/suite/agent-session-entry-ids.test.ts`

### M17 Session files are written whole, and an entry is saved before the session takes it

- **Files**
  - `packages/coding-agent/src/core/session-manager.ts`
- **Why**: pi rewrites a session file (a migration on open, a branch, an empty file's header) by opening it with `"w"` and writing in place, so a crash or a write error leaves it truncated. `_writeWhole()` writes a file beside it, fsyncs it and renames it into place, and a new session's first write links the file in, which fails if a file is there. `_appendEntry()` saves the entry before it joins the session, so an entry that cannot be written never becomes the leaf in memory.
- **In a merge**: Keep `_writeWhole()` in `_rewriteFile()` and in `_persist()`'s first flush, and `_persist()` ahead of the in-memory push in `_appendEntry()`. Upstream's rollback after a failed write covers the same case; keep mu's order and leave the rollback out.
- **Tests**
  - `packages/coding-agent/test/session-manager/persistence.test.ts`

### M18 Retries outlast short outages and content-filter cuts

- **Files**
  - `packages/coding-agent/src/core/agent-session.ts`
  - `packages/coding-agent/src/core/settings-defaults.ts`
  - `packages/coding-agent/schemas/settings.schema.json`
  - `packages/coding-agent/docs/settings.md`
- **Why**: In an unattended `mu --print` run, a provider error ends the task: a reply cut by the content filter is never retried, and three retries (14 s of backoff) do not outlast a one-minute outage. `_isRetryableError()` retries a content-filter cut at most twice, and `retry.maxRetries` defaults to 8, about four minutes of backoff with the 60-second cap.
- **In a merge**: Keep the `CONTENT_FILTER` check in `_isRetryableError()`, after the context-overflow check, and `maxRetries: 8` in `SETTINGS_DEFAULTS`, the settings docs and `settings-manager.test.ts`. Regenerate `settings.schema.json` (`npm run generate:schemas`).
- **Tests**
  - `packages/coding-agent/test/settings-manager.test.ts`
  - `packages/coding-agent/test/suite/agent-session-retry-events.test.ts`

### M19 MCP on pi's built-in client, with what mu's server catalog needs

- **Files**
  - `packages/coding-agent/src/core/mcp-servers.ts`
  - `packages/coding-agent/src/extensions/mcp/index.ts`
  - `packages/coding-agent/src/extensions/mcp/runtime.ts`
  - `packages/coding-agent/src/index.ts`
- **Why**: mu runs MCP on pi's client and adds a catalog of servers it takes over from other tools' configuration, connected when a task needs one. It needs `inheritEnv: false` on stdio servers, which start with their own `env` only so model keys never reach them; an `mcp:connection` event (`MCP_CONNECTION_EVENT`) on `pi.events` when a server's connection changes, with its tool names; and the `loadMcpConfig` export, to read which servers `mcp.json` defines.
- **In a merge**: Keep `inheritEnv` in `McpStdioServerConfig` and `validateMcpServerConfig()`, its pass-through in `createDefaultTransport()`, the `pi.events.emit(MCP_CONNECTION_EVENT, …)` after `emitChange()` in the connection-state handler, and the exports in `index.ts`.
- **Tests**
  - `packages/kyrn-judge/test/mcp-feature.test.ts`

### M20 Resource walks enter each symlinked folder once

- **Files**
  - `packages/coding-agent/src/core/package-manager.ts`
- **Why**: The skill and resource walks follow symlinked folders without remembering where they have been, so a link back up (`skills/loop -> ..`) is walked again at every level until the path is too long, and two such links make the walk exponential: startup never reaches the first frame. `enterOnce()` keeps the real paths a walk has entered.
- **In a merge**: Keep the `visited` parameter and the `enterOnce()` check in `collectFiles()` and `collectSkillEntries()`, passed on in each recursive call. A recursive walk upstream adds gets the same.
- **Tests**
  - `packages/coding-agent/test/package-manager-link-loops.test.ts`

### M21 A message that starts with "- " is a message, not an option

- **Files**
  - `packages/coding-agent/src/cli/args.ts`
- **Why**: `parseArgs()` reads every argument that starts with `-` as an option, so a task written as a list (`mu -p "- Fix the parser"`) ends with "Unknown option" and exit 1. An option never has whitespace right after its dashes, so such an argument is a message; `-x` is still an unknown option.
- **In a merge**: Keep the `/^-+\s/` branch ahead of the option checks in `parseArgs()`.
- **Tests**
  - `packages/coding-agent/test/args.test.ts`

### M22 Commands of a launcher's own extensions carry no [t] tag

- **Files**
  - `packages/coding-agent/src/config.ts`
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- **Why**: mu's launcher loads mu's extension with `-e`, so pi tags every mu command in autocomplete with `[t]`, for an extension loaded for this run only. `PI_APP_EXTENSIONS` names the extensions (paths, separated like PATH) a launcher loads as part of itself, and `isAppExtension()` leaves their commands untagged, like a built-in extension's.
- **In a merge**: Keep `isAppExtension()` in `config.ts` and its check in `getAutocompleteSourceTag()`.
- **Tests**
  - `packages/coding-agent/test/interactive-mode-app-extension-tag.test.ts`

### M23 ctx.ui.select() starts on a given option, and long options wrap under their text

- **Files**
  - `packages/coding-agent/src/core/extensions/types.ts`
  - `packages/coding-agent/src/modes/interactive/components/extension-selector.ts`
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- **Why**: mu's `/permissions` opens on the current mode, so Enter keeps it instead of switching a Judge mode session to full access. `initialIndex` in the dialog options sets the option the cursor starts on, and the selector's `OptionLine` wraps a long option under its own text, not under the arrow.
- **In a merge**: Keep `initialIndex` in `ExtensionUIDialogOptions` and `ExtensionSelectorOptions`, its pass-through in interactive mode's `select` dialog (next to upstream's `finish()`), and `OptionLine`.
- **Tests**
  - `packages/coding-agent/test/extension-selector.test.ts`
  - `packages/kyrn-judge/test/permissions.test.ts`

### M24 /login under another name than pi

- **Files**
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- **Why**: When `APP_NAME` is not `"pi"`, `/login` offers no Claude subscription sign-in, which Anthropic's terms do not let other apps offer, and no `openai-codex` login, since ChatGPT signs in through the `openai` provider; a stored sign-in still works until `/logout`. The first menu leaves out the Sign in with Radius shortcut, pi's own service, and a sign-in passes `agentName: APP_NAME`, so OpenAI shows mu as its own app.
- **In a merge**: Keep `HIDDEN_SIGN_INS` and its check in `getLoginProviderOptions()`, the `APP_NAME !== "pi"` condition on `radiusOption` in `showLoginAuthTypeSelector()`, and the `agentName` in the login options. Under the name pi, all three change nothing.
- **Tests**
  - `packages/coding-agent/test/interactive-mode-hidden-sign-ins.test.ts`
  - `packages/kyrn-judge/test/auth.test.ts`

### M25 With no model, the help points to mu setup or /login

- **Files**
  - `packages/coding-agent/src/core/auth-guidance.ts`
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- **Why**: As mu, `getProviderLoginHelp()` tells a user without a model to run `mu setup`, since `/login` exists only inside a session, and inside a session (`inSession`) leads with `/login`. A first message `/login` opens the sign-in as if typed, which is how `mu setup` starts the session once a subscription is chosen. The first line of each message stays pi's, since the desktop app matches on it.
- **In a merge**: Keep the `APP_NAME === "mu"` branch and the `options` parameter of `getProviderLoginHelp()` and `formatNoModelsAvailableMessage()`, the `inSession` warning in interactive mode's startup, and the `/login` first-message branch ahead of `session.prompt(initialMessage)`.
- **Tests**
  - `packages/coding-agent/test/auth-guidance-mu.test.ts`
  - `packages/kyrn-judge/test/setup-launcher.test.ts`

### M26 Escape during a sign-in goes back without an error

- **Files**
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- **Why**: GitHub Copilot's sign-in waits on a request with the dialog's signal, so Escape rejects it with the abort instead of "Login cancelled", and `/login` prints "Failed to login to GitHub Copilot: This operation was aborted". An aborted dialog counts as cancelled and goes back to the list.
- **In a merge**: Keep `|| dialog.signal.aborted` on the "Login cancelled" branch after the login flow.
- **Tests**
  - `packages/coding-agent/test/interactive-mode-login-cancel.test.ts`

### M27 The footer says "no model" for the agent's placeholder

- **Files**
  - `packages/coding-agent/src/modes/interactive/components/footer.ts`
- **Why**: With no model set up, the footer shows the agent's placeholder id `unknown` as if it were a model. `FooterComponent` shows "no model" for the placeholder (provider and id both `unknown`).
- **In a merge**: Keep the `placeholder` check where `modelName` is computed.
- **Tests**
  - `packages/coding-agent/test/footer-width.test.ts`

### M28 Under another name, startup shows only the app's header

- **Files**
  - `packages/coding-agent/src/core/settings-manager.ts`
- **Why**: mu's welcome header says what the session starts with, and pi's listing of loaded resources under it ([Skills], [Prompts], [Extensions]) reads like scaffolding. When `APP_NAME` is not `"pi"`, `getQuietStartup()` defaults to `"header"`; a `quietStartup` in settings.json, `false` included, holds, and problems loading resources still show.
- **In a merge**: Keep the `APP_NAME === "pi"` default in `getQuietStartup()` and its acceptance of `false`.
- **Tests**
  - `packages/coding-agent/test/settings-quiet-startup-mu.test.ts`

### M29 pi's text names commands by the app's name

- **Files**
  - `packages/coding-agent/src/cli/auth-command.ts`
  - `packages/coding-agent/src/core/resource-loader.ts`
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- **Why**: A few of pi's texts name a command as `pi` under any name: `mu auth --help` prints `pi auth …`, a crash note says "start pi and run /bug", and the replaced built-in extension warning says to run `pi config`. They use `APP_NAME`, as the rest of those files do.
- **In a merge**: Keep `${APP_NAME}` in `printAuthCommandHelp()`, the `omitReplacedExtensions()` warning and `crashReportInstructions()`. Text upstream adds there that names a command takes `APP_NAME` too.

### M30 pi's index exports what mu setup and mu auth use

- **Files**
  - `packages/coding-agent/src/index.ts`
- **Why**: `mu setup` checks a key with one request through the proxy a session would use, and `mu auth` lists an account's models with the one pi starts that provider on first. Both run against pi's bundle, so `index.ts` exports `applyHttpProxySettings`, `configureHttpDispatcher` and `defaultModelPerProvider`.
- **In a merge**: Keep the three exports; if upstream moves these functions, export them from their new place.

### M31 GitHub Copilot's default model is asserted

- **Files**
  - `packages/coding-agent/test/model-resolver.test.ts`
- **Why**: Copilot's catalog has no GPT-5.4, so a default of it names a model that does not exist. The test asserts the Copilot default `gpt-6.1-sol`, which is also upstream's value in `defaultModelPerProvider`.
- **In a merge**: Take upstream's side if the line conflicts. When upstream asserts the Copilot default itself or changes it, drop mu's line and retire this entry.

### M32 A custom system prompt section with a built-in name replaces it in place

- **Files**
  - `packages/coding-agent/test/system-prompt.test.ts`
- **Why**: In print, json and sub-agent runs, mu's welcome feature replaces pi's `<docs>` section with one line by giving a custom section the same name. The test pins what that relies on in `buildSystemPromptSections()`: a custom section with a built-in name takes the built-in's place, and an empty one leaves the built-in section.
- **In a merge**: Keep the test. If upstream changes `buildSystemPromptSections()` so that it fails, adapt mu's welcome feature (`packages/kyrn-judge/src/extension/features/welcome.ts`) rather than the test.

### M33 pi's tests pass in a long checkout path and beside a real sign-in

- **Files**
  - `packages/coding-agent/test/external-editor.test.ts`
  - `packages/coding-agent/test/tool-execution-component.test.ts`
  - `packages/coding-agent/test/suite/agent-session-compaction.test.ts`
  - `packages/ai/test/openai-chatgpt-oauth.test.ts`
- **Why**: These tests fail when the checkout path is long or has spaces, or when a real sign-in holds port 1455. The editor fixture is copied to a temp folder, tool rows render wide enough not to wrap a long path, the compaction threshold test uses a fixed system prompt (and expects exactly one compaction), and the ChatGPT OAuth tests listen on port 0.
- **In a merge**: Take upstream's changes to the tests and keep these adjustments in them.

### M34 The test harness streams at a set speed and cleans up on Windows

- **Files**
  - `packages/coding-agent/test/suite/harness.ts`
- **Why**: mu's watchdog, monitor and usage tests depend on time, so `createHarness()` takes `tokensPerSecond` for the faux provider. On Windows a git process the session started can hold the temp folder for a moment (EPERM, EBUSY), so the cleanup's `rmSync()` retries.
- **In a merge**: Keep `tokensPerSecond` in `HarnessOptions` and its pass-through to `registerFauxProvider()`, and `maxRetries` and `retryDelay` on the temp folder's `rmSync()`.
- **Tests**
  - `packages/kyrn-judge/test/watchdog.test.ts`
  - `packages/kyrn-judge/test/monitor.test.ts`

### M35 The kernel-lock manager test gets 20 seconds

- **Files**
  - `packages/chord/test/manager.test.ts`
- **Why**: "a child-owned kernel lock admits one live process" starts four child processes in a row, and on slow CI runners each start can take over a second, past the 5-second default test timeout.
- **In a merge**: Upstream's main deletes this file in its Chord v2 restructure. Take the deletion and retire this entry.

### M36 CHANGELOG lines for mu's changes to pi's packages

- **Files**
  - `packages/ai/CHANGELOG.md`
  - `packages/coding-agent/CHANGELOG.md`
- **Why**: The Unreleased sections of the ai and coding-agent CHANGELOGs carry a line for each mu change to the package, next to upstream's: M3 in ai, and M3, M18, M21, M22, M23 and M50 in coding-agent.
- **In a merge**: Take upstream's CHANGELOG and put mu's lines back in the section they were in.

### M37 mu's README, contributor guide and security policy

- **Files**
  - `README.md`
  - `CONTRIBUTING.md`
  - `SECURITY.md`
- **Why**: The repository is mu's, so these describe mu: what it is and how it measures against pi, how to install it, how to contribute (in English or Chinese), and how to report a vulnerability privately. pi's versions point to pi's community channels and its contributor gate.
- **In a merge**: Keep mu's side whole. Read upstream's change for anything mu's docs should say too.

### M38 The root checks skip .claude and desktop/

- **Files**
  - `biome.json`
  - `scripts/check-pinned-deps.mjs`
  - `scripts/check-ts-relative-imports.mjs`
- **Why**: The desktop app in `desktop/` keeps its own dependency rules, lockfile and TypeScript setup, with `.js` import specifiers, so the pinned-deps and relative-import checks skip it. Agent worktrees under `.claude` hold a second root configuration, which stops biome from running at all, and a second source tree, so biome and both checks skip `.claude`.
- **In a merge**: Keep `!!.claude` in biome's `files.includes`, and `.claude` in `ignoredDirectories` and `desktop` in `ignoredPaths` in both scripts.

### M39 The docs reference pages come from the judgment layer's manifest

- **Files**
  - `scripts/write-docs-reference.mjs`
- **Why**: mu's `docs/reference/decision-points.md` and `docs/reference/features.md` are written from `packages/kyrn-judge/manifest.json`, the file the desktop app's settings read, with each decision point's built-in mode. `--check` fails when the pages are out of date.
- **In a merge**: mu's alone; upstream has no such file.

### M40 mu's issue forms, pull request template, CODEOWNERS and Dependabot

- **Files**
  - `.github/ISSUE_TEMPLATE/*`
  - `.github/PULL_REQUEST_TEMPLATE.md`
  - `.github/CODEOWNERS`
  - `.github/dependabot.yml`
- **Why**: Issues and pull requests to mu go to mu's maintainers: forms for bugs, features and decision point proposals, contact links to mu's Discussions, private security reports and docs, a pull request checklist, reviews requested from the maintainers, and one monthly pull request that updates the GitHub Actions the workflows use. pi's forms (`bug.yml`, `contribution.yml`, `package-report.yml`) are deleted.
- **In a merge**: Keep mu's files, and keep pi's deleted forms deleted: an upstream edit to one is a modify/delete conflict, resolved with `git rm`.

### M41 pi's contributor and issue gates are deleted

- **Files**
  - `.github/APPROVED_CONTRIBUTORS`
  - `.github/workflows/approve-contributor.yml`
  - `.github/workflows/pr-gate.yml`
  - `.github/workflows/issue-gate.yml`
  - `.github/workflows/issue-analysis.yml`
  - `.github/workflows/issue-triage-labels.yml`
  - `.github/workflows/remove-inprogress-on-close.yml`
- **Why**: These gate issues and pull requests to pi's approved contributors and triage pi's issues. In mu's repository they would act on mu's issues, auto-closing them among other things.
- **In a merge**: Keep them deleted. An upstream edit to one is a modify/delete conflict, resolved with `git rm`; a new upstream workflow of this kind stays out too.

### M42 pi's release and publishing workflows are deleted

- **Files**
  - `.github/workflows/build-binaries.yml`
  - `.github/workflows/nix.yml`
  - `.github/workflows/preview-packages.yml`
  - `.github/workflows/publish-model-catalog.yml`
- **Why**: They build and publish pi's releases: its binaries, Nix package, preview packages and model catalog. None of that is mu's, and pi's preview registry refuses mu's repository (its cleanup job gets 403 "Repository owner not allowed"); mu's own workflows (M43) build and release mu. The scripts they run, such as `scripts/preview-packages.mjs`, and `nix/` stay as upstream's, so upstream's changes to them merge cleanly.
- **In a merge**: Keep them deleted. An upstream edit to one is a modify/delete conflict, resolved with `git rm`.

### M43 mu's CI and release workflows

- **Files**
  - `.github/workflows/ci.yml`
  - `.github/workflows/desktop.yml`
  - `.github/workflows/npm.yml`
  - `.github/workflows/site.yml`
  - `.github/workflows/windows-permission.yml`
  - `.github/workflows/windows-tests.yml`
  - `scripts/merge-update-info.mjs`
  - `scripts/merge-update-info.test.mjs`
- **Why**: mu's CI checks the harness (pi and mu's judgment layer) and the desktop app on every push and pull request. `desktop.yml` builds, signs and releases the desktop app for six platforms and merges each system's update feed with `merge-update-info.mjs`; `npm.yml` builds, smoke-tests and publishes `mu-agent`; `site.yml` builds and deploys mu's site; and the Windows workflows run mu's tests and permission round trip on Windows.
- **In a merge**: In `ci.yml`, keep mu's `harness` and `desktop` jobs in place of upstream's `build-check` and `test` jobs, and take upstream's changes to the jobs mu keeps, such as `mcp-conformance`. The other files are mu's alone.

### M44 The weekly pi upstream sync

- **Files**
  - `.github/workflows/upstream-sync.yml`
- **Why**: mu merges pi's main every week. The workflow merges it into a branch and opens a pull request; a conflict in `package-lock.json` alone is resolved by keeping mu's and refreshing it, and any other conflict opens an issue. The pull request quotes this ledger's entries for the files the merge changes, and the issue quotes them for the conflicting files (`fork-ledger.mjs explain`).
- **In a merge**: mu's alone; upstream has no such file.

### M45 The fork ledger and its check

- **Files**
  - `scripts/fork-ledger.mjs`
  - `scripts/fork-ledger.test.mjs`
  - `.github/workflows/ci.yml`
- **Why**: Whoever resolves a conflict in a file of pi's has to know what mu's side is for, and a change nobody wrote down is lost by taking upstream's side. `fork-ledger.mjs` lists the files of pi's that differ from the last upstream commit merged into `HEAD`, and fails when one is in no entry of this ledger or when an entry names a file that no longer differs. The `fork-ledger` job in `ci.yml` fetches pi's main and runs it on every pull request. It is not part of `npm run check`: a local `upstream/main` older than mu's last upstream merge would blame mu for upstream's changes.
- **In a merge**: The script is mu's alone. In `ci.yml`, keep the `fork-ledger` job.

### M46 Newer action versions in the workflows mu keeps from pi

- **Files**
  - `.github/workflows/env.yml`
  - `.github/workflows/env-daemons.yml`
  - `.github/workflows/npm-audit.yml`
  - `.github/workflows/ci.yml`
- **Why**: mu's monthly action update (`.github/dependabot.yml`) also bumps the actions in pi's workflows: `actions/setup-node` 7.1.0, `actions/upload-artifact` 7.0.2 and `actions/download-artifact` 8.0.2, pinned by commit as upstream pins them.
- **In a merge**: Take whichever side pins the newer version of each action, pinned by commit. `env.yml` also carries M5's `npm run build:pinned`.

### M47 package-lock.json

- **Files**
  - `package-lock.json`
- **Why**: The lockfile also resolves mu's workspace package `packages/kyrn-judge` (`@kyrn/judge`) and its dependencies, such as `shx` and `shelljs`, which pi's lockfile does not have.
- **In a merge**: Keep mu's lockfile and refresh it, as the sync workflow does: `git checkout --ours package-lock.json`, then `npm install --package-lock-only --ignore-scripts`. Keeping mu's side keeps mu's resolved versions where upstream raised them, for a security advisory among other reasons: compare the versions upstream's side changed (`git diff <base> upstream/main -- package-lock.json`) and raise those in mu's lockfile too.

### M48 One account's models are chosen for /model and the app's model menus

- **Files**
  - `packages/coding-agent/src/core/enabled-models.ts`
  - `packages/coding-agent/src/core/settings-manager.ts`
  - `packages/coding-agent/src/core/slash-commands.ts`
  - `packages/coding-agent/src/index.ts`
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - `packages/coding-agent/src/modes/interactive/components/scoped-models-selector.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-types.ts`
  - `packages/coding-agent/docs/models.md`
  - `packages/coding-agent/docs/rpc-commands.md`
  - `packages/coding-agent/docs/slash-commands.md`
- **Why**: A sign-in to ChatGPT (44 OpenAI models) or Antigravity puts every model of the account in `/model` and in the app's model menus. pi's `enabledModels` already decides what `/model` shows first, but only `/scoped-models` sets it, for every provider at once, and the app's menus ignored it. `enabled-models.ts` writes the list one provider at a time (`withProviderModels`: `<provider>/*` for all of its models, the default, or one `<provider>/<id>` per chosen model; the other providers' entries stay) and adds `<provider>/*` after a sign-in to a provider the list leaves out (`withProviderOffered`), so a new account never ends up hidden. The TUI asks right after a subscription sign-in with several models, and `/scoped-models <provider>` asks again (`showProviderModelsSelector()`, the scoped models selector with its own heading). RPC `get_available_models` adds `enabledModels`, read again from the settings files each time (`reloadEnabledModels()`), since the app chooses with `mu auth enable`, another process. `index.ts` exports the functions for `mu auth`.
- **In a merge**: Keep `enabledModels` in the `get_available_models` answer, `reloadEnabledModels()`, the `offerSignedInProvider()` call before `completeProviderAuthentication()` in both login dialogs, the selector after an OAuth one, and `/scoped-models <provider>`. If upstream changes how `enabledModels` patterns are read (`resolveModelScopeFromModels`), check `enabled-models.test.ts` still passes.
- **Tests**
  - `packages/coding-agent/test/enabled-models.test.ts`
  - `packages/coding-agent/test/suite/provider-models-selector.test.ts`
  - `packages/coding-agent/test/suite/rpc-models-signed-out-elsewhere.test.ts`

### M50 A sequential tool is a barrier in a batch of tool calls

- **Files**
  - `packages/agent/src/agent-loop.ts`
  - `packages/agent/README.md`
  - `packages/coding-agent/src/core/tools/edit.ts`
  - `packages/coding-agent/src/core/tools/write.ts`
  - `packages/coding-agent/docs/extensions.md`
- **Why**: pi runs a batch of tool calls in parallel, and one call of a tool that declares `executionMode: "sequential"` makes the whole batch run one call at a time. A tool that changes files has to declare it for a batch like `[write run.sh, bash "chmod +x run.sh && ./run.sh"]` to run in order, and then every read and command in such a batch loses its concurrency. In 1341 Terminal-Bench sessions of mu, 6212 of 19074 tool-calling turns sent two calls or more, 481 of those had an edit or a write, and in 89 a later call named the file an earlier edit or write changed. `executeToolCalls()` now cuts the batch at its sequential calls (`barrierSegments()`): the calls before one have ended when it starts, the calls after it start when it has ended, and the calls between two of them run in parallel as before. Results stay in the model's order. `edit` and `write` declare `executionMode: "sequential"`, so a call after one in its batch sees the file changed: without it, a `[write run.sh, look at run.sh]` batch measured the file missing.
- **In a merge**: Keep the segment loop in `executeToolCalls()` and `barrierSegments()`. If upstream changes how a batch runs (`executeToolCallsParallel()`, `executeToolCallsSequential()`), keep a sequential call running alone, after the calls before it, without serializing the rest of the batch. `config.toolExecution === "sequential"` still runs everything one call at a time. Keep `executionMode: "sequential"` on the `edit` and `write` definitions.
- **Tests**
  - `packages/agent/test/agent-loop.test.ts`
  - `packages/coding-agent/test/suite/agent-session-batch-order.test.ts`

## Retired
