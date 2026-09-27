# mu in the original AionUi application

> The project was renamed from KYRN to **mu** on 2026-09-21. What the app shows says mu; folder, module, channel,
> i18n-key and stored event names still say `kyrn`, on purpose. The data home is `~/.mu`, or `~/.kyrn` on a machine
> that has not moved it yet: `~/.mu` is never created beside an existing `~/.kyrn`. The full list is in
> `kyrn/docs/10-rename-to-mu.md` of the harness repository. Below, "KYRN" in the verification notes is the same project.

The integration is an ACP adapter, not a second desktop interface. AionUi's
existing projects, conversations, model/thinking selector, file panel, tool cards
and permissions remain the product UI. mu remains the execution engine.

Startup automatically registers and health-checks mu. The registration is found by its adapter command, not by
its display name: one from before the rename is renamed in place (same id, so old conversations stay attached),
and a refused rename never blocks startup. The backend's update replaces the whole record, and its agent list
leaves the record's environment variables out, so the rename first reads the whole record (setting `enabled` to the
value it already has answers with it) and sends everything back with only the name changed. If the whole record
cannot be read, the old name stays: an old label costs less than a user's cleared variables. Checked against a real
AionCore v0.2.2 on a throw-away data directory, not only against a mock: `node scripts/kyrn/registration-check/check.mjs`
(19 checks; run it again after every AionCore upgrade, since none of this is a documented contract). Other agents and
assistants are disabled in the backend, not merely hidden. Their upstream source
remains in the checkout; existing conversation history is not deleted.
The adapter reuses
the local mu login and judgment configuration; do not put API keys in AionUi.
The model and thinking choices come from the live mu process, not a hardcoded
list. Changes are confirmed through ACP and persisted in the pi session.
Jev classification and tools appear in AionUi's existing tool cards. Actual model
thinking streams through ACP thought chunks, including history replay; encrypted
signatures and redacted placeholders are not shown.

Session IDs map to pi session files under `<home>/acp-sessions`. Reopening a
conversation reloads that pi session. Concurrent prompts on one session are
rejected; cancellation sends pi's abort command. Closing the ACP connection
terminates its owned processes.

Current limits: text/text-resource and raster image input; client-provided MCP servers are
not imported, and free-text extension dialogs are cancelled rather than guessed.
Built-in mu browser, hive, skills and tools still run inside mu.

Where mu comes from (`process/agent/kyrn/harness.ts`): `MU_ROOT` / `KYRN_ROOT` when set; else the copy the packaged
app carries (`<resources>/harness/mu-agent`, below); else a checkout beside this one (`../KYRN`, or `..` in the MU
monorepo); else `mu-agent` installed with npm (`npm i -g mu-agent`), found from `mu` on PATH or in npm's usual global
folders. The npm package, the app's copy included, keeps its keys in `~/.mu/.env` and its Laya venv in
`~/.mu/local-judge`, and the settings follow it there.

Windows has no bash. There the registration's command is `acp.cmd`, which runs `acp.mjs` with Node (22.19 or newer
on PATH), and the adapter starts the harness as `node <root>/kyrn/bin/mu.mjs --mode rpc`, with no shell; closing a
conversation ends the harness's whole process tree with `taskkill /T`. macOS and Linux keep the bash `acp` and the
checkout's bash forwarder: the registration is found by its command, so that path must not change there. Not run on
a real Windows machine yet.

AionCore runs a registration's command only up to its first space, and the installer puts the app for all users in
`C:\Program Files\mu` (#4). So on Windows a launcher whose path has whitespace is registered by a spelling without it
(`process/agent/kyrn/windows/launcherCommand.ts`): its real path when that has none, else its 8.3 short path
(`C:\PROGRA~1\mu\resources\mu\acp.cmd`), else a forwarder: `mu-desktop\acp.cmd`, an ASCII batch file that hands over
to the launcher, in the first folder without spaces that takes it (the user's local app data, ProgramData, the public
profile), rewritten at each start. A registration under mu's name that runs the same launcher by another spelling gets
this start's command; one that runs another file is still refused. When no spelling works (a folder outside ASCII
without a short name, no folder for the forwarder), the start says to install mu into a folder whose path has no
spaces, such as `C:\mu`. `register.mjs` does the same on Windows, where it needs Node 22.18 or newer.

