import { beforeAll, describe, expect, test, vi } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Under another name than pi, as mu runs it (kyrn/bin/mu.mjs gives the package piConfig.name "mu").
vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/config.ts")>()),
	APP_NAME: "mu",
}));

const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.ts");

function provider(id: string, name: string, auth: { oauth?: boolean; apiKey?: boolean }) {
	return {
		id,
		name,
		auth: {
			...(auth.oauth ? { oauth: { name, isSubscription: true, login: vi.fn() } } : {}),
			...(auth.apiKey ? { apiKey: { login: vi.fn() } } : {}),
		},
	};
}

function fakeThis() {
	const providers = [
		provider("anthropic", "Anthropic", { oauth: true, apiKey: true }),
		provider("openai", "OpenAI", { oauth: true, apiKey: true }),
		provider("openai-codex", "OpenAI Codex (legacy)", { oauth: true }),
		provider("radius", "Radius", { oauth: true }),
		provider("xai", "xAI", { oauth: true }),
	];
	return {
		session: {
			modelRuntime: {
				getProviders: () => providers,
				getProviderAuthStatus: () => ({ configured: false }),
				isUsingOAuth: () => false,
			},
		},
	};
}

describe("/login under mu's name", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("offers no Claude subscription sign-in, and still an Anthropic API key", () => {
		const options = (InteractiveMode as any).prototype.getLoginProviderOptions.call(fakeThis()) as Array<{
			id: string;
			authType: string;
		}>;
		const offered = options.map((option) => `${option.id}:${option.authType}`);
		expect(offered).not.toContain("anthropic:oauth");
		expect(offered).toContain("anthropic:api_key");
		expect(offered).toEqual(expect.arrayContaining(["openai:oauth", "openai:api_key", "xai:oauth"]));
	});

	test("offers no Codex CLI login: ChatGPT signs in through OpenAI", () => {
		const options = (InteractiveMode as any).prototype.getLoginProviderOptions.call(fakeThis()) as Array<{
			id: string;
		}>;
		expect(options.map((option) => option.id)).not.toContain("openai-codex");
	});

	test("the first menu has no Sign in with Radius; Radius stays in the account list", () => {
		let shown: string[] = [];
		const self = {
			...fakeThis(),
			getLoginProviderOptions: (InteractiveMode as any).prototype.getLoginProviderOptions,
			ui: { requestRender: vi.fn() },
			showSelector: (create: (done: () => void) => { component: { render(width: number): string[] } }) => {
				shown = create(() => {}).component.render(80);
			},
		};
		(InteractiveMode as any).prototype.showLoginAuthTypeSelector.call(self);
		const text = shown.join("\n");
		expect(text).toContain("Sign in with an account");
		expect(text).toContain("Sign in with an API key");
		expect(text).not.toContain("Radius");

		const accounts = (InteractiveMode as any).prototype.getLoginProviderOptions.call(fakeThis(), "oauth") as Array<{
			id: string;
		}>;
		expect(accounts.map((option) => option.id)).toContain("radius");
	});

	test("/login anthropic finds only the API key", () => {
		const options = (InteractiveMode as any).prototype.findLoginProviderOptions.call(
			{ ...fakeThis(), getLoginProviderOptions: (InteractiveMode as any).prototype.getLoginProviderOptions },
			"anthropic",
		) as Array<{ authType: string }>;
		expect(options.map((option) => option.authType)).toEqual(["api_key"]);
	});
});
