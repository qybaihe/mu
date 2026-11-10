# What waits for you: `/waiting`

mu holds a run up for you as little as it can. A permission question nobody answers is set aside, a question the model asks times out and the model carries on, and what mu suggests is said once, in a notice, when a run has ended. So things pile up behind five commands: `/approve`, `/answer`, `/skills`, `/evolve` and `/capabilities`. A notice named each command once, and a notice scrolls away.

`/waiting` lists all of them in one place, each with the command that deals with it.

Code: the command is in `packages/kyrn-judge/src/extension/features/commands.ts`; each feature says what it keeps waiting with `runtime.waits` (`src/extension/runtime.ts`).

## What it shows

```
The agent's work waits for these:
  /approve: a step that runs once you allow it: npm publish
  /answer: the model asked, and went on without your answer: Which tag should the release get? (and 1 more)
mu suggests these, and nothing waits for them:
  /skills show release-to-npm: a skill mu drafted from a run, Cut a patch release of this package and publish it to npm. (/skills accept release-to-npm installs it, /skills reject release-to-npm discards it)
  /evolve accept npm test: keep npm test allowed in this project: you allowed it for the session 3 times in a row
  /capabilities open feature:ttsr: turn on Mid-stream correction, from the next session: the model suggested it for work like this, and it's off now
```

With nothing waiting it says `Nothing waits for you.`

Two groups, because they are not equally urgent:

| group | what is in it | from |
| --- | --- | --- |
| the agent's work waits | steps whose permission question nobody answered in time | [permissions](permissions.md#a-question-nobody-answers) |
| | questions the model asked with `ask_user` and went on without | [ask_user](ask-user.md#answering-later-answer) |
| mu suggests | skills drafted from a run, not installed yet | [procedures](procedures.md) |
| | a lower approval line, and commands to keep allowed in this project | [self-evolution](self-evolution.md) |
| | features the model offered in this conversation that are still off | [feature offers](feature-offers.md) |

Each line is built when you ask, from what the feature holds then: an item is gone from the list once you have dealt with it, by its own command or any other way (a message of yours settles the model's open questions, for example).

## What it does not do

- It adds no notice and no status line. The status lines for `/approve` and `/answer` stay as they were, and each suggestion is still said once when its run ends; those notices now end by naming `/waiting`.
- It is not in the desktop app as a panel. The app shows what `/waiting` says as a line in the conversation, as it does for any command's answer.
- A feature that is switched off lists nothing: with `features.evolve` off there are no suggestions to list.
