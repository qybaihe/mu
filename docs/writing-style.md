# Writing style

How mu talks in English: the README, the docs, the command line, the desktop app and the kernel's messages. The goal is
text a native-speaking engineer reads without noticing it, and a Hacker News reader trusts.

## Voice

- **Plain and direct.** Say what happens, in the order it happens. Short sentences. Active voice.
- **Peer to peer.** Write for a working engineer. No hype ("revolutionary", "supercharge", "seamless", "unleash"), no
  cheerleading, no exclamation marks.
- **Concrete over abstract.** A number, a command or a short example beats an adjective. "Cuts a 34 KB test log to
  19 KB" beats "dramatically reduces noise".
- **Honest about limits.** Say what is measured and what is not. Unmeasured claims do not ship.
- **Idiomatic, not literal.** If a sentence reads like a translation, rewrite it from the meaning, not from the words.

## Rules of thumb

- Use contractions in the app and the CLI ("don't", "isn't", "you'll"). Docs may use them too; be consistent within a
  page.
- Sentence case for every label, button, heading and menu item: "Default model", not "Default Model".
- Buttons are verbs: "Sign in", "Add provider", "Turn on". Not "OK" when a verb fits.
- Prefer common phrasal verbs: set up, turn on/off, sign in/out, look up, roll back.
- Address the reader as "you". mu is "mu" (lowercase, even at the start of a sentence), never "we" in the product.
  The docs may say "we" for the authors.
- Avoid noun stacks and "the X of the Y of the Z". Avoid cleft sentences ("What mu does is..."). Avoid starting with
  "Left to...", "Each one...", "Everything that...". Avoid "one" as a pronoun.
- One idea per sentence; one sentence per hint or tooltip where possible.
- Errors say what happened and what to do next: "Couldn't reach OpenRouter. Check your network or proxy, then try
  again." Never blame the user.
- Numbers: digits for 10 and above and for anything measured ("3 files", "0.3 s"). Units after a non-breaking space in
  prose, no space in compact UI ("340ms" is fine in a log line).
- Lists: parallel grammar. No serial (Oxford) comma unless a list would be ambiguous without it.
- American spelling: "behavior", "color", "canceled", "license" (noun and verb).
- Keep code, commands, paths, keys and identifiers in backticks in docs and as-is in the UI: `/permissions`,
  `~/.mu/agent/mu.json`, `tool.risk`.

## Words

Product terms. Use these spellings and meanings everywhere; don't invent synonyms.

| Term | Meaning | Notes |
| --- | --- | --- |
| mu | The product: the CLI and the desktop app. | Lowercase. "μ" only as the logo. |
| judge | A small, fast model that answers one bounded question. | Not "judger", "arbiter", "classifier" (a classifier is one kind of judge). |
| Jev | TypeSafe's hosted judge model, the default judge. | A name; never "the Jev". Use it only for that model; when you describe how mu works, say "the judge". |
| Laya | The local judge. | |
| decision point | A place in the agent loop where mu asks the judge. | Written as an id in code font: `tool.risk`. Not "judgment point", "hook". |
| verdict | The judge's answer at a decision point. | Not "judgment", "ruling", "result". |
| ledger | The local log of every verdict. | |
| kernel | mu's judgment layer as a whole. | "judgment kernel" on first mention. |
| active / shadow / off | A decision point's mode. | Shadow: asked and logged, changes nothing. |
| lesson | A remembered rule or correction. | Not "memory", "experience". |
| task frame | The goal, your constraints and the acceptance criteria mu keeps for a task. | |
| board | The plain-language progress board. | "the board" after first mention. |
| hive, bee | A group of read-only investigator subagents and one member. | Keep the metaphor light. |
| subagent | A helper agent the main agent starts. | One word. Not "sub-agent", "helper". |
| permission mode | Full access, Judge mode or Ask first. | |
| provider, model | Where models come from, and the model itself. | "Sign in with ChatGPT", "add an API key". |
| session, conversation | CLI: session. Desktop: conversation. | |

## Before and after

| Before | After |
| --- | --- |
| Found from the key. | Detected from the key. |
| Always TypeSafe directly. | Always connects to TypeSafe directly. |
| There is nothing to show. | Nothing here yet. |
| Line 3 is not in the right form. | Line 3 isn't valid. Expected `NAME=value`. |
| is everything wired up: judge, model, browser, sub-agents | check that the judge, model, browser and subagents are set up |
| the task as mu holds it | the current task: goal, constraints and checklist |
| /swarm stop [name] has it report now | /swarm stop [name] asks it to report now |
| Left to the big model, they cost tokens, latency and attention. | Handing these to the main model costs tokens, time and focus. |
| mu stopped in the middle of the turn. | mu stopped mid-turn. Send your message again to retry. |

## Where the strings live

See [translations.md](translations.md). In short: the desktop app's English is
`desktop/packages/desktop/src/renderer/services/i18n/locales/en-US/*.json`; the kernel's is the `en` side of
`say({ zh, en })` and of `packages/kyrn-judge/src/manifest.ts`. Changing the English does not require changing other
languages unless the meaning changed.
