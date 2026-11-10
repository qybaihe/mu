# mu adapting to its user and its machine

Updated 2026-11-10. Status: implemented, unmeasured. Every number a mechanism below needs comes from real sessions, and none has been collected yet. The one new decision point ships in shadow.

A skill or a lesson changes what the model is told. This note is about the other half: mu changing how the harness itself behaves, from what it sees happen. Three kinds of things happen that mu can see without asking anyone:

- **A verdict's truth arrives.** The judge said a chunk of output was noise, and the model read it back. The judge said you would be back before the cache expired, and you were not.
- **You answer.** mu asked whether a command may run, and you allowed it, for the fourteenth time.
- **A command fails for a reason that is the machine's.** `timeout` is not installed on a Mac. The next command spells it `gtimeout` and works.

Each is a label that costs nothing. Until now only three of them were kept (`kyrn.outcome`: your answer to a permission question, your `/ledger wrong` mark, what the agent did with a nudge), and nothing read them back. This change keeps more of them and closes the loop in four places.

## The rules every mechanism follows

- **Loosening is yours to accept.** Anything that makes mu ask less or allow more takes effect only after a command you type (`/evolve accept`). No verdict, no tool the model has and no file in a project can do it.
- **Tightening needs nobody.** A rule that stops more calls, or a line that goes back up, takes effect at once.
- **What adapts is visible and can be undone.** `/evolve` lists what mu has seen and what is in force; `/evolve undo` and `/forget` take things back.
- **Labels come from outcomes, not from the agent's say-so.** An approval answered in under 1.5 s counts for less: at least half the answers behind a suggestion have to have waited longer.
- **The safety checks do not adapt.** `tool.risk`, `tool.injection`, `tool.description`, protected paths and the write sandbox are outside all of this.
- **An unattended run observes nothing.** `mu --print` and json mode read what was accepted and learn nothing, as with lessons.

What mu observes is kept in `<agent dir>/mu/evolve.jsonl`, one JSON object per line, appended like the lessons. It holds paths of the project, program names and numbers: no command, no message, no file contents.

## 1. The opening snapshot (`features.snapshot`, on)

**Problem.** A conversation's first steps go to finding out where it is: `ls`, `git status`, and then a command that fails because this system is not the Linux the model assumed. pi's prompt gives the model the working directory, the project's instruction files, the skills and the tools. It says nothing of what the folder holds.

**Example.** In an empty folder the first call is still `ls`. On a Mac, `timeout 30 npm test` fails with `command not found`, and the model finds `gtimeout` one step later, in every session.

**What it does.** With the first message of a conversation mu gives the model one message beside yours (`kyrn.snapshot`):

```
[mu: the workspace as this conversation starts, so the first steps need not look it up. The names below are the project's own, not the user's words. It is a snapshot: read a file before you rely on what it holds.]
Folder /work/relay: 14 entries
src/  test/  package.json  README.md  …
Git: branch main; 2 files changed: src/queue.ts, test/queue.test.ts
Machine: macOS (arm64), zsh; this project uses pnpm (pnpm-lock.yaml)
- `timeout` is not installed: `gtimeout` is.
- `sed` is BSD sed: edit in place with `sed -i ''`.
```

