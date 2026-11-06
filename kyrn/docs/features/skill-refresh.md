# Skills installed mid-session, and reads of a skill as labels

The code is in `packages/kyrn-judge/src/extension/features/skills.ts` (when it runs, the label) and `src/extension/features/skill-refresh.ts` (which folders are read, what counts as a change, the message). Tests: `packages/kyrn-judge/test/skill-refresh.test.ts`.

## The problem

pi loads skills twice in a session at most: when it starts, and on `/reload`. The system prompt lists what it loaded then. A skill installed later is not in that list: one `/skills accept` installs from a draft (`procedures.md`), one the user copies into `~/.mu/agent/skills/`, one the agent writes itself. Until the next session the model does not know it is there, so a draft accepted to help with this very task could not help with it. A skill deleted mid-session stays in the list, and the model may read a file that is gone.

Rewriting the system prompt each time would put the skill in the list, but it changes the prompt's prefix, and the cache of every request after it starts over.

## What mu does

With each message of the user, the skills feature reads again the folders pi finds skills in without being told:

- `<agent dir>/skills` (where `/skills accept` installs) and `~/.agents/skills`;
- in a trusted project only, the project's `.pi/skills` (where `/skills accept --project` installs) and the `.agents/skills` folders from the working directory up to the repository's root. pi does not load an untrusted project's skills, and neither does this.

What changed is told to the model in one `kyrn.skills-changed` message, after the user's message. The system prompt is not touched:

```
Skills installed during this session, which the system prompt does not list:
- release-to-npm: Cut a patch release of this package and publish it to npm. (read /Users/me/.mu/agent/skills/release-to-npm/SKILL.md to use it)

Skills removed during this session: their files are gone, so do not use them: calendar (/Users/me/.mu/agent/skills/calendar/SKILL.md).
```

- **Added** means a skill file that was not on disk when pi loaded the list. A file that was there and pi left out (switched off in the settings, or another skill had its name) stays out.
- **Removed** means a skill the model knows of, from the prompt or from an earlier message, whose file is gone. Any skill counts, also one a package or a setting added.
- Each change is told once. A skill put back after it was removed is told again.
- Past ten new skills at once, the rest are named only. `find_skill` lists them, and a later skill-disclosure verdict can announce them like any hidden skill.
- After `/reload` the list pi loads is taken as it is: what it now holds is in the prompt, and nothing of it is told again.
- A skill only a person can call (`disable-model-invocation`) is never told: the model doesn't see it in the prompt either.
- Not in a sub-agent, whose list is loaded when it starts.

`/skills accept` says so: "The agent hears of it with your next message; it is listed in the system prompt from the next session (or after /reload)." With `features.skills.refresh: false`, or for `--project` in an untrusted project, it says what it said before: from the next session.

A skill is not watched while a run is going. The folders are read once per message of the user, which costs a few directory listings.

## The label

When the model `read`s a skill's file, the session gets a `kyrn.skill-read` entry (`pi.appendEntry`: kept in the file, never sent to the model). The file can be any skill the model knows of: in the prompt's list, hidden from it, or told of mid-session. One entry per skill per user turn.

```jsonc
{ "type": "custom", "customType": "kyrn.skill-read", "data": {
  "name": "calendar", "path": "/Users/me/.mu/agent/skills/calendar/SKILL.md", "turn": 1,
  "listed": "hidden", "verdict": "6f1c…", "hid": true } }
```

| field | meaning |
| --- | --- |
| `listed` | How mu had shown the model the skill: `prompt` (in the system prompt's list), `hidden` (the first verdict kept it out, and mu never showed it again), `found` (hidden, then listed by `find_skill`), `announced` (hidden, then announced by a later verdict), `added` (installed during the session and told then). |
| `verdict` | The ledger id of the session's first `skills.disclosure` verdict, when the judge answered it and the skill was one it was asked about. In shadow mode too: there it is the verdict that would have chosen the list. |
| `hid` | Whether that verdict said to leave the skill out. |
| `announcedBy` | The ledger id of the later verdict that announced it. |

A skill the judge kept out (`hid: true`) and the model read anyway is a miss of the disclosure decision. A skill it kept in and the model read is a hit. These labels come from real work, and nobody has to mark anything: the ledger records what the judge said, and this records what the model did. A read is not proof that the skill was needed, since the model may read it and find that it doesn't help.
