---
name: performance
description: Find and fix what makes mu slow or expensive, with measurements a reviewer can rerun. Use for a request to make mu faster or cheaper, judge latency per turn, startup time, request size and prompt cache reuse, memory, and before adding a performance check to CI.
---

# Making mu faster, with evidence

Start from what a person waits for or pays for, measure it, and change one thing at a time. A loop that looks slow, an unused cache or a large file is a lead, not a finding.

## What costs time and money in mu

- **The judge inside a turn.** Preflight, `tool.approval` and `turn.continue` can each wait on the judge. The latency they add lands in every turn that asks.
- **Request size.** Every tool description and line of system prompt goes out each request (`test/golden/model-surface.md`). See the `agent-experience` skill.
- **Prompt cache reuse.** A request that changes early bytes (a timestamp, a reordered tool list) loses the provider's cache for everything after them. The desktop's ring shows the share reused, `cacheRead / (input + cacheRead + cacheWrite)`; `kyrn/docs/07-cache-investigation.md` is a worked investigation.
- **Startup.** `npm run profile:tui` measures until the TUI is usable, and `npm run profile:rpc` until the first `get_state` answer. Both use your agent dir unless you pass `--isolated-agent-dir`, so say which you used.
- **Memory.** mu 0.1.3 could not start on a 1 GB server: its bundle was transpiled by Babel at every start, taking more than 500 MB of heap (`test/npm-package.test.ts`).

## Count, then time

CI runners vary: process starts got 4 to 6 times slower on GitHub's Ubuntu runners in one week (#303). A wall-clock threshold on CI is either loose enough to miss a regression or tight enough to flake. Prefer counts, which are the same on every machine:

- judge calls per turn: `MockJudgeProvider.calls.length`, or `engine.stats.calls`, `inputTokens` and `probes`;
- characters of model surface, from the golden file;
- work done that must not happen at all: the bundle test counts Babel transpiles and expects none.

To measure the latency the judge adds, give `MockJudgeProvider` a responder that waits a fixed time, run a faux-provider session (`packages/coding-agent/test/suite/harness.ts`), and compare turn time with and without the judge. That isolates mu's own overhead from model and network latency. Say so when you report it: it is not the whole latency a person sees.

## Before changing code

Write down, in the PR or the commit message:

| | |
|---|---|
| Operation | what the person does, and what marks it done |
| Workload | sizes and counts (turns, tool calls, output bytes), and why they are typical or the tail |
| Entry path | built `dist/` or source, Node or Bun, bundle or not |
| Clock | cold or warm, what is inside the timing and what is not |
| Result | every sample, the aggregate that decides, the threshold |
| Behaviour | the tests and golden files that must not change |

Run it on the current code first and keep the numbers. Build fixtures from constants in the test. Never from your own sessions, prompts, paths or keys: if you look at real sessions to choose sizes, keep only counts.

## Changing code

- One cause per change. Re-run the focused measurement and the whole operation it belongs to: a faster helper that the operation does not wait on is not a win.
- A negative control: the new check fails on the old code, or when the removed work is put back.
- Keep behaviour. `model-surface.md`, `decision-requests.md` and `decision-policies.md` stay unchanged unless the change means them to. A cache needs a clear invalidation and an owner that frees it.
- Drop the change when the gain disappears end to end, a typical workload gets slower, or the code gets much harder to follow for a few percent.

## Reporting

Workload, then before and after with the ratio, then what still behaves the same and how you checked, then the negative control, then what you did not measure. Keep numbers from someone else, numbers you measured locally, and CI's numbers apart.
