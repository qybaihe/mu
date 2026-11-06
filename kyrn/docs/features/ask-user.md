# Questions for the user: `ask_user`

Some decisions are the user's to make, and the request does not settle them: which database, which of two layouts, whether to keep the old API. Before, the model's only way to ask was to end its reply with the question and stop, and turn.continue could read that as asking for a go-ahead and send it back to work. `ask_user` asks one to four questions with options to pick from while the run goes on, and gives the model the answers as the tool's result.

Code: `packages/kyrn-judge/src/extension/features/ask-user.ts`. Option: `features.askUser` (`enabled`, `waitMs`).

## What the model sends

```jsonc
{ "questions": [
  { "question": "Which database should the app use?", "header": "Database",
    "options": [
      { "label": "SQLite (Recommended)", "description": "One file, nothing to run" },
      { "label": "Postgres", "description": "A server to run, scales further" } ] },
  { "question": "Which parts should I set up now?", "multiSelect": true,
    "options": [ { "label": "Auth" }, { "label": "Billing" }, { "label": "Admin panel" } ] } ] }
```

One to four questions, two to six options each. The tool's description asks for the recommended option first, with "(Recommended)" after its label, and says the tool is not for a go-ahead on work the user asked for.

## How it asks

One question after another, with the dialogs every client has, so the terminal, the desktop app and any RPC client can answer it as they are:

- **Pick one**: a select with each option (`label — description`) and "Something else (type it)", which opens a line for the user's own words.
- **Pick any** (`multiSelect`): a line with the options numbered in its title. The user types `1,3` (any separator), or their own answer. Anything that is not only numbers of options is taken as their own words.

Before each dialog mu presents a `question.asked` frame with the question in full, and a `question.resolved` frame after it (see below). A client can show the question as a card from the frame and answer the dialog from the card. The desktop app does (`desktop/…/native/components/composer/NativeQuestion.tsx`): options with their descriptions, a line for one's own words, Skip, and, while questions nobody answered in time wait, a line above the send box whose Answer button sends `/answer`.

Each dialog waits `waitMs` (default 120 000 ms; 0 waits until answered). Esc skips that question and the ones after it.

## What the model is told

| outcome | when | the result says |
| --- | --- | --- |
| `answered` | every question has an answer | `The user answered:` and one line a question: the labels picked, or `in their own words: "…"` |
| `partly` | an answer, then Esc | the answers, the questions skipped, and not to ask those again or take skipping as permission |
| `skipped` | Esc at the first question | not to ask again, and not to take skipping as permission: carry on with what is settled and say what it assumed |
| `pending` | a dialog waited `waitMs` with no answer | the answers so far, the questions still open, and that this is pending, not a skipped answer and not permission: carry on with work that does not depend on it |
| `stopped` | the user stopped the run while asking | nothing was answered |
| `nobody` | the session has no UI | nobody can answer here: take the choice easiest to undo, say which and why |

A second `ask_user` in the same turn after a skip gets the skip back at once, with no dialog.

## Answering later: `/answer`

Questions that timed out stay open. The status bar says `mu has a question for you: type /answer` (`mu.ask.pending`). `/answer` asks the open questions again from the first one still unanswered, and sends the answers as a message of the user's:

```
[My answer to what you asked with ask_user (call call_3f9a), after you carried on]
- Database: Which database should the app use? → Postgres
```

It is steered into the run when one is going, and starts one otherwise. A dialog of `/answer` that times out leaves the questions open again.

The user's next message of their own settles whatever is still open: what they write is their answer, and the status line goes away.

## Who has it

- Not a sub-agent: it is not registered there. The parent asks.
- Not an unattended run (`mu --print`, json mode): it is in `catalog.unattendedHidden`, so it is not in the request.
- Without a UI it answers `nobody`.
- It is on the read-only lists of the permission modes, the checkpoint, the credential guard and the board: asking changes nothing on the machine.

## turn.continue

While questions are open (a `pending` result not yet answered or settled), a `go_ahead` verdict of turn.continue does not send the agent back: an agent that did what it could and ends on "Should I wire the database once you pick one?" is waiting for the answer the user has to give. A `promised` verdict still does.

## Frames

`question.asked`, before each dialog:

| field | meaning |
| --- | --- |
| `id` | `question-<n>`, one per dialog |
| `toolCallId` | the `ask_user` call |
| `index`, `count` | which question of the call, from 0, and how many |
| `question`, `header?` | as the model wrote them |
| `options` | `{ label, description? }[]` as the model wrote them |
| `multiSelect` | a pick-any question |
| `dialog` | `select` or `input`: the dialog that follows |
| `choices` | for `select`: the strings it offers, in its order, the last being "Something else (type it)" in the user's language. Answer the select with one of them; after the last, an `input` dialog follows for the user's words |

For `input`, answer with the numbers of the options picked (`1,3`), or the user's own words.

`question.resolved`, after it: `{ id, toolCallId, index, outcome, answer? }`, `outcome` being `answered`, `skipped`, `timeout` or `stopped`, and `answer` `{ question, selected: string[], custom? }`.

## The entry

A `kyrn.question` custom entry for each call, and one more when `/answer` answers it:

```jsonc
{ "toolCallId": "call_3f9a", "count": 2, "outcome": "pending", "answered": 0, "waitedMs": 120004 }
{ "toolCallId": "call_3f9a", "count": 2, "outcome": "answered", "answered": 2, "waitedMs": 301220, "late": true }
```

It never reaches the model. It says how often questions get answered, skipped or left waiting.