The packaged app has no desktop sources and no tsx, and needs no Node on the machine. It carries the adapter bundled
into one file, `out/main/mu-acp.js` (unpacked from the asar, built by `scripts/build-mcp-servers.js` like the builtin
MCP servers), and mu itself: the npm package `mu-agent` with its dependencies in `<resources>/harness/mu-agent`. It
registers `resources/mu/acp` (`acp.cmd` on Windows) as the command, which runs the adapter on the app's own binary
as Node (`ELECTRON_RUN_AS_NODE=1`; Electron 37 carries Node 22.21), and the adapter starts mu the same way
(`launchCommand` in `piRpc.ts`). `MU_NODE`, when set, runs both on that Node instead. mu drops the variable for
what it starts (tools, servers) and gives it back only to its own sub-agents.

`scripts/kyrn/bundle-harness.mjs` puts mu in `resources/harness` before electron-builder runs
(`scripts/build-with-builder.js`), and `scripts/afterPack.js` checks the packaged app has it
(`packages/shared-scripts/src/verify-bundled-harness.js`). Which mu: `MU_HARNESS_TARBALL`, a tarball packed from a
harness checkout (`node kyrn/npm/build.mjs --pack`; the MU repository's CI packs it from the same commit), else
`mu-agent` from the npm registry at the version pinned in the root `package.json` (`muAgentVersion`). Its
dependencies are installed by npm for the target system and processor (`--os`, `--cpu`), without install scripts;
npm is needed at build time only.

WSL (`process/agent/kyrn/windows/wsl.ts`): on Windows, a conversation whose folder is inside a WSL distribution
(`\\wsl.localhost\<distro>\...`, or `\\wsl$\...`) gets its harness started inside that distribution:
`wsl.exe --distribution <distro> --cd <linux path> --exec bash -lc <start script>`. mu must be installed there
(`npm i -g mu-agent`); the script finds it on the login PATH, through nvm or in npm's usual folders, and says what to
install when it is missing. The harness shares the Windows side's agent folder (one sign-in, one configuration:
`MU_AGENT_DIR`) and the app's session file, both translated by WSL through `WSLENV` (`/p`); keys in a `.env` come
from the distribution's own `~/.mu/.env`. Closing a conversation ends mu's input first (it then shuts down by
itself), and ends the `wsl.exe` tree only if that did not work. The app's local judge and browser bridge listen on
Windows' loopback, which WSL reaches only in mirrored networking mode. The start script is tested with bash; nothing
of this has run on a real Windows machine with WSL yet.

`node scripts/kyrn/start-check/check.mjs [--packaged]` checks this whole chain on the machine it runs on, the way the
app and AionCore run it (on Windows: `acp.cmd` through `cmd /d /c`, the harness as `node mu.mjs`, `taskkill /T` at the
end): the harness is found, mu answers over RPC, the registration's command answers the ACP handshake and opens a
session, and ending each leaves no process behind. With `--packaged` it does the same for the bundled adapter and
`resources/mu`. It uses a throwaway home, calls no model and needs no key, so CI can run it on Windows runners.

The earlier `kyrn/` prototype is paused. It is not the product UI direction.

## Local verification (2026-09-21)

- Original AionUi dev app starts with its original components and KYRN additions.
- Backend custom-agent registration `KYRN` passes its own health check (`online`).
- Real ACP handshake: 256 authenticated models; current Codex Sol, medium;
  seven supported thinking levels. Setting medium returns a confirmed update.
- In the original UI: KYRN is the sole enabled agent. Native project folder
  picker and original combined model/thinking menu remain in place.
- Focused adapter tests cover streaming, cancellation, invalid configuration,
  session replay and real-shaped Jev/hive events. No model tokens in unit tests.
- pi's prompt response acknowledges preflight only. The adapter waits for
  `agent_settled` before completing the ACP turn; otherwise AionUi stops accepting
  text too early. A regression test guards this boundary.
- Native end-to-end check: original AionUi shows Jev classification and the actual
  Codex response `KYRN connected`. After the native additions, 21 focused tests,
  full TypeScript check, focused lint and i18n validation pass.
- Native UI shows actual thinking and replays two real completed delegate workers
  and their execution records after restart. No test credentials were saved into
  the user's configuration; settings persistence tests use temporary fixtures.

Start the original app with `scripts/kyrn/start`. It uses the verified local
Electron runtime and AionCore v0.2.2 ARM64 binary. The upstream dependencies are
installed from `bun.lock` with `--frozen-lockfile --ignore-scripts`; no npm
lifecycle hooks were run. Agent registration is saved by AionUi itself.

