# A sub-agent's own session

A sub-agent (a `delegate` task or chain step, a `hive` investigator or verifier) is a child pi process. When the parent session is saved to a file, the child saves its own session too, so what it did can be opened and read after it has ended. Before, children ran with `--no-session`: once a `delegate` call returned, its report was all that was left of the child's work, and a child cut off by a crash left nothing.

## Where

```
<agentDir>/subagents/<parent session id>/<time>_<name>_<random>.jsonl
```

- `<agentDir>` is `~/.mu/agent`, or what `MU_CODING_AGENT_DIR` says.
- `<name>` is the sub-agent's name as `/swarm` shows it: the task's title, or the investigator's name. Letters and digits of any script are kept, so a title in Chinese stays readable; everything else becomes `_`.
- The random part keeps two sub-agents of the same name apart, also when a provider reuses a tool call id. pi opens an existing file and carries on its conversation, so a name that came round again would start the new sub-agent inside the old one's.
- The folder is beside `sessions/`, not in it: `/resume`, `mu -c` and the desktop app's conversation list don't show sub-agents, and nothing that totals usage over `sessions/` counts their spend twice (see below).

The child gets the path as `--session <file>`. pi creates the file once the session has its first message, which for a sub-agent is the task, so every sub-agent that started has one.

When the parent keeps no session file (`--no-session`, an in-memory session in a test or an embedding app), the child keeps none either and runs with `--no-session`, as before.

## The entry

The parent's session gets a `kyrn.subagent-session` entry as each sub-agent starts: before it has done anything, so the link is there also when the parent is killed while the sub-agent runs. A sub-agent stopped while it waited for a slot never started and gets none. It is a custom entry (`pi.appendEntry`): kept in the file, never sent to the model.

```jsonc
{ "type": "custom", "customType": "kyrn.subagent-session", "data": {
  "toolCallId": "call_3f9a", "kind": "delegate", "name": "find the session store",
  "session": "/Users/me/.mu/agent/subagents/019a.../2026-11-05T08-12-40-118Z_find_the_session_store_1c2d3e4f.jsonl" } }
```

| field | meaning |
| --- | --- |
| `toolCallId` | the parent's `delegate` or `hive` tool call that started the sub-agent |
| `kind` | `delegate` or `hive` |
| `name` | the sub-agent's name in that call, as in its `kyrn.usage` entry |
| `session` | absolute path of its session file |

Code: `src/swarm/sessions.ts` (`subagentSessionFile`), `recordSubagentSessions` in `src/extension/features/swarm.ts`.

## Opening one

`mu --session <file>` opens it like any session. A sub-agent that worked in an isolated checkout recorded that checkout as its folder, and the checkout is removed when the sub-agent ends; pi then asks whether to continue in the current folder.

## Usage

A sub-agent's spend is counted once, in the parent's `kyrn.usage` entry for it ([usage-accounting.md](usage-accounting.md)). Its own file carries the same assistant messages with their usage, so adding the file to the parent's totals counts them twice. What the file adds is what the parent's entry leaves out: the judge calls the child made (`kyrn.decision`), and every step it took.

## Privacy

The same as for any session: the file stays on this machine, and mu sends it nowhere. Nothing deletes it, as nothing deletes the parent's session; removing the parent's folder under `subagents/` removes all of its sub-agents' sessions.
