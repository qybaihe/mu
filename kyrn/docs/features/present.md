# Files for the user: `present`

When a task's result is a file (a report, a deck, a build, an export), the model's last word about it was a path in its reply. `present` hands the user those files as a list they open each one from: in the desktop app a card in the conversation, in the terminal the tool's result.

Code: `packages/kyrn-judge/src/extension/features/present.ts`. Option: `features.present` (`enabled`).

## The call

```jsonc
{ "files": [ { "path": "out/report.pdf" }, { "path": "/Users/me/Desktop/deck.pptx", "label": "Slides for Monday" } ],
  "note": "The report has the numbers you asked for." }
```

- One to eight files, absolute or from the working folder. Each has to be a regular file that exists. A folder, a missing file and a second mention of the same file are left out, and the result says so. With nothing left, the call fails and says to present files once they are written.
- Nothing is read from inside the files, and nothing is copied: a name, a size and an absolute path are all a client needs.
- `label` is what the user sees in place of the file's name. `note` is one line for the user about them.

The result the model gets:

```
Presented to the user (2 files):
- report.pdf (out/report.pdf, 2.0 KB)
- Slides for Monday (/Users/me/Desktop/deck.pptx, 3.3 MB)
```

Its `details` are `{ files: [{ path, name, bytes }], note? }`, with absolute paths. They are kept in the session with the result, so a reopened conversation shows the same card. No entry of its own is written.

## The two guidelines

The tool brings two lines into the system prompt's guidelines:

- Call present once at the end with the files the user asked for; not to list the source files you edited.
- When you name a file that exists, link it: `[api.ts](src/api.ts#L24)`, the line as `#L24` or `#L24-L30`, and the file's name as the label.

The desktop app reads both anchors (`markdownUtils.ts` `parseHashLocation`), and opens such a link in its preview at that line.

The tool is on the list from the first request on, so the system prompt does not change during a session.

## Who has it

- A sub-agent does not: its parent presents what the task produced.
- An unattended run (`mu --print`, json mode) leaves it out of the request (`catalog.unattendedHidden`): nobody opens the files there.
- It only looks at what is on disk, so it is on the read-only lists of the permission modes, the checkpoint, the credential guard and the board.

## The desktop card

The native transcript passes a finished `present` call's details to its row as the call's raw output (`toMessages.ts`), and the message list shows such a row as a card of its own, not as a call in the tool box (`Messages/acp/MessageDeliverables.tsx`): "Files for you (2)", the note, and a row per file with its name, its folder and its size. A click opens the file in the preview, as a file link in a reply does.
