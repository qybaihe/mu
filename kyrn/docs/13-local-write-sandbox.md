# Local write sandbox

Status: steps 1 and 2 of the rollout are built (`features.confine`, off by default, 2026-11-04): the floor, the denial line and the way out (`outside: true`). Step 3 is proposed.

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

Linux, 2026-11-04: bubblewrap 0.8.0 in a Debian 12 container (`node:24-bookworm`) on an Ubuntu 24.04 kernel (6.8), with the floor's own arguments (`bwrapArgs`) and the project at `/home/node/work/app`.

- **Unprivileged.** Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns = 1`), and a container's own cannot be had either. The probe fails with `bwrap: setting up uid map: Permission denied`, and the floor refuses every command, which is what it should do.
- **bwrap installed setuid** (as some distributions ship it), so it needs no unprivileged user namespaces:

| command | result |
| --- | --- |
| write inside the project, write under `/tmp` | ok |
| `echo x > ~/outside.txt` | `Read-only file system` |
| node's `writeFileSync`, Python's `open(…, "w")` outside the project | `EROFS`, `OSError: [Errno 30] Read-only file system` |
| append to `.git/config`, write `.git/hooks/pre-commit` | `Read-only file system` |
| `git config user.name x` | `could not write config file .git/config: Device or resource busy`: git renames `config.lock` over the file, which is a mount point of its own |
| `ls /proc` | 5 processes: the floor's own PID namespace (`--unshare-pid`) |

The denial line reads all of them, `EBUSY` on a read-only part included.

## Design

### Where the floor goes

The programs the agent chooses: `bash`, `bg_start`, and the program `debug_start` debugs. The debug adapter starts inside the floor, and the program is its child, so it can write no more than a command could; a refused write gets the same line in the debugger's result, above the program's output. mu's own programs stay outside: the tool packs (`gh`, `git` with fixed arguments), language servers, MCP servers and subagents, which are mu processes and confine their own commands.

The seam already exists. The Nebius feature replaces `bash` with `createBashToolDefinition(cwd, { operations })`. A local sandbox wraps `createLocalBashOperations()` the same way: `exec(command, cwd, options)` runs `sandbox-exec -p <profile> <shell> -c <command>`, or `bwrap … -- <shell> -c <command>`, with the shell and prefix the foreground tool uses (`background.ts` already reads them). The profile goes on the command line rather than in a file, since a file in a writable folder could be rewritten by the command it confines, for the next one. Only one of the two sandboxes can be on: the Nebius one takes precedence, since nothing runs locally then.

### Profiles

- **macOS.** The profile above, plus the cache folders that exist on the machine: `~/.npm`, `~/.cache`, `~/Library/Caches`, `~/.cargo/registry`, `~/.cargo/git`, `~/go/pkg/mod`, `~/.gradle/caches`, `~/.m2/repository`, `~/.pnpm-store`, `~/.bun/install/cache`, `~/.yarn/berry/cache`. `features.confine.writable` adds more. Neither the home folder itself nor mu's own folder (`~/.mu`) can be added that way.
- **Linux.** `bwrap --ro-bind / / --dev /dev --proc /proc --bind <project> <project> --bind <tmp> <tmp> --ro-bind-try <project>/.git/hooks <project>/.git/hooks --ro-bind-try <project>/.git/config <project>/.git/config --unshare-pid --die-with-parent --`, with the same caches bound writable. `--unshare-pid` is required: without it, `/proc/<pid>/root` of a process outside the sandbox is a way around the file view.
- **Windows.** No sandbox. With the feature on, every command is refused, and the status line says why.
- **Optional, off by default.** Network off (`(deny network*)` except localhost; `--unshare-net`), which breaks `npm install`. Denying reads of `~/.ssh`, `~/.aws`, `~/.config/gh` and `~/.mu`, which complements the credential tripwire; git over ssh then needs the agent socket instead of key files.

### Probe, and failing closed

At session start mu runs `/usr/bin/true` under the profile. The project is taken as its real path, so a symlink to elsewhere confines to where it leads. If the probe fails while the sandbox is on, because `sandbox-exec` or `bwrap` is missing or user namespaces are restricted, or if the project folder is `/` or holds the home folder, `bash`, `bg_start` and `debug_start` refuse every command: "mu: the write sandbox is on but cannot start here (<reason>). Nothing ran." mu never quietly falls back to running unconfined. The status line says why.

### When a write is refused

The model has to know the sandbox refused a write, or it will look for another way to make the same change.

- **Not run, or refused.** If the runner fails before the command starts (a bad profile, `bwrap` cannot set up namespaces), the result says so: the command did not run. If the command ran and a write was refused, the result gets a fixed line (built, `refusedWrites` and `refusalNote` in `floor.ts`). It is added when a line of the output says `Operation not permitted`, `EPERM`, `Read-only file system` or `EROFS` and names a path outside every writable folder, or in a read-only part, or says `Device or resource busy` (`EBUSY`) and names a read-only part, resolved to its real location: `[mu write sandbox: <path> is outside what commands may write here (this project, the temporary folders and package caches), so the write was refused. Do the work inside the project if you can. If the task needs this write, run the command again with outside: true and a reason: it then runs outside the sandbox, once, if the judge or the user allows it. A folder the task keeps needing, the user can allow with features.confine.writable.]`, and for `.git/hooks` or `.git/config` a line that names the same way out. With the permission feature off nobody can allow the way out, and the line says instead to tell the user what to run or which folder to allow.
- **A way out (built).** The confined `bash` and `bg_start` have two optional parameters, `outside: true` and `reason`. The permission gate decides such a call, and the tool runs it unconfined only when the gate allowed that call, with that command (`runtime.floorExit`).
  - **Who decides.** The judge first (`tool.approval`, `where`: outside the write sandbox, a command that can write anywhere this computer lets it), then the user when the judge is not sure. It is allowed once, never for the session, and each answer is kept (`kyrn.outcome` with `outsideFloor: true`). A flagged, credential-carrying or protected call follows its own rules as before.
  - **In every mode.** Full access asks too, the judge and then the user, or refuses where nobody can be asked: a way out allowed without a question would leave the floor bounding nothing. Minimal permissions ask the user directly, as for everything else.
  - **The reason.** The user sees it, in the question. The judge does not: the model wrote it, and only the user's words vouch for a call. The judge weighs the command against the task and what the user said, as for any other call.
  - **What stays inside.** A call without a reason is refused before anyone is asked. A command that only looks runs inside the floor, which lets it read everything, and nobody is asked. With the permission feature off, nobody can allow the way out, so `outside: true` runs inside the floor and the result says why.
  - **Background jobs.** A `bg_start` call asks out the same way and is decided the same way. A job let out runs outside the floor for as long as it runs, so the judge and the user are asked about a server or a watcher, not about one command; its output gets no denial line. The user's own `/jobs start` runs outside the floor, as a command typed into a terminal does.

### With the permission modes

There are two independent settings: the sandbox (`features.confine.enabled`) and the permission mode (`full`, `judge`, `ask`).

- **First version (built).** Every mode asks what it asks today, and the sandbox bounds what an approved command can do. The way out is asked about in every mode, full access too.
- **Later, after measuring.** In Judge mode with the floor on, a command could run without the judge when it neither asks to go outside nor carries a credential, since the floor bounds its writes. The judge's work narrows to the way out and to actions outside this computer. That would make Judge mode faster and cheaper. It needs the denial line and the way out to work well first.

## Rollout

1. **Profiles, probe and confined `bash`/`bg_start`** behind `features.confine: { "enabled": true }`, off by default. Built: `packages/kyrn-judge/src/confine/floor.ts` and `packages/kyrn-judge/src/extension/features/confine.ts`.
   - Unit tests cover the generated profile and bwrap arguments.
   - A macOS-only test runs real `sandbox-exec` (CI's harness job is Linux, so that test runs locally and on macOS runners).
   - A Linux test runs only where `bwrap` works.
2. **The denial line and `outside: true`**, through the judge. Built, for `bash` and `bg_start`. A background job's output gets the same line where it is read (`bg_output`), among mu's own notes above the job's output, with the same way out. A debugging run's results (`debug_start`, `debug_step`) get it the same way, above the program's output, and have no way out.
3. **Turn it on for mu's own runs** (TB2.1, mubench real tasks) and count:
   - commands refused that the task needed;
   - which cache folders were missing;
   - how often the way out was asked for and allowed.

   Then decide whether the floor is on by default on macOS.

## Open questions

- Debuggers that attach with the operating system's debugging interface. `debug_start` runs inside the floor (measured on macOS 27 with debugpy 1.8.21: it stops at breakpoints and reads locals as before, the program writes in the project, and its write to the home folder is refused with `PermissionError: [Errno 1] Operation not permitted`; debugpy needs no folder outside the floor). lldb-dap and delve are not measured: lldb on the machine measured cannot debug a process without macOS developer mode, with or without the floor, and delve was not installed. Their caches (Go's build cache, lldb's module cache) are under `~/Library/Caches` and `~/.cache`, which the floor lets them write; whether Seatbelt lets them attach to the program is the open part.
- `git push -u` and `git remote add` will ask for the way out every time. One option is a narrower exception that lets git write `.git/config` for `branch.*` and `remote.*` keys only, through a wrapper; Seatbelt cannot tell keys apart.
