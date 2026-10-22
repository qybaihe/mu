---
title: Context
summary: How mu keeps the context small: tool output by the chunk, stale results dropped without summaries, skills and MCP servers only when needed.
---

The model's attention is limited, and so is its context. mu keeps out what the task doesn't need, so the context rarely fills and the prompt cache stays warm. Each piece below is a [decision point](@decisions) you can switch or put in shadow.

## Long tool output {#admission}

Output longer than 4,000 characters, from a search, a build or a command, is cut into chunks of about 1,200 characters, and the judge is asked of each: does this matter now? Up to 16 chunks go in one request, the state billed once. What matters enters the context; the rest is archived with a pointer, so the model can fetch it if it turns out to need it. If the judge takes longer than four seconds, the output goes in whole.

`read`, `edit` and `write` are never filtered: when the model reads a file, it gets the file.

## Test logs {#test-logs}

A failing run often prints the same diff, DOM dump or stack trace once for every failing test. With test-log trimming on, mu keeps the first copy and turns each repeat into one line that says which lines it repeats. No model is called, and the markers expand back to the original byte for byte; the full log stays on disk, with a line at the end pointing to it.

```json
{ "features": { "admission": { "testLog": "rules" } } }
```

`"jev"` goes one step further: with a verbose reporter, the judge also picks which passing records and test output the current goal still needs. Failures and the summary are never asked about. The settings call this *Test log trimming*. Measurements are on the [decision points page](@decisions#measured).

mu also tells test runners that an agent is reading, so Vitest and others print only failures and the summary.

## Forgetting stale results {#forgetting}

When context use crosses 50%, 70% and 85%, results longer than 6,000 characters and at least two turns old are judged: still needed, or stale? A stale result becomes a one-line tombstone in every request from then on. Nothing is summarized, and the session file keeps the original.

## Summary-free compaction {#compaction}

Off by default. When a conversation is compacted, the judge keeps or prunes passages one by one instead of a model writing a summary. Kept passages stay word for word; pruned ones keep their first 300 characters.

```json
{ "features": { "compaction": true } }
```

## Skills, packs and MCP servers {#disclosure}

Install a lot, show little:

- **Skills.** Only the descriptions of skills that relate to the task go into the prompt. The others stay findable. With fewer than four skills, nothing is filtered.
- **Packs and MCP servers.** They are installed but hidden: a server's process doesn't start and its tools aren't shown until the judge finds the task needs it, or the model asks for it. Tool lists are cached, so the judge knows what a server offers before it has ever run. `"exposure": "always"` under `mcp.servers` in `mu.json` keeps one open.

The packs that ship with mu: ast-grep structural search and rewrite, GitHub through `gh`, `/commit`, `/review`, conflict resolution and a debugger (debugpy, delve, lldb-dap). Each needs its program installed and gives an install hint when it is missing.

## What you already set up elsewhere {#inherit}

mu reads, without changing them, the rules, skills and MCP servers you set up for Claude Code, Cursor and Codex. Always-on rules join the prompt; a rule for certain files is handed over the first time the model touches such a file; the rest are listed by description. A project's own rules and servers are only used for a trusted project, and a server a project defines asks before its first start. `/inherit` shows what was taken over and what wasn't.

## Lessons and the cache {#more}

- **Lessons** bring at most five relevant lines into a turn, however large the library; see [Lessons](@docs/lessons).
- **Cache warming.** When you are likely back soon, mu refreshes the prompt cache before it expires, so your next message doesn't pay for the whole prompt again.
- **Notifications** such as the context budget (70%, 85%) reach the model now, later or never, as the judge decides, so they don't land in the middle of an edit.
