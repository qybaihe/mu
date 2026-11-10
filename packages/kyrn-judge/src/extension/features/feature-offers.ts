import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { featureOptions } from "../../config.ts";
import { say } from "../../language.ts";
import { MANIFEST } from "../../manifest.ts";
import { CONFIG_FILE, LEGACY_CONFIG_FILE } from "../../naming.ts";
import { Backups, readJsonFile, writeFileAtomic } from "../../setup/files.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";
import { isUnattended } from "./unattended.ts";

export const FEATURE_OFFER_ENTRY = "kyrn.feature-offer";

/**
 * mu's features that are off by default and do something once turned on. Not the Nebius sandbox: it needs an account
 * and a key, which no answer to a question sets up.
 */
export const OFFERED_FEATURES: readonly string[] = ["compaction", "ttsr", "confine"];

export interface FeatureOfferRecord {
	readonly feature: string;
	/** `on`: written to the config file. `offered`: the user was told of it when the run ended, and it stays off. */
	readonly answer: "on" | "offered";
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
 * machine is in the capability catalog as `feature:<name>`, with its summary, so `find_capability` lists it.
 *
 * Opening one there turns nothing on and asks nobody. Features are set up when a session starts, so the answer could
 * not change the run that is going: a question in the middle of it would hold the work up for nothing. The model is
 * told at once to carry on without the feature, and once the run has settled mu tells the user of it in one notice, with
 * the command that turns it on. `/capabilities open feature:<name>` is the user asking for it: it writes the feature to
 * the config file loadConfig reads, for the next conversation.
 *
 * Only the user decides: the capability judge never opens a feature (features/catalog.ts), an unattended run says and
 * writes nothing, and a sub-agent has no offers. A feature is offered once in a conversation: a `kyrn.feature-offer`
 * entry records that the user was told of it, or turned it on, and is read back when the session is opened again.
 */
export function registerFeatureOffers(runtime: KyrnRuntime, configDir: string | undefined): void {
	const options = runtime.options("featureOffers", { enabled: true });
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH || !configDir) return;
	const { pi } = runtime;
	/** What became of a feature in this conversation: the user was told of it, or turned it on. */
	const answered = new Map<string, FeatureOfferRecord["answer"]>();
	/** The features the model offered in the run that is going, oldest first: the user is told of them when it ends. */
	const waiting: string[] = [];

	for (const name of OFFERED_FEATURES) {
		const feature = titleOf(name);
		if (!feature || featureOptions(runtime.config, name, { enabled: feature.defaultEnabled }).enabled) continue;
		if (!worksHere(name)) continue;
		runtime.catalog.register({
			id: `feature:${name}`,
			kind: "feature",
			title: feature.title.en,
			description: `${feature.summary.en} Off now, and only the user turns it on, from the next conversation: opening it tells them of it when this run ends.`,
			tools: [],
			exposure: "judged",
		});
	}

	runtime.waits(() =>
		[...answered].flatMap(([name, answer]) => {
			const feature = answer === "offered" ? titleOf(name) : undefined;
			if (!feature) return [];
			return [
				{
					kind: "offered" as const,
					command: `/capabilities open feature:${name}`,
					what: say({
						zh: `打开「${say(feature.title)}」，下一个会话起生效：模型建议这类任务用它，现在是关的`,
						en: `turn on ${say(feature.title)}, from the next session: the model suggested it for work like this, and it's off now`,
					}),
				},
			];
		}),
	);

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

	runtime.offerFeature = (id, ctx, by) => {
		runtime.touch(ctx);
		const name = id.replace(/^feature:/, "");
		const feature = titleOf(name);
		if (!feature || !OFFERED_FEATURES.includes(name)) return `There is no feature "${id}" to turn on.`;
		const title = feature.title.en;
		const before = answered.get(name);
		if (before === "on") return `${title} is already turned on for the next conversation.`;
		if (by === "user") return write(name, title, by);
		if (before === "offered" || waiting.includes(name)) {
			return `${title} was already offered to the user in this conversation, and it is still off. Do not offer it again; carry on without it.`;
		}
		if (!ctx.hasUI || isUnattended(ctx)) {
			return `${title} is off, and only the user can turn it on; nobody can be told of it in this session. Carry on without it.`;
		}
		waiting.push(name);
		return `${title} is off, and turning it on takes effect only from the next conversation, so nothing changes in this run. mu tells the user of it when this run ends, and they decide. Carry on without it, and do not offer it again.`;
	};

	// Once the run has settled, not at `agent_end`: a check may still send the agent back to work from there, and the
	// notice belongs under the answer the user reads when they come back.
	pi.on(
		"agent_settled",
		failOpen((_event, ctx: ExtensionContext) => {
			runtime.touch(ctx);
			// One the user turned on themselves while the run went on needs no telling.
			const offered = waiting.splice(0).filter((name) => !answered.has(name));
			if (offered.length === 0 || !ctx.hasUI) return undefined;
			for (const name of offered) {
				const feature = titleOf(name);
				if (!feature) continue;
				const words = { title: say(feature.title), summary: say(feature.summary) };
				ctx.ui.notify(
					say({
						zh: `mu：模型建议为这类任务打开「${words.title}」，它现在是关的。${words.summary}\n/capabilities open feature:${name} 打开它，下一个会话起生效。不用理会就保持关闭，这次对话里不会再提，之后在 /waiting 里能看到。`,
						en: `mu: the model suggests ${words.title} for work like this. It's off now. ${words.summary}\n/capabilities open feature:${name} turns it on, from the next session. Leave it and it stays off; mu won't bring it up again in this session, and it stays in /waiting.`,
					}),
					"info",
				);
				record({ feature: name, answer: "offered", by: "model" });
			}
			return undefined;
		}),
	);

	pi.on(
		"session_start",
		failOpen((_event, ctx: ExtensionContext) => {
			runtime.touch(ctx);
			answered.clear();
			waiting.length = 0;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== FEATURE_OFFER_ENTRY) continue;
				const data = entry.data as Partial<FeatureOfferRecord> | undefined;
				if (typeof data?.feature === "string" && (data.answer === "on" || data.answer === "offered")) {
					answered.set(data.feature, data.answer);
					if (data.answer === "on") runtime.featuresTurnedOn.add(`feature:${data.feature}`);
				}
			}
			return undefined;
		}),
	);
}
