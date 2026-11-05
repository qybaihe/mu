import { describe, expect, it } from "vitest";
import { ToolMasks } from "../src/extension/tool-masks.ts";

/** pi's active tool list, counting how often it is set. */
function fakePi(tools: string[]) {
	const pi = {
		active: [...tools],
		sets: 0,
		getActiveTools: () => [...pi.active],
		setActiveTools: (names: string[]) => {
			pi.active = [...names];
			pi.sets++;
		},
	};
	return pi;
}

describe("tool masks", () => {
	// The catalog put a capability's tool back when the capability opened, although the description screen had taken it
	// off, and the list was right again only once the screen took it off a second time.
	it("keep a tool off while any owner holds it, and put it back when none does", () => {
		const pi = fakePi(["read", "mcp__docs__search", "mcp__docs__fetch"]);
		const masks = new ToolMasks(pi);
		masks.set("catalog", ["mcp__docs__search", "mcp__docs__fetch"], "capability not open");
		masks.apply();
		expect(pi.active).toEqual(["read"]);
		masks.set("tool.description", ["mcp__docs__fetch"], "poisoned");
		masks.apply();
		// The capability opens: the catalog lets go, the screen still holds one of its tools.
		masks.set("catalog", [], "capability not open");
		masks.apply();
		expect(pi.active).toEqual(["read", "mcp__docs__search"]);
		masks.set("tool.description", [], "poisoned");
		masks.apply();
		expect(pi.active).toEqual(["read", "mcp__docs__search", "mcp__docs__fetch"]);
	});

	it("never put back a tool no mask took off, such as one the user left out with --tools", () => {
		const pi = fakePi(["read", "bash"]);
		const masks = new ToolMasks(pi);
		masks.set("unattended", ["edit"], "left out");
		masks.apply();
		masks.set("unattended", [], "left out");
		masks.apply();
		expect(pi.active).toEqual(["read", "bash"]);
		expect(pi.sets).toBe(0);
	});

	it("take off again what something else put back, and leave the list alone when nothing changes", () => {
		const pi = fakePi(["read", "bash", "mcp__evil__add"]);
		const masks = new ToolMasks(pi);
		masks.set("tool.description", ["mcp__evil__add"], "poisoned");
		masks.apply();
		masks.apply();
		expect(pi.sets).toBe(1);
		pi.setActiveTools([...pi.active, "mcp__evil__add"]);
		masks.apply();
		expect(pi.active).toEqual(["read", "bash"]);
	});

	it("keep the order of the tools that stay, and add a tool put back at the end", () => {
		const pi = fakePi(["a", "b", "c", "d"]);
		const masks = new ToolMasks(pi);
		masks.set("catalog", ["b"], "closed");
		masks.apply();
		masks.set("catalog", [], "closed");
		masks.apply();
		expect(pi.active).toEqual(["a", "c", "d", "b"]);
	});

	it("say for each held tool who holds it and why", () => {
		const masks = new ToolMasks(fakePi([]));
		masks.set("tool.description", ["mcp__x__b"], "poisoned");
		masks.set("catalog", ["mcp__x__b", "mcp__x__a"], "capability not open");
		expect(masks.held()).toEqual([
			{ tool: "mcp__x__a", by: [{ owner: "catalog", why: "capability not open" }] },
			{
				tool: "mcp__x__b",
				by: [
					{ owner: "tool.description", why: "poisoned" },
					{ owner: "catalog", why: "capability not open" },
				],
			},
		]);
	});
});
