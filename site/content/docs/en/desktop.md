---
title: The desktop app
summary: The conversation, the work panel beside it, the send box, the keyboard, settings and how the app shares everything with the command line.
---

## The conversation {#conversation}

- **One list for both.** The conversation list is mu's own session files. A session you started in a terminal shows up in the app, and one started in the app can be continued with `mu -c` or `mu -r`.
- **Quiet by default.** What mu says to the model on its own, such as a reminder to verify, a goal continuation, a new error or a rewind, shows as a single line in your language; the original text is one click away. A run of tool calls is folded into one line that says what was done, such as *read 3 files · ran 1 command*.
- **Files open beside it.** Click the path of a file a tool call read or wrote, or a file a reply names, and it opens in the work panel's preview: code and other text, Markdown, HTML, PDF, CSV, images and diffs. Other files open in their own app.
- **Your dev server opens in the app.** When a command prints a local address such as `http://localhost:5173/`, a button under it opens the page in the work panel's browser.
- **Fork from any message.** Each message has a fork button that starts a new branch from that point.
- **Go back to before a message.** Under a message of yours whose turn changed files, a button goes back to the checkpoint mu took then. mu asks whether the files, the conversation or both go back. When the conversation goes back, your message returns to the send box to send again.
- **Row menu.** Rename, pin, mark as unread, archive or delete a conversation.

## When a conversation needs you {#attention}

- **Notifications.** When another conversation finishes or waits for you, the system tells you.
- **A count on the Dock icon** shows how many conversations are waiting (macOS; the launcher on Linux).
- **A sound, if you want one.** Settings → System → *Play a sound when a conversation finishes or needs you*. It chimes even while mu is in front, with a different chime when mu asks something or a run fails. While it's on, system notifications stay silent, so you don't hear two sounds. It's off by default.
- **The computer stays awake while a conversation runs,** so idle sleep doesn't cut a long run short. The display can still turn off, and closing the lid still puts it to sleep. Settings → System turns it off.

## The send box {#send-box}

- **Permission mode.** Full access, *Judge mode* or *Ask first*, switched per conversation. See [Permissions and safety](@docs/permissions).
- **Goal.** Set a goal, and the agent keeps working until it holds. While a goal runs, a goal line above the box shows its state. See [Goal mode](@docs/goal).
- **Context ring.** How full the context is, at a glance.
- **Queued messages.** A message sent while the agent works waits in a queue and can be taken back before it is used.
- **Slash commands.** Type `/` for mu's and pi's commands, the same as in the terminal.
- **What you point at goes with your next message.** A page element, a screenshot, a page's console or a comment on a diff line shows as a chip in the send box until you send it, and you can remove any of them first.
- **Background commands.** While a command runs in the background, such as a dev server, a watcher or a long build, a pill beside the send box says how many. Its list shows each command, how long it has run and its log, with buttons to stop one or all of them. When the conversation's folder has a package.json with scripts, the pill shows **Run** and lists them: Run starts one as a background job, and when it ends, mu is told, so you can ask it why the tests failed. In the terminal, `/jobs start [--name <label>] <command>` does the same.

## The keyboard {#keys}

On Windows and Linux, read <kbd>Ctrl</kbd> for <kbd>⌘</kbd>.

| Keys | What they do |
| --- | --- |
| <kbd>⌘K</kbd> | The command palette: conversations, settings and commands |
| <kbd>⌘P</kbd> | Open a file in the conversation's folder by name |
| <kbd>⌘1</kbd> to <kbd>⌘9</kbd> | Open the conversation at that position in the sidebar |
| <kbd>⇧⌘A</kbd> | Open the next conversation that finished or asked something while you were elsewhere |
| <kbd>Ctrl Tab</kbd>, <kbd>Ctrl ⇧ Tab</kbd> | Open the conversation below or above |
| <kbd>⌘/</kbd> | List every shortcut the app handles |

The list is also in the command palette and under Help → Keyboard shortcuts. It writes each key the way your system shows it.

## The work panel {#panel}

The panel beside the conversation has eight tabs:

| Tab | What it shows |
| --- | --- |
| **Board** | The [plain-language board](@docs/board): how far the work is, what's happening now, what waits for you and a running account |
| **Judge** | The live ledger: every verdict with its question, its answer, its probability and how long it took |
| **Hive** | The [hive](@docs/hive): each bee, what it's doing and a map of which finding went to whom |
| **Lessons** | The [lessons library](@docs/lessons): what mu has learned, how often each lesson was recalled and followed; edit or retire one |
| **Files** | The project's files |
| **Preview** | The file or page being worked on: code, Markdown, HTML, PDF, CSV, images and diffs |
| **Source** | The folder's git changes and their diffs, a commit box and the branch's pull request |
| **Browser** | The built-in browser the agent drives step by step, with its goal; pause it, take over or stop it |

