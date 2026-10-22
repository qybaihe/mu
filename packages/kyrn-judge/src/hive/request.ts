/**
 * `/hive <question>`: a person starts a hive by asking a question. The main
 * model still plans the bees, since it knows the project and the angles, but
 * it is told to do so at once, in its first step, and never to ask anything
 * first: the question is the whole brief.
 */

/** What the text after `/hive` asks for. */
export type HiveArgs =
	/** Nothing, or "status": what the running sub-agents are doing, as `/swarm` shows it. */
	| { readonly kind: "status" }
	/** "stop [name]" or "kill [name]": the same as `/swarm stop|kill [name]`. */
	| { readonly kind: "control"; readonly verb: "stop" | "kill"; readonly name?: string }
	| { readonly kind: "question"; readonly question: string };

/**
 * `/hive` keeps what it did as the alias of `/swarm`: alone it shows the running sub-agents, and "stop" or
 * "kill" with at most a bee's name controls them. Anything longer is a question, so "/hive stop words: where
 * are they defined?" starts a hive rather than stopping one.
 */
export function parseHiveArgs(args: string): HiveArgs {
	const text = args.trim();
	if (!text || text === "status") return { kind: "status" };
	const [verb, name, ...more] = text.split(/\s+/);
	if ((verb === "stop" || verb === "kill") && more.length === 0) {
		return { kind: "control", verb, ...(name ? { name } : {}) };
	}
	return { kind: "question", question: text };
}

/**
 * What `/hive <question>` asks of the model. It goes with the person's `/hive <question>` as a hidden message of
 * that turn; only a `/hive` queued behind a running turn sends it as the message itself, so it starts with the
 * question. Three bees is the default because two rarely have anything to pass each other and more than four
 * mostly repeat each other; the angles are ones whose findings bear on each other, since that is what a hive is
 * for (independent parts are `delegate`'s job).
 */
export function hiveRequest(question: string): string {
	return [
		`Question for a hive: ${question.trim()}`,
		"",
		"Call the `hive` tool now, as your first step: do not read anything first, and do not ask me anything.",
		"- goal: my question as I asked it, and what a complete answer to it must contain.",
		"- bees: three investigators (two for a narrow question, four for one with four separate parts). Give each a different angle on the same question, chosen so that what one finds can confirm, correct or advance what the others look at: where it is implemented, how it is configured or called, what running it or its tests shows, what the history or the documentation says. Name each after its angle.",
		"",
		"When the hive returns, answer my question from the reports and the board: the answer first, then the evidence (file:line, commands and what they printed). Rely most on findings that were confirmed or that corrected another, and say what stayed disputed or unverified. Answer in the language of my question.",
	].join("\n");
}
