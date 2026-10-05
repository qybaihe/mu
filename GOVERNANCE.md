# Governance

## Roles

- **Maintainers** review and merge pull requests, triage issues, decide what goes into a release, publish releases, and enforce the [Code of Conduct](CODE_OF_CONDUCT.md). The current maintainer is [@qybaihe](https://github.com/qybaihe), who started the project.
- **Contributors** are everyone who opens an issue, a pull request or a discussion, reviews, tests or translates.

## How decisions are made

Most decisions happen in the open, on the issue or pull request they concern. Maintainers aim for agreement with the people involved; when there is none, the maintainers decide and say why.

Larger changes (a new feature or setting, a new decision point, a change to what leaves the user's machine, a new dependency) are discussed in an issue before code is written. What decides them, in order:

1. What users of mu need, and what they can see and control. A verdict changes what the model does, never whether it asks the user.
2. Measurements over opinions: a judge or a decision point is switched on by default only with numbers from real sessions.
3. Staying close to pi and AionUi, so that their releases can keep being merged.

## Becoming a maintainer

Contributors who have made several substantial contributions, review others' work with care, and know a part of the code well may be invited to become maintainers by the existing maintainers. Maintainers who are inactive for a long time may step back, and are welcome to return.

## Upstream projects

mu is built on [pi](https://github.com/earendil-works/pi) (MIT) and [AionUi](https://github.com/iOfficeAI/AionUi) (Apache 2.0). Their maintainers govern their projects; mu follows their releases, reports problems that belong upstream, and keeps their licenses and notices.

## Changes to this document

Changes are proposed in a pull request and merged by a maintainer after at least a week of open discussion.