**The panel follows the agent.** While it's open on Files, Preview, Source or Browser, a file the agent finishes writing shows in the preview, and when the agent uses its browser, the Browser tab comes forward. A closed panel only gets dots. A toggle on those tabs turns following off.

### Source control {#source}

- **Stage and commit.** Stage or unstage a file or a whole section, write a message and commit with <kbd>⌘Enter</kbd>. With nothing staged, *Commit all* stages every change first, new files included. If git refuses (a hook fails, or no identity is set), its output shows under the box.
- **One change at a time.** In a file's diff, each change has a *Stage this change* button, or *Unstage this change* in the staged diff, so you can commit part of a file. Staging never touches the file on disk.
- **Let mu commit.** mu splits the changes into commits and writes their messages. It shows you the plan and commits only when you agree.
- **Nothing is thrown away here.** The tab has no discard button; to put files back, go back to before a message.
- **The branch's pull request.** Under the branch line: the pull request's number and title (click to open it on GitHub), its state and how many of its checks passed. Click the count to list the checks and open one. While a check runs, the row updates every 30 seconds. On a branch without one, *Let mu open one* asks mu to push the branch and open it; mu shows you the title, description, repository and base branch first. This uses GitHub's `gh` CLI, signed in as you; without it there's no row.

### Comments on a diff {#diff-comments}

In a diff in the preview, the button beside a line opens a comment box under it. Your comments go with your next message, each with its file, line and code.

### The built-in browser {#browser}

The built-in browser keeps its own profile and never touches your own browser. Each step shows what was clicked and how sure the judge was; submitting, paying or deleting stops and asks you first.

Three buttons show mu what you're looking at:

- **Pick an element.** Click an element of the page; the click doesn't reach the page. The element goes into your next message with the page's address, a selector that finds it, its text, styles and HTML, and a picture of it. <kbd>↑</kbd> selects its parent, and <kbd>Esc</kbd> cancels.
- **Screenshot.** Puts the page as it looks now into your next message, as an image.
- **Console.** When the page has logged errors or warnings since it loaded, a button shows how many; it adds the last 50 to your next message, oldest first, each with its source.

## Signing in to models {#models}

Settings → Models connects a model without leaving the app: sign in with ChatGPT, or paste an API key for any provider pi supports. ChatGPT uses OpenAI's own Sign in with ChatGPT (Plus or Pro plan). A server of your own works too, including a plain `http://` address on your machine or network.

Google's two sign-ins are Google's logins for its own tools. Using them from another program may break Google's terms, so the app states the risk first and goes on only if you agree. A Gemini API key and Vertex AI need none of this.

## Settings {#settings}

Settings are grouped by area: **Preferences**, **Models**, **Kernel**, **Details**, **Capabilities** and **System**. A search box at the top of the sidebar finds any setting.

- **Kernel** lists each feature as one row with a switch; its decision points are listed under it, each with its own switch. The judges page chooses who answers.
- **Capabilities** lists skills by source (mu's own, the project's or inherited from Claude Code, Codex and Cursor), lets you add a skill folder and remove your own; and lists MCP servers, each with a switch. Keys passed to a server as arguments are masked.
- **System** holds the notification sound and keeping the computer awake.
- Everything the settings change is written to `~/.mu/agent/mu.json`, so it holds for the command line too, and vice versa.

The interface comes in 13 languages, including Simplified and Traditional Chinese, English, Japanese and Korean.

## Importing conversations {#import}

Conversations from Claude Code, the Codex CLI and ZCode can be imported and continued in mu with their full history: messages, tool calls, thinking and images. When the first-run guide finds some, it offers to import them on its first screen; Settings has the same option. Importing a conversation again brings over what's new in it. The command line does it with `mu import --list` and `mu import <file>`.

## Updates, proxies and logs {#updates}

- **Updates.** The app tells you when a new release is out, with its size; it downloads only after you agree and installs at the next restart.
- **Proxy.** With no `HTTPS_PROXY` set, mu, the sign-ins and the key checks in the app follow the system proxy.
- **Logs.** Settings → About opens the log folder.
