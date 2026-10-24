import { createAssistantMessageEventStream, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// mu: after /logout, a session on the signed-out subscription's model failed its next prompt ("No API key").

const SIGNED_IN: OAuthCredential = {
	type: "oauth",
	access: "access",
	refresh: "refresh",
	expires: Date.now() + 3_600_000,
};

/** A subscription: usable while its OAuth credential is stored, as ChatGPT's or Grok's sign-in. */
function subscription(harness: Harness): Provider {
	const model = { ...harness.getModel(), provider: "account", id: "plus", name: "Plus" };
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
		getModels: () => [model],
		stream: () => createAssistantMessageEventStream(),
		streamSimple: () => createAssistantMessageEventStream(),
	};
}

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

/** A session on the subscription's model, signed out of it the way /logout does. */
async function loggedOut(settings: { defaultProvider?: string; defaultModel?: string } = {}) {
	const harness = await createHarness({ models: [{ id: "faux-1" }, { id: "faux-2" }], settings });
	harnesses.push(harness);
	const runtime = harness.session.modelRuntime;
	await harness.authStorage.modify("account", async () => SIGNED_IN);
	runtime.registerNativeProvider(subscription(harness));
	await runtime.refresh({ allowNetwork: false });
	const plus = runtime.getModel("account", "plus");
	if (!plus) throw new Error("the subscription's model is not listed");
	await harness.session.setModel(plus);
	await runtime.logout("account");
	const self = {
		session: harness.session,
		settingsManager: harness.settingsManager,
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
	};
	const leave = (providerId: string): Promise<string | undefined> =>
		(InteractiveMode as any).prototype.leaveLoggedOutModel.call(self, providerId);
	return { harness, runtime, self, leave };
}

describe("/logout of the provider the session runs on", () => {
	test("goes on with the saved default model, and says so", async () => {
		const { harness, self, leave } = await loggedOut({ defaultProvider: "faux", defaultModel: "faux-2" });
		await expect(leave("account")).resolves.toBe("Switched to faux/faux-2.");
		expect(harness.session.model).toMatchObject({ provider: "faux", id: "faux-2" });
		expect(self.footer.invalidate).toHaveBeenCalled();
	});

	test("says how to get a model when no other one is available", async () => {
		const { harness, runtime, leave } = await loggedOut();
		vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue([]);
		await expect(leave("account")).resolves.toBe("No other model is available. Use /login to add one.");
		expect(harness.session.model?.provider).toBe("account");
	});

	test("changes nothing for another provider, or one still configured another way", async () => {
		const { harness, leave } = await loggedOut({ defaultProvider: "faux", defaultModel: "faux-2" });
		await leave("account");
		// faux is configured with a key from models.json: logging out of a stored credential leaves it usable.
		await expect(leave("faux")).resolves.toBeUndefined();
		await expect(leave("other")).resolves.toBeUndefined();
		expect(harness.session.model).toMatchObject({ provider: "faux", id: "faux-2" });
	});
});
