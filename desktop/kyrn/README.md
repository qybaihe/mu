# KYRN Desktop — development preview

A dedicated KYRN product target inside the desktop app's source tree. The
surrounding app is reference source only here: **do not run its root `npm start`**.
This target has its own entry point, lockfile and dependency graph.

## Start

Run `./start.command` (Node 24), or double-click it in Finder.
`KYRN_ROOT` may point to a different KYRN source checkout. By default, the
adjacent `../KYRN` checkout is used. Select a project folder to create a task.

For a fresh installation:

```sh
npm ci --ignore-scripts --workspaces=false
node scripts/runtime.mjs
./start.command
```

The runtime setup downloads Electron from its official releases and checks the
package's pinned checksums; npm lifecycle scripts stay disabled. The dev server
binds only to `127.0.0.1:4317`. This is a native Electron development app, not yet
a signed/notarized distributable.

## Product boundary

- The desktop app's CodeMirror editor, theme and language loader
  (`src/vendor/codeEditor/`) are reused under Apache-2.0.
- KYRN owns the conversation UI, judgment timeline, swarm cards and RPC host.
- No local backend service, ACP backend, external coding-agent integration, Team MCP server,
  office assistant catalog, bot/channel adapter, provider SDK, analytics or
  promotional entry is installed or imported by this target.
- Only the KYRN launcher starts agents. Its existing model configuration and
  OAuth login remain authoritative. The judge selection stays in KYRN's config.
- Keys are never returned to the renderer. BrowserWindow uses context isolation,
  sandboxing, no Node integration, a restricted IPC surface and no navigation.

## Implemented slice

- Project selection; desktop task history and restart/resume of its pi session.
- Real model list from the local CLI; streaming chat, tool results, Queue/Steer,
  abort and extension approval dialogs.
- Native judge pending / verdict / late / fallback cards and decision timeline.
  These are actual typed outputs, not inferred chain-of-thought.
- Hive/delegate snapshots as per-bee cards, shared findings and wrap-up/kill.
- Git file listing, code editing with stale-revision protection, worktree/staged
  Diff display. Credential-like files are excluded from normal preview.
- Light/dark appearance, no external fonts or image fetches.

## Storage and limits

Desktop catalog/events: `~/Library/Application Support/KYRN Desktop` on macOS.
Authoritative model sessions: KYRN's normal agent directory. One live process per
desktop task; a single-instance app lock prevents duplicate desktop owners.
Closing the window leaves the host alive; quitting asks to stop running tasks.

This first slice is **not yet simultaneous CLI/App attachment to an existing
CLI process**. Do not concurrently resume the same desktop session in another
CLI. A shared daemon with command ownership and cursor-based reconnection is
the next synchronization milestone. Event replay is bounded to 6,000 events;
older authoritative transcripts remain in pi's session files. Browser tabs,
terminal PTYs, full IDE language services, packaging and update delivery are
not implemented in this target yet.

## Verification

```sh
npm run check
node --test test/files.test.mjs test/state.test.mjs test/rpc-host.test.mjs
npm audit
```

See `THIRD_PARTY_NOTICES.md` and `LICENSE` for upstream attribution.
