import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * `/login` with Sign in with ChatGPT, on pi's own runtime and flow and the real callback port (1455), into a
 * credential store of its own: Escape gives the port back, and a port another program keeps fails with a sentence
 * that names it. No browser is opened and nothing reaches the network.
 */

const PORT = 1455;
const DEVICE_ID = "e61bbe28-07ef-466d-8e5d-a344f94ab305";

const portFree = () =>
	new Promise<boolean>((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(PORT, "127.0.0.1", () => probe.close(() => resolve(true)));
	});

/** The parts of InteractiveMode `/login` uses, around pi's real model runtime. */
function fakeThis(modelRuntime: ModelRuntime) {
	const dialogs: { cancel(): void }[] = [];
	let opened: () => void = () => {};
	const page = new Promise<void>((resolve) => {
		opened = resolve;
	});
	const self = {
		session: { model: undefined, modelRuntime },
		settingsManager: { getOrCreateDeviceId: () => DEVICE_ID },
		programStatus: { setBlocked: vi.fn() },
		ui: { requestRender: vi.fn(), setFocus: vi.fn() },
		editorContainer: {
			clear: vi.fn(),
			addChild: (child: unknown) => {
				if (child && typeof child === "object" && "signal" in child)
					dialogs.push(child as unknown as { cancel(): void });
			},
		},
		editor: {},
		showError: vi.fn(),
		completeProviderAuthentication: vi.fn(),
		// The page is not opened in a browser here.
		notifyAuthDialog: (_dialog: unknown, event: { type: string }) => {
			if (event.type === "auth_url") opened();
		},
		showAuthPrompt: (InteractiveMode as any).prototype.showAuthPrompt,
		loginProvider: (InteractiveMode as any).prototype.loginProvider,
	};
	return { self, dialogs, page };
}

describe.sequential("/login on the ChatGPT callback port", () => {
	const dirs: string[] = [];
	let blocker: Server | undefined;

	const runtime = () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-login-port-"));
		dirs.push(dir);
		return ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	};

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(async (context) => {
		// A real program on this machine holds the port (the Codex CLI's login): leave it alone.
		if (!(await portFree())) context.skip();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 404 })),
		);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		if (blocker) await new Promise((resolve) => blocker?.close(resolve));
		blocker = undefined;
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
		expect(await portFree()).toBe(true);
	});

	test("Escape stops the sign-in and gives the port back", async () => {
		const { self, dialogs, page } = fakeThis(await runtime());
		const onBack = vi.fn();
		const login = (InteractiveMode as any).prototype.showLoginDialog.call(self, "openai", "ChatGPT", onBack);
		await page;
		expect(await portFree()).toBe(false);

		dialogs[0]?.cancel();
		await login;

		expect(self.showError).not.toHaveBeenCalled();
		expect(onBack).toHaveBeenCalledOnce();
		expect(await portFree()).toBe(true);
	});

	test("names the program keeping the port", async () => {
		blocker = createServer((_request, response) => response.writeHead(404).end("Not Found"));
		await new Promise<void>((resolve) => blocker?.listen(PORT, "127.0.0.1", resolve));
		const { self } = fakeThis(await runtime());

		await (InteractiveMode as any).prototype.showLoginDialog.call(self, "openai", "ChatGPT", vi.fn());

		expect(self.showError).toHaveBeenCalledOnce();
		const [message] = self.showError.mock.calls[0] as [string];
		expect(message).toMatch(/^Failed to login to ChatGPT: Port 1455 is in use by .+, probably for its own sign-in/);
		if (process.platform === "darwin") expect(message).toContain(`(process ${process.pid})`);
		expect(message).toContain("Finish or cancel that sign-in, then try again.");
	});
});
