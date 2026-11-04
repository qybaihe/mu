# What the main model is given

Written by `model-surface.test.ts`: the system prompt and the tools offered with every feature of mu on, in a
fresh session. Do not edit by hand; run the test with `-u`.

## System prompt

```text
You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.

<tools>
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

Additional tools may be available.
</tools>

<rules>
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- You can inspect PI_* environment variables for current model and session details.
- Use edit for targeted changes. Batch changes to one file in a single call.
- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files
</rules>

<docs>
Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: <pi>/README.md
- Additional docs: <pi>/docs
- Examples: <pi>/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)
- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.
</docs>

<cwd>
<cwd>
</cwd>
```

## Tool: read

```text
Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.
```

```json
{
	"type": "object",
	"required": [
		"path"
	],
	"properties": {
		"path": {
			"type": "string",
			"description": "Path to the file to read (relative or absolute)"
		},
		"offset": {
			"type": "number",
			"description": "Line number to start reading from (1-indexed)"
		},
		"limit": {
			"type": "number",
			"description": "Maximum number of lines to read"
		}
	}
}
```

## Tool: bash

```text
Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.
```

```json
{
	"type": "object",
	"required": [
		"command"
	],
	"properties": {
		"command": {
			"type": "string",
			"description": "Shell command to execute"
		},
		"timeout": {
			"type": "number",
			"description": "Timeout in seconds (optional, no default timeout)"
		}
	}
}
```

## Tool: edit

```text
Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.
```

```json
{
	"type": "object",
	"required": [
		"path",
		"edits"
	],
	"properties": {
		"path": {
			"type": "string",
			"description": "Path to the file to edit (relative or absolute)"
		},
		"edits": {
			"type": "array",
			"items": {
				"type": "object",
				"required": [
					"oldText",
					"newText"
				],
				"properties": {
					"oldText": {
						"type": "string",
						"description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."
					},
					"newText": {
						"type": "string",
						"description": "Replacement text for this targeted edit."
					}
				}
			},
			"description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead."
		}
	}
}
```

## Tool: write

```text
Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.
```

```json
{
	"type": "object",
	"required": [
		"path",
		"content"
	],
	"properties": {
		"path": {
			"type": "string",
			"description": "Path to the file to write (relative or absolute)"
		},
		"content": {
			"type": "string",
			"description": "Content to write to the file"
		}
	}
}
```

## Tool: todo

```text
The checklist of what has to be true before the task is finished, kept in mu's task frame. list shows it. done ticks one item and needs one line of evidence (the command that passed, the file that changed). add records an item you discovered. Tick items as you finish them; do not say the task is done while one is open.
```

```json
{
	"type": "object",
	"required": [
		"action"
	],
	"properties": {
		"action": {
			"type": "string",
			"enum": [
				"list",
				"done",
				"add"
			],
			"description": "list, done or add"
		},
		"id": {
			"type": "string",
			"description": "Id of the item to tick, such as a2 (done)"
		},
		"evidence": {
			"type": "string",
			"description": "One line on what shows the item is met (done)"
		},
		"text": {
			"type": "string",
			"description": "What has to be true (add)"
		}
	}
}
```

## Tool: find_skill

```text
List installed skills that are not shown in the system prompt. Use it when a task needs a capability you have no skill for.
```

```json
{
	"type": "object",
	"properties": {
		"query": {
			"type": "string",
			"description": "Words to look for in skill names and descriptions"
		}
	}
}
```

## Tool: find_capability

```text
List installed capabilities that are not in your tool list yet (debugger, structural search, MCP servers, review and commit helpers and more), or open one by id. Use it when a task needs a tool you do not have.
```

```json
{
	"type": "object",
	"properties": {
		"query": {
			"type": "string",
			"description": "Words to look for in capability names and descriptions"
		},
		"open": {
			"type": "string",
			"description": "Id of the capability to open, as listed by this tool"
		}
	}
}
```

## Tool: apply_patch_from

```text
Bring the patch of an isolated subagent into the working tree with git apply --3way: all of it or, on a conflict, none of it. Nothing is staged or committed. Look first with action "stat" (files) or "diff" (one file).
```

