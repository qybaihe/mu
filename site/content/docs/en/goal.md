---
title: Goal mode and finishing
summary: The task frame, /goal and the checks that keep a run from stopping early, drifting or going in circles.
---

## The task frame {#frame}

The task frame holds the goal, your hard constraints in your own words with where you said them, the current subgoal and the acceptance items. The acceptance items are also the to-do list the model ticks off.

Every message you send is judged once (`task.frame`): a new task, a new hard constraint, a correction, a new subgoal or no change. Only a change has a model rewrite the frame, so a plain *thanks* costs nothing. `/frame` shows the current frame. It follows the conversation tree: after a fork or a rewind, the frame of that branch comes back.

## Goal mode {#goal}

```text
/goal all tests in packages/api pass and the README documents the new flag
```

The agent starts at once and keeps working until the condition holds. `/goal` alone shows the goal, its state, the last check's reason and the next step, or asks for a condition when there is none. `/goal clear` ends it. In the app, set a goal from the send box; the goal line shows its state.

Each time the agent wants to stop, a model reads the evidence and decides: **met**, **continue** with a concrete next step, or **needs you**. The evidence is the goal; the acceptance items still open; files edited and not checked since; the last test, build or lint run and its result; what the run did; and the closing message. Facts win over words: an open acceptance item or an unverified edit always means *not yet*, whatever the closing message says. The judge (`goal.met`) answers only when the checking model gives no answer.

It stops by itself, and tells you why, when:

| Reason | Default |
| --- | --- |
| It needs you (a choice only you can make) | |
| You press <kbd>Esc</kbd>, or a model call fails | |
| Runs in a row end without a single tool call | 2 |
| Runs judged to make no progress | 2 (the first time, it is told to change course) |
| Continuations since your last message | 20 |
| Minutes since your last message | 180 |

After a pause, your next message picks the goal up again. A reopened session brings a running goal back paused, never running.

## The checks at the end of every turn {#checks}

Without a goal, each turn still gets these:

- **Completion check** (`turn.completion`). When the model says it is done, mu asks whether anything verified that. If not, one nudge to check, for example to run the tests.
- **Stopped short** (`turn.continue`). A run that ends on *next, I'll run the tests* without doing it, or asks for a go-ahead on work you already asked for, is sent back to it, at most twice per message. mu never nudges it toward a step that's hard to undo or reaches beyond this machine, such as a push, a publish, a delete or a payment.

## Drift and dead ends {#drift}

- **Drift monitor** (`turn.drift`). Every six tool calls, mu checks that the work still serves the goal. Rules catch the other failure, going in circles: the same call three times within the last eight.
- **Judged rewind** (`turn.rewind`). When the agent goes in circles, or one command keeps failing, the judge asks whether the approach is a dead end. Only a confident dead end with no progress proposes going back to the turn's checkpoint, with a note of what was tried and why it was dropped. The proposal waits two minutes for you; unanswered, the run carries on. It never rewinds by itself.

## Rewinding by hand {#rewind}

`/checkpoints` lists the snapshots of the current branch, newest first: number, turn, time, how many files changed since. `/rewind` goes back to the latest, `/rewind 3` to number 3; it first shows which files would be put back, deleted or restored, then asks whether to take back the files, the conversation or both. `/rewind undo` takes a rewind back.
