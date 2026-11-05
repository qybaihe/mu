---
name: trim-reasoning-leakage
description: Find and fix comments, JSDoc and docs that read like the session that wrote them, not like the code as it is. Use when reviewing or cleaning prose an agent wrote, before a PR that adds many comments or docs, and when a comment cites a plan item, a PR's vantage, a review, or what the code used to do.
---

# Prose that stands at HEAD

Most of mu is written by agents, and their comments carry traces of the session: codes from a plan that is not in the repo, "this PR adds", "used to", a reply to a reviewer. A reader later has none of that context.

The test for every suspect passage: **can a reader with only the repository resolve every reference and check every claim?** If not, restate each fact so it stands alone, then delete the rest. A passage with no fact in it (a bare code, a walk through the next three lines) is deleted.

## What to look for

1. **Codes from notes outside the repo.** `(J1)`, `(S1, S4)`, "item 3 of the plan". mu's own numbering is citable: the decision points A1 to E6, H1 and H2 (`kyrn/docs/01-jev-integration-brainstorm.md`, `04-injection-points.md`), the fork ledger's M numbers, issue and PR numbers. A code that exists in both is worse than one that exists in neither: it resolves, to the wrong thing. E2 in `04-injection-points.md` is cache warming, so a comment that cites some other E2 sends the reader to cache warming.
2. **One PR's vantage.** "This PR adds", "a later PR", "the previous commit". Say what the code does. Work left for later is an issue or a `TODO` with one.
3. **Change narration.** "Used to", "previously", "was renamed", "the old code". State the present behaviour. A regression pin is a counterfactual: "without the retry, Windows reports EBUSY here", not "this used to fail". What a person can still meet is not narration: a migration that reads a `mu.json` written by an older mu says so, because that file exists.
4. **Review choreography.** "Rejected in review", "per review", "as discussed". Keep the decision and the reason; drop who said it when.
5. **Arguing with a reviewer.** "This cast is safe, it simply…". State the invariant that makes it safe, or delete the comment if the code shows it.
6. **Narrated control flow.** "First we read the file, then we check…". Delete. AGENTS.md: a comment explains a non-obvious why.
7. **Hedges.** "Probably fine", "should be enough", "for now" with nothing after it. Write the actual bound (a measured size, a limit), or a `TODO` with an issue.
8. **Working-language slips.** Chinese working words (设计稿, 评审, 上一轮, 先这样) in an English comment or doc, or English notes left in a Chinese doc. Not slips: `say({ zh, en })` strings, manifest locales, and a Chinese example of what a user types. `desktop/AGENTS.md` asks for English comments too, and the app has many Chinese ones already: fix those a change touches, not the whole folder.

Keep: issue and PR numbers, `// mu:` markers, measured numbers ("about 1.1 s on a normal runner"), runtime old and new ("the old connection drains first"), and an explained lint suppression.

## The probes

From the repo root, over mu's own folders; add the paths a change touches (`desktop/packages/desktop/src` for the app; this file quotes every pattern, so leave it out if you add `.pi`). The probes over-match on purpose and miss cases too, so judge every hit, and also read the densest prose in scope (module JSDoc, `kyrn/docs`) without a pattern.

```bash
scope=(packages/kyrn-judge kyrn docs)
skip=(--glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/test/golden/**' --glob '!**/CHANGELOG.md')
c='^\s*(//|/\*|\*|#)'  # a comment line

# 1. Notes that are not in the repo, and codes no committed doc defines.
rg -n -P '\b(ANALYSIS|PLUGINS|BRIEF|NOTES|PLAN|HANDOFF)\.md\b' "${skip[@]}" "${scope[@]}"
rg -n -P "$c"'.*(\b(?:[JLGU]|EC|SK|AG|EX|IN)\d{1,2}\b|\([ST]\d{1,2}(?:[,+ ]+[A-Z]{1,2}\d{1,2})*\))' --glob '*.{ts,tsx,mjs}' "${skip[@]}" "${scope[@]}"
# E codes resolve in 04-injection-points.md: check each one means what that table says.
rg -n -P "$c"'.*\bE\d{1,2}\b(?![.\d-])' --glob '*.{ts,tsx}' "${skip[@]}" "${scope[@]}"

# 2. One PR's vantage.
rg -n -i -P "$c"'.*\b(this PR|later PRs?|previous commits?|this commit|in this change)\b' --glob '*.{ts,tsx,mjs}' "${skip[@]}" "${scope[@]}"
rg -n -i -P '\b(this PR|later PRs?|previous commits?|in this change)\b' --glob '*.md' "${skip[@]}" "${scope[@]}"

# 3. Change narration in comments.
rg -n -i -P "$c"'.*\b(used to (?:be|have|return|send|ask|show|say|run|keep|take)|previously|was renamed|was moved|the old (?:code|version|behaviou?r|implementation|way))\b' --glob '*.{ts,tsx,mjs}' "${skip[@]}" "${scope[@]}"

# 4, 7. Review choreography and hedges.
rg -n -i -P 'rejected in review|review round|per review|as discussed|probably fine|should be enough|should suffice|hopefully' "${skip[@]}" "${scope[@]}"
rg -n -i -P "$c"'.*\bfor now\b' --glob '*.{ts,tsx,mjs}' "${skip[@]}" "${scope[@]}"

# 8. Chinese working words in English comments.
rg -n -P "$c"'.*(设计稿|评审|上一?轮|旧版|以前|遗留|待定|先这样|临时)' --glob '*.{ts,tsx,mjs}' "${skip[@]}" "${scope[@]}"
```

A probe with no hits proves nothing until it has hit a known positive, and a noisy one proves nothing until it has passed a near miss. Check a probe you change:

```bash
printf '%s\n' '// Frozen first (J1).' ' * A presigned S3 link.' | rg -P "$c"'.*(\b(?:[JLGU]|EC|SK|AG|EX|IN)\d{1,2}\b|\([ST]\d{1,2}(?:[,+ ]+[A-Z]{1,2}\d{1,2})*\))'
# hits the first line only
```

Known false positives: "used to" about a thing rather than the code ("where a file used to be"); "for now" inside a test's scripted user text or a runtime fallback ("the rules decide for now").

## Fixing

- Restate before deleting. List the facts a passage carries, keep each one in present tense, then cut the rest. A trim that turns "must" into "may", deletes a true fact, or drops the measurement behind a number is worse than the leak.
- Model-visible text is not just prose. A tool description, a hint or a judge question that changes shows up in `test/golden/model-surface.md` or `decision-requests.md`; follow those files' rules (`-u`, a new `version`) and change it only with a reason beyond wording.
- Generated files (`manifest.json`, `docs/reference/*.md`, golden files) are fixed at their source, then regenerated.
- Commit messages and PR bodies are records of a change and may say "this PR". The rules here are for what stays in the tree.