```json
{
	"type": "object",
	"required": [
		"id"
	],
	"properties": {
		"id": {
			"type": "string",
			"description": "Patch id from a delegate result, e.g. p-3f9a2c"
		},
		"action": {
			"anyOf": [
				{
					"type": "string",
					"const": "apply"
				},
				{
					"type": "string",
					"const": "stat"
				},
				{
					"type": "string",
					"const": "diff"
				}
			],
			"description": "Default: apply"
		},
		"file": {
			"type": "string",
			"description": "For diff: a path from the patch"
		},
		"conflicts": {
			"anyOf": [
				{
					"type": "string",
					"const": "abort"
				},
				{
					"type": "string",
					"const": "markers"
				}
			],
			"description": "abort (default): change nothing on a conflict. markers: apply what merges, leave conflict markers in the rest"
		}
	}
}
```

## Tool: delegate

```text
Run tasks in fresh subagents, each with its own context window: in parallel for parts that do not depend on each other and for side work whose details you do not need (broad code search, web research), or with chain: true one after another, each step handed what the step before reported (scout, then plan, then implement). Each subagent sees only its own instructions, so make them self-contained. Give each part what must be true when it is done (done) and, when it is for an item of your todo list, that item's id (serves): the subagent works to that list, and you get back which criteria it met with its evidence. A fitting role, model and thinking level are chosen per task; name a role only when you want a specific one (browser, investigator, planner, reviewer, scout, worker). Returns each subagent's final report. In a git repository a subagent that edits files works in an isolated copy, and its changes come back as a patch that only apply_patch_from brings in.
```

```json
{
	"type": "object",
	"required": [
		"tasks"
	],
	"properties": {
		"tasks": {
			"type": "array",
			"items": {
				"type": "object",
				"required": [
					"title",
					"instructions"
				],
				"properties": {
					"title": {
						"type": "string",
						"description": "Short name of the task, shown to the person on mu's board and in its list of subagents: a few words in the language the person writes in"
					},
					"instructions": {
						"type": "string",
						"description": "Complete, self-contained instructions, including what to report back"
					},
					"agent": {
						"type": "string",
						"description": "Role name. Leave out to have one chosen."
					},
					"done": {
						"type": "array",
						"items": {
							"type": "string"
						},
						"maxItems": 8,
						"description": "What must be true when this part is done, one checkable statement each"
					},
					"serves": {
						"type": "string",
						"description": "Id of the item of your todo list this part is for, such as a2"
					},
					"isolation": {
						"anyOf": [
							{
								"type": "string",
								"const": "worktree"
							},
							{
								"type": "string",
								"const": "none"
							}
						],
						"description": "worktree: edit in an isolated copy and hand back a patch (default for roles that edit). none: edit in place"
					}
				}
			},
			"minItems": 1
		},
		"chain": {
			"type": "boolean",
			"description": "Run the tasks in order, one at a time; each gets the report of the one before. Stops at the first step that does not finish. Steps edit in place unless one asks for a worktree"
		}
	}
}
```

## Tool: hive

```text
Put several investigators on ONE hard problem at once, each from a different angle (reproduce it, read the code involved, search history, search the web, test a hypothesis). Unlike delegate, they are not isolated: a fast judgment model watches every step and passes what one of them finds to the others it matters to, so they build on each other instead of repeating each other. Use it when a problem resists a direct attempt or its cause is unknown. Investigators do not edit files; you get their reports and the shared findings, and you make the change.
```

```json
{
	"type": "object",
	"required": [
		"goal",
		"bees"
	],
	"properties": {
		"goal": {
			"type": "string",
			"description": "The problem, stated completely: symptoms, what was tried, constraints"
		},
		"bees": {
			"type": "array",
			"items": {
				"type": "object",
				"required": [
					"name",
					"focus"
				],
				"properties": {
					"name": {
						"type": "string",
						"description": "Short name, e.g. repro, history, auth-code"
					},
					"focus": {
						"type": "string",
						"description": "The angle this one takes, self-contained"
					},
					"agent": {
						"type": "string",
						"description": "Role name. Default: investigator (read-only plus bash and browse)"
					}
				}
			},
			"minItems": 2
		}
	}
}
```

## Tool: locate

