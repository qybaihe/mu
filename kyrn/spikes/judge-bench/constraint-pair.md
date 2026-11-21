# Paired constraint judge check

Opt-in, not CI. The runner uses the kernel's System One transport without opening a session or loading its config or auth. `--requests` prints both arms' decision state and questions offline. `--live` sends one request per case per arm, alternates which version goes first, and never retries. The `candidate` arm uses the current shared decision and reports its actual version. Set `SET=heldout` to select the separately authored cases, or `CASE` to select one by ID.

## Six-question guard regression

The completed rename was still in the frame when an unrelated edit was blocked. This fixture isolates the guard: it starts with five synthetic rules that the edit doesn't break, then `Rename agents.md to AGENTS.md` at `constraint_5` (zero-based). The target is `collage-spec.md`; all three replacements are synthetic. The v1 arm sends only `edit: collage-spec.md`, as the old formatter missed nested `edits`. The candidate uses the production formatter for the same edit. This is a shape match, not a session replay or a test of why the rename stayed in the frame.

```sh
CASE=legacy-rename-spec-six node kyrn/spikes/judge-bench/constraint-pair-bench.ts --requests
```

The expected broken-rule set is `[]`. In `legacy-rename-spec-six-block-control`, only rule 2 changes: it forbids the preview-column change in the same batch. The expected set is `[2]`. Blocking on `[5]` or `[2, 5]` gives the same overall block but fails `wrongRuleSet`, which compares all selected indexes. `falseBlocks` and `missedViolations` still measure only the overall action. A timeout or other missing verdict is unanswered, not a correct allow. A returned `unclear` is distinct from a missing reply; if no rule blocks, it counts as a miss when the label requires a block.

### Opt in to the original pinned Jev 1.14 model

No live Jev 1.14 result is available for this case. Set these variables explicitly with an approved System One POST endpoint, the **exact original pinned model ID** (not `jev-latest` or another provider's alias), and a dedicated benchmark credential. From the repo root:

```sh
CASE=legacy-rename-spec-six SET=regression \
BENCH_JUDGE_URL="${BENCH_JUDGE_URL:?set the approved POST endpoint}" \
BENCH_JUDGE_MODEL="${BENCH_JUDGE_MODEL:?set the exact original pinned model ID}" \
BENCH_JUDGE_API_KEY="${BENCH_JUDGE_API_KEY:?set an approved benchmark credential}" \
node kyrn/spikes/judge-bench/constraint-pair-bench.ts --live
```

Only for a documented unauthenticated free route serving that exact model, unset the key and replace its assignment above with `BENCH_JUDGE_FREE=1`. No such route was established here. With no custom endpoint and model, `--live` instead uses OpenCode Zen `jev-1.13-free`; that is a separate model, not a reproduction.

## Current result: one-call permissions and stable targets (Jev 1.13)

The current `tool.constraint` v5 and `task.frame` v7 completed all 24 synthetic pairs. The guard selected the expected rules on **13/13** calls (seven allows, six blocks). In this run v1 incorrectly blocked the six-rule rename case on rule 5, while v5 allowed it. On the matched blocking control v1 allowed the call, while v5 identified rule 2. The older live runs below had different v1 results; none used Jev 1.14 or the private session.

The frame selected the expected limit and target in **11/11** turns, including one commit without retiring the recurring rule, implementation approval ending a hold, and review-only assent granting nothing. The separate work label matched **9/11**; the two permissions to implement or commit were read as changing the limit only. These are classifier checks, not end-to-end measures of privacy, persistence or one-time consumption; the corresponding regression tests use the real adapter or session hooks offline.

## Earlier result: v1 vs tool v3 and frame v5 on Jev 1.13

One live run compared v1 against `tool.constraint` v3 and `task.frame` v5 on the same 23 synthetic cases. All pairs got answers. The new guard selected exactly the expected rules in **13/13** calls (seven allows, six blocks). Both arms allowed the six-question spec edit; only the new guard identified rule 2 in its blocking control. V1 missed three required blocks in all.

The new frame chose the expected limit action and target in **10/10** cases; v1 matched five. Explicit implementation permission lifted only the edit restriction; approval to continue the review lifted nothing. The separate work label matched in **8/10** cases: two permissions with work were read as limit changes alone. These are decision results, not a full session run on the original judge.

An earlier candidate used numbered options without quoting the rule. On the docs-only withdrawal it selected the publishing ban instead (0.82). The current options quote the target directly. That case informed the change; it is a regression case, not independent evidence of generalization.

## Earlier live result: v1 vs v2 on OpenCode Zen `jev-1.13-free`

One run, 18 complete pairs, 5 s per request, zero unanswered. This was the original fixture set: the legacy case had one question (with a period at the end of the rename text), not one sample for each historical retry. These measurements do not cover the six-question cases or later decision versions.

| Guard | False blocks / allows | Missed violations / blocks | Unanswered |
| --- | ---: | ---: | ---: |
| v1 | 0/6 | 2/5 | 0 |
| v2 | 0/6 | 0/5 | 0 |

The legacy rename/spec edit was **allowed by both**: v1 gave 0.64, below the 0.8 block bar; v2 chose `compatible` at 1.00. This run did not reproduce the historical false block. V2 caught both content-dependent violations (one held out) without blocking their matched harmless edits. Both versions kept the direct prohibition and exclusive-scope controls.

| Frame | Wrong limit / answered | Wrong work / answered | Unanswered |
| --- | ---: | ---: | ---: |
| v1 | 3/7 | 4/7 | 0 |
| v2 | 1/7 | 3/7 | 0 |

For v1, `constraint` and `correction` both imply a forced constraint admission in the legacy merge, and there is no classifier signal for a targeted withdrawal. This comparison scores that signal, not actual writer output. V2 correctly kept a one-time correction out of the limit path. It picked the wrong rule (`withdraw_1` at 0.48 instead of `withdraw_2` at 0.38) on the held-out turn lifting one of two rules; the production threshold turned that into `unclear`, so no withdrawal was authorized. Some work classifications remained weak even when the limit was right.

## Writer smoke check

A separate run used the real writer prompt, parser and merge with three synthetic messages and fixed frame verdicts: a rename with unclear work and no limit, a task with an explicit prohibition, and replacement of one of two existing rules. An initial prompt put `{id, text}` objects in the input's `constraints` field; `gpt-oss-20b` copied that shape in two replies and the parser rejected them. After separating input `existing_limits` from the output list of new strings, the same model and three cases produced the expected subgoal and exact active rules in all three. This checks the writer given those verdicts, not whether the judge would choose them. No original session text was sent to the writer.

## Rollout gate

These runs support the guard's handling of nested edits and the frame's handling of the tested withdrawals, not a claim that the historical false block is fixed across models. Before expanding active use, repeat on the intended pinned judge in shadow, with complete pairs, no added false blocks, and exact rule selections on prohibitions and scope. Include additional independently labeled withdrawal cases with competing rules; verify the named rule is lifted and the other rules stay. Writer behavior should also be checked on the model used for deployment; the paired judge runner itself doesn't call a writer.
