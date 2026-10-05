# Releasing

For maintainers. mu ships two things that are versioned separately:

- **The desktop app**, `vX.Y.Z` tags on this repository, published as GitHub pre-releases with installers for six platforms.
- **The `mu-agent` npm package**, the command line, which the app also carries inside it. Its version is in `kyrn/npm/package.template.json` and its changelog in [kyrn/npm/CHANGELOG.md](../kyrn/npm/CHANGELOG.md).

## What CI does

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every push to `main` and every pull request | `npm run check` and the tests; the app's lint, format, i18n, types and unit tests; MCP conformance |
| `windows-tests.yml`, `windows-permission.yml` | pushes and pull requests | the kernel's and the app's unit tests on Windows; the start chain and a permission round trip |
| `npm.yml` | pushes to `main` that touch the harness | builds and packs `mu-agent`, installs the tarball and runs it on Linux (Node 22.19), macOS and Windows; the tarball is kept as an artifact |
| `desktop.yml` | pushes to `main` that touch `desktop/`, and `v*` tags | packs this commit's mu, builds the app for macOS, Windows and Linux (x64 and arm64), signs and notarizes the macOS builds, holds a real conversation in each built app; on a tag, publishes the release |
| `npm-audit.yml` | daily | audits the dependencies |

## Releasing the npm package

1. Add the release's section to `kyrn/npm/CHANGELOG.md` (move `[Unreleased]` under a version and date) and bump the version.
2. Push to `main` and wait for `npm.yml` to pass on all three systems.
3. Publish the tarball that CI built and tested (the `mu-agent-tarball` artifact), not one built locally, from an account with publish rights: `npm publish mu-agent-X.Y.Z.tgz`.
4. Check the registry's shasum against the tarball's, and tag the commit `mu-agent-vX.Y.Z` (a tag only, no GitHub release).

## Releasing the desktop app

1. Make sure the app carries the intended `mu-agent` (the build packs the mu of the same commit) and that `desktop.yml` passed on `main`, including the conversations held in the built apps.
2. Update [CHANGELOG.md](../CHANGELOG.md): move `[Unreleased]` under the new version.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag run builds every platform again, writes `SHA256SUMS` and the update feeds, and creates the pre-release.
4. Read the release page: every installer, `SHA256SUMS`, the four `latest*.yml` update feeds. Edit the notes so they say what changed for users.
5. An installed earlier version offers the update after the user agrees; check that it does.

Releases stay pre-releases while mu is 0.x.

## Secrets

macOS signing and notarization use the repository secrets `BUILD_CERTIFICATE_BASE64`, `P12_PASSWORD` and `KEYCHAIN_PASSWORD` and the notarization credentials. Workflows from forks never see them: pull requests from forks build and test, they do not sign or publish.
