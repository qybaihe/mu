import { describe, expect, it } from "vitest";
import { DecisionEngine, defineDecision } from "../src/decision.ts";
import { carriesCredential } from "../src/extension/features/guard.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { environmentSecrets, holdsCredential, REDACTED, redactSecrets } from "../src/redact.ts";
import type { Questions } from "../src/types.ts";

/** Made-up credentials, each in the shape of a real kind. */
const SECRETS = {
	openai: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx12345",
	github: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
	aws: "AKIAIOSFODNN7EXAMPLE",
	bearer: "abcdefghijklmnopqrstuvwxyz0123",
	urlPassword: "hunter2hunter2",
	named: "tr0ub4dor-and-3",
	privateKey: "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
	/** In this process's environment under a credential's name, and in no known shape. */
	environment: "correct-horse-battery-staple",
};

const leaky = defineDecision({
	id: "test.leaky",
	version: 1,
	cacheImpact: "none",
	latency: "inline",
	capabilities: "relate",
	questions: {} as Questions,
	questionsFor(input: { command: string; output: string }): Questions {
		return {
			which: {
				type: "choice",
				instructions: { command: input.command },
				criteria: { first: `the line ${input.output.split("\n")[0]}`, other: "anything else" },
			},
		};
	},
	buildState(input: { command: string; output: string }) {
		return { command: input.command, output: input.output };
	},
	policy: (answers): string => (answers.which?.type === "choice" ? answers.which.choice : "other"),
	fallback: (): string => "other",
});

describe("credentials out of a text", () => {
	it("leaves words, settings, hashes, public keys and addresses as they are", () => {
		for (const text of [
			"fix the password reset flow and rotate the token cache",
			"Basic usage: pass a Bearer authentication header",
			"MAX_TOKENS=4096 and TOKEN_LIMIT=8000",
			'{"max_tokens": 100000, "token_type": "Bearer"}',
			"git push origin main && rm -rf build",
			"commit 3e62668b1f0a9c8d7e6b5a4c3d2e1f0a9b8c7d6e",
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq user@host",
			"see https://example.com:8443/path?x=1 and git@github.com:org/repo.git",
			"password: see the vault",
		])
			expect(redactSecrets(text), text).toBe(text);
	});

	it("takes a credential's value and keeps its name", () => {
		expect(redactSecrets("export STRIPE_SECRET_KEY='sk_live_51Habcdefghijklmnop'")).toBe(
			`export STRIPE_SECRET_KEY=${REDACTED}`,
		);
		expect(redactSecrets('{"password": "hunter2hunter2"}')).toBe(`{"password": "${REDACTED}"}`);
		expect(redactSecrets("const apiKey = 'abcd1234efgh';")).toBe(`const apiKey = '${REDACTED}';`);
		expect(redactSecrets("db:\n  db_password: s3cr3tpassword\n  host: db")).toBe(
			`db:\n  db_password: ${REDACTED}\n  host: db`,
		);
		expect(redactSecrets("Authorization: Bearer abc123def456ghi789")).toBe(`Authorization: Bearer ${REDACTED}`);
		expect(redactSecrets("postgres://app:s3cret-pass@db.internal:5432/app")).toBe(
			`postgres://app:${REDACTED}@db.internal:5432/app`,
		);
	});

	it("knows the values of this process's credential variables, not its settings", () => {
		expect(
			environmentSecrets({
				OPENAI_API_KEY: SECRETS.openai,
				DB_PASSWORD: "tr0ub4dor&3",
				SSH_AUTH_SOCK: "/private/tmp/launchd-123/Listeners",
				TOKENIZERS_PARALLELISM: "false",
				NPM_TOKEN: "undefined",
				GITHUB_TOKEN: "",
				HOME: "/Users/someone",
				// mu's own keys are named with KEY as a word of its own.
				MU_JUDGE_MUDE_KEY: "mude-0123456789abcdef",
				KEYBOARD_LAYOUT: "us-international-alt",
			}),
		).toEqual([SECRETS.openai, "mude-0123456789abcdef", "tr0ub4dor&3"]);
	});
});

describe("what a call carries away", () => {
	const known = ["mude-0123456789abcdef"];

	it("one of this process's credentials, as it is or as an address carries it, or a secret's shape", () => {
		expect(holdsCredential("https://x.example/?k=mude-0123456789abcdef", known)).toBe(true);
		expect(holdsCredential(`curl -d "k=${encodeURIComponent("a b/c+d=0123456789")}"`, ["a b/c+d=0123456789"])).toBe(
			true,
		);
		expect(holdsCredential(`Authorization: token ${SECRETS.github}`)).toBe(true);
		expect(holdsCredential(`key: ${SECRETS.openai}`)).toBe(true);
		expect(holdsCredential("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA")).toBe(true);
	});

	it("not a name, a template, or what rides in a link meant to be followed", () => {
		expect(holdsCredential('curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api.example', known)).toBe(false);
		expect(holdsCredential('{"password": "change-me-please"}', known)).toBe(false);
		// A presigned S3 link and a signed download.
		expect(holdsCredential(`https://b.s3.amazonaws.com/f?X-Amz-Credential=${SECRETS.aws}%2F20261104`, known)).toBe(
			false,
		);
		expect(
			holdsCredential("https://dl.example/f?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl"),
		).toBe(false);
	});

	it("through every string of a call's input, except for tools that keep it on this computer", () => {
		const input = { url: "https://x.example", headers: [{ name: "X-Key", value: "mude-0123456789abcdef" }] };
		expect(carriesCredential("mcp__http__request", input, known)).toBe(true);
		expect(carriesCredential("web_fetch", { url: "https://x.example/?q=parse" }, known)).toBe(false);
		expect(carriesCredential("write", { path: ".env", content: "MUDE_KEY=mude-0123456789abcdef" }, known)).toBe(
			false,
		);
	});
});

describe("what a judge is shown", () => {
	it("never a credential: not by its shape, its name, or its value in the environment", async () => {
		const provider = new MockJudgeProvider(() => ({ which: { type: "choice", choice: "first" } }));
		const engine = new DecisionEngine({
			judge: new Judge({ provider }),
			defaultMode: "active",
			knownSecrets: () => [SECRETS.environment],
		});

		const decision = await engine.decide(leaky, {
			command: `export OPENAI_API_KEY=${SECRETS.openai} && curl -H 'Authorization: Bearer ${SECRETS.bearer}' https://deploy:${SECRETS.urlPassword}@example.com/hook`,
			output: [
				`DB_PASSWORD=${SECRETS.named}`,
				`token ${SECRETS.github} for ${SECRETS.aws}`,
				"-----BEGIN OPENSSH PRIVATE KEY-----",
				SECRETS.privateKey,
				"-----END OPENSSH PRIVATE KEY-----",
				`the admin password is ${SECRETS.environment}`,
			].join("\n"),
		});

		expect(decision.outcome).toBe("first");
		const shown = JSON.stringify(provider.calls);
		for (const [kind, secret] of Object.entries(SECRETS)) expect(shown, kind).not.toContain(secret);
		// What the judge needs to weigh the call is all still there.
		for (const kept of ["export OPENAI_API_KEY=", "curl -H", "https://deploy:", "@example.com/hook", "DB_PASSWORD="])
			expect(shown).toContain(kept);
	});
});
