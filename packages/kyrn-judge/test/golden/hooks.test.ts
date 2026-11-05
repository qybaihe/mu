import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../../src/config.ts";
import { createKyrnJudgeExtension } from "../../src/extension/kyrn-judge.ts";
import { MANIFEST } from "../../src/manifest.ts";
import { MockJudgeProvider } from "../../src/providers/mock.ts";

/**
 * `docs/reference/hooks.md`: what each part of mu registers with pi, recorded while mu registers with every feature on,
 * and the runtime fields features set for each other, found in the source. Which features handle an event, and in which
 * order, was spread over the feature table's comments and a hand-kept map (`kyrn/docs/04-injection-points.md`); a
 * feature that moves in the table, or starts handling another event, shows up here as a diff in the pull request.
 * `npx vitest --run test/golden -u` writes the file.
 */
const GOLDEN = fileURLToPath(new URL("../../../../docs/reference/hooks.md", import.meta.url));
const SRC = fileURLToPath(new URL("../../src", import.meta.url));

type Kind = "event" | "tool" | "command" | "shortcut" | "flag" | "message renderer" | "entry renderer" | "channel";

interface Hook {
	readonly part: string;
	readonly kind: Kind;
	readonly name: string;
	readonly final?: boolean;
}

/** pi, with every registration written down under the part of mu that made it. */
function recording(pi: ExtensionAPI, hooks: Hook[], part: () => string): ExtensionAPI {
	const named: Partial<Record<keyof ExtensionAPI, (args: unknown[]) => Omit<Hook, "part">>> = {
		on: ([event, , options]) => ({
			kind: "event",
			name: String(event),
			...((options as { final?: boolean } | undefined)?.final ? { final: true } : {}),
		}),
		registerTool: ([tool]) => ({ kind: "tool", name: (tool as { name: string }).name }),
		registerCommand: ([name]) => ({ kind: "command", name: `/${String(name)}` }),
		registerShortcut: ([key]) => ({ kind: "shortcut", name: String(key) }),
		registerFlag: ([name]) => ({ kind: "flag", name: `--${String(name)}` }),
		registerMessageRenderer: ([type]) => ({ kind: "message renderer", name: String(type) }),
		registerEntryRenderer: ([type]) => ({ kind: "entry renderer", name: String(type) }),
	};
	const events = new Proxy(pi.events, {
		get(target, key) {
			const value = Reflect.get(target, key) as unknown;
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (key === "on") hooks.push({ part: part(), kind: "channel", name: String(args[0]) });
				return value.apply(target, args);
			};
		},
	});
	return new Proxy(pi, {
		get(target, key) {
			if (key === "events") return events;
			const value = Reflect.get(target, key) as unknown;
			if (typeof value !== "function") return value;
			const describe = named[key as keyof ExtensionAPI];
			return (...args: unknown[]) => {
				if (describe) hooks.push({ part: part(), ...describe(args) });
				return value.apply(target, args);
			};
		},
	});
}

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** What mu registers with every feature on, and the parts in the order they registered, those with nothing too. */
async function registrations(): Promise<{ hooks: Hook[]; order: string[] }> {
	const hooks: Hook[] = [];
	const order: string[] = [];
	let part = "kernel";
	// A home of its own: the features that keep state there (memory, checkpoints, inherited setups) register as usual.
	const home = mkdtempSync(join(tmpdir(), "mu-hooks-"));
	dirs.push(home);
	const kyrn = createKyrnJudgeExtension({
		provider: new MockJudgeProvider(() => ({})),
		config: parseConfig({
			features: {
				...Object.fromEntries(MANIFEST.features.map((feature) => [feature.name, true])),
				// The run's time budget, without which the deadline feature has nothing to watch.
				deadline: { enabled: true, budgetS: 600 },
			},
		}),
		roots: { home, agentDir: join(home, "agent") },
		trace: (next) => {
			part = next;
			if (next !== "kernel") order.push(next);
		},
	});
	const harness = await createHarness({ extensionFactories: [(pi) => kyrn(recording(pi, hooks, () => part))] });
	harnesses.push(harness);
	return { hooks, order };
}

const OFF_BY_DEFAULT = new Set(
	MANIFEST.features.filter((feature) => !feature.defaultEnabled).map((feature) => feature.name),
);
const label = (part: string) => `\`${part}\`${OFF_BY_DEFAULT.has(part) ? " (off by default)" : ""}`;

/** Each part once, in the order it first did this, with how many times it did. */
function parts(hooks: readonly Hook[]): string[] {
	const counted = new Map<string, number>();
	for (const hook of hooks) counted.set(hook.part, (counted.get(hook.part) ?? 0) + 1);
	return [...counted].map(([part, times]) => `${label(part)}${times > 1 ? ` ×${times}` : ""}`);
}

function eventsSection(hooks: readonly Hook[]): string[] {
	const byEvent = new Map<string, Hook[]>();
	for (const hook of hooks)
		if (hook.kind === "event") byEvent.set(hook.name, [...(byEvent.get(hook.name) ?? []), hook]);
	const lines = ["## Events", ""];
	for (const [event, handlers] of [...byEvent].sort(([a], [b]) => a.localeCompare(b))) {
		// pi runs an event's handlers in the order they were registered, final tool_call handlers after all the others.
		const normal = handlers.filter((hook) => !hook.final);
		const final = handlers.filter((hook) => hook.final);
		lines.push(`### \`${event}\``, "");
		parts(normal).forEach((part, at) => {
			lines.push(`${at + 1}. ${part}`);
		});
		const first = parts(normal).length;
		parts(final).forEach((part, at) => {
			lines.push(`${first + at + 1}. ${part}, final`);
		});
		lines.push("");
	}
	return lines;
}

