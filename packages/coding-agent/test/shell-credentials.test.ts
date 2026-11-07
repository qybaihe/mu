import { afterEach, describe, expect, it, vi } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { ENV_PASS_ENV, withoutCredentials } from "../src/utils/shell.ts";

describe("the agent's commands and the credentials in the environment", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("takes out what a credential's name holds, when the value looks like one", () => {
		const env = withoutCredentials({
			PATH: "/usr/bin",
			OPENAI_API_KEY: "sk-test-0123456789abcdef",
			MU_JUDGE_MUDE_KEY: "mude-0123456789",
			GH_TOKEN: "ghp_0123456789abcdefghij",
			AWS_SECRET_ACCESS_KEY: "abcdefghijklmnopqrstu",
			DB_PASSWORD: "hunter2hunter2",
			GOOGLE_APPLICATION_CREDENTIALS: "/home/me/service-account.json",
			// Settings, not credentials: short, or without a digit.
			MAX_TOKENS: "4096",
			TOKENIZERS_PARALLELISM: "false",
			SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
		});
		expect(Object.keys(env).sort()).toEqual(["MAX_TOKENS", "PATH", "SSH_AUTH_SOCK", "TOKENIZERS_PARALLELISM"]);
	});

	it("keeps the credentials the user passes on by name", () => {
		const env = withoutCredentials({
			GH_TOKEN: "ghp_0123456789abcdefghij",
			NPM_TOKEN: "npm_0123456789abcdefghij",
			OPENAI_API_KEY: "sk-test-0123456789abcdef",
			[ENV_PASS_ENV]: "GH_TOKEN, NPM_TOKEN",
		});
		expect(env).toEqual({
			GH_TOKEN: "ghp_0123456789abcdefghij",
			NPM_TOKEN: "npm_0123456789abcdefghij",
			[ENV_PASS_ENV]: "GH_TOKEN, NPM_TOKEN",
		});
	});

	it.skipIf(process.platform === "win32")("a bash call runs without them", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-test-0123456789abcdef");
		vi.stubEnv("GH_TOKEN", "ghp_0123456789abcdefghij");
		vi.stubEnv(ENV_PASS_ENV, "GH_TOKEN");
		let seen: NodeJS.ProcessEnv | undefined;
		const bash = createBashTool(process.cwd(), {
			spawnHook: (context) => {
				seen = context.env;
				return context;
			},
		});
		const result = await bash.execute("credentials", { command: 'printf "%s|%s" "$OPENAI_API_KEY" "$GH_TOKEN"' });

		expect(seen).not.toHaveProperty("OPENAI_API_KEY");
		expect(seen?.GH_TOKEN).toBe("ghp_0123456789abcdefghij");
		expect(result.content).toEqual([{ type: "text", text: "|ghp_0123456789abcdefghij" }]);
	});
});
