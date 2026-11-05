---
name: error-handling
description: Decide what mu does when something fails, and what it tells the model and the user. Use when writing or reviewing catch blocks, fallbacks, retries, a judge or MCP or sandbox failure path, an interrupted run, or an error message a person or the model reads.
---

# When something fails

For every failure, decide three things: which way it fails (open or closed), who can make it safe to go on, and what each reader is told. Catching an exception only stops it from propagating. It does not undo what already happened.

## Open or closed

The direction follows what the code guards.

- **Advice fails open.** A feature that only helps (a hint, a note, a judgment of drift) must never block a tool or a prompt. pi treats a throw from a handler as a veto, so such handlers are wrapped in `failOpen` (`extension/runtime.ts`).
- **A gate fails closed.** "A gate that failed must not open: an error asks the user, or refuses where nobody can be asked" (`features/permissions.ts`). The write sandbox that cannot start refuses the command and says `Nothing ran.` (`features/background.ts`).
- **The judge failing is an expected outcome.** Timeouts, outages, invalid answers and abstentions all return the decision's `fallback`, and the ledger records `source: "fallback"` (`decision.ts`). Each decision chooses a fallback that is safe for what it decides: `tool.approval`'s is `unsure`, which sends the call to the user.

When you add a catch, write next to it which of these it is.

## Typed failures

- Expected failures carry a stable kind that callers branch on. `JudgeError.kind` (`errors.ts`) is `timeout`, `auth`, `payment_required`, `rate_limited` and so on, and "callers never branch on message text."
- Keep the cause (`new Error(message, { cause })`). Keep what a person reads apart from what code matches.
- A bug is not an expected failure. An exception nothing caught ends mu, because its state can no longer be trusted (`extension/rejections.ts`). Containing it must never turn it into a success.

## Effects: none, some, done or unknown

Say which one is true after the failure, and never claim more than you know.

- A call that was interrupted after it started has an unknown outcome. The `recovery` feature tells the model to check before running it again ("Running it twice may do it twice"), and says plainly when a call never started.
- A retry needs an operation that is safe to repeat, a limit, and a way to cancel. A `git push` or an MCP send is not safe to repeat blindly.
- Partial state that stays invalid needs to stay visible (a notice, a `/doctor` row, a status line), not only a log line.

## What each reader is told

- **The model** gets English, in the tool result: what failed, the effect, and the next step it can take. "mu: the write sandbox is on but cannot start here (reason). Nothing ran." is the shape: subject, cause, effect.
- **The user** gets their language: strings through `say({ zh, en })` (`language.ts`), and desktop events with a stable code and `params` beside the English (`kyrn/docs/features/presentation-codes.md`). Codes are only ever added, and an existing code never changes meaning.
- **Secrets stay out.** Error text that quotes a command, a URL or a response can carry a key. What goes to the judge or into the ledger passes through `redact.ts`. A message names the variable or the file, never its value.
- Reporting must not fail the operation. Writing a log line can fail too: `rejections.ts` ignores an `error` from a closed stderr instead of ending mu.

## Check the result, not the catch

A test of a failure path checks what the user and the model end up with: the call was blocked or the question asked, the note is in the session, the file is unchanged. A test that only shows the error was caught proves nothing about where mu is afterwards.
