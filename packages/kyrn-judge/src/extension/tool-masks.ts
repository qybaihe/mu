import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A tool kept off the model's list, and every owner that keeps it off with why. */
export interface HeldTool {
	readonly tool: string;
	readonly by: readonly { readonly owner: string; readonly why: string }[];
}

/**
 * The one place mu takes tools off the model's list and puts them back. Each owner (the capability catalog, an
 * unattended run, the MCP description screen) says which tools it keeps off and why, and `apply` sets pi's active list
 * from all of them at once. Owners used to edit the list themselves, each putting back only what it had taken: a
 * capability the catalog opened came back on the list although the description screen had taken its tool off, until
 * the screen took it off again at the next turn.
 *
 * Only tools a mask took off are ever put back: what the user left off (`--tools`) stays off. The order of the tools
 * that stay is kept, and a tool put back goes at the end, so a request's tool list changes as little as it can.
 */
export class ToolMasks {
	private readonly pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;
	private readonly masks = new Map<string, { readonly tools: ReadonlySet<string>; readonly why: string }>();
	/** Tools a mask took off the active list: the only ones `apply` puts back. */
	private readonly withheld = new Set<string>();

	constructor(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">) {
		this.pi = pi;
	}

	/** What `owner` keeps off the list from now on, replacing what it kept off before. No tools: it keeps none. */
	set(owner: string, tools: Iterable<string>, why: string): void {
		const held = new Set(tools);
		if (held.size === 0) this.masks.delete(owner);
		else this.masks.set(owner, { tools: held, why });
	}

	/** Every tool kept off, with who keeps it off and why, for `/status`. */
	held(): HeldTool[] {
		const found = new Map<string, { owner: string; why: string }[]>();
		for (const [owner, mask] of this.masks) {
			for (const tool of mask.tools) found.set(tool, [...(found.get(tool) ?? []), { owner, why: mask.why }]);
		}
		return [...found].sort(([a], [b]) => a.localeCompare(b)).map(([tool, by]) => ({ tool, by }));
	}

	/** Whether some owner keeps `tool` off the list. */
	holds(tool: string): boolean {
		for (const mask of this.masks.values()) if (mask.tools.has(tool)) return true;
		return false;
	}

	/** Sets pi's active tools: every held tool off, and back every tool a mask took off that no mask holds now. */
	apply(): void {
		const active = this.pi.getActiveTools();
		const kept = active.filter((tool) => !this.holds(tool));
		for (const tool of active) if (this.holds(tool)) this.withheld.add(tool);
		const back: string[] = [];
		for (const tool of [...this.withheld]) {
			if (this.holds(tool)) continue;
			this.withheld.delete(tool);
			if (!active.includes(tool)) back.push(tool);
		}
		if (kept.length !== active.length || back.length > 0) this.pi.setActiveTools([...kept, ...back]);
	}
}
