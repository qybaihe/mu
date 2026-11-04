# Local write sandbox

Status: step 1 of the rollout is built (`features.confine`, off by default, 2026-11-04), and so is the denial line of step 2. The way out (`outside: true`) and step 3 are proposed.

The judge and the permission modes run inside mu's own process, and most of what they decide is a model's judgment. This proposal adds a floor that does not depend on any model being right: the commands the agent runs can write only to the project and the temporary folders, enforced by the operating system.

## Why

A judge only weighs what it is shown. One chain it cannot see:

1. The agent edits `package.json` so that `test` runs `node scripts/x.js`, and writes `scripts/x.js`. Both are edits inside the project, which Judge mode lets through without a judgment.
2. It runs `npm test`. That is a check: the judge reads `bash: npm test` and approves it at 0.7.
3. `scripts/x.js` appends to `~/.zshrc` or `~/.ssh/authorized_keys`.

No wording of the approval question fixes this, because the judge never reads `scripts/x.js`. With a write floor, step 3 fails with `Operation not permitted`. A prompt injection that talks the agent into the same chain fails the same way.

The credential work (#310) covers sending keys away. Nothing yet covers writing outside the project.

## What was measured

macOS 27.0.1, `/usr/bin/sandbox-exec` (Seatbelt), 2026-11-04. The profile allows everything, denies every write, allows writes to the project, the temporary folders and the few devices a shell uses, then denies writes to the project's `.git/hooks` and `.git/config` again. In Seatbelt the later rule wins, so the last two stay read-only inside a writable project.

```scheme
(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath (param "PROJECT"))
  (subpath (param "TMP"))
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))
(deny file-write*
  (subpath (string-append (param "PROJECT") "/.git/hooks"))
  (literal (string-append (param "PROJECT") "/.git/config")))
```

Run as `sandbox-exec -f profile.sb -D PROJECT=<project> -D TMP=<TMPDIR> /bin/bash -c '<command>'`:

| command | result |
| --- | --- |
| `echo hi > ~/.probe` | `Operation not permitted` |
| `node -e 'fs.writeFileSync(os.homedir() + "/.probe", "x")'` | refused too: children inherit the profile |
| append to `.git/hooks/pre-commit`, to `.git/config` | `Operation not permitted` |
| write, `mkdir` inside the project, write under `$TMPDIR` | ok |
| `git add`, `git commit`, `git checkout -b` in an existing repository | ok |
| `git config user.name x`, `git remote add origin …` | `could not write config file .git/config` |
| `git init` in a new folder | refused: it writes `.git/hooks` |
| `npm install is-number` | `EPERM` on `~/.npm/_cacache/tmp/…` |
| the same with `npm_config_cache=<project>/.npm-cache` | ok |
| `python3 -m venv .venv` | ok |

Two consequences shape the design. Package managers write their caches under the home folder, so the profile needs a list of writable cache folders. Anything that writes `.git/config` (`git config`, `git remote add`, `git push -u`) needs a way out that the user or the judge approves.

Linux (`bwrap`) was not measured: this machine has none, and Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns`). bwrap needs those namespaces unless it is installed setuid.

## Design

### Where the floor goes

The commands the agent chooses: `bash` and `bg_start`. The program `debug_start` starts is not confined yet (see the open questions). mu's own programs stay outside: the tool packs (`gh`, `git` with fixed arguments), language servers, MCP servers and subagents, which are mu processes and confine their own commands.

The seam already exists. The Nebius feature replaces `bash` with `createBashToolDefinition(cwd, { operations })`. A local sandbox wraps `createLocalBashOperations()` the same way: `exec(command, cwd, options)` runs `sandbox-exec -p <profile> <shell> -c <command>`, or `bwrap … -- <shell> -c <command>`, with the shell and prefix the foreground tool uses (`background.ts` already reads them). The profile goes on the command line rather than in a file, since a file in a writable folder could be rewritten by the command it confines, for the next one. Only one of the two sandboxes can be on: the Nebius one takes precedence, since nothing runs locally then.

### Profiles

- **macOS.** The profile above, plus the cache folders that exist on the machine: `~/.npm`, `~/.cache`, `~/Library/Caches`, `~/.cargo/registry`, `~/.cargo/git`, `~/go/pkg/mod`, `~/.gradle/caches`, `~/.m2/repository`, `~/.pnpm-store`, `~/.bun/install/cache`, `~/.yarn/berry/cache`. `features.confine.writable` adds more. Neither the home folder itself nor mu's own folder (`~/.mu`) can be added that way.
- **Linux.** `bwrap --ro-bind / / --dev /dev --proc /proc --bind <project> <project> --bind <tmp> <tmp> --ro-bind-try <project>/.git/hooks <project>/.git/hooks --ro-bind-try <project>/.git/config <project>/.git/config --unshare-pid --die-with-parent --`, with the same caches bound writable. `--unshare-pid` is required: without it, `/proc/<pid>/root` of a process outside the sandbox is a way around the file view.
- **Windows.** No sandbox. With the feature on, every command is refused, and the status line says why.
- **Optional, off by default.** Network off (`(deny network*)` except localhost; `--unshare-net`), which breaks `npm install`. Denying reads of `~/.ssh`, `~/.aws`, `~/.config/gh` and `~/.mu`, which complements the credential tripwire; git over ssh then needs the agent socket instead of key files.

### Probe, and failing closed

At session start mu runs `/usr/bin/true` under the profile. The project is taken as its real path, so a symlink to elsewhere confines to where it leads. If the probe fails while the sandbox is on, because `sandbox-exec` or `bwrap` is missing or user namespaces are restricted, or if the project folder is `/` or holds the home folder, `bash` and `bg_start` refuse every command: "mu: the write sandbox is on but cannot start here (<reason>). Nothing ran." mu never quietly falls back to running unconfined. The status line says why.

### When a write is refused

The model has to know the sandbox refused a write, or it will look for another way to make the same change.

- **Not run, or refused.** If the runner fails before the command starts (a bad profile, `bwrap` cannot set up namespaces), the result says so: the command did not run. If the command ran and a write was refused, the result gets a fixed line (built, `refusedWrites` and `refusalNote` in `floor.ts`). It is added when a line of the output says `Operation not permitted`, `EPERM`, `Read-only file system` or `EROFS` and names a path outside every writable folder, or in a read-only part, resolved to its real location: `[mu write sandbox: <path> is outside what commands may write here (this project, the temporary folders and package caches), so the write was refused. Do the work inside the project, or tell the user which folder the task needs: they can allow it with features.confine.writable.]`, and for `.git/hooks` or `.git/config` a line that says to tell the user what to run. Once the way out exists, the line will name it instead.
- **A way out.** `bash` gets two optional parameters, `outside: true` and `reason`. Such a call goes to the judge first (`tool.approval`, with `where: "outside the write sandbox"` and the reason in the state), and to the user when the judge is not sure. It is allowed once only, never for the session. A flagged or credential-carrying call follows its own rules as before.

### With the permission modes

There are two independent settings: the sandbox (`features.confine.enabled`) and the permission mode (`full`, `judge`, `ask`).

- **First version.** The floor only. Every mode asks what it asks today, and the sandbox bounds what an approved command can do.
- **Later, after measuring.** In Judge mode with the floor on, a command could run without the judge when it neither asks to go outside nor carries a credential, since the floor bounds its writes. The judge's work narrows to the way out and to actions outside this computer. That would make Judge mode faster and cheaper. It needs the denial line and the way out to work well first.

## Rollout

1. **Profiles, probe and confined `bash`/`bg_start`** behind `features.confine: { "enabled": true }`, off by default. Built: `packages/kyrn-judge/src/confine/floor.ts` and `packages/kyrn-judge/src/extension/features/confine.ts`.
   - Unit tests cover the generated profile and bwrap arguments.
   - A macOS-only test runs real `sandbox-exec` (CI's harness job is Linux, so that test runs locally and on macOS runners).
   - A Linux test runs only where `bwrap` works.
2. **The denial line and `outside: true`**, through the judge. The denial line is built, for `bash`; a background job's output is read later, by `bg_log`, and gets no line yet.
3. **Turn it on for mu's own runs** (TB2.1, mubench real tasks) and count:
   - commands refused that the task needed;
   - which cache folders were missing;
   - how often the way out was asked for and allowed.

   Then decide whether the floor is on by default on macOS.

## Open questions

- `debug_start`: debugpy and the Node inspector may write caches of their own. Step 1 leaves debuggers unconfined; list those caches before confining them.
- `git push -u` and `git remote add` will ask for the way out every time. One option is a narrower exception that lets git write `.git/config` for `branch.*` and `remote.*` keys only, through a wrapper; Seatbelt cannot tell keys apart.
