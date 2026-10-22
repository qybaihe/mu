# Permission modes

How much mu may do without asking. There are three modes, and you can switch between them at any time with `/permissions`.

| mode | id | what runs without asking | what asks |
| --- | --- | --- | --- |
| 完全访问 / Full access | `full` | everything | nothing |
| 判定模式 / Judge mode | `judge` | reading; editing files inside the project; whatever the judge is sure the task needs | whatever the judge is not sure of, thinks goes beyond the request, or thinks is unrelated |
| 最小权限 / Minimal permissions | `ask` | reading only | every edit, command, outside action and sub-agent |

Some things hold in every mode:

- **Hard constraints still apply.** What you said not to do is stopped by the constraint gate, even in full access. That gate is about your words, not about permission.
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
    - only judges not trusted with approvals, such as a local judge alone. Their answer is the neutral one, marked `untrusted`.
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
- `/permissions reset`: forget what was allowed for this conversation.

## Presentation events (for the desktop)

| kind | payload | when |
| --- | --- | --- |
| `permissions.mode` | `{ mode, label, conversationSwitch: true, modes: [{ id, label, description }] }` | at session start and on every switch. `conversationSwitch` says `--here` is understood; an older harness would read `judge --here` as an unknown word |
| `permissions.request` | `{ id, toolCallId, mode, tool, kind, summary, reason, flag?, grant?: { key, label }, answers: string[] }` | right before the picker opens |
| `permissions.resolved` | `{ id, toolCallId, answer: "once" \| "session" \| "deny" }` | once the picker is answered |
| `permissions.approved` | `{ toolCallId, tool, kind, summary, by: "judge" \| "grant" }` | a call that needed permission ran without asking you |

- `toolCallId` is the id of the tool call the event is about: the same id as in pi's tool events and in that call's tool result. A client marks that call's own row with it, also when the judge or a conversation grant let the call run. What the model is told about a refused call stays in English in the tool result.
- `kind` is one of `edit`, `shell`, `run`, `outside`, `delegate` or `other`.
- `reason` is one of `ask` (minimal mode), `unsure`, `beyond`, `unrelated`, `flagged`, `protected`, `nojudge` (no judge will answer the next step either) or `judgedown` (the judge did not answer this time). A flagged command keeps `flagged` whatever the judge did.
- `answers` holds the exact option strings the picker offers, in order. The picker is the normal extension `select` dialog (over RPC, `extension_ui_request` with `method: "select"`), so the desktop answers it with the chosen string.
- To switch modes, send `/permissions <id>` as a typed command when the person picked the mode, and `/permissions <id> --here` when the app does it by itself (and `conversationSwitch` is there).