For a different local AionUi instance, set
`AIONUI_BACKEND_URL` to that instance's loopback URL and run
`node scripts/kyrn/register.mjs`. It follows the same rules as startup and never replaces an unrelated registration.

## Native settings and collaboration

Settings → mu settings provides Beta compression, decision mode, ordered judge
cascade, provider/model/endpoint/timeout and write-only API key entry. It edits
`<home>/agent/mu.json` (or `kyrn.json` while that is the only file there; saving goes to the file that was read),
preserving profiles, routes and other feature options. Credential variables may be named `MU_JUDGE_*` or `KYRN_JUDGE_*`.
Stale saves are rejected. Keys remain in the harness `.env` (0600); only presence
booleans return to the renderer. Changes apply to new sessions or after using the
original reconnect button. OAuth credentials are never read by the desktop.

The original resizable project panel has Collaboration and Files views:

- Swarm: per-bee state, model/thinking, tool/turn counters, progress and errors;
  durable execution records, accepted/rejected gates and confirmed deliveries.
- Jev: classification and decision probabilities, outcomes, fallback and timing;
  these are decisions, not invented reasoning text.
- Memory: actual recall, capture decisions and stored lessons.
- Images: actual tool-returned raster images with run/bee provenance, not image
  understanding by the text-only judge.

Events persist in `<home>/acp-sessions/<session>.events.jsonl`. Byte cursors preserve
partial UTF-8 lines; paginated rendering retains previous records. These streams
never enter the model context. Canonical mu temp run directories (still named `kyrn-hive-*`, `kyrn-swarm-*`) are the only
allowed source; external symlink targets are excluded. Observation failures never
fail a model turn. Events before this recorder was installed are not fabricated.

AionCore v0.2.2 stores the ACP resume anchor in `acp_session`, not in
`conversation.extra.acp_session_id`. The main process reads only that binding via
Node SQLite in read-only mode, keyed by conversation ID and agent ID. The backend
remains the sole database writer. This version-specific seam should move to a
backend session API when one is exposed.

This is a local development app, not a packaged installer. CLI and App share
configuration, but do not yet attach to the same live process.

## Native Hive view

Hive tool calls now render as native summary cards with named bee icons, reported
states and an action to open Collaboration. Original input/output remains under
Raw evidence. Other tools and delegate runs retain their existing views.

The Hive panel has a run selector, clickable bee map, execution inspector and
information feed. Directed map edges come only from confirmed `hive.delivery`
records joined to notes in the same run. Jev gate approval is not a delivery;
gates and shared findings have separate disclosures. Unknown sources do not
create an inferred edge. Selecting a bee pins its run while newer runs arrive.

The inspector shows the last reported tool/state, model, assigned focus, recorded
messages and completed tool output. It is not the full outbound model prompt or
a live per-bee terminal. Tool start/end records are paired; duplicate tool-result
messages are not shown twice. Final compact snapshots do not erase the durable
execution records. Thinking is shown only when explicitly present as readable
model output; signatures and redacted blocks are not displayed.

Assignment metadata is captured from real Hive start arguments as a bounded,
whitelisted `hive.manifest`, outside model context. Older runs without that event
show that the assignment was not recorded. New capture code applies on the next
adapter start/reconnect; do not interrupt an active task merely to enable it.

Card navigation is scoped to conversation/run/bee, opens rather than toggles the
panel, and works in the existing desktop and mobile hosts. Non-project chats open
an on-demand drawer without replacing their workspace controls.

Verification: 78 focused tests across 12 desktop files pass. Isolated browser
fixtures exercise named-bee click-through and 220/260/280/420/500 px panel widths,
with light/dark screenshot review. These are not real-task desktop E2E results;
no live session was modified or restarted to manufacture activity.

## Context, compaction and cache telemetry

The collaboration panel now shows live context usage, the effective auto-compaction
threshold, Beta mode and actual compaction results. Completed operations show
before/after token estimates, reduction percentage and kept/pruned/dropped counts.
Plans are not reported as savings. Default summary fallback, cancellation and errors
remain distinct. After compaction, current usage is unknown until a new model response;
the result card explicitly labels the post-compaction token estimate.

Settings → mu adds automatic compaction and a token threshold. It shares
`<home>/agent/settings.json` with pi, preserving existing model/reserve settings.
Zero follows the model window minus reserve; other values must be integers from
8192 to 10000000. A configured threshold is clamped to the model budget. It triggers
at the next model-request boundary; it is not a hard truncation limit. A small cap
also limits the recent-history retention budget. Reconnect to apply saved settings.

