# Permission modes

How much mu may do without asking. There are three modes, and you can switch between them at any time with `/permissions`.

| mode | id | what runs without asking | what asks |
| --- | --- | --- | --- |
| 完全访问 / Full access | `full` | everything | nothing |
| 判定模式 / Judge mode | `judge` | reading; editing files inside the project; whatever the judge is sure the task needs | whatever the judge is not sure of, thinks goes beyond the request, or thinks is unrelated |
| 最小权限 / Minimal permissions | `ask` | reading only | every edit, command, outside action and sub-agent |

Some things hold in every mode:

- **Hard constraints still apply.** What you said not to do is stopped by the constraint gate, even in full access. That gate is about your words, not about permission.
- **A call that would carry a credential away asks, every time** (judge and minimal permissions). A call carries one when its input holds the value of one of mu's credential variables (the model providers' and the judge's keys, those from mu's `.env`), written out or URL-encoded, or a value only a secret looks like (`sk-…`, `ghp_…`, a private key block). This covers reading tools too: a `web_fetch` with a key in its address asks. No judge is asked, the question shows the call with the credential taken out, and there is no "for this session" answer. Naming a variable (`curl -H "Authorization: Bearer $GH_TOKEN"`) carries nothing, and tools that only work on files here (`write`, `edit`) are not checked. The agent's commands do not get these variables at all (see `MU_PASS_ENV` in [configuration](../../../docs/configuration.md)).
- **Reading is never asked about.** This covers `read`, `grep`, `find`, `ls`, `todo`, `web_search`, `web_fetch`, background output, `sg_search`, the debugger's inspect/step/stop, and shell commands made only of read-only programs (`git status`, `cat … | grep … | head`), also joined by `;`, `&&`, `||` or line breaks (`pwd && find . -name '*.ts' | sort | head`, `git status --short; git log --oneline -5`). They may throw output away (`2>/dev/null`, `&>/dev/null`) or join outputs (`2>&1`). A redirect that writes a file, `sed -i`, `tee`, `find` with `-exec`, `-delete` or `-fprint`, a substitution, a subshell, or `cd` followed by `git` (a repository found elsewhere may carry a config that runs programs) makes the whole command one that asks. `features.permissions.readOnlyChains: false` goes back to single commands and pipelines only.
- **Unlisted tools are asked about.** A tool mu does not know (an MCP tool, for example) needs permission. A command counts as read-only only when every part of it is on the short read-only list.
- **mu's own settings are always yours to decide.** Any call that touches the agent folder (`~/.mu/agent`, spelled as a path, with `~` or with `$HOME`) is asked every time. The judge cannot approve it, and "allow for this conversation" is not offered.

## What the judge is asked

Judge mode puts one choice question, `tool.approval`, to the judge model: what is `tool_call` for `task` and `user_message`? The answer is `needed`, `beyond`, `unrelated` or `unclear`.

- Only `needed` at probability 0.8 or higher runs without you.
- Anything else asks you, and the prompt says why ("The judge thinks this goes beyond what you asked for").
- If there is no verdict at all, you are asked, and the prompt says why:
  - `nojudge`: no judge will answer the next step either. "No judge is available yet, so mu asks about each step." / "还没有可用的判定器，所以每一步都先问你。" This covers four cases:
    - no usable key (`error:auth`);
    - no credit on the judge's account (`error:payment_required`);
    - no judge that could be built at all, which also fails as `error:auth`;
    - only judges not trusted with approvals (a judge whose `profile` says so; mude 1.0 is trusted with them). Their answer is the neutral one, marked `untrusted`.
  - `judgedown`: the judge failed this time. "The judge did not answer this time, so mu asks you." / "判定器这次没有回答，所以先问你。" This covers any other `error:*` (down, too slow, a broken answer), and an answer marked `unavailable`, where the tier that should have answered failed while another answered.
  - When several judges are configured and every one fails, the failure that may pass is reported over one that lasts, whatever their order. So a local judge that is down, plus a hosted judge without a key, gives `judgedown`.
  - When the decision's mode is `off`, the judge is never asked, and the prompt still says `unsure`, as before.

  Before 2026-09-25 (macOS QA), a judge that never answered was reported as the judge being unsure of the step.

The judge's verdict counts even when the decision's own mode is `shadow`, because choosing Judge mode is the opt-in.

