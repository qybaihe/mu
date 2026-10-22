# KYRN Desktop: integrate into the existing desktop app first

> 已于 2026-09-21 更名为 mu（命令 `mu`，标识 μ）。本文是更名前的记录，正文基本保持原样；新旧名对照见 [10-rename-to-mu.md](10-rename-to-mu.md)。

## Current direction (2026-09-21)

User feedback: reuse as much of the existing desktop app as possible; integrate
KYRN first, defer custom visual design. The independent `KYRN-desktop/kyrn` shell is a paused prototype,
not the product entry point.

Current entry: `/Users/baihe/Documents/KYRN-desktop/scripts/kyrn/start`.
The desktop app's existing components are reused, with native KYRN settings and a
collaboration view added to the existing project panel. The ACP adapter lives
under `packages/desktop/src/process/agent/kyrn` in the desktop checkout.

Existing desktop UI → the backend's existing ACP management → KYRN ACP adapter →
`kyrn --mode rpc`. The desktop app owns project selection, conversations, model/thinking
menus, code previews and approval UI. KYRN owns model execution, the judge and swarm
orchestration. This avoids maintaining two independent settings and UI systems.

Verified: registered KYRN agent reports online in the desktop app's health check; real
model menu exposes 256 authenticated models and seven supported thinking levels;
the native project picker opens the KYRN checkout. Judge and tool progress use
existing ACP tool cards. The sidebar/window identify the product as KYRN.
Other agent/assistant entries are disabled in the backend and removed from the
product navigation, while upstream source and saved history remain intact.

Native additions:

- Actual model thinking via ACP thought chunks, including replay; no signatures
  or fabricated reasoning. Raster image input reaches the main model.
- Settings → KYRN: Beta compression, decision mode, judge cascade and
  provider/model/endpoint/timeout/key configuration. Existing CLI config is the
  source of truth. Keys are write-only; changes require new session/reconnect.
- Right collaboration panel: live per-bee state and paginated execution
  records; judge gates, accepted notes and confirmed deliveries; experience recall
  and capture; actual tool image artifacts. No fictitious image judging.
- Durable presentation-only event stream, byte cursors and exact session
  isolation. The backend (v0.2.2) keeps the ACP binding in its `acp_session` table; a
  read-only main-process lookup avoids the obsolete `extra.acp_session_id` field.

Verification: 21 focused desktop tests, desktop typecheck/lint/i18n checks pass.
Native UI shows actual thinking and replays two real completed workers after
restart. Older events from before the recorder was installed are not invented.

ACP sessions map to persistent pi sessions under `~/.kyrn/acp-sessions`.
Credentials still belong to the KYRN launcher; they are not copied into the desktop app.

### Context budget and cache display

Native settings expose automatic compaction and `compaction.maxContextTokens` in
pi's `settings.json` (0/unset follows the model's normal window minus reserve).
The effective threshold is the lower of the configured cap and model budget.
This is an early trigger, not a hard token ceiling: a large tool result can cross
it before the next assistant-request boundary. Compaction runs at pi's existing
boundary, not by aborting an active tool or swarm. Recent-history retention is
limited to half a configured cap so compaction has room to work.

RPC `get_state` exposes `contextUsage` and effective `compactionSettings`.
`context.policy` and `compaction.plan` presentation events expose Beta policy and
plans. Actual applied results come from core `compaction_end`, with
`details.kyrn.metrics` for kept/pruned/dropped results and before/after characters.
The desktop distinguishes a plan from applied pruning, fallback summary and failure.
Post-compaction token counts are estimates; current usage remains unknown until
pi receives new provider usage.

The right panel has a green cache-hit ring sourced from native `get_session_stats`:
`cacheRead / (input + cacheRead + cacheWrite)` across the recorded session, including
compacted history. Output tokens are excluded; cache writes are not hits. Missing
or zero total input renders an em dash, never a made-up cache rate. Statistics and
all panel events remain outside the model context.

Native end-to-end verification shows `KYRN connected` from Codex in an existing
desktop conversation. The adapter waits for pi's `agent_settled`, not its early
prompt acknowledgement; a regression test covers this critical boundary.

## Earlier prototype (retained, paused)

## Locations

- Harness: `/Users/baihe/Documents/KYRN`
- Desktop checkout: `/Users/baihe/Documents/KYRN-desktop`
- Dedicated product: `/Users/baihe/Documents/KYRN-desktop/kyrn`
- Start: `/Users/baihe/Documents/KYRN-desktop/kyrn/start.command`
- Upstream baseline: `6744099b279b991c17e31c243f0920477bd31cb6`
- Desktop branch: `codex/kyrn-desktop`. No commit or push performed.

The dedicated target has no runtime dependency on the backend or the desktop
app's agent integrations. Only selected Apache-2.0 editor components are adapted;
the product shell and host are KYRN-specific. Upstream reference source stays
untouched outside the product target.

## Runtime boundary

Renderer → narrow Electron IPC → sole per-session RpcHost → `kyrn --mode rpc`.
The normal launcher supplies the existing OAuth/model settings and judge keys
to the child process. No credential file is read by the desktop implementation.

The existing RPC tool result `details.snapshot` carries hive/delegate state.
No extra swarm scheduler is introduced. Stop/kill call the existing `/swarm`
command. Approval requests are rendered as native app dialogs/cards and replied
to using pi's `extension_ui_response` protocol.

## Judgment events

`KyrnRuntime.present()` publishes versioned sequence-numbered envelopes with
runtime/turn correlation. SDK embedding can inject `onPresentation`; RPC
transports them as JSON in `setStatus`, key `kyrn.presentation.v1`.

- `preflight.pending`: the actual classification begins.
- `preflight.verdict`: observed result, including shadow/late/fallback state.
- `preflight.wait_end`: timeout/skip/verdict; no false permanent spinner.
- `decision`: ledger record without raw input state.
- `progress`: preparation steps from memory/skills features.

Presentation events never enter the model context. Rendering failure never
changes execution. The normal TUI presentation stays intact.

## Still separate from full synchronization

Desktop tasks share KYRN configuration but do not attach to an already-running
CLI process. Simultaneous CLI/App control requires a shared daemon, one session
writer, idempotent commands and cursor-based replay. Do not describe shared
configuration or reading history as completed live synchronization.
