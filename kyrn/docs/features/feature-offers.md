# Offers to turn features on

Some of mu's features are off by default, and someone who has never opened the settings does not know they are there. When a task would use one, the model can offer it. The offer does not hold up the run: mu tells the user of the feature when the run ends, and they turn it on with one command.

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

Each feature is a `feature:<name>` entry of the capability catalog, with its summary and "Off now, and only the user turns it on, from the next conversation: opening it tells them of it when this run ends." `find_capability` lists it with the other hidden capabilities, and its description names it among what is installed.

`find_capability({ open: "feature:ttsr" })` does not open anything in the session, and asks nobody. Features are set up when a session starts, so no answer could change the run that is going: a question in the middle of it would hold the work up for an answer that matters only to the next conversation.

The call returns at once:

> Mid-stream correction is off, and turning it on takes effect only from the next conversation, so nothing changes in this run. mu tells the user of it when this run ends, and they decide. Carry on without it, and do not offer it again.

When the run has settled (`agent_settled`: no check sends the agent back any more), mu says one notice for each feature offered in it, under the answer the user reads when they come back:

```text
mu: the model suggests Mid-stream correction for work like this. It's off now. The judge, not a regular expression, notices when output goes astray, …
/capabilities open feature:ttsr turns it on, from the next session. Leave it and it stays off; mu won't bring it up again in this session.
```

A notice takes no answer and no key press: it does not take the editor, so a message the user is typing is not interrupted. The desktop app shows it as a line in the conversation.

What the model is told:

| case | the result says |
| --- | --- |
| the first offer of a feature | it is off, takes effect only from the next conversation, the user is told when the run ends; carry on without it, and do not offer it again |
| a second offer in the conversation | at once: already offered, still off, do not offer it again |
| the user turned it on meanwhile | that it is already turned on for the next conversation |
| nobody to tell (no UI, an unattended run) | it is off, only the user can turn it on, nobody can be told of it in this session |

Features are set up when a session starts, so a feature turned on now works from the next conversation.

## Who decides

Only the user:

- The capability judge (`capability.disclosure`) never sees a feature entry. Its candidates leave them out, so it cannot open one, and a session where only features are hidden asks it nothing.
- Where nobody can be told (no UI, or an unattended run), nothing is said or written, and the model is told that only the user can turn it on.
- A sub-agent has no offers.
- `/capabilities open feature:<name>` is the user asking for it. It turns the feature on with no question. `/capabilities` lists feature entries as `off`, or `on next conv.` once turned on. A feature the user turns on this way while the run is still going gets no notice at its end.

## What is written

mu writes the file `loadConfig` reads, in the agent directory (`~/.mu/agent`). That is the first of `mu.json` and `kyrn.json` that exists, or a new `mu.json` when neither does. Writing a new mu.json beside an existing kyrn.json would make loadConfig read only the new file, and every other setting would be lost.

- The raw JSON is read and written back with one change: `features.<name>` becomes `true`, or gets `enabled: true` when it holds the feature's options. The rest stays as it is.
- A copy of the file goes to `~/.mu/backups/<time>/` first.
- A file that is not plain JSON (comments, a typo) is not touched. The model is told that the feature stays off and how to turn it on by hand.

## The entry

A `kyrn.feature-offer` entry, kept in the session and never sent to the model:

```jsonc
{ "feature": "ttsr", "answer": "offered", "by": "model" }
{ "feature": "compaction", "answer": "on", "by": "user" }
```

`answer` is `offered` (the user was told of it when a run ended, and it stays off) or `on` (they turned it on, which `/capabilities open` does: `by` is `user`). When the session opens again both are read back, so a feature is offered once in a conversation.