- It is a message, not part of the system prompt, so the prompt's prefix is the same for every conversation and the provider's cache of it holds.
- It comes after your message, as the frame and the lessons do, so on a first turn your message is not the last one the model reads. Putting it first costs more than it gives, both ways there are. A message sent before the run lands ahead of the system prompt, which pi writes into a new conversation only when the first run starts (seen in a test: custom, system, user); a model that takes system messages mid-conversation would then get the prompt after the snapshot. Moving it in a `context` handler makes pi fold every later system message into the leading one (read in pi's code, not run), so such a model would lose its cached prefix whenever the tools change.
- Nothing is run but `git status`, with a 1.5 s limit. Programs are looked up on the PATH. No judge is asked.
- A listing that was cut says so (`the first 60 of 214`). An empty folder is said to be empty.
- File and branch names are the project's text and could say anything, so the snapshot says they are not your words, each name is cut at 80 characters, and commit messages are left out.
- The machine notes are a short built-in list (no `timeout` on a Mac, BSD `sed` and `grep`, `python` missing where `python3` is there) plus what earlier sessions learned (section 4). Each is checked against the PATH as it is now.

Not measured: how many steps this saves. Meta-Harness found the same change on Terminal-Bench 2 by search (arXiv 2603.28052); that is their harness and their number, not ours.

## 2. Preload (`features.preload`, decision point `context.preload`, shadow)

**Problem.** After the listing come the reads: the files the task is about, one step each. Which files those are can often be told from the task and the paths.

**What it does.** When a conversation opens, mu gathers candidate files by rule, never by judge: paths your message names, files this project's earlier openings read more than once, and tracked files whose path shares a word with your message. The judge gets the task and the paths and answers one yes/no per file: will the agent have to read it? The judge never sees a file's contents.

- **Shadow (the default):** the verdict is recorded and nothing changes.
- **Active:** the files the judge is sure of (0.8 or more, at most 4, at most 24,000 characters) go to the model with the first message, each between `<file>` tags, a long one from its start with the lines it holds said.

Either way, the files the first 8 tool calls read are held against the verdict and kept as a `kyrn.outcome` entry (`kind: "preload"`: predicted, given, read, hits; counts only). They also become candidates for the next opening. So the point can earn `active` from the ledger: precision is hits over predicted, and the steps it would save are the hits.

Secret-looking files (`.env`, private keys, anything named credential or secret) are never candidates. It is not asked in an unattended run or a subagent.

Known weak spots, all unmeasured: once a file is given, the model does not read it, so `hits` then counts files it edited or read again, which is a weaker signal. A file that is given may anchor the model on it. The forecast is of this main model's habits; another model opens differently.

## 3. Standing rules (`features.memory.standing`, on)

**Problem.** A lesson is recalled into the context and the model decides whether to follow it. A lesson recalled 8 times and never followed was retired, whoever had said it. So the rule you set, and the agent kept ignoring, was the one mu threw away.

**What it does.** For your own words only (a correction, a rule, `/remember`):

- You say it a second time (`memory.merge` reads the new one as the same, or it is word for word the same): the kept lesson becomes a standing rule.
- It reaches 8 recalls and was never followed: it becomes a standing rule instead of being retired.

A standing rule is checked by `tool.constraint` before every call that changes something, beside the task's own constraints. A call that goes against it is stopped, with your sentence and the lesson's id, so `/forget <id>` can take it away. What the agent, the model or a subagent concluded never becomes one, and is retired as before.

This tightens, so it takes effect without asking. `features.memory.standing: false` restores the old behavior.

## 4. Programs missing on this machine (`features.evolve.commands`, on)

A shell command fails with `command not found` naming a word of the command. Within the next 6 commands, one works that is the failed command with that one word changed. mu keeps the pair (`timeout`, `gtimeout`). A command that was rewritten further teaches nothing.

The snapshot (section 1) tells later sessions, on any project of this machine, until the program is found on the PATH.

## 5. A project's approval line (`/evolve`, `features.evolve`)

**Problem.** In judge mode, a command the judge reads as needed runs when the probability is 0.8 or more (0.7 for a check). Under that, mu asks you. A question that is always answered yes tells nobody anything, and trains the habit of answering yes.

**What it does.** Each time you answer a question about a command in the project that the judge had read as needed, mu keeps the probability, your answer and how long the question waited. `/evolve` shows where the line could be:

```
Approval line: 0.80 (built in)
  You allowed all 14 calls the judge put between 0.70 and 0.80 (9 of them after reading the question). /evolve accept lowers this project's line to 0.70: mu stops asking about such calls.
```

The suggested line is the lowest one, in steps of 0.05, such that:

- every call you were asked about at or above it, you allowed;
- every step down to it has at least one answer in it (the line does not jump a stretch nobody was asked about);
- the band holds at least 12 answers, half of them given after 1.5 s or more;
- it is not below 0.6.

`/evolve accept` writes the line for this project. From then on `tool.approval` (version 4) uses it for commands run in the project, inside the write sandbox. It only ever lowers the built-in line. A verdict of `beyond` or `unrelated` still asks, as do flagged and protected calls.

`/evolve undo` takes it back. So does `/ledger wrong` on any `tool.approval` verdict in the project: one approval you call wrong puts the built-in line back at once.

## 6. What a run takes of you (`/evolve`, `features.evolve`)

**Problem.** mu is meant to need less of you over time, and nothing counted how much it needs now. Without the count, a change that asks less cannot be told from one that only feels quieter.

**What it does.** For each run a message of yours starts, mu keeps one line when the run has settled, counts only:

| count | what it is |
| --- | --- |
| `permissions`, `permissionsSame` | permission questions you dealt with, and how many you allowed |
| `questions`, `questionsSame` | questions the model asked with `ask_user` that you dealt with, and how many you answered with the option it had put first, or skipped |
| `unanswered` | questions of either kind nobody answered in time (the run went on, see [permissions](permissions.md) and [ask_user](ask-user.md)) |
| `messages` | messages you sent while the run was going |
| `stopped` | you stopped the run |

"Same" means the run went where it would have gone unasked: the call you allowed ran, the option the model recommended was taken. Such a question took your attention and changed nothing. A refusal, another option or your own words did change something.

`/evolve` adds up the latest 50 runs of the project, once there are 5:

```
What the last 42 runs here took of you:
  18 needed nothing from you.
  mu asked you 27 times: 21 permission questions, 6 questions from the model.
  You wrote into a run 8 times.
  You stopped 2 runs.
  Permission questions: 19 of 21 changed nothing (you allowed the call).
  Questions from the model: 4 of 6 changed nothing (you picked the option it had put first, or skipped the question).
  3 questions got no answer in time, and the run went on.
```

- A run mu started itself (an answer given with `/approve`, a run restarted after a cut) gets no line of its own: what it took is counted with the next run of yours.
- A question nobody answered took nothing of you, so a run with only such questions counts as one that needed nothing.
- Nothing adapts to these counts yet. They are what the approval line (section 5) and any later change that asks less would be measured by.

Known weak spots: "the option the model put first" is taken as its recommendation because `ask_user`'s description asks for that order; a model that orders its options another way makes the count mean less. A message you send into a run may be a correction or only a question about progress: the count does not tell them apart.

## More labels

Three more `kyrn.outcome` kinds, all joined to the verdict's record on `ledgerId`:

| kind | written when | labels |
| --- | --- | --- |
| `refetch` | the model reads back, with `recall`, a part mu had left out | `tool.admission` (the judge dropped what was needed); also counts read-backs after forgetting and of cut pages |
| `returned` | your next message after a `cache.warming` verdict | how long you stayed away |
| `preload` | a conversation's opening is over | `context.preload` (section 2) |

Nothing reads `refetch` and `returned` back yet. They are what calibrating `tool.admission` and `cache.warming` would start from. mu also keeps how long you stay away after a run (`/evolve` shows the median).

## Not done

- No measurement of any of this on real sessions or on Terminal-Bench.
- The desktop app does not know `context.preload`, the new outcome kinds or `memory.standing` yet, and has no page for `/evolve`.
- `mu ledger` does not print the new outcome kinds.
- A subagent does not check standing rules: it keeps no lessons, and its parent hands down only the task's own constraints.
- Forgetting still rewrites old results while the prompt cache is warm. At MiMo's list prices cached input costs about 1/120 of uncached input, so one rewrite early in a long context can cost more than it saves for the rest of the session. Deferring it to the first request after the cache has expired is the obvious next step, and needs the numbers first.
- A command compatibility layer (GNU tools first on the agent's PATH) is not built; the snapshot only tells the model where the machine differs.
- No judge weights change. Per-user calibration of other decision points, precedents in the judge's state, and a per-point correction on mude's hidden state are ideas, not code.