function tableSection(title: string, kinds: readonly Kind[], hooks: readonly Hook[]): string[] {
	const rows = hooks.filter((hook) => kinds.includes(hook.kind));
	if (rows.length === 0) return [];
	return [
		`## ${title}`,
		"",
		"| name | registered by |",
		"|---|---|",
		...rows.map((hook) => `| \`${hook.name}\` | ${label(hook.part)} |`),
		"",
	];
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sourceFiles(join(dir, entry.name))
			: entry.name.endsWith(".ts")
				? [join(dir, entry.name)]
				: [],
	);
}

/** The runtime fields set outside runtime.ts, with the files that set them and the files that read them. */
function sharedFields(): string[] {
	// A chain may break the line before the dot: `runtime\n\t.notify?.(…)`.
	const WRITE = /\b(?:runtime|shared)\s*\.([a-zA-Z]+)\s*(?:=(?![=>])|\?\?=|\+=|-=|\+\+|--)/g;
	const USE = /\b(?:runtime|shared)\s*\.([a-zA-Z]+)\b/g;
	const setBy = new Map<string, Set<string>>();
	const uses = new Map<string, Map<string, number>>();
	const writes = new Map<string, Map<string, number>>();
	for (const file of sourceFiles(SRC)) {
		const path = relative(SRC, file).replaceAll("\\", "/");
		const text = readFileSync(file, "utf8");
		// The runtime reads its own fields as this.<field>; what it sets there is its own state, not shared.
		if (path === "extension/runtime.ts") {
			for (const [, field] of text.matchAll(/\bthis\.([a-zA-Z]+)\b/g)) {
				const counts = uses.get(field) ?? new Map<string, number>();
				uses.set(field, counts.set(path, (counts.get(path) ?? 0) + 1));
			}
			continue;
		}
		for (const [, field] of text.matchAll(WRITE)) {
			setBy.set(field, (setBy.get(field) ?? new Set()).add(path));
			const counts = writes.get(field) ?? new Map<string, number>();
			writes.set(field, counts.set(path, (counts.get(path) ?? 0) + 1));
		}
		for (const [, field] of text.matchAll(USE)) {
			const counts = uses.get(field) ?? new Map<string, number>();
			uses.set(field, counts.set(path, (counts.get(path) ?? 0) + 1));
		}
	}
	const readBy = (field: string) =>
		[...(uses.get(field) ?? [])]
			.filter(([path, count]) => count > (writes.get(field)?.get(path) ?? 0))
			.map(([path]) => path)
			.sort();
	const list = (paths: readonly string[]) => (paths.length > 0 ? paths.map((path) => `\`${path}\``).join(", ") : "-");
	return [
		"## What features share on the runtime",
		"",
		"Fields of `KyrnRuntime` (`src/extension/runtime.ts`) that code outside it sets, with the files that read them,",
		"found by searching `src` for `runtime.<field>` (and `this.<field>` in runtime.ts). A field more than one file sets",
		"is marked: two features that set it in the same turn decide between them by the order above.",
		"",
		"| field | set by | read by |",
		"|---|---|---|",
		...[...setBy]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(
				([field, by]) =>
					`| \`${field}\`${by.size > 1 ? " (set in more than one file)" : ""} | ${list([...by].sort())} | ${list(readBy(field))} |`,
			),
		"",
	];
}

// Windows is left out as for the other generated files: the registrations are the same there.
describe.skipIf(process.platform === "win32")("the hook table", () => {
	it("is as recorded", async () => {
		const { hooks, order } = await registrations();
		const silent = order.filter((part) => !hooks.some((hook) => hook.part === part));
		const text = [
			"# Hooks",
			"",
			"<!-- Generated by packages/kyrn-judge/test/golden/hooks.test.ts. Do not edit by hand: run `npx vitest --run test/golden -u` from packages/kyrn-judge. -->",
			"",
			"What each part of mu registers with pi, recorded with every feature switched on. The features register in the",
			"order of the table in `packages/kyrn-judge/src/extension/kyrn-judge.ts`, and pi calls an event's handlers in the",
			"order they were registered, except that `tool_call` handlers registered as final run after all the others. So",
			"the order under each event is the order its handlers run in. `kernel` is what mu registers around the features.",
			"",
			`The features, in that order: ${order.map(label).join(", ")}.`,
			"",
			...(silent.length > 0 ? [`Registered nothing here: ${silent.map(label).join(", ")}.`, ""] : []),
			...eventsSection(hooks),
			...tableSection("Tools", ["tool"], hooks),
			...tableSection("Commands", ["command"], hooks),
			...tableSection("Shortcuts and flags", ["shortcut", "flag"], hooks),
			...tableSection("Renderers", ["message renderer", "entry renderer"], hooks),
			...tableSection("Event bus channels (`pi.events`)", ["channel"], hooks),
			...sharedFields(),
		].join("\n");
		await expect(text).toMatchFileSnapshot(GOLDEN);
	});
});
