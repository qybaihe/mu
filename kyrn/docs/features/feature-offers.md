# Offers of features that are off

Some of mu's features are off by default, and someone who has never opened the settings does not know they are there. When a task would use one, the model can offer it, and the user turns it on with one answer.

Code: `packages/kyrn-judge/src/extension/features/feature-offers.ts`. Option: `features.featureOffers` (`enabled`).

## Which features

The features that are off by default and do something once they are turned on:

| id | feature |
| --- | --- |
| `feature:compaction` | Summary-free compaction |
| `feature:ttsr` | Mid-stream correction |
| `feature:confine` | Write sandbox: only on macOS, or on Linux with `bwrap` on the PATH. Windows has no write floor |

The Nebius sandbox is not offered: it needs an account and a key, which no answer to a question sets up. A feature that is already on (in mu.json, or by the user's options) is not offered either.

## How it is offered

Each feature is a `feature:<name>` entry of the capability catalog, with its summary and "Off now: opening it asks the user whether to turn it on, from the next conversation." `find_capability` lists it with the other hidden capabilities, and its description names it among what is installed.

`find_capability({ open: "feature:ttsr" })` does not open anything in the session. mu asks the user with ask_user's dialog, `askQuestions`, so the desktop app shows the question card: "Turn on Mid-stream correction?", with "Turn it on" (and the feature's summary) or "Not now". The question waits 2 minutes.

What the model is told:

| answer | the result says |
| --- | --- |
| Turn it on | `The user turned on Mid-stream correction (features.ttsr in /Users/me/.mu/agent/mu.json). It takes effect from the next conversation; this one goes on without it. Turning it on allows nothing beyond that feature.` |
| Not now, Esc, or their own words | that the user declined it, so it stays off, their words if any, and not to offer it again in this conversation |
| no answer in time | it stays off; carry on without it, and do not ask again unless they bring it up |
| a second offer after a decline | at once, with no question: declined earlier in this conversation, do not offer it again |

Features are set up when a session starts, so a feature turned on now works from the next conversation.

## Who decides

Only the user:

- The capability judge (`capability.disclosure`) never sees a feature entry. Its candidates leave them out, so it cannot open one, and a session where only features are hidden asks it nothing.
- Where nobody can be asked (no UI, or an unattended run), nothing is written, and the model is told that only the user can turn it on.
- A sub-agent has no offers.
- `/capabilities open feature:<name>` is the user asking for it. It turns the feature on with no question. `/capabilities` lists feature entries as `off`, or `on next conv.` once turned on.

## What is written

mu writes the file `loadConfig` reads, in the agent directory (`~/.mu/agent`). That is the first of `mu.json` and `kyrn.json` that exists, or a new `mu.json` when neither does. Writing a new mu.json beside an existing kyrn.json would make loadConfig read only the new file, and every other setting would be lost.

- The raw JSON is read and written back with one change: `features.<name>` becomes `true`, or gets `enabled: true` when it holds the feature's options. The rest stays as it is.
- A copy of the file goes to `~/.mu/backups/<time>/` first.
- A file that is not plain JSON (comments, a typo) is not touched. The model is told that the feature stays off and how to turn it on by hand.

## The entry

A `kyrn.feature-offer` entry for each answer, kept in the session and never sent to the model:

```jsonc
{ "feature": "ttsr", "answer": "on", "by": "model" }
{ "feature": "compaction", "answer": "declined", "by": "model" }
{ "feature": "compaction", "answer": "on", "by": "user" }
```

`answer` is `on`, `declined` or `unanswered`. `by` is `model` for an offer and `user` for `/capabilities open`. When the session opens again, `on` and `declined` are read back, so a declined feature is still not offered.
