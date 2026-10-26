// Reads tool calls as JSON lines {name, input, cwd} on stdin; prints, per line, 1 if Ask-first mode would ask, else 0.
import { createInterface } from "node:readline";
import { permissionNeed } from "../../packages/kyrn-judge/src/permissions/modes.ts";
for await (const line of createInterface({ input: process.stdin })) {
	if (!line.trim()) continue;
	const { name, input, cwd } = JSON.parse(line);
	console.log(permissionNeed(name, input ?? {}, cwd) ? 1 : 0);
}
