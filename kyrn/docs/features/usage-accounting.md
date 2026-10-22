# Spend the session's messages do not carry

Whoever totals a session's usage adds up the `usage` of its assistant messages (and the judge's, from `kyrn.decision`). Two kinds of model spend never reach an assistant message of the session:

- **A reply the watchdog cut.** The request is aborted, and an OpenAI-compatible stream reports usage only in its last chunk, which never comes. The aborted message keeps its reasoning text with a usage of zero. On Terminal-Bench 2.1, 9 cuts of about 27k reasoning tokens each were recorded as 0.
- **Sub-agents** (`delegate`, `hive`, a hive's verifiers). A child runs with `--no-session`, so its usage is only in the JSON events it streams to the parent. One hive run spent $0.089, three times its parent's recorded cost, and no session file showed it.

mu records both as `kyrn.usage` entries in the parent's session file. They are custom entries (`pi.appendEntry`): kept in the file, never sent to the model.

## The entry

```jsonc
// A cut reply: 76,589 characters of reasoning, no usage reported.
{ "type": "custom", "customType": "kyrn.usage", "data": {
  "source": "watchdog-cut", "model": "xiaomi/mimo-v2.6-pro",
  "input": 0, "output": 21883, "cacheRead": 0, "cacheWrite": 0, "cost": 0.019,
  "estimated": true, "estimatedOutput": 21883, "thoughtChars": 76589, "thinkingMs": 600012 } }

// A hive investigator stopped after five minutes without a sign of life.
{ "type": "custom", "customType": "kyrn.usage", "data": {
  "source": "subagent", "kind": "hive", "name": "repro", "role": "investigator", "model": "xiaomi/mimo-v2.6-pro",
  "input": 8120, "output": 3904, "cacheRead": 61440, "cacheWrite": 0, "cost": 0.0072,
  "partial": true, "status": "timed-out", "turns": 6 } }
```

| field | meaning |
| --- | --- |
| `source` | `watchdog-cut` or `subagent` |
| `model` | `provider/model-id`, when known |
| `input`, `output`, `cacheRead`, `cacheWrite` | as on an assistant message's `usage`: `input` is uncached input |
| `cost` | USD at the model's catalog price; absent when the price is unknown |
| `estimated`, `estimatedOutput` | part of `output` is mu's estimate, not a count a provider reported, and how much |
| `partial` | more was spent than is counted (subagent only, see below) |
| `thoughtChars`, `thinkingMs` | watchdog-cut: the reasoning that had streamed, and how long the reply had thought |
| `kind`, `name`, `role`, `status`, `turns` | subagent: `delegate` or `hive`, its name and role, how it ended, its turns |

Add the token fields and `cost` to the session's totals.

## watchdog-cut

Written once the cut run has settled, just before the `kyrn.watchdog` message that asks again (`src/extension/features/watchdog.ts`, `cutUsage`).

- `output` is estimated from the reasoning that had streamed: `ceil(chars / 3.5)`. 3.5 characters per token is the median measured over 164 reasoning-only MiMo v2.6 Pro replies on Terminal-Bench 2.1 (3.54; p10 2.52, p90 4.19), and what pi's own token estimate uses (`src/usage.ts`). For one reply it is good to about ±25%.
- Output the provider did report on the aborted message is subtracted, so nothing is counted twice. When it reported as much or more, no entry is written.
- The cut request's prompt is not estimated. It was sent, but it is mostly a cache read.
- `cost` is the estimate at the output price of the model that wrote the reply.

## subagent

Written in the parent's session when a sub-agent ends, however it ends (`src/swarm/run.ts`, `subagentUsage`; `recordBeeUsage` in `src/extension/features/swarm.ts`).

- The tokens and `cost` are the sums of the `usage` on the child's assistant messages, as it streamed them. `cost` is at the child's model's catalog price, which pi computes in the child.
- A child's own `kyrn.usage` entries (its watchdog's cuts) arrive as `entry_appended` events and are added in, with `estimated` and `estimatedOutput`.
- `partial: true` when the sub-agent did not finish (`status` is `failed`, `stopped` or `timed-out`): a request it was in when it was stopped, or that failed, reports no usage. Events after it was stopped are not read.
- A bee that never started (stopped while it waited for a slot) gets no entry.
- Not included: the judge calls made inside the child (its `kyrn.decision` entries stay in its in-memory session).
