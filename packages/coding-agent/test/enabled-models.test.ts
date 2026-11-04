import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { enabledModelIds, withProviderModels, withProviderOffered } from "../src/core/enabled-models.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

const MODELS = [
	model("openai", "gpt-6-sol"),
	model("openai", "gpt-6-luna"),
	model("openai", "gpt-4o"),
	model("google-antigravity", "gemini-3.1-pro-high"),
	model("google-antigravity", "claude-sonnet-4-6"),
	model("google-antigravity", "gpt-oss-120b-medium"),
	model("anthropic", "claude-sonnet-5-5"),
];

describe("enabled models by provider", () => {
	it("enables every model while nothing is set", () => {
		expect(enabledModelIds(undefined, MODELS)).toBeUndefined();
		expect(enabledModelIds([], MODELS)).toBeUndefined();
		// pi offers every model when the list matches none of them.
		expect(enabledModelIds(["nobody/*"], MODELS)).toBeUndefined();
	});

	it("keeps every other provider whole when one provider is first narrowed", () => {
		const patterns = withProviderModels(undefined, MODELS, "google-antigravity", [
			"gemini-3.1-pro-high",
			"claude-sonnet-4-6",
		]);
		expect(patterns).toEqual([
			"openai/*",
			"anthropic/*",
			"google-antigravity/gemini-3.1-pro-high",
			"google-antigravity/claude-sonnet-4-6",
		]);
		expect(enabledModelIds(patterns, MODELS)).toEqual([
			"openai/gpt-6-sol",
			"openai/gpt-6-luna",
			"openai/gpt-4o",
			"anthropic/claude-sonnet-5-5",
			"google-antigravity/gemini-3.1-pro-high",
			"google-antigravity/claude-sonnet-4-6",
		]);
	});

	it("replaces only the provider's entries, where they were", () => {
		const before = ["openai/gpt-6-sol", "google-antigravity/*", "anthropic/claude-sonnet-5-5"];
		expect(withProviderModels(before, MODELS, "google-antigravity", ["claude-sonnet-4-6"])).toEqual([
			"openai/gpt-6-sol",
			"google-antigravity/claude-sonnet-4-6",
			"anthropic/claude-sonnet-5-5",
		]);
		expect(withProviderModels(before, MODELS, "openai", [])).toEqual([
			"google-antigravity/*",
			"anthropic/claude-sonnet-5-5",
		]);
	});

	it("spells out a pattern of another form that reaches the provider", () => {
		const patterns = withProviderModels(["*sonnet*:high", "openai/*"], MODELS, "google-antigravity", []);
		expect(patterns).toEqual(["anthropic/claude-sonnet-5-5:high", "openai/*"]);
	});

	it("goes back to pi's default when every provider has all its models", () => {
		const narrowed = withProviderModels(undefined, MODELS, "openai", ["gpt-6-sol"]);
		expect(withProviderModels(narrowed, MODELS, "openai", "all")).toBeUndefined();
		expect(withProviderModels(undefined, MODELS, "openai", "all")).toBeUndefined();
	});

	it("keeps a hand-written list that leaves a provider out", () => {
		// openai is left out on purpose: restoring Antigravity's default must not bring it back.
		const patterns = withProviderModels(
			["anthropic/*", "google-antigravity/claude-sonnet-4-6"],
			MODELS,
			"google-antigravity",
			"all",
		);
		expect(patterns).toEqual(["anthropic/*", "google-antigravity/*"]);
	});

	it("refuses a list that enables no model at all", () => {
		const only = MODELS.filter((each) => each.provider === "openai");
		expect(() => withProviderModels(undefined, only, "openai", [])).toThrow("At least one model must stay enabled");
	});

	it("offers a newly signed-in provider that the list leaves out", () => {
		const patterns = ["openai/gpt-6-sol"];
		expect(withProviderOffered(patterns, MODELS, "google-antigravity")).toEqual([
			"openai/gpt-6-sol",
			"google-antigravity/*",
		]);
		expect(withProviderOffered(patterns, MODELS, "openai")).toBeUndefined();
		expect(withProviderOffered(undefined, MODELS, "openai")).toBeUndefined();
		// A list that matches nothing offers every model already.
		expect(withProviderOffered(["nobody/*"], MODELS, "openai")).toBeUndefined();
		expect(withProviderOffered(patterns, MODELS, "xai")).toBeUndefined();
	});
});

describe("SettingsManager.reloadEnabledModels", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("reads a list another process saved", () => {
		dir = mkdtempSync(join(tmpdir(), "mu-enabled-models-"));
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ enabledModels: ["openai/*"] }));
		const settings = SettingsManager.create(dir, agentDir);
		expect(settings.getEnabledModels()).toEqual(["openai/*"]);

		writeFileSync(settingsPath, JSON.stringify({ enabledModels: ["google-antigravity/*"], theme: "light" }));
		expect(settings.getEnabledModels()).toEqual(["openai/*"]);
		expect(settings.reloadEnabledModels()).toEqual(["google-antigravity/*"]);
		expect(settings.getEnabledModels()).toEqual(["google-antigravity/*"]);

		writeFileSync(settingsPath, JSON.stringify({}));
		expect(settings.reloadEnabledModels()).toBeUndefined();
	});

	it("keeps a value this process set and has not written yet", () => {
		dir = mkdtempSync(join(tmpdir(), "mu-enabled-models-"));
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settings = SettingsManager.inMemory({ enabledModels: ["openai/*"] });
		settings.setEnabledModels(["anthropic/*"]);
		expect(settings.reloadEnabledModels()).toEqual(["anthropic/*"]);
	});
});
