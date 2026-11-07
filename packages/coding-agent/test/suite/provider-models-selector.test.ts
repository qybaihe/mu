import { createAssistantMessageEventStream, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { ScopedModelsSelectorComponent } from "../../src/modes/interactive/components/scoped-models-selector.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness } from "./harness.ts";

// mu: after a ChatGPT or Antigravity sign-in, and with `/scoped-models <provider>`, one account's models are chosen for
// /model and Ctrl+P, and saved to the global `enabledModels` without touching the other providers' models.

const method = <T extends unknown[]>(name: string) =>
	Reflect.get(InteractiveMode.prototype, name) as (this: object, ...args: T) => void;

const SIGNED_IN: OAuthCredential = {
	type: "oauth",
	access: "access",
	refresh: "refresh",
	expires: Date.now() + 3_600_000,
};

/** An account with three models, signed in with OAuth like Antigravity. */
function account(harness: Harness): Provider {
	const base = harness.getModel();
	const models = ["sol", "luna", "terra"].map((id) => ({ ...base, provider: "account", id, name: id }));
	return {
		id: "account",
		name: "Account",
		auth: {
			oauth: {
				name: "Account",
				isSubscription: true,
				login: async () => SIGNED_IN,
				refresh: async (credential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => models,
		stream: () => createAssistantMessageEventStream(),
		streamSimple: () => createAssistantMessageEventStream(),
	};
}

describe("one provider's models in /model", () => {
	let harness: Harness | undefined;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	async function open() {
		harness = await createHarness();
		const runtime = harness.session.modelRuntime;
		await harness.authStorage.modify("account", async () => SIGNED_IN);
		runtime.registerNativeProvider(account(harness));
		await runtime.refresh({ allowNetwork: false });
		vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		let selector: ScopedModelsSelectorComponent | undefined;
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context = {
			session: harness.session,
			settingsManager: harness.settingsManager,
			showSelector: (factory: (close: () => void) => { component: ScopedModelsSelectorComponent }) => {
				selector = factory(() => {}).component;
			},
			ui: { requestRender: vi.fn() } as unknown as TUI,
			showStatus,
			showError,
			updateAvailableProviderCount: vi.fn(),
			scopeSessionTo: method("scopeSessionTo"),
			applyEnabledModels: method("applyEnabledModels"),
			showProviderModelsSelector: method("showProviderModelsSelector"),
		};
		return {
			context,
			showStatus,
			showError,
			get selector() {
				if (!selector) throw new Error("Expected the selector to open");
				return selector;
			},
		};
	}

	it("lists only the provider's models and saves its choice beside the others", async () => {
		const view = await open();
		method<[string]>("showProviderModelsSelector").call(view.context, "account");
		const rendered = stripAnsi(view.selector.render(120).join("\n"));
		expect(rendered).toContain("Account models");
		expect(rendered).toContain("sol");
		expect(rendered).not.toContain(harness?.getModel().id);

		// Enter on the first row (sol) leaves it out; ctrl+s saves.
		view.selector.handleInput("\r");
		view.selector.handleInput("\x13");
		const faux = harness?.getModel().provider;
		expect(harness?.settingsManager.getEnabledModels()).toEqual([`${faux}/**`, "account/luna", "account/terra"]);
		expect(harness?.session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
			`${faux}/${harness?.getModel().id}`,
			"account/luna",
			"account/terra",
		]);
		expect(view.showStatus).toHaveBeenCalledWith("/model offers 2 Account models");

		// All of them again is the default: nothing is left to save.
		view.selector.handleInput("\x01");
		view.selector.handleInput("\x13");
		expect(harness?.settingsManager.getEnabledModels()).toBeUndefined();
		expect(harness?.session.scopedModels).toEqual([]);
	});

	it("finds the provider by its id in any case, and says when it has no models", async () => {
		const view = await open();
		const showFor = method<[string]>("showProviderModelsSelectorFor");
		showFor.call(view.context, "ACCOUNT");
		expect(stripAnsi(view.selector.render(120).join("\n"))).toContain("Account models");
		showFor.call(view.context, "nobody");
		expect(view.showError).toHaveBeenCalledWith('No models available from "nobody". Use /login to sign in to it.');
	});

	it("offers a newly signed-in provider that the saved list leaves out", async () => {
		const view = await open();
		const faux = `${harness?.getModel().provider}/${harness?.getModel().id}`;
		harness?.settingsManager.setEnabledModels([faux]);
		method<[string]>("offerSignedInProvider").call(view.context, "account");
		expect(harness?.settingsManager.getEnabledModels()).toEqual([faux, "account/**"]);
		expect(harness?.session.scopedModels).toEqual([]);
	});
});
