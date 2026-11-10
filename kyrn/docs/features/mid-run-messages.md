# Messages sent while the agent is working

A message you send while a run is going reaches the agent the way you sent it: a steer (Enter) at its next step, a follow-up (Alt+Enter in the terminal) after the run. The key says when. What the message says is usually the better guide, so mu asks the judge what the message is (`input.interjection`) and acts on the answer.

Code: `packages/kyrn-judge/src/extension/features/interjection.ts`, `packages/kyrn-judge/src/decisions/interjection.ts`. Options: `features.interjection` (`enabled`, `waitMs`, `answerStatus`).

## What the judge reads, and what mu does

| the message is | for example | what happens |
| --- | --- | --- |
| a correction | "Stop, that is the production database." | It reaches the agent at its next step, also when you queued it for after the run. |
| more work | "Also add an index on email." | It waits for the end of the run, also when you sent it as a steer. |
| a question about progress | "How far along are you?" | mu answers it. The agent isn't sent it (see below). |
| an unrelated question | "By the way, what does the deploy script do?" | It waits for the end of the run. |
| something else, or the judge isn't sure | "Hmm." | It goes as you sent it. |

The judge has `waitMs` (1.5 s by default) to answer. With no verdict in time, a judge that failed, no judge, or a run that ended meanwhile, the message goes as you sent it. Messages reach the run in the order you sent them, however long each verdict takes. A message with images, and one sent before mu knows the task's goal, goes as sent without a verdict. In shadow mode the verdict is only recorded.

## A question about progress

**Problem.** "How far along are you?" sent as a steer reaches the model at its next step. The model stops what it was doing to write a summary, and one that answers with text and no tool call ends the run there. The question costs a step of the run, sometimes the run, to say what the harness mostly knows already.

**What mu does.** It answers in a notice, from what it has, and doesn't send the message to the agent:

```
mu: the agent is still working and wasn't sent "How far along are you?". Here's where the run stands:
  6 min into this run, 14 steps so far.
  Checklist, 2 of 4 done:
    [x] The users table has the new columns
    [x] Every row is copied
    [ ] The index on email exists
    [ ] The tests pass
  Running now: bash: npm test (40 s)
  It last said: "Copying is done. Running the tests before I drop the old column."
  1 step is waiting for your permission: type /approve
To have the agent answer instead, send the same message again within a minute.
```

| line | where it comes from |
| --- | --- |
| the question | your message, cut at 80 characters: it is in the conversation nowhere else |
| time and steps | since your message started the run; a step is a tool call of the agent's |
| checklist | the task frame's acceptance list ([task frame](task-frame.md)), when it has items |
| running now | the tool calls that haven't returned; for a command, its first 60 characters |
| it last said | the agent's latest prose, cut at 200 characters |
| what waits for you | permission questions ([permissions](permissions.md)) and questions of `ask_user` ([ask_user](ask-user.md)) nobody answered in time |

None of it is a model's summary. mu makes no model call for the answer, and it can't say more than these facts. For the agent's own account, send the same message again within a minute: it goes to the agent as you sent it, and the judge isn't asked.

Asking also says you are at the keyboard: a question mu had stopped waiting on ("away", see [ask_user](ask-user.md#answering-later-answer)) is asked again from then on.

**When it applies.**

- The judge reads the message as a question about progress with a probability of at least 0.85. The other readings act from 0.7: keeping a message from the agent takes a surer reading than moving it in the queue.
- The session has someone to show a notice to. In `mu --print` and json mode the message goes as sent.
- Not in a sub-agent: its messages come from its parent, which wants the agent's own answer.
- `features.interjection.answerStatus` is on (the default). Set it to `false` and such a message goes as you sent it.

**What it costs.** No judge call beyond the one every mid-run message already had. The message isn't in the conversation: the agent never learns you asked, and the session file doesn't keep the question or mu's answer.

Not measured: how often the judge reads a message as a question about progress when it isn't one.

`/evolve` counts these questions for each run (`status`, see [self-evolution](self-evolution.md), section 7).
