#!/usr/bin/env node
/**
 * A small MCP server for tests, speaking newline-delimited JSON-RPC on stdio.
 *
 *   --starts-file <path>       appends a line on every start, so tests can count starts
 *   --crash-on-start           writes to stderr and exits before answering anything
 *   --hang-on-start            never answers anything, as a stuck start does
 *   --leak-env <NAME>          writes the value of that variable to stderr on start and when it crashes
 *
 * Tools: echo, fail, picture, crash, grow (adds the tool `late` and announces the change), plus fillers whose names
 * need cleaning up, and enough of them that `tools/list` needs several pages.
 */
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const startsFile = option("--starts-file");
const leak = option("--leak-env");
const PAGE = 3;

if (startsFile) appendFileSync(startsFile, `${process.pid}\n`);
if (leak) process.stderr.write(`starting with token ${process.env[leak]}\n`);
if (flag("--crash-on-start")) {
	process.stderr.write("fatal: cannot open database /nowhere/db.sqlite\n");
	process.exit(2);
}

const tool = (name, description, properties = {}, required = []) => ({
	name,
	description,
	inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties, required },
});
const tools = [
	tool("echo", "Echo a message back", { message: { type: "string", description: "What to say" } }, ["message"]),
	tool("fail", "Always reports an error"),
	tool("picture", "Returns a tiny image"),
	tool("crash", "Takes the server down"),
	tool("grow", "Adds another tool and says so"),
	tool("pad.one", "Filler with a dot in its name"),
	tool("pad one", "Filler with a space in its name"),
];

let initialized = false;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const refuse = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

function call(id, params) {
	const name = params?.name;
	const input = params?.arguments ?? {};
	if (name === "echo") return reply(id, { content: [{ type: "text", text: `echo: ${input.message}` }] });
	if (name === "fail") return reply(id, { content: [{ type: "text", text: "the upstream API said no" }], isError: true });
	if (name === "picture") {
		return reply(id, {
			content: [
				{ type: "text", text: "one pixel" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
		});
	}
	if (name === "crash") {
		process.stderr.write(`panic: out of cheese${leak ? ` (token ${process.env[leak]})` : ""}\n`);
		process.exit(3);
	}
	if (name === "grow") {
		if (!tools.some((entry) => entry.name === "late")) tools.push(tool("late", "A tool that appeared later"));
		reply(id, { content: [{ type: "text", text: "grown" }] });
		send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		return undefined;
	}
	if (name === "late" && tools.some((entry) => entry.name === "late")) {
		return reply(id, { content: [{ type: "text", text: "late but here" }] });
	}
	return refuse(id, -32602, `Unknown tool: ${name}`);
}

function handle(message) {
	if (flag("--hang-on-start")) return undefined;
	const { id, method, params } = message;
	if (id === undefined) {
		if (method === "notifications/initialized") initialized = true;
		return;
	}
	if (method === "initialize") {
		return reply(id, {
			protocolVersion: "2025-06-18",
			capabilities: { tools: { listChanged: true } },
			serverInfo: { name: "fake", version: "1.0.0" },
		});
	}
	if (!initialized) return refuse(id, -32600, "Received request before initialization was complete");
	if (method === "tools/list") {
		const start = params?.cursor ? Number(params.cursor) : 0;
		const next = start + PAGE < tools.length ? String(start + PAGE) : undefined;
		return reply(id, { tools: tools.slice(start, start + PAGE), ...(next ? { nextCursor: next } : {}) });
	}
	if (method === "tools/call") return call(id, params);
	return refuse(id, -32601, `Method not found: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const end = buffer.indexOf("\n");
		if (end === -1) break;
		const line = buffer.slice(0, end).trim();
		buffer = buffer.slice(end + 1);
		if (!line) continue;
		try {
			handle(JSON.parse(line));
		} catch (error) {
			process.stderr.write(`bad message: ${error.message}\n`);
		}
	}
});
// The client closing its end is the signal to leave.
process.stdin.on("end", () => process.exit(0));