Commands that the risk rules flag work differently: a recursive `rm` (`rm -f file` alone is not flagged), force push, `sudo`, running a downloaded script (piped into a shell or an interpreter, or saved and then run; `curl … | python3 -c '…'` reads the download as data and is not flagged) and the rest of the guard's rules. In Judge mode they use the guard's `tool.risk` question and run only when the judge is sure you asked for them. In minimal mode the flag is shown in the question. A flagged command can only be allowed once, never for the whole conversation.

With permission modes on (the default), they take over the old guard. With `features.permissions: false` in mu.json, the guard works on its own as before.

## Asking

A call that needs you shows one picker with fixed answers:

- `Allow once` / 允许这一次
- `Allow for this conversation（<scope>）` / 这次对话都允许（<scope>）. This is offered only when the call has a safe scope.
- `Don't allow` / 不允许

While the picker waits, the status line `mu.permissions.pending` says "Waiting for your permission: <summary>" / "等你授权：<summary>". It is cleared once you answer. The mode itself is always shown in the status line `mu.permissions` ("Permissions: Judge mode" / "权限：判定模式").

"For this conversation" covers:

| call | scope |
| --- | --- |
| edits inside the project | all of them |
| a command | its program, plus the sub-command for `git`/`npm`/`pnpm`/`yarn`/`cargo`/`docker`/… (`npm test`, `git commit`) |
| a command with chaining, redirection or substitution, or starting with `VAR=`, `sudo`, `env`, `bash -c`, … | nothing: once only |
| an edit outside the project | that file |
| another tool | that tool |

Allowances are forgotten when you switch mode or run `/permissions reset`.

Esc while the picker is open counts as "Don't allow". A refusal reaches the model as: "The user did not allow this (…). Do not try another way around it: ask them, or carry on without it."

### A question nobody answers

A question does not hold the run for long. The picker waits `features.permissions.waitMs` (default 120 000 ms; 0 waits until answered). When nobody answers in that time:

- The call does not run. The model is told: "The user has not answered yet whether to allow this (…). This is pending: not permission, and not a refusal. Do not try another way around it. Carry on with work that does not depend on it, and say at the end what still waits for them."
- The question waits. A status line of its own, `mu.approve.pending`, says "1 step is waiting for your permission: type /approve" / "1 步在等你授权：输入 /approve". It has a text while questions wait, as `mu.ask.pending` has for ask_user's: a client can draw a button that sends `/approve` from it. `mu.permissions.pending` is only the open picker's line.
- Nobody was there, so the questions that follow in the same run are not waited for either: each waits with the first at once. The same call made again gets the same answer, with no second question. This lasts until the user writes a message or answers a question. The same holds across the two kinds of question: one the model asked with `ask_user` that nobody answered sets the next permission question aside at once, and a permission question nobody answered makes the model's next question pending at once ([ask_user](ask-user.md#answering-later-answer)).

