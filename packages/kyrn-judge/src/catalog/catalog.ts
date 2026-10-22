/**
 * The capability catalog: what makes "install a lot, expose little" possible.
 *
 * Tools, MCP servers, language servers and capability packs all register
 * here. A capability that is `always` exposed is part of every session. One
 * that is `judged` is installed but its tools stay out of the model's tool
 * list until the judge finds it relevant to the task, or the model asks for
 * it through `find_capability`. Its backing process starts only then.
 *
 * Hidden is never gone: every hidden capability can be found and opened by
 * the model, and a capability that had to be asked for is recorded as a miss,
 * which is the label a disclosure judge is later measured against.
 */
export type CapabilityKind = "tool" | "pack" | "mcp" | "lsp";

export interface Capability {
	/** Stable and unique, e.g. "pack:ast-grep", "mcp:github", "tool:web". */
	readonly id: string;
	readonly kind: CapabilityKind;
	/** A short name for people. */
	readonly title: string;
	/** One sentence on what it is for. The judge and `find_capability` read this. */
	readonly description: string;
	/** Names of the registered tools that belong to it. */
	readonly tools: readonly string[];
	/** `always`: in every session. `judged`: hidden until found relevant or asked for. */
	readonly exposure: "always" | "judged";
	/** Starts whatever backs it (a server, a child process). Called once, on first opening. */
	readonly activate?: () => Promise<void> | void;
}

/**
 * How a capability came to be open. `requested` is a miss of the disclosure decision. `parent`: a sub-agent opened
 * what its parent has open.
 */
export type OpenedBy = "always" | "judge" | "requested" | "user" | "parent";

export interface OpenRecord {
	readonly id: string;
	readonly by: OpenedBy;
	readonly turn: number;
}

export class CapabilityCatalog {
	private readonly entries = new Map<string, Capability>();
	private readonly opened = new Map<string, OpenRecord>();
	private readonly activated = new Set<string>();

	/** Registering the same id again replaces the entry: an MCP server list can be reloaded. */
	register(capability: Capability): void {
		this.entries.set(capability.id, capability);
	}

	get(id: string): Capability | undefined {
		return this.entries.get(id);
	}

	list(): readonly Capability[] {
		return [...this.entries.values()];
	}

	isOpen(id: string): boolean {
		const capability = this.entries.get(id);
		return capability !== undefined && (capability.exposure === "always" || this.opened.has(id));
	}

	/** Judged capabilities that are still hidden. */
	hidden(): readonly Capability[] {
		return this.list().filter((capability) => !this.isOpen(capability.id));
	}

	/** Tools that must stay out of the model's tool list right now. */
	hiddenTools(): ReadonlySet<string> {
		const open = new Set(
			this.list()
				.filter((capability) => this.isOpen(capability.id))
				.flatMap((capability) => capability.tools),
		);
		// A tool shared by two capabilities is visible as soon as one of them is open.
		return new Set(
			this.hidden()
				.flatMap((capability) => capability.tools)
				.filter((tool) => !open.has(tool)),
		);
	}

	/**
	 * Opens a capability and starts what backs it. Resolves to false when the id
	 * is unknown or it was open already. A failing `activate` leaves it closed and
	 * rethrows, so the caller can say why.
	 */
	async open(id: string, by: OpenedBy, turn: number): Promise<boolean> {
		const capability = this.entries.get(id);
		if (!capability || this.isOpen(id)) return false;
		if (capability.activate && !this.activated.has(id)) {
			await capability.activate();
			this.activated.add(id);
		}
		this.opened.set(id, { id, by, turn });
		return true;
	}

	/** Everything opened so far, in order. */
	history(): readonly OpenRecord[] {
		return [...this.opened.values()];
	}

	/** Hidden capabilities whose title, id or description contains any of the words; all of them for an empty query. */
	search(query: string): readonly Capability[] {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		return this.hidden().filter((capability) => {
			const text = `${capability.id} ${capability.title} ${capability.description}`.toLowerCase();
			return words.length === 0 || words.some((word) => text.includes(word));
		});
	}
}
