# Proposal: `turn.teaching` — a folded teaching card at the turns that were worth explaining

Local proposal (the issue is opened after the user approves going public; fields follow `.github/ISSUE_TEMPLATE/decision_point.yml`).

## When it is asked

At `agent_end`, once per completed user turn, in the background (the turn is never held for it; `memory.outcome` is the precedent for the timing). Turns cut short by the user or by an error are not asked about. Every completed turn is asked — teaching moments (`design_discussion` turns with no tool calls) must not be filtered away by a step-count rule.

## The question

One choice question, `pivot`:

> Judging by `turn_digest`, what was the pivot of this turn: the point where an uninformed reader would have made the worse call?
>
> - `product_tradeoff`: the answer chose between product options the user could have wanted (scope, simplicity vs completeness, breaking users, cost).
> - `arch_weighing`: the answer weighed ways to build it (library vs hand-rolled, where a layer goes, coupling, what the codebase already has).
> - `counterintuitive_pitfall`: the work hit a trap whose safe path is the opposite of what it looks like (the fix that is not the fix, the flag that does the reverse).
> - `routine`: ordinary work or an ordinary answer; nothing a reader would get wrong.
> - `other`: cannot tell.

`other` is the escape option (required for every choice).

## What the judge reads

One field, `turn_digest`: the user's message clipped to 400 chars, the turn's tool calls as one line each (first/last few kept, middle counted), and the final message clipped to 800 chars — the same digest `memory.outcome` reads (`turnDigest` in `src/memory/phrasing.ts`). Roughly 0.5–2.5 KB per turn.

## The effect

Nothing the model reads. On a teaching verdict (`product_tradeoff`, `arch_weighing` or `counterintuitive_pitfall`, and the option's own probability is sharp), the configured writer model phrases one folded card — `why` (≤120 chars) and `ruledOut` (≤2 shorter options it decided against) — and the kernel presents it (`turn.teaching` presentation event). The desktop app shows it in the conversation as a line collapsed to one row the reader can open; the TUI and other clients never see it in the model's context. Without a writer configured, nothing shows (fail-open, quiet first). Without a judge answer, or on `routine`/`other`/a flat distribution, nothing happens anywhere.

Ships in **shadow**: the verdict, the card and the presentation are recorded (ledger + judge panel) but the desktop inserts no line, until real sessions show the false-positive rate is acceptable. Flipping it on is one line in `mu.json` (`modes["turn.teaching"] = "active"`); the calibration numbers go in this proposal's Evidence before that is suggested.

## Evidence

- Source: the "顺带私教" design (case ①) — `tmp/side-tutor-plans.md` (2026-11-22), which this proposal follows.
- The noise it replaces: the desktop shows a judge line ("归类中…") every turn (`MessageJudgeLine`) and the TUI prints `kyrn.lessons`/`kyrn.hint` rows every turn; none of it says why a decision was made at the moments that deserve it.
- Prior art in this repo: `memory.outcome` (same timing, same digest); the writer phrasing lessons (`CORRECTION_PROMPT`, `WAY_OUT_PROMPT`); the `mu:notice:` one-line rows in the desktop bridge.
- Cost: one more background judge request per turn (`judge-budget.md` grows by one row per scripted turn) plus one writer request per teaching verdict. The judge call is the price of not injecting teaching into the model's context; the writer call happens only on the rare verdict.
- Calibration: shadow-run sample and false-positive notes are appended below as they come in.

### Calibration log (shadow)

First sample (fork build `build/local-fork-n`, 2026-11-22, judge `glm-flash` tier at ~1 s per ask, writer `zai-coding-cn/glm-5.3`):

| turn | asked | judge's pick | probability | card | right? |
|---|---|---|---|---|---|
| "配置塞进一个 config 对象还是拆成命名参数？权衡一下" | pivot | `arch_weighing` | 0.85 | yes — "两种方式各有代价，所以没有全押一边，而是按参数性质拆分：必需项保可读性，可选项打包保扩展性。" | yes |
| "先只做 JSON 导出还是一步到位三格式？取舍一下" | pivot | `product_tradeoff` | 0.85 | yes — "JSON 最先落地，因为它是最小可用方案；展平规则和依赖只有在有实际需求时才确定。" | yes |
| "把变量名 x 改成 itemCount" | pivot | `routine` | 0.85 (0.6, 0.7 on its later sub-runs) | none | yes |

3/3 correct, no false positive, distribution sharp (0.85 against 0.0375 for the rest) — the 0.7 bar sits comfortably. Shadow presented every card with `state: shadow`; the transcript showed no card row and no judge-line row (the fold held), and the judge panel listed the records.
