import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { featureOptions } from "../../config.ts";
import { say } from "../../language.ts";
import { MANIFEST } from "../../manifest.ts";
import { CONFIG_FILE, LEGACY_CONFIG_FILE } from "../../naming.ts";
import { Backups, readJsonFile, writeFileAtomic } from "../../setup/files.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";
import { askQuestions, type Question } from "./ask-user.ts";
import { isUnattended } from "./unattended.ts";

export const FEATURE_OFFER_ENTRY = "kyrn.feature-offer";
/** How long the question waits, as ask_user's does: then the feature stays off. */
const WAIT_MS = 120_000;

/**
 * mu's features that are off by default and do something once turned on. Not the Nebius sandbox: it needs an account
 * and a key, which no answer to a question sets up.
 */
export const OFFERED_FEATURES: readonly string[] = ["compaction", "ttsr", "confine"];

export interface FeatureOfferRecord {
	readonly feature: string;
	/** `on`: written to the config file. `declined`: the user said not now. `unanswered`: nobody answered in time. */
	readonly answer: "on" | "declined" | "unanswered";
	/** `model`: the model offered it (find_capability). `user`: the user asked for it (/capabilities open). */
	readonly by: "model" | "user";
}

/** Whether a feature can work on this machine: the write sandbox needs sandbox-exec (macOS) or bwrap (Linux). */
export function worksHere(
	name: string,
	platform: NodeJS.Platform = process.platform,
	path = process.env.PATH ?? "",
): boolean {
	if (name !== "confine") return true;
	if (platform === "darwin") return true;
	if (platform !== "linux") return false;
	return path
		.split(delimiter)
		.filter(Boolean)
		.some((dir) => existsSync(join(dir, "bwrap")));
}

/**
 * The file loadConfig reads in `dir`: the first of mu.json and kyrn.json that exists, else a new mu.json. Writing any
 * other one would leave it unread, or, with a new mu.json beside an existing kyrn.json, put every other setting out of
 * reach.
 */
export function configFile(dir: string): string {
	for (const name of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
		const path = join(dir, name);
		if (existsSync(path)) return path;
	}
	return join(dir, CONFIG_FILE);
}

/**
 * Turns `name` on in the config file of `dir`, as written: `features.<name>` becomes `true`, or gets `enabled: true`
 * when it holds the feature's options. The rest of the file stays as it is. A copy of it goes to mu's backups first.
 * A file that is not plain JSON is not touched: the user fixes it, or turns the feature on by hand.
 */
export function turnOn(dir: string, name: string, now = new Date()): { file: string } | { problem: string } {
	const file = configFile(dir);
	const read = readJsonFile(file);
	if (read.state === "unreadable") return { problem: `${file} is not plain JSON, so mu did not change it` };
	const config = read.state === "ok" ? { ...read.value } : {};
	const features =
		typeof config.features === "object" && config.features !== null && !Array.isArray(config.features)
			? { ...(config.features as Record<string, unknown>) }
			: {};
	const current = features[name];
	features[name] =
		typeof current === "object" && current !== null && !Array.isArray(current)
			? { ...(current as Record<string, unknown>), enabled: true }
			: true;
	config.features = features;
	new Backups(dirname(dir), now).save(file);
	writeFileAtomic(file, `${JSON.stringify(config, null, "\t")}\n`);
	return { file };
}

const titleOf = (name: string) => MANIFEST.features.find((feature) => feature.name === name);

/**
 * Offers mu's features that are off by default, when a task would use one. Each one that is off and works on this
 * machine is in the capability catalog as `feature:<name>`, with its summary, so `find_capability` lists it. Opening
 * one there does not turn it on: mu asks the user with ask_user's dialog (a card in the desktop app) whether to turn it
 * on, and only their yes writes it to the config file loadConfig reads. It takes effect from the next conversation,
 * since features are set up when a session starts; the model is told so, and that turning it on allows nothing beyond
 * that feature.
 *
 * Only the user decides: the capability judge never opens a feature (features/catalog.ts), an unattended run writes
 * nothing, and a sub-agent has no offers. A feature the user declined is not offered again in that conversation: a
 * `kyrn.feature-offer` entry records each answer and is read back when the session is opened again. `/capabilities open
 * feature:<name>` is the user asking for it, and turns it on without the question.
 */
