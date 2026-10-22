import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function fakeThis(fail: (dialog: { cancel(): void }) => Promise<never>) {
	return {
		session: { model: undefined },
		ui: { requestRender: vi.fn(), setFocus: vi.fn() },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor: {},
		showError: vi.fn(),
		loginProvider: (dialog: { cancel(): void }) => fail(dialog),
		completeProviderAuthentication: vi.fn(),
	};
}

describe("a sign-in cancelled with Escape", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("goes back without an error, also when the flow rejects with the abort itself", async () => {
		// GitHub Copilot's flow waits on a request with the dialog's signal: Escape rejects it with an AbortError.
		const self = fakeThis(async (dialog) => {
			dialog.cancel();
			throw new DOMException("This operation was aborted", "AbortError");
		});
		const onBack = vi.fn();
		await (InteractiveMode as any).prototype.showLoginDialog.call(self, "github-copilot", "GitHub Copilot", onBack);
		expect(self.showError).not.toHaveBeenCalled();
		expect(onBack).toHaveBeenCalledOnce();
	});

	test("a failure that is not a cancel is still reported", async () => {
		const self = fakeThis(async () => {
			throw new Error("device code expired");
		});
		await (InteractiveMode as any).prototype.showLoginDialog.call(self, "github-copilot", "GitHub Copilot", vi.fn());
		expect(self.showError).toHaveBeenCalledWith("Failed to login to GitHub Copilot: device code expired");
	});
});
