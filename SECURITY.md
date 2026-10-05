# Security policy

## Reporting a vulnerability

Please report security problems **privately**, through the repository's [private report form](https://github.com/qybaihe/mu/security/advisories/new) (Security → Report a vulnerability). Only the maintainers can read it. Do not open a public issue, pull request or discussion about it.

Include:

- what an attacker can do, and what they need first;
- steps to reproduce, a proof of concept or logs;
- the version (`mu --version`, or the desktop app's About page), the platform, and the configuration that matters (permission mode, judges);
- any mitigation you know of.

mu is maintained by a small team. You can expect an acknowledgement within a few days and a first assessment within two weeks. We will agree on a disclosure date with you, credit you in the advisory unless you prefer not to be named, and publish a fixed release before the details.

请通过仓库的[私密报告表单](https://github.com/qybaihe/mu/security/advisories/new)报告安全问题，不要公开发 issue。中文报告同样欢迎。

## Supported versions

mu is in pre-release (0.1.x). Fixes go into `main` and the next release; older releases are not patched. Please check that a problem exists on the latest release or on `main`.

| Version | Supported |
| --- | --- |
| Latest 0.1.x release (desktop app and `mu-agent` on npm) | Yes |
| `main` | Yes |
| Earlier releases | No: update first |

## How mu draws its boundaries

mu is a coding agent that runs on your machine, as you. Like pi, which it is built on, it treats your user account, your files and your configuration as inside one trust boundary: it can run commands and change files, and it is not a sandbox. Run it in a container or a virtual machine when you need isolation.

On top of that, mu adds guards. They lower risk; they are not guarantees, and a report that one of them can be talked around is welcome but is judged by its impact:

- **Permission modes.** *Full access*, *Jev approves* and *Minimal permissions* decide what runs without asking ([details](kyrn/docs/features/permissions.md)). Commands flagged by the risk rules (`rm -rf`, force pushes, `sudo`, running a downloaded script and others) are never allowed for a whole conversation, and calls that touch mu's own settings folder are asked about every time.
- **Your constraints.** What you said not to do is checked before every call that changes something, in every mode.
- **Prompt-injection screening.** Web pages, search results and MCP output are screened passage by passage (`tool.injection`); passages carrying instructions aimed at the AI are withheld from the model. A judge can miss one: this is defence in depth, not a filter you can rely on alone.
- **Projects are untrusted by default.** MCP servers defined by a project are not started until you approve them, and a project cannot point the judge at an endpoint of its choosing.
- **Secrets.** Keys stay on your machine. Credentials are masked before text reaches the judge, the board or a session title, `.env` and key files are kept out of checkpoints, and a key set for one judge service is never sent to another.

### What leaves your machine

- Your conversation goes to the model provider you chose, as with any coding agent.
- The judge sees only the fields each question needs. With no judge key, those questions go to the free Jev on OpenCode Zen; with a key, to the service it belongs to. `MU_JUDGE=off`, or the local judge (Laya), keeps them on your machine.
- Nothing is downloaded without your consent: the local judge's model, browser runtimes and app updates all ask first.
- The desktop app sends no telemetry and no crash reports.

## In scope

- The `mu` launcher and the judgment kernel (`kyrn/`, `packages/kyrn-judge/`), the `mu-agent` npm package and the desktop app (`desktop/`), as released here.
- A way past a guard above that needs no prior write access to your machine: for example, a web page or an MCP result that makes mu run a command the permission mode should have asked about, or that gets a credential sent to a third party.
- Leaks of credentials or conversation content to a party you did not choose.
- The update and download paths of the desktop app.

## Out of scope

- Behaviour that needs an attacker to already write to your home directory, your shell configuration, mu's settings (`~/.mu`), the project's files you chose to trust, or the environment.
- Commands you allowed, or that full access lets run, doing what they do.
- A model or a judge simply being wrong, without a boundary being crossed.
- Extensions, skills, packages and MCP servers you installed or approved yourself.
- Vulnerabilities in pi or AionUi that mu does not change: please report those [to pi](https://github.com/earendil-works/pi/security) or [to AionUi](https://github.com/iOfficeAI/AionUi/security) as well; we will take their fixes.
- Third-party services (model providers, TypeSafe, OpenCode, Cloudflare).
