---
title: The desktop app
summary: The conversation, the work panel beside it, the send box, settings and how the app shares everything with the command line.
---

The desktop app runs on macOS, Windows and Linux and bundles mu and its runtime. It runs the same agent and judgment kernel as the command line, in a process of its own, so everything the command line can do, the app can do. It adds a work panel next to the conversation, so you can see what the agent and the judge are doing.

## The conversation {#conversation}

- **One list for both.** The conversation list is mu's own session files. A session you started in a terminal shows up in the app, and one started in the app can be continued with `mu -c` or `mu -r`.
- **Quiet by default.** What mu says to the model on its own, such as a reminder to verify, a goal continuation, a new error or a rewind, shows as a single line in your language; the original text is one click away. A run of tool calls is folded into one line that says what was done, such as *read 3 files · ran 1 command*.
- **Fork from any message.** Each message has a fork button that starts a new branch from that point.
- **Row menu.** Rename, pin, mark as unread, archive or delete a conversation.
- **Notifications.** When another conversation finishes or waits for you, the system tells you.

## The send box {#send-box}

- **Permission mode.** Full access, *Judge mode* or *Ask first*, switched per conversation. See [Permissions and safety](@docs/permissions).
- **Goal.** Set a goal, and the agent keeps working until it holds. While a goal runs, a goal line above the box shows its state. See [Goal mode](@docs/goal).
- **Context ring.** How full the context is, at a glance.
- **Queued messages.** A message sent while the agent works waits in a queue and can be taken back before it is used.
- **Slash commands.** Type `/` for mu's and pi's commands, the same as in the terminal.

<kbd>⌘K</kbd> (<kbd>Ctrl K</kbd> on Windows and Linux) opens the command palette.

## The work panel {#panel}

The panel beside the conversation has eight tabs:

| Tab | What it shows |
| --- | --- |
| **Board** | The [plain-language board](@docs/board): how far the work is, what's happening now, what waits for you and a running account |
| **Judge** | The live ledger: every verdict with its question, its answer, its probability and how long it took |
| **Hive** | The [hive](@docs/hive): each bee, what it's doing and a map of which finding went to whom |
| **Lessons** | The [lessons library](@docs/lessons): what mu has learned, how often each lesson was recalled and followed; edit or retire one |
| **Files** | The project's files |
| **Preview** | A preview of the page or file being worked on |
| **Source** | The folder's git changes and their diffs |
| **Browser** | The built-in browser the agent drives step by step, with its goal; pause it, take over or stop it |

The built-in browser keeps its own profile and never touches your own browser. Each step shows what was clicked and how sure the judge was; submitting, paying or deleting stops and asks you first.

## Signing in to models {#models}

Settings → Models signs you in without leaving the app: a ChatGPT, Claude, Grok or Google (Gemini CLI or Antigravity) subscription, or an API key for any provider pi supports. A server of your own works too, including a plain `http://` address on your machine or network. The thinking level of each model can be changed there.

Google's two sign-ins are Google's logins for its own tools. Using them from another program may break Google's terms, so the app states the risk first and goes on only if you agree. A Gemini API key and Vertex AI need none of this.

## Settings {#settings}

Settings are grouped by area, each page short: **Preferences**, **Models**, **Kernel**, **Details**, **Capabilities** and **System**. A search box at the top of the sidebar finds any setting.

- **Kernel** lists each feature as one row with a switch; its decision points are listed under it, each with its own switch. The judges page chooses who answers.
- **Capabilities** lists skills by source (mu's own, the project's or inherited from Claude Code, Codex and Cursor), lets you add a skill folder and remove your own; and lists MCP servers, each with a switch. Keys passed to a server as arguments are masked.
- Everything the settings change is written to `~/.mu/agent/mu.json`, so it holds for the command line too, and vice versa.

Light and dark follow the system. The interface comes in 13 languages, including Simplified and Traditional Chinese, English, Japanese and Korean.

## Importing conversations {#import}

Conversations from Claude Code, the Codex CLI and ZCode can be imported and continued in mu, with their whole history: messages, tool calls, thinking and images. The first-run guide offers this on its first screen when it finds some, under each app's icon, and Settings has it too. Importing a conversation again brings over what's new in it. The command line does it with `mu import --list` and `mu import <file>`.

## Updates, proxies and logs {#updates}

- **Updates.** The app tells you when a new release is out, with its size; it downloads only after you agree and installs at the next restart.
- **Proxy.** With no `HTTPS_PROXY` set, mu, the sign-ins and the key checks in the app follow the system proxy.
- **Logs.** Settings → About opens the log folder.
