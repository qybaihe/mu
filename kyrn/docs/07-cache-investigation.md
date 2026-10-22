# Cache investigation and first fix

> 已于 2026-09-21 更名为 mu（命令 `mu`，标识 μ）。本文是更名前的记录，正文保持原样；新旧名对照见 [10-rename-to-mu.md](10-rename-to-mu.md)。

Date: 2026-09-21. Scope: prompt-cache reuse in the existing KYRN/pi/ACP stack.
No live model calls, configuration changes, desktop restarts, or release builds were used.

## Findings

The desktop ring reports cumulative cached input share:

`cacheRead / (input + cacheRead + cacheWrite)`

This is useful accounting, but not a measurement of whether the previous request's
prefix survived. Cold starts, newly added tool output, model switches and auxiliary
usage all affect it. `getSessionStats()` includes assistant, tool, summary and warming
usage across the session; the desktop does not double-add those totals.

Read-only inspection found four surviving pi session files among ten ACP mappings.
In the sampled 33 comparable consecutive same-model requests, 30 had nonzero cache
reads covering at least approximately 96% of the previous prompt. This is a usage-based
proxy for reuse, not a token-by-token payload comparison. All sampled requests used
Codex OAuth (Sol/Astra); do not extrapolate these results to other providers.

Example: previous input was 6,622 tokens, next request reported 6,528 cache reads and
14,156 uncached input tokens. The next request's cached share was only about 31.6%,
but cache reads covered about 98.6% of the previous input. Most of the low share came
from new input, not re-billing the old prompt.

Two complete misses followed approximately 11-minute and 38.6-minute gaps. Cache
expiry or backend routing are candidates, not proven causes. One complete miss
followed a roughly 20-second gap without a recorded model/thinking change. The saved
telemetry does not contain its outbound payload, so its cause remains unknown.
There were no recorded forgetting or compaction operations in this sample.

## Request paths checked

- pi records prompt section/tool changes as transcript deltas. For current Codex
  models supporting mid-conversation system messages, these are appended rather
  than rewriting the initial system prompt. Providers without that capability may
  fold changes into the leading prompt instead.
- Preflight and memory hints append messages. Presentation events and decision
  custom entries are not model messages.
- Admission operates before a new tool result enters context; it does not normally
  rewrite a previously sent result.
- Forgetting changes historical results in the outgoing context. Compaction also
  changes history, intentionally, at a compaction boundary.
- The Codex session ID/prompt-cache key remains stable. WebSocket delta continuation
  is separate from prompt caching: changing top-level options can disable delta
  continuation without proving a cache miss on the subsequent full request.
- Codex reasoning changes remain a hypothesis to measure, not a reason to disable
  judge routing globally. The short-gap miss above had no recorded effort change.

## Fixed: stable forgetting epochs

`packages/kyrn-judge/src/extension/features/forgetting.ts` previously held all state
only in closures and consumed the first unspent threshold. At 90% usage it could
rewrite different old results on three consecutive requests for 50/70/85%, even
without further growth. Reload lost replacements; successful compaction did not
rearm thresholds in the live instance.

The fix:

- Spend all already-crossed levels in one bounded batch. Empty crossings stay armed.
- Save replacement decisions, judged IDs and spent levels as versioned
  `kyrn.forgetting.state` custom entries, outside model context.
- Restore from the active branch on start/reload/resume/tree navigation.
- Start a new epoch only after successful compaction; failure/cancellation retains state.
- Discard late decisions after lifecycle transitions and persist before applying.
- Preserve original tool results in the session; the outgoing projection is still separate.

Ten regression cases in `packages/kyrn-judge/test/forgetting.test.ts` use the faux
session harness and real extension event runner. They cover threshold batching,
future/empty thresholds, fresh-instance reload, branch isolation, successful/failed
compaction, late replies and shadow behavior. They validate local lifecycle and
projection stability, not server-side cache retention or improved billing.

## In development: cache diagnostics and skill persistence

Status update: 2026-09-21, reported by the user. The four items below are **in
development, pending acceptance**. This update records ongoing work; it does not
claim implementation, passing tests, deployment, or improved live cache reuse.
They are separate from the completed forgetting fix above.

| Work item | Scope | Acceptance criteria |
| --- | --- | --- |
| Latest main-model request diagnostics | Keep the cumulative ring; separately show cache reads, previous/current prompt input totals, request interval, provider/model and compaction boundaries. | Exclude auxiliary calls from the main-request comparison; unknown values stay unknown; growth-heavy input must not be mislabeled as prefix loss. |
| Outbound request fingerprints | Compare system instructions, tools, historical prefix and reasoning/options separately, correlated to the actual request and its usage. | Store fingerprints and necessary non-content metadata only, never prompt/tool-result bodies, credentials or authorization headers; unchanged prefixes remain comparable when new content is appended. |
| Evidence-based classification | Distinguish reported cache misses, normal new input, model changes, and WebSocket continuation fallback. | Full-request fallback must not automatically count as a cache miss; missing evidence remains unknown; idle time alone must not prove expiry. |
| Persistent skill disclosure | Restore hidden/disclosed skill state across reload/resume and tree navigation. | Fresh runtime restores the active branch's selection without reclassifying the whole catalog; branches stay isolated; hidden skills remain discoverable. |

Reuse `packages/coding-agent/src/core/cache-stats.ts` where applicable. Its
missed-token estimate is a heuristic, not proof of a provider defect. Fingerprint
changes are diagnostic evidence, not provider-side cache-hit measurements.

On acceptance, record changed files, exact test commands/results and any observed
live request evidence. Offline tests cannot establish a live cache-hit improvement.
Measure the next naturally occurring low-reuse request before changing provider
cache metadata, cache warming or per-turn reasoning policy.

Do not promise a cache-hit percentage, pad prompts to improve the ring, reset
cumulative totals after compaction, or remove useful context just to improve a metric.
