/**
 * Cases for skill-capture-bench.ts: digests of runs as mu writes them (memory/phrasing.ts `turnDigest`). A procedure
 * is a run whose steps would do another task of its kind; a one-off is a run for this task only; covered is a
 * procedure that an installed skill already describes.
 */
export interface CaptureCase {
	readonly id: string;
	readonly label: "procedure" | "one_off" | "covered";
	readonly skills: readonly { readonly name: string; readonly description: string }[];
	readonly digest: string;
}

const digest = (request: string, steps: readonly string[], final: string): string =>
	[`user: ${request}`, ...steps.map((step) => `step: ${step}`), `assistant: ${final}`].join("\n");

const NONE: CaptureCase["skills"] = [];
const RELEASE_SKILL = [
	{
		name: "release-npm",
		description: "Release a new version of this package to npm: bump, changelog, build, tag, publish, verify.",
	},
];

export const CASES: readonly CaptureCase[] = [
	{
		id: "release",
		label: "procedure",
		skills: NONE,
		digest: digest(
			"cut a patch release",
			[
				"bash: git status --short -> ok",
				"bash: npm version patch --no-git-tag-version -> ok",
				"edit: CHANGELOG.md -> ok",
				"bash: npm run build -> ok",
				"bash: npm test -> ok",
				"bash: git commit -am 'Release v1.4.1' -> ok",
				"bash: git tag v1.4.1 -> ok",
				"bash: git push --follow-tags -> ok",
				"bash: npm publish -> ok",
				"bash: npm view mypkg version -> ok",
			],
			"Released v1.4.1: bumped, changelog updated, built and tested, tagged, pushed and published; npm shows 1.4.1.",
		),
	},
	{
		id: "upstream-merge",
		label: "procedure",
		skills: NONE,
		digest: digest(
			"merge the latest upstream changes",
			[
				"bash: git fetch upstream --no-tags -> ok",
				"bash: git switch -c merge/upstream-20261019 -> ok",
				"bash: git merge --no-ff upstream/main -> error",
				"bash: git diff --name-only --diff-filter=U -> ok",
				"bash: git checkout --ours package-lock.json -> ok",
				"bash: npm install --package-lock-only --ignore-scripts -> ok",
				"bash: npm run check -> ok",
				"bash: ./test.sh -> ok",
				"bash: git commit -> ok",
			],
			"Merged upstream main (32 commits); only package-lock.json conflicted, regenerated it; check and tests pass.",
		),
	},
	{
		id: "new-decision-point",
		label: "procedure",
		skills: NONE,
		digest: digest(
			"add a decision point that asks whether a diagnostic is worth showing",
			[
				"read: docs/adding-a-decision-point.md -> ok",
				"write: packages/kyrn-judge/src/decisions/diagnostics-delivery.ts -> ok",
				"edit: packages/kyrn-judge/src/extension/features/lsp.ts -> ok",
				"edit: packages/kyrn-judge/src/manifest.ts -> ok",
				"bash: node packages/kyrn-judge/scripts/write-manifest.ts -> ok",
				"bash: node scripts/write-docs-reference.mjs -> ok",
				"write: packages/kyrn-judge/test/diagnostics-delivery.test.ts -> ok",
				"bash: npx vitest --run test/diagnostics-delivery.test.ts -> ok",
				"bash: npm run check -> ok",
			],
			"Added diagnostics.delivery: decision, feature wiring, manifest, regenerated reference docs, tests pass.",
		),
	},
	{
		id: "add-locale",
		label: "procedure",
		skills: NONE,
		digest: digest(
			"add Italian to the app",
			[
				"read: src/common/config/i18n-config.json -> ok",
				"edit: src/common/config/i18n-config.json -> ok",
				"bash: cp -r locales/en-US locales/it-IT -> ok",
				"edit: locales/it-IT/common.json -> ok",
				"edit: locales/it-IT/settings.json -> ok",
				"bash: bun run i18n:types -> ok",
				"bash: node scripts/check-i18n.js -> ok",
			],
			"Italian added: config entry, translated locale files, regenerated key types; the i18n check passes.",
		),
	},
	{
		id: "db-migration",
		label: "procedure",
		skills: NONE,
		digest: digest(
			"add a column for the user's timezone",
			[
				"bash: npx prisma migrate dev --name add_user_timezone -> ok",
				"edit: prisma/schema.prisma -> ok",
				"bash: npx prisma generate -> ok",
				"edit: src/users/service.ts -> ok",
				"bash: npm run typecheck -> ok",
				"bash: npm test -- users -> ok",
			],
			"Added users.timezone with a migration, regenerated the client, updated the service; types and tests pass.",
		),
	},
	{
		id: "rotate-ci-secret",
		label: "procedure",
		skills: NONE,
		digest: digest(
			"the deploy token expired, put the new one in CI",
			[
				"bash: gh secret list -R acme/web -> ok",
				"bash: gh secret set DEPLOY_TOKEN -R acme/web < /tmp/token -> ok",
				"bash: rm /tmp/token -> ok",
				"bash: gh workflow run deploy.yml -R acme/web -> ok",
				"bash: gh run watch -R acme/web -> ok",
			],
			"DEPLOY_TOKEN replaced, the temp file removed, and a deploy run with the new token succeeded.",
		),
	},
	{
		id: "fix-null-parser",
		label: "one_off",
		skills: NONE,
		digest: digest(
			"the parser crashes on an empty file",
			[
				"bash: npm test -- parser -> error",
				"read: src/parser.ts -> ok",
				"grep: tokens.length in src -> ok",
				"edit: src/parser.ts -> ok",
				"write: test/parser-empty.test.ts -> ok",
				"bash: npm test -- parser -> ok",
			],
			"Fixed: parse() read tokens[0] without checking for an empty list; it now returns an empty document. Added a test.",
		),
	},
	{
		id: "explain-code",
		label: "one_off",
		skills: NONE,
		digest: digest(
			"how does the cache key get built?",
			["grep: cacheKey in src -> ok", "read: src/cache/key.ts -> ok", "read: src/cache/index.ts -> ok"],
			"The key is the method, the normalized URL and the Accept-Language header, hashed with SHA-1 in key.ts:12.",
		),
	},
	{
		id: "rename-variable",
		label: "one_off",
		skills: NONE,
		digest: digest(
			"rename userData to profile in the settings page",
			[
				"grep: userData in src/settings -> ok",
				"edit: src/settings/Page.tsx -> ok",
				"edit: src/settings/Form.tsx -> ok",
				"bash: npm run typecheck -> ok",
			],
			"Renamed userData to profile in both files; types check.",
		),
	},
	{
		id: "flaky-test",
		label: "one_off",
		skills: NONE,
		digest: digest(
			"the zoom test fails sometimes in CI",
			[
				"bash: gh run view 39229162603 --log-failed -> ok",
				"read: tests/unit/renderer/mermaidBlockPanZoom.dom.test.tsx -> ok",
				"read: src/renderer/components/Markdown/MermaidBlock.tsx -> ok",
				"edit: src/renderer/components/Markdown/MermaidBlock.tsx -> ok",
				"bash: bunx vitest run tests/unit/renderer/mermaidBlockPanZoom.dom.test.tsx -> ok",
			],
			"The reset of the zoom ran in an effect after the commit and undid a fast click; it now happens with the diagram update.",
		),
	},
	{
		id: "css-tweak",
		label: "one_off",
		skills: NONE,
		digest: digest(
			"make the sidebar a bit wider",
			["read: src/styles/sidebar.module.css -> ok", "edit: src/styles/sidebar.module.css -> ok"],
			"Sidebar width 240px -> 280px.",
		),
	},
	{
		id: "bug-investigation",
		label: "one_off",
		skills: NONE,
		digest: digest(
			"why do some users get logged out after an hour?",
			[
				"grep: expiresIn in src/auth -> ok",
				"read: src/auth/session.ts -> ok",
				"bash: git log -S refreshToken --oneline -> ok",
				"read: src/auth/refresh.ts -> ok",
				"edit: src/auth/refresh.ts -> ok",
				"bash: npm test -- auth -> ok",
			],
			"The refresh request used the access token's expiry instead of the refresh token's; fixed in refresh.ts, tests pass.",
		),
	},
	{
		id: "release-covered",
		label: "covered",
		skills: RELEASE_SKILL,
		digest: digest(
			"release 2.0.1",
			[
				"read: .pi/skills/release-npm/SKILL.md -> ok",
				"bash: npm version patch --no-git-tag-version -> ok",
				"edit: CHANGELOG.md -> ok",
				"bash: npm run build -> ok",
				"bash: git tag v2.0.1 -> ok",
				"bash: git push --follow-tags -> ok",
				"bash: npm publish -> ok",
			],
			"Released 2.0.1 following the release-npm skill.",
		),
	},
];

