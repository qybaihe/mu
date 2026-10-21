# Security policy

## Reporting a vulnerability

Please report security problems **privately**, through the repository's [private report form](https://github.com/qybaihe/mu/security/advisories/new) (Security → Report a vulnerability). Only the maintainers can read it. Don't open a public issue, pull request or discussion about it.

Include:

- what an attacker can do, and what they need first;
- steps to reproduce, a proof of concept, or logs;
- the version (`mu --version`, or the desktop app's About page), the platform, and the relevant configuration (permission mode, judges);
- any mitigation you know of.

mu is maintained by a small team. You can expect an acknowledgment within a few days and a first assessment within two weeks. We'll agree on a disclosure date with you, credit you in the advisory unless you'd rather not be named, and publish a fixed release before the details.

请通过仓库的[私密报告表单](https://github.com/qybaihe/mu/security/advisories/new)报告安全问题，不要公开发 issue。中文报告同样欢迎。

## Supported versions

mu is in pre-release (0.1.x). Fixes go into `main` and the next release; older releases aren't patched. Please check that the problem exists on the latest release or on `main`.

| Version | Supported |
| --- | --- |
| Latest 0.1.x release (desktop app and `mu-agent` on npm) | Yes |
| `main` | Yes |
| Earlier releases | No: update first |

## Where mu draws its boundaries

mu is a coding agent that runs on your machine, as you. Like pi, which it's built on, it treats your user account, your files and your configuration as one trust boundary: it can run commands and change files, and it isn't a sandbox. Run it in a container or a virtual machine when you need isolation.

On top of that, mu adds guards. They lower risk but aren't guarantees. Reports that one of them can be talked around are welcome, and are judged by their impact:

- **Permission modes.** *Full access*, *Jev approves* and *Ask first* decide what runs without asking ([details](kyrn/docs/features/permissions.md)). Commands flagged by the risk rules (`rm -rf`, force pushes, `sudo`, running a downloaded script, and others) can never be allowed for a whole conversation, and calls that touch mu's own settings folder are asked about every time.
- **Your constraints.** What you said not to do is checked before every call that changes something, in every mode.
- **Prompt-injection screening.** Web pages, search results and MCP output are screened passage by passage (`tool.injection`), and passages containing instructions aimed at the AI are withheld from the model. A judge can miss one: this is defense in depth, not a filter to rely on by itself.
- **Projects are untrusted by default.** MCP servers defined by a project aren't started until you approve them, and a project can't point the judge at an endpoint of its choosing.
- **Secrets.** Keys stay on your machine. Credentials are masked before text reaches the judge, the board or a session title; `.env` and key files are kept out of checkpoints; and a key set for one judge service is never sent to another.

### What leaves your machine

- Your conversation goes to the model provider you chose, as with any coding agent.
- The judge sees only the fields each question needs. With no judge key, those questions go to the free Jev on OpenCode Zen; with a key, to the service the key belongs to. `MU_JUDGE=off`, or the local judge (Laya), keeps them on your machine.
- Nothing is downloaded without your consent: the local judge's model, browser runtimes and app updates all ask first.
- The desktop app sends no telemetry and no crash reports.

## In scope

- The `mu` launcher and the judgment kernel (`kyrn/`, `packages/kyrn-judge/`), the `mu-agent` npm package, and the desktop app (`desktop/`), as released here.
- A way past one of the guards above that doesn't need prior write access to your machine: for example, a web page or an MCP result that makes mu run a command the permission mode should have asked about, or that gets a credential sent to a third party.
- Leaks of credentials or conversation content to a party you didn't choose.
- The desktop app's update and download paths.

## Out of scope

- Behavior that requires an attacker who can already write to your home directory, your shell configuration, mu's settings (`~/.mu`), project files you chose to trust, or the environment.
- Commands you allowed, or that full access lets run, doing what they do.
- A model or a judge simply being wrong, without a boundary being crossed.
- Extensions, skills, packages and MCP servers you installed or approved yourself.
- Vulnerabilities in pi that mu doesn't change: please also report those [to pi](https://github.com/earendil-works/pi/security); we'll pick up the fix.
- Third-party services (model providers, TypeSafe, OpenCode, Cloudflare).