The green ring uses pi's cumulative session usage, including compacted history:
`cacheRead / (input + cacheRead + cacheWrite)`. Output is excluded, writes are not
hits, no reported input shows an em dash, and compaction does not reset totals.
Tooltip text shows the numerator/denominator and scope. This is token-weighted,
not an average of per-request percentages, and not a monetary savings estimate.

Context snapshots refresh at session attach/model changes, message/tool completion,
compaction and task settlement. They and the actual `compaction_start/end` events
are durable presentation data, never extra model messages. Focused desktop tests
cover empty/unknown usage, cache math, failed compactions, settings preservation,
stale edits and adapter refresh after compaction.

Verification for this addition: 29 focused desktop tests, TypeScript, focused lint
and all-locale i18n checks pass. Native UI shows the green ring updating from real
session usage. Harness verification includes 15 focused KYRN tests, 37 upstream
compaction regressions and the complete `npm run check` pipeline. The user's
existing compression threshold was not lowered just to manufacture a result.

## Icon, colour scheme and display name (2026-09-22)

- `python3 scripts/kyrn/icon/build-icon.py` rebuilds every icon from
  `resources/brand/mu-icon-source.png` (needs Pillow and numpy; `iconutil` for the
  `.icns`, macOS only, skipped elsewhere with the iconset kept). The artwork is not repainted: only the noisy
  edge is replaced by a clean continuous-corner mask, the body is made opaque and
  the tile is placed on the canvas. `--verify` re-measures the source and fails if
  the fitted tile moved; re-runs are byte-identical. `app.icns` and `app_dev.png`
  carry the macOS margin (824/1024), everything else is full-bleed. Sizes of 32 px
  and below use a simplified tile with a bolder glyph.
- The glyph is one path shared by the script, `renderer/assets/logo.svg` and
  `components/brand/glyph.ts`; `tests/unit/kyrn/brandMark.test.ts` keeps them equal.
- The look is a second colour scheme, `data-color-scheme='mu'` on `<html>`
  (`styles/themes/mu-color-scheme.css`, `mu-arco.css`, `mu-shell.css`). It keeps the
  upstream specificity, so theme tokens and custom CSS themes still win; setting the
  attribute back to `default` restores the upstream colours untouched.
- Since 2026-09-22 (the user: the pink and purple all over looked bad) the page is
  neutral again: upstream's white, greys and black, and its near-black greys in dark,
  with only the tertiary text grey deepened for contrast. Light lavender and light pink
  are the accent and stay small: primary buttons (`--mu-accent-fill`, dark text on it),
  the send button (`--mu-accent-gradient`, pink into lavender, dark arrow), a switch
  or checked box, the current step, the selected row's 3 px bar, a chosen card's border
  and ring, focus rings, selection, links. The judge keeps pink as its mark on a tint
  that is nearly white. A test fails if a surface, border or text grey takes a colour
  cast again.
- `node scripts/kyrn/theme/contrast.mts` prints the WCAG contrast of every text
  pair in both appearances and exits 1 under a floor;
  `tests/unit/kyrn/themeContrast.test.ts` holds the same table.
- Upstream strings that name the product are shown as mu by an i18next
  post-processor (`common/kyrn/displayName.ts`), not by editing 13 locale files.

## Settings area: everything mu can be told (2026-09-22)

Settings → mu settings is now an area with a section list: judges (tiers, keys, timeouts), decision points, features,
models and providers, context, local judge (read-only for now). One draft and one sticky save bar cover all sections,
because the files behind them share one revision: `<home>/agent/mu.json` (or `kyrn.json`), pi's `settings.json` and pi's
`models.json`. A save based on an older revision is refused and offers a reload. A save only rewrites what it changes:
untouched files are not rewritten, untouched entries keep their spelling, and built-in judges nobody edited are no longer
frozen into mu.json.

- **Decision points and features** are rendered from `<KYRN_ROOT>/packages/kyrn-judge/manifest.json`, whatever it lists
  (Chinese for Chinese locales, English for all others). `modes.<decisionId>` is an override; "follow default" removes the
  key. `features.<name>` is `false` when off and nothing else has to be kept, otherwise an object; option values are
  validated per kind (type, range, choices, length), values equal to the default are not written, and keys the manifest
  does not describe (`routes`, `writer`, `recordState`, `judges.*.profile`, a future option) are never dropped. Without
  the file, or with an unknown `version`, the page says the harness is too old and keeps the basic settings.
  The harness reads its configuration once per process (`loadConfig` in `registerKyrn`), so changes apply to new sessions;
  a running session keeps what it started with until it is reconnected.
