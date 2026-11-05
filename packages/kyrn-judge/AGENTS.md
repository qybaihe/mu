# The judgment kernel (`packages/kyrn-judge`)

Rules for working in this package. The repository's root `AGENTS.md` still applies; it comes from pi and says nothing about mu. This package is mu's own code, not pi's: changing it needs no entry in `kyrn/docs/fork-ledger.md`. A change to pi's directories (`packages/ai`, `packages/agent`, `packages/coding-agent`, and the rest of what upstream has) does need one, or the CI job "Fork ledger" fails (`node scripts/fork-ledger.mjs`).

## Where things are

- `src/decisions/`: one file per decision point, built with `defineDecision` (`src/decision.ts`): the questions, `buildState`, `policy`, `fallback` and `version`.
- `src/extension/features/`: the features that ask the decisions and act on them. They are registered in the table in `src/extension/kyrn-judge.ts`. The order there matters where two features handle the same event, and a comment says why at each place it does.
- `src/extension/runtime.ts`: `KyrnRuntime`, the state features share. When a feature sets a field there for others, its comment says which feature sets it and which read it.
- `src/manifest.ts`: every decision point and feature with its options, in Chinese and English, for the settings pages. Other languages are in `i18n/manifest.json`.
- `kyrn/docs/04-injection-points.md`: the map of where the judge is wired into pi. `docs/adding-a-decision-point.md`: the full checklist for a new decision point, the desktop app included.

## Rules

- **A kernel error never breaks the agent.** Wrap every handler in `failOpen` (`src/extension/runtime.ts`). Bound every wait on the judge with `within`, so a slow judge gives the fallback instead of a stall.
- **Doing nothing is safe.** When no judge answers, the decision's `fallback` leaves mu as it would be without the point. A verdict acts only in active mode: in shadow mode it is recorded and changes nothing. New decision points ship in shadow.
- **What the judge saw is what runs.** Register every `tool_call` handler with `{ final: true }`: a final handler gets the input frozen, after every other handler has changed it, and can only block. `test/permissions.test.ts` fails on a `tool_call` handler that is not final.
- **A decision's request and its policy are versioned.** When the state, the questions or the policy of a decision change, bump its `version`, so ledger records stay comparable. `test/golden/decision-requests.md` (what each decision asks) and `test/golden/decision-policies.md` (what it does with the answers) fail until it is bumped, even with `-u`. A new decision needs a fixed input in `test/golden/decision-inputs.ts`: the golden test fails for a decision point without one.
- **What the main model is given is reviewed as a diff.** The system prompt and every tool's name, description and parameters are in `test/golden/model-surface.md`. A change there is a change to what the model reads: say why in the pull request.
- **A session's custom entries and messages are registered.** A new type written with `appendEntry` or as a `customType` goes in `src/entries.ts`, with the files that write it and who reads it; `test/entries.test.ts` fails on one that is not there. One that another program reads (the desktop app, `mu ledger`) has a schema there, and its `version` goes up when the schema changes: `test/golden/entries.md` fails until it does, even with `-u`.
- **Secrets stay out of the judge and the ledger.** The engine redacts known secrets from the state before a judge sees it (`src/decision.ts`, `src/redact.ts`). Do not send state to a judge any other way. The ledger keeps no state unless the user turns `recordState` on, and `kyrn.outcome` records keep no state or call text.
- **What a program printed is data.** A tool result that carries a program's or a page's output puts mu's own lines first, then the untrusted marker, then that output (see `background.ts`, `packs/debugger.ts`, `web.ts`).
- **What the agent runs gets none of mu's credentials.** Start the agent's programs with `withoutCredentials(process.env)` (from `@earendil-works/pi-coding-agent`). With the write sandbox on (`features.confine`), start them through `runtime.floor` as `bash`, `bg_start` and `debug_start` do, and refuse to run when the floor cannot start.

## After a change

- **Settings text** changed in `src/manifest.ts`: run `node packages/kyrn-judge/scripts/write-manifest.ts`, then `node scripts/write-docs-reference.mjs` from the repository root. `docs/reference/` is generated: never edit it by hand. `test/manifest.test.ts` fails when a decision or an option is missing.
- **Goldens:** `npx vitest --run test/golden -u` from this package, after the versions are bumped. Read the diff before committing it.
- **Tests** go through pi's harness (`../coding-agent/test/suite/harness.ts`) with `MockJudgeProvider`, never a network judge or a paid key. Run one file with `npx vitest --run test/<name>.test.ts` from this package, the whole package with `npx vitest --run`. Tests that need a real sandbox, debugger or browser skip themselves where there is none: CI's Linux runner skips the Seatbelt and bubblewrap ones, so run those on macOS before saying a sandbox change works.
- **Then** `npm run check` from the repository root.

## Text

- English the user or the model reads follows `docs/writing-style.md`: plain, concrete, honest about what is not measured.
- Commits and pull requests that touch `desktop/` carry no AI signature (`desktop/AGENTS.md`).