/** Held out: written after the wording and DRAFT_AT were fixed on CASES, run once (SET=heldout). */
export const HELDOUT: readonly CaptureCase[] = [
	{
		id: "docker-image",
		label: "procedure",
		skills: NONE,
		digest: digest(
			"publish a new docker image for the api",
			[
				"bash: docker build -t ghcr.io/acme/api:1.8.0 . -> ok",
				"bash: docker run --rm ghcr.io/acme/api:1.8.0 npm test -> ok",
				"bash: docker push ghcr.io/acme/api:1.8.0 -> ok",
				"edit: deploy/values.yaml -> ok",
				"bash: helm upgrade api ./deploy -f deploy/values.yaml -> ok",
				"bash: kubectl rollout status deploy/api -> ok",
			],
			"Built, tested and pushed api:1.8.0, bumped the chart value and rolled it out; the rollout finished.",
		),
	},
	{
		id: "new-api-endpoint",
		label: "procedure",
		skills: NONE,
		digest: digest(
			"add an endpoint that lists invoices",
			[
				"read: src/routes/orders.ts -> ok",
				"write: src/routes/invoices.ts -> ok",
				"edit: src/routes/index.ts -> ok",
				"edit: openapi.yaml -> ok",
				"bash: npm run gen:client -> ok",
				"write: test/routes/invoices.test.ts -> ok",
				"bash: npm test -- routes -> ok",
			],
			"GET /invoices added after the orders route's pattern: route, registration, OpenAPI entry, regenerated client, tests.",
		),
	},
	{
		id: "dependency-audit",
		label: "procedure",
		skills: NONE,
		digest: digest(
			"npm audit is red again, clean it up",
			[
				"bash: npm audit --omit=dev --json -> ok",
				"bash: npm ls minimist -> ok",
				"edit: package.json -> ok",
				"bash: npm install --package-lock-only --ignore-scripts -> ok",
				"bash: npm audit --omit=dev -> ok",
				"bash: npm test -> ok",
			],
			"Two advisories, both through minimist; pinned an override to 1.2.8, refreshed the lockfile, audit is clean and tests pass.",
		),
	},
	{
		id: "typo-readme",
		label: "one_off",
		skills: NONE,
		digest: digest(
			"fix the typo in the install section",
			["read: README.md -> ok", "edit: README.md -> ok"],
			"'intall' -> 'install' in the README.",
		),
	},
	{
		id: "off-by-one",
		label: "one_off",
		skills: NONE,
		digest: digest(
			"pagination skips one item per page",
			[
				"read: src/list/paginate.ts -> ok",
				"edit: src/list/paginate.ts -> ok",
				"write: test/paginate.test.ts -> ok",
				"bash: npm test -- paginate -> ok",
			],
			"offset was page * size + 1; now page * size. Test added.",
		),
	},
	{
		id: "explain-error",
		label: "one_off",
		skills: NONE,
		digest: digest(
			"what does this stack trace mean? (TypeError: Cannot read properties of undefined (reading 'runtime'))",
			["grep: \\.runtime in src/renderer -> ok", "read: src/renderer/AcpSendBox.tsx -> ok"],
			"It is logged when stop is pressed before the agent has a runtime; the handler reads agent.runtime without a check. Harmless.",
		),
	},
	{
		id: "upstream-covered",
		label: "covered",
		skills: [
			{
				name: "merge-upstream",
				description: "Merge the upstream repository's main branch: fetch, merge, refresh the lockfile on conflict, check, test.",
			},
		],
		digest: digest(
			"merge upstream again",
			[
				"read: ~/.mu/agent/skills/merge-upstream/SKILL.md -> ok",
				"bash: git fetch upstream --no-tags -> ok",
				"bash: git merge --no-ff upstream/main -> ok",
				"bash: npm run check -> ok",
				"bash: ./test.sh -> ok",
			],
			"Merged upstream with the merge-upstream skill; no conflicts, check and tests pass.",
		),
	},
];