- **Custom providers** live in `models.json`. The endpoint type is the first choice: `openai-completions`,
  `openai-responses`, `anthropic-messages`, `google-generative-ai`. The API key is write-only: it goes to the harness
  `.env` as `MU_PROVIDER_<ID>_API_KEY` (the launcher exports that file) and `models.json` only holds `"$MU_PROVIDER_<ID>_API_KEY"`.
  A literal, `!command` or other variable written by hand is kept and shown as "set (by hand)"; extra `headers` are kept
  and only their names are shown. Overrides of built-in providers, `modelOverrides`, unknown `api` values and unknown
  fields are preserved untouched. A `models.json` with comments (pi accepts them) is read but not written: providers are
  then read-only. Removing a provider removes the key this app stored for it.
- **Default model and thinking level** are `defaultProvider`, `defaultModel`, `defaultThinkingLevel` in `settings.json`
  (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). pi lets `modelThinkingLevels["provider/model"]` win over
  the default, so an existing entry for the chosen model follows along.
- **Test connection** is one minimal request from the main process in the wire format of the chosen type: the model list
  where the API has one, else a one-token request. Eight-second timeout, redirects refused, the key in no URL, log line,
  error or result, and a saved key is only ever sent to the address it was saved for.
- **Built-in logins** are listed from what mu last reported to the backend (`config_options` of the agent record in
  `/api/agents/management`): a snapshot of the last connection, not a live query. The app never reads `auth.json`
  itself; subscription sign-in (below) goes through pi's own credential code.

Verification: 97 focused tests in 6 files under `tests/unit/kyrn/settings/` (store, connection test against a local `http.createServer`,
renderer), the 20 earlier settings tests unchanged, TypeScript, lint, format and the all-locale i18n check. Layout checked
in an isolated browser fixture with synthetic data at 1180, 900 and 420 px, light and dark. Not run against a real
provider, and not in the real Electron app.

## First-run guide and subscription sign-in (2026-09-22)

- **The guide** (`/welcome`) opens once for someone without a startup model (`mu.onboarding.v1` in localStorage marks
  it seen) and again from Settings → Models → "新手引导": what mu is, a model, a judge (Jev with its key, or the local
  Laya), a summary. Everything is written in one save at the end, keys only as credentials. The OpenAI tile asks for
  Chat Completions or Responses; the judge page offers Jev and Laya only, the full tier editor stays under "高级设置".
- **Signing in with a subscription** (ChatGPT Plus/Pro as pi's `openai-codex`, Claude Pro/Max as `anthropic`) runs pi's
  own OAuth flow in a child process, `mu auth status | login <provider> | logout <provider>` (the harness's
  `packages/kyrn-judge/src/auth`), started by `LoginManager` (`process/agent/kyrn/login.ts`) through the harness's
  launcher like a session, with `MU_AGENT_DIR` = mu's agent dir: the same for a checkout, npm's mu-agent and the copy
  inside the packaged app. The credential lands where pi reads it, as `/login` in the terminal does. `mu auth` speaks
  JSON lines; it prints provider ids, credential types, the sign-in page address and model names, never a credential. Only `https:` addresses are opened in the browser. pi's Codex question "browser or device
  code" is answered "browser" (the app is on the machine with the browser); the pasted-code field is offered only as the
  way out when the callback does not arrive (port busy, browser elsewhere). Sign-out deletes the provider's credential
  only when it is an OAuth one, never a key stored for the same provider. The account's first model is pi's own
  starting model for it (`defaultModelPerProvider`).
- **Where**: the guide's first tile, and Settings → Models → "订阅账号" (sign in / sign out, immediate, outside the save
  bar; the startup model then offers the account's models before a running mu has reported them).
- Google sign-in (Gemini CLI, Antigravity) is not offered: upstream pi removed it (fe66edd94, 2026-04-30), and
  re-adding it means reusing another product's OAuth client, with the account risk that carries. Waiting on a decision.

Verification: `tests/unit/kyrn/settings/login.test.ts` (the manager against a fake runner: page opening, answers, cancel,
a newer sign-in replacing an older one, status, sign-out, `mu auth` started through a launcher), the guide and settings DOM tests with a mocked
bridge. Against pi's real code with an empty temporary agent dir: `status`, `logout`, and `login` for both providers up
to the sign-in page (auth URL emitted, callback server listening on 53692 / 1455, cancel closes it). A complete sign-in
needs a person in the browser and was not run.
