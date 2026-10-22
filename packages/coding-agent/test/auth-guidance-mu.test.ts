import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...(actual as Record<string, unknown>),
		APP_NAME: "mu",
	};
});

import { formatNoApiKeyFoundMessage, formatNoModelsAvailableMessage } from "../src/core/auth-guidance.ts";

describe("auth guidance in mu", () => {
	it("points a new user to `mu setup`, since /login only exists inside a session", () => {
		const message = formatNoApiKeyFoundMessage("unknown");
		expect(message).toContain("Run `mu setup` to connect a model");
		expect(message).toContain("Inside a session, /login does the same.");
		expect(message).not.toContain("providers.md");
	});

	it("keeps the first line the desktop app matches on", () => {
		expect(formatNoApiKeyFoundMessage("anthropic").split("\n")[0]).toBe("No API key found for anthropic.");
		expect(formatNoModelsAvailableMessage()).toMatch(/^No models available\. Run `mu setup`/);
	});
});
