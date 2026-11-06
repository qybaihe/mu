# Plan mode: `/plan`

The agent looks and plans first, changes nothing, and starts only once the user approves its plan.

Code: `packages/kyrn-judge/src/extension/features/plan.ts`. Option: `features.plan` (`enabled`).

## Commands

| command | does |
| --- | --- |
| `/plan` | turns plan mode on |
| `/plan <task>` | turns it on and sends the task as the user's message |
| `/plan approve` | approves the plan the agent last wrote, as the Approve answer does |
| `/plan off` | leaves plan mode without a plan |

The status bar says `Plan mode: nothing changes until you approve a plan (/plan off to leave)` (`mu.plan`) while it is on.

## The prompt cache

Nothing is taken off the model's tool list, and the system prompt stays as it is. Turning plan mode on appends one `kyrn.plan` message, which tells the model what plan mode means and how to hand in a plan; leaving it without a plan appends one more. Both go at the end of the conversation, so the cached prefix holds across the switch, and `test/golden/model-surface.md` does not change with it.

Taking edit and write off the list (as pi's plan-mode example extension does) would change the tool list twice per plan, and each change makes the next request start the cache over.

## What is refused

In plan mode, a `tool_call` handler (final, before the permission gate) refuses every call that would need permission in some mode: `permissionNeed` in `src/permissions/modes.ts` is not empty for it. That covers an edit or write, a shell or background command that is not on the read-only list (a chain of read-only commands is read-only), a sub-agent (`delegate`, `hive`), and an MCP, browser or other tool mu does not know to be read-only. The reason the model reads:

```
mu: plan mode is on, so nothing changes until the user approves a plan, and edit src/api.ts could change something. Read, search and ask instead; when the plan is ready, reply with it under # Plan.
```

The rest goes through: reading, searching, `ls`, `git log`, `lsp`, `web_fetch`, `web_search`, `recall`, the `todo` list and `ask_user`. The refusal holds in every permission mode, Full access included, and nobody is asked: there is nothing to allow.

A read-only command that asks to run outside the write floor (`bash` or `bg_start` with `outside: true`, with the confine feature on) is not refused by plan mode: it changes nothing. The permission gate decides that way out as it does in every mode (`runtime.floorExit`), and a call nobody allowed runs inside the floor.

## Handing in a plan

The plan-mode message asks for a reply that starts with a `# Plan` line, then the steps as a list. A run in plan mode that ends on a reply with a heading `# Plan`, `## Plan: …`, `# 计划` or `# 方案` is a plan.

Once that run has settled, mu asks the user with ask_user's dialog (`askQuestions` in `features/ask-user.ts`), so the terminal shows a select and the desktop app the question card, with `question.asked` and `question.resolved` frames as for ask_user:

- **Approve and start**: plan mode ends. The plan's steps go on the task frame's checklist (`runtime.addChecklist`, as the user's items). The steps are the top-level list items under the heading, up to the next heading, 12 at most. Then mu sends, as the user's message:

  ```
  I approve the plan. Plan mode is off: carry it out now. Its 3 steps are on the task's checklist (todo list shows them): tick each one as you finish it.
  ```

  The second sentence is there only when steps went on the checklist. That happens only with the frame feature on and a task in the frame.
- **Keep planning**: plan mode stays on, and nothing is sent; the user says what to change.
- **Something else**: what the user writes is sent as their message, `Not yet. <their words>` and `Keep planning: change the plan and reply with it under # Plan.`
- **Esc**: nothing happens. `/plan approve` or a message is the way on.
- **A message the user types instead of answering**: it takes the question down and is their answer to the plan.

The question waits as long as it takes: the run is over, so nothing waits on it.

## The checks that send the agent back

While plan mode is on, turn.continue and the completion check say nothing. A plan says what will be done ("I'll start with the rename."), which turn.continue would read as a promise to act now; the agent would then try an edit, and plan mode would refuse it. The completion check has nothing to ask about either, since nothing was changed.

## The entry

`kyrn.plan` entries, kept in the session and never sent to the model:

```jsonc
{ "state": "on", "by": "command" }
{ "state": "approved", "by": "answer", "steps": 3 }
{ "state": "off", "by": "command" }
```

On `session_start` and `session_tree` the last entry on the branch says whether plan mode is on, so it comes back with a reopened session.

## Who has it

The `/plan` command works in an interactive session and in the desktop app. A sub-agent has no plan mode. In a `mu --print` run there is nobody to approve a plan.
