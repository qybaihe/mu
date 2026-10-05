/**
 * Server names pi accepts. pi's MCP client takes `[A-Za-z0-9_-]` in a server
 * name, treats `-` and `_` as the same (both become `_` in the tool names
 * `mcp__<server>__<tool>`), and names its tools itself. Names in the wild have
 * dots, spaces and slashes.
 */
export function sanitizeName(name: string): string {
	const clean = name
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^[_-]+|[_-]+$/g, "");
	return clean || "x";
}

/** Two names pi would mix up: the same once `-` is `_`, in any case. */
export const nameKey = (name: string): string => name.replace(/-/g, "_").toLowerCase();

/**
 * One pi server name per server, in the order given, stable for a given set of names. Two names that
 * sanitize to the same one ("my.server", "my server") both stay usable, and none takes a name of
 * `reserved` (the servers pi's own mcp.json defines).
 */
export function allocateServerNames(names: readonly string[], reserved: Iterable<string> = []): Map<string, string> {
	const allocated = new Map<string, string>();
	const taken = new Set([...reserved].map(nameKey));
	for (const name of names) {
		// Short enough to leave room for a recognizable piece of each tool's own name.
		const wanted =
			sanitizeName(name)
				.slice(0, 24)
				.replace(/[_-]+$/, "") || "x";
		let candidate = wanted;
		for (let count = 2; taken.has(nameKey(candidate)); count++) candidate = `${wanted}_${count}`;
		taken.add(nameKey(candidate));
		allocated.set(name, candidate);
	}
	return allocated;
}

export function capabilityId(serverName: string): string {
	return `mcp:${serverName}`;
}