```text
Find the files most likely to contain something, described in words (e.g. 'where session cookies are set'). Returns a ranked list of paths. Prefer it over repeated grep when you do not know the exact identifier.
```

```json
{
	"type": "object",
	"required": [
		"query"
	],
	"properties": {
		"query": {
			"type": "string",
			"description": "What you are looking for, in plain words"
		},
		"directory": {
			"type": "string",
			"description": "Limit the search to this directory"
		}
	}
}
```

## Tool: judge_items

```text
Ask the judge model, a fast yes/no classifier, one question about each of many items at once (file paths, log lines, findings, URLs, short texts); each item gets the probability of yes. For sorting or filtering many items by a plain criterion instead of reading them all yourself; not for reasoning, arithmetic or writing.
```

```json
{
	"type": "object",
	"required": [
		"question",
		"items"
	],
	"properties": {
		"question": {
			"type": "string",
			"description": "A yes/no question about ONE item, e.g. 'Is this test about login?'"
		},
		"items": {
			"type": "array",
			"items": {
				"type": "string"
			},
			"description": "The items, one string each"
		},
		"context": {
			"type": "string",
			"description": "What every item should be read with, said once (the goal, a definition)"
		}
	}
}
```

## Tool: browse

```text
Open a web page and, optionally, carry out a goal on it (search, fill a form, navigate, find information). A fast judgment model drives every click, so state the WHOLE goal once, including any text to type, instead of calling this step by step. Returns the final page text and a trace of the actions taken. Without a goal it just returns the page text. Actions that look irreversible (paying, deleting, sending) stop and ask first.
```

```json
{
	"type": "object",
	"required": [
		"url"
	],
	"properties": {
		"url": {
			"type": "string",
			"description": "Page to open, including https://"
		},
		"goal": {
			"type": "string",
			"description": "Everything to accomplish on the site, in plain words"
		}
	}
}
```

## Tool: bg_start

```text
Start a long-running shell command (dev server, watcher, long build or test run) in the background and get its job id at once. Read it with bg_output, end it with bg_stop. Jobs end with the session, except in an unattended run, where they keep running after it.
```

```json
{
	"type": "object",
	"required": [
		"command"
	],
	"properties": {
		"command": {
			"type": "string",
			"description": "Shell command"
		},
		"name": {
			"type": "string",
			"description": "Short label"
		},
		"cwd": {
			"type": "string",
			"description": "Working directory"
		},
		"watch": {
			"type": "string",
			"description": "Regex: tell me when a line of output matches"
		}
	}
}
```

## Tool: bg_output

```text
New output of a background job and its state (running, or exited with its code). Without id: list the jobs. With wait_for or timeout it waits for a matching line, the end of the job or the timeout, so do not poll in a loop.
```

```json
{
	"type": "object",
	"properties": {
		"id": {
			"type": "string",
			"description": "Job id"
		},
		"since": {
			"type": "number",
			"description": "Cursor from an earlier call. Default: where the last read ended"
		},
		"wait_for": {
			"type": "string",
			"description": "Regex to wait for in new output"
		},
		"timeout": {
			"type": "number",
			"description": "Seconds to wait for wait_for, or without it for the job to end"
		}
	}
}
```

## Tool: bg_stop

```text
Stop a background job and everything it started.
```

```json
{
	"type": "object",
	"required": [
		"id"
	],
	"properties": {
		"id": {
			"type": "string",
			"description": "Job id"
		}
	}
}
```

## Tool: web_fetch

```text
Read one web page or file by URL as plain text (HTML becomes readable text; JSON and text pass through). No JavaScript, no login: use browse for pages that need either.
```

```json
{
	"type": "object",
	"required": [
		"url"
	],
	"properties": {
		"url": {
			"type": "string",
			"description": "http(s) URL"
		},
		"max_length": {
			"type": "number",
			"description": "Most characters to return"
		}
	}
}
```

## Tool: web_search

```text
Search the web. Returns titles, URLs and snippets; read a result with web_fetch.
```

```json
{
	"type": "object",
	"required": [
		"query"
	],
	"properties": {
		"query": {
			"type": "string",
			"description": "Search words"
		},
		"count": {
			"type": "number",
			"description": "Results wanted, default 8"
		}
	}
}
```
