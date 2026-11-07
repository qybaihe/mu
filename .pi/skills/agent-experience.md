---
name: agent-experience
description: Design what a model reads in mu, the main model and the judge. Use when adding or changing a tool (name, description, parameters, result), a skill, a capability in the catalog, text mu adds to the conversation, or a judge decision's request.
---

# What the model reads

Every tool's description and parameter schema goes out with every request, and so does every line mu adds to the system prompt. A sentence that helps one turn in fifty is paid for in all fifty. A result that dumps a whole log fills the context for the rest of the session.

## Measure first

`packages/kyrn-judge/test/golden/model-surface.md` is the system prompt and every tool the main model gets with mu loaded. Write it before and after your change, and read the diff as the model would:

```bash
cd packages/kyrn-judge
wc -c test/golden/model-surface.md
node ../../node_modules/vitest/dist/cli.js --run test/golden/model-surface.test.ts -u
wc -c test/golden/model-surface.md
git diff test/golden/model-surface.md
```

A character is about a quarter of a token. State the size change in the PR. The judge's requests are recorded the same way in `test/golden/decision-requests.md`. A decision whose request changes needs a new `version`, and the test fails until it has one.

## Shown or found

- A tool most coding turns do not call goes behind `find_capability` (the catalog, `features/catalog.ts`). A skill goes behind `find_skill`. Then its description is paid for only in the turns that open it.
- Unattended runs drop the tools in `UNATTENDED_HIDDEN` (`catalog.ts`): benchmark runs next to never called them, and each one was in every request. A new tool belongs there unless an unattended run needs it.
- A capability or skill is shown by its description. The judge that decides whether a message needs it reads only the first 220 characters (`DESCRIPTION_LENGTH` in `decisions/capability-disclosure.ts` and `skill-disclosure.ts`). Put the words a request would use first: tool names, then what it is for.

## Writing a tool

- **Say what it does and what it returns.** Leave out how: the permission gate, the judge, the sandbox and the result markers are mu's business. The model learns them from results when they matter.
- **Leave out what the result teaches.** A missing file fails to read; a refused call says it was refused. Do not warn about either in the description.
- **Put a parameter's rules on the parameter.** Defaults, ranges, units, "only with `x`": in its TypeBox `description`, not in the tool's. A tool description that changes with configuration usually means that part is a parameter.
- **Say each fact once.** Not in the description and again in a system prompt section, a parameter, or another tool.
- **Put what is irreversible before the action.** If a call can delete, send or publish, the description or the parameter that does it says so. `bash`'s `outside` parameter in the write sandbox is the model to follow.

## Writing a result

- **Bounded, with a way to the rest.** Return a summary with an id, path or offset that gets more, and say what was left out. `bg_output` says `[showing the last N of M new characters; the full log is <path>]`. A truncated result that does not say so reads as the whole thing.
- **Nearby context when it is cheap.** A line number with the line, a match with a few lines around it. Not the whole file.
- **Data from outside stays marked.** MCP results, web pages and background job output are wrapped as untrusted data (`UNTRUSTED` in `features/mcp.ts`). mu's own instructions go outside that wrapper, above it, as `bg_output`'s sandbox note does. Otherwise the model cannot tell mu's words from the page's.

## Check the whole run

Fewer characters help only when the model does not then search more, read the same file twice, or call the wrong tool. After a change to a description or a result, run a faux-provider session (`packages/coding-agent/test/suite/harness.ts`) that exercises the tool. For a change meant to shift behaviour, also run a real task or a mubench case and compare the calls made, not only the first request's size.
