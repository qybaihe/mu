# Skills installed mid-session

The code is in `packages/kyrn-judge/src/extension/features/skills.ts` (when it runs) and `src/extension/features/skill-refresh.ts` (which folders are read, what counts as a change, the message). Tests: `packages/kyrn-judge/test/skill-refresh.test.ts`.

## The problem

pi loads skills twice in a session at most: when it starts, and on `/reload`. The system prompt lists what it loaded then. A skill installed later is not in that list: one `/skills accept` installs from a draft (`procedures.md`), one the user copies into `~/.mu/agent/skills/`, one the agent writes itself. Until the next session the model does not know it is there, so a draft accepted to help with this very task could not help with it. A skill deleted mid-session stays in the list, and the model may read a file that is gone.

Rewriting the system prompt each time would put the skill in the list, but it changes the prompt's prefix, and the cache of every request after it starts over.

## What mu does

With each message of the user, the skills feature reads again the folders pi finds skills in without being told:

- `<agent dir>/skills` (where `/skills accept` installs) and `~/.agents/skills`;
- in a trusted project only, the project's `.mu/skills` (where `/skills accept --project` installs) and the `.agents/skills` folders from the working directory up to the repository's root. pi does not load an untrusted project's skills, and neither does this.

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