export function registerFeatureOffers(runtime: KyrnRuntime, configDir: string | undefined): void {
	const options = runtime.options("featureOffers", { enabled: true });
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH || !configDir) return;
	const { pi } = runtime;
	/** Answered in this conversation: declined, or turned on (which needs the next conversation to show). */
	const answered = new Map<string, FeatureOfferRecord["answer"]>();

	for (const name of OFFERED_FEATURES) {
		const feature = titleOf(name);
		if (!feature || featureOptions(runtime.config, name, { enabled: feature.defaultEnabled }).enabled) continue;
		if (!worksHere(name)) continue;
		runtime.catalog.register({
			id: `feature:${name}`,
			kind: "feature",
			title: feature.title.en,
			description: `${feature.summary.en} Off now: opening it asks the user whether to turn it on, from the next conversation.`,
			tools: [],
			exposure: "judged",
		});
	}

	const record = (data: FeatureOfferRecord): void => {
		answered.set(data.feature, data.answer);
		pi.appendEntry(FEATURE_OFFER_ENTRY, data);
	};

	const write = (name: string, title: string, by: FeatureOfferRecord["by"]): string => {
		const result = turnOn(configDir, name);
		if ("problem" in result) {
			return `${title} stays off: ${result.problem}. It is turned on with features.${name}: true in that file.`;
		}
		record({ feature: name, answer: "on", by });
		runtime.featuresTurnedOn.add(`feature:${name}`);
		return `The user turned on ${title} (features.${name} in ${result.file}). It takes effect from the next conversation; this one goes on without it. Turning it on allows nothing beyond that feature.`;
	};

	runtime.offerFeature = async (id, ctx, by) => {
		runtime.touch(ctx);
		const name = id.replace(/^feature:/, "");
		const feature = titleOf(name);
		if (!feature || !OFFERED_FEATURES.includes(name)) return `There is no feature "${id}" to turn on.`;
		const title = feature.title.en;
		const before = answered.get(name);
		if (before === "on") return `${title} is already turned on for the next conversation.`;
		if (by === "user") return write(name, title, by);
		if (before === "declined") {
			return `The user declined ${title} earlier in this conversation. Do not offer it again; carry on without it.`;
		}
		if (!ctx.hasUI || isUnattended(ctx)) {
			return `${title} is off, and only the user can turn it on; nobody can be asked in this session. Carry on without it.`;
		}
		const words = { title: say(feature.title), summary: say(feature.summary) };
		const question: Question = {
			question: say({ zh: `打开「${words.title}」吗？`, en: `Turn on ${words.title}?` }),
			header: say({ zh: "功能", en: "Feature" }),
			options: [
				{
					label: say({ zh: "打开", en: "Turn it on" }),
					description: say({
						zh: `下一个会话起生效：${words.summary}`,
						en: `From the next session: ${words.summary}`,
					}),
				},
				{
					label: say({ zh: "先不用", en: "Not now" }),
					description: say({
						zh: "保持关闭；这次对话里不会再提",
						en: "It stays off, and mu won't offer it again in this session",
					}),
				},
			],
		};
		const { answers, ended } = await askQuestions(runtime, ctx, [question], { waitMs: WAIT_MS, signal: ctx.signal });
		const answer = answers[0];
		if (answer?.selected[0] === question.options[0].label) return write(name, title, "model");
		if (ended === "timeout") {
			record({ feature: name, answer: "unanswered", by: "model" });
			return `The user did not answer whether to turn on ${title}, so it stays off. Carry on without it; do not ask again unless they bring it up.`;
		}
		record({ feature: name, answer: "declined", by: "model" });
		const said = answer?.custom ? ` They said: ${JSON.stringify(answer.custom)}` : "";
		return `The user declined ${title}, so it stays off.${said} Do not offer it again in this conversation; carry on without it.`;
	};

	pi.on(
		"session_start",
		failOpen((_event, ctx: ExtensionContext) => {
			runtime.touch(ctx);
			answered.clear();
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== FEATURE_OFFER_ENTRY) continue;
				const data = entry.data as Partial<FeatureOfferRecord> | undefined;
				if (typeof data?.feature === "string" && (data.answer === "on" || data.answer === "declined")) {
					answered.set(data.feature, data.answer);
					if (data.answer === "on") runtime.featuresTurnedOn.add(`feature:${data.feature}`);
				}
			}
			return undefined;
		}),
	);
}