`/approve` asks the waiting questions again, oldest first, with the same picker and the same answers. Then mu tells the model what was picked, in a `kyrn.approval` message of its own (not as the user's words, so nothing reads it as a new task or a rule):

```
[mu: the user answered about the steps that were waiting for their permission]
- Allowed: npm install left-pad. If you still need it, make that same call again; the permission holds for exactly that call, once.
- Not allowed: git push origin main. Do not try another way around it.
```

- An allowed call runs when the model makes it again with the same tool and the same input, once. A call that differs in any way asks again.
- With an allowed call, the message is steered into a run that is going, or starts one. A refusal alone starts nothing: the model reads it when the next run starts.
- A question `/approve` asks that nobody answers in time waits on.

A new message from the user ends the waiting: the questions of the run before it are dropped, and a call that needs permission asks with the picker again, since the user is there. Switching mode drops them too, with what was allowed.

While questions wait, a `go_ahead` verdict of turn.continue does not send the agent back: an agent that ends on "Should I install it once you allow it?" is waiting for an answer only the user can give.

When nobody can be asked (print mode, a sub-agent), a call that would ask is refused, and the reason tells the model to report what it needed.

## Where the mode comes from

When a conversation starts:

1. If the conversation was switched before, it keeps that mode (from a `mu.permissions` session entry), including when it is reopened.
2. Otherwise `MU_PERMISSIONS` (or `KYRN_PERMISSIONS`) applies. Sub-agents get their parent's current mode this way.
3. Otherwise the mode last chosen with `/permissions` applies, read from `<agentDir>/mu/permissions.json` (`{"version":1,"mode":"ask"}`, mode 600).
4. Otherwise `features.permissions.mode` in mu.json applies, which defaults to `judge`.

`/permissions <mode>` switches this conversation, writes the session entry, saves the new default for later conversations, and forgets allowances. Other running conversations keep their own mode.

`/permissions <mode> --here` switches this conversation only: the session entry, the status line and `permissions.mode` as above, but the saved default stays as it was and nothing is notified. When the conversation is already in that mode, nothing changes and allowances stay; only `permissions.mode` is sent again. This is for the app putting a conversation back in the mode it had there (on load, fork or a new conversation seeded from the last pick): only a switch the person made should change the default for the terminal and for new conversations. Keep the order above: session entry, then `MU_PERMISSIONS`, then `permissions.json`.

**`permissions.json` is a contract with the desktop app.** The app's settings page writes it (2026-09-22, KYRN-desktop `4e26995`), and `PermissionDefaults` reads it back:

- The format is `{"version": 1, "mode": "full" | "judge" | "ask"}`, mode 600.
- mu reads only these three ids. Aliases such as `yolo` are for typing, not for the file.
- Any other version, a missing file or a broken file counts as "not set".
- mu writes the file only when the person switches with `/permissions <mode>` (never with `--here`), and it writes the whole file.

Tell the desktop session before changing the version, the location or the accepted values.

## Commands

- `/permissions`: a picker of the three modes with descriptions. Without a UI, it prints the current mode.
- `/permissions full | judge | ask`: switch. `yolo`, `auto`, `minimal`, `read-only`, `完全访问`, `审批`, `判定模式` and `最小权限` also work.
- `/permissions full | judge | ask --here`: switch this conversation only (above).
- `/permissions reset`: forget what was allowed for this conversation. A command accepted for the project with `/evolve accept <command>` stays: `/evolve undo <id>` takes that back ([self-evolution](self-evolution.md), section 6).
- `/approve`: answer the permission questions nobody answered in time (above).

## Presentation events (for the desktop)

| kind | payload | when |
| --- | --- | --- |
| `permissions.mode` | `{ mode, label, conversationSwitch: true, modes: [{ id, label, description }] }` | at session start and on every switch. `conversationSwitch` says `--here` is understood; an older harness would read `judge --here` as an unknown word |
| `permissions.request` | `{ id, toolCallId, mode, tool, kind, summary, reason, flag?, grant?: { key, label }, answers: string[] }` | right before the picker opens |
| `permissions.resolved` | `{ id, toolCallId, answer: "once" \| "session" \| "deny" \| "pending" }` | once the picker is answered, or its wait is over (`pending`: nobody answered, the call did not run and waits for `/approve`) |
| `permissions.approved` | `{ toolCallId, tool, kind, summary, by: "judge" \| "grant" \| "project" \| "user" }` | a call that needed permission ran without asking you now (`grant`: allowed for this conversation; `project`: a command you accepted for this project with `/evolve accept`; `user`: you allowed this same call with `/approve`) |

- `toolCallId` is the id of the tool call the event is about: the same id as in pi's tool events and in that call's tool result. A client marks that call's own row with it, also when the judge or a conversation grant let the call run. What the model is told about a refused call stays in English in the tool result.
- `kind` is one of `edit`, `shell`, `run`, `outside`, `delegate` or `other`.
- `reason` is one of `ask` (minimal mode), `unsure`, `beyond`, `unrelated`, `flagged`, `protected`, `nojudge` (no judge will answer the next step either) or `judgedown` (the judge did not answer this time). A flagged command keeps `flagged` whatever the judge did.
- A question answered with `/approve` gets a second `permissions.request` and `permissions.resolved` pair with the `id` and the `toolCallId` it had the first time. A question set aside at once, because nobody answered the one before it, gets its `permissions.request` and a `pending` `permissions.resolved` with no dialog between them.
- `answers` holds the exact option strings the picker offers, in order. The picker is the normal extension `select` dialog (over RPC, `extension_ui_request` with `method: "select"`), so the desktop answers it with the chosen string.
- To switch modes, send `/permissions <id>` as a typed command when the person picked the mode, and `/permissions <id> --here` when the app does it by itself (and `conversationSwitch` is there).
