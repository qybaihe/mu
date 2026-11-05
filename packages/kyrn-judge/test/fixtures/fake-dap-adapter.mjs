#!/usr/bin/env node
// A debug adapter for tests. The "program" is a text file, one statement a line:
//   name = <json>    an assignment
//   print <text>     a line on stdout
//   raise <message>  an exception (stops there when the "uncaught" filter is set)
//   write <path>     a file the program makes; a write that fails is printed on stderr, as node words it
//   loop             runs on the spot until paused
// Flags: --port N (listen there, as delve does), --answer-launch-first (lldb-dap's order:
// launch is answered before `initialized`; the default is debugpy's: after configurationDone),
// --reverse (sends a runInTerminal request and prints what the client answered),
// --pidfile P (writes its process id there), --stray P (starts a "debuggee" that ignores the
// disconnect and outlives the adapter, as a real one can, and writes its process id there).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const portAt = argv.indexOf("--port");
const pidAt = argv.indexOf("--pidfile");
if (pidAt >= 0) writeFileSync(argv[pidAt + 1], String(process.pid));
const strayAt = argv.indexOf("--stray");
if (strayAt >= 0) {
	// Same process group as the adapter, no pipes of ours: only a signal to the group ends it.
	const stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	writeFileSync(argv[strayAt + 1], String(stray.pid));
	stray.unref();
}
const THREAD = 7;

let write = (data) => process.stdout.write(data);
let seq = 1;
const send = (message) => {
	const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }), "utf8");
	write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
};
const event = (name, body = {}) => send({ type: "event", event: name, body });
const respond = (request, body = {}, failure) =>
	send({
		type: "response",
		request_seq: request.seq,
		command: request.command,
		success: !failure,
		...(failure ? { message: failure } : {}),
		body,
	});

let path = "";
let program = [];
let pc = 0;
const locals = {};
const breakpoints = new Map();
let filters = [];
let running = false;
let pendingLaunch;
let exception;
const members = new Map();
let nextRef = 5000;

const typeOf = (value) =>
	Array.isArray(value)
		? "list"
		: value === null
			? "NoneType"
			: typeof value === "object"
				? "dict"
				: typeof value === "number"
					? "int"
					: typeof value === "string"
						? "str"
						: "bool";

function variable(name, value) {
	let reference = 0;
	if (typeof value === "object" && value !== null) {
		reference = nextRef++;
		members.set(reference, Object.entries(value));
	}
	return { name, value: JSON.stringify(value), type: typeOf(value), variablesReference: reference };
}

function holds(condition) {
	if (!condition) return true;
	const match = /^(\w+)\s*==\s*(.+)$/.exec(condition);
	if (!match) return true;
	return JSON.stringify(locals[match[1]]) === JSON.stringify(JSON.parse(match[2]));
}

function stop(reason, extra = {}) {
	running = false;
	event("stopped", { reason, threadId: THREAD, allThreadsStopped: true, ...extra });
}

function finish(code) {
	running = false;
	event("exited", { exitCode: code });
	event("terminated");
}

/** Runs one line. False: the program stopped or ended on it. */
function execute() {
	const line = program[pc] ?? "";
	const assignment = /^(\w+)\s*=\s*(.+)$/.exec(line);
	if (assignment) locals[assignment[1]] = JSON.parse(assignment[2]);
	else if (line.startsWith("print ")) event("output", { category: "stdout", output: `${line.slice(6)}\n` });
	else if (line.startsWith("write ")) {
		try {
			writeFileSync(line.slice(6), "written by the program\n");
		} catch (error) {
			event("output", { category: "stderr", output: `${error.message}\n` });
		}
	}
	else if (line.startsWith("raise ")) {
		const message = line.slice(6);
		if (exception === undefined && filters.includes("uncaught")) {
			exception = message;
			stop("exception", { description: `ValueError: ${message}`, text: "ValueError" });
			return false;
		}
		event("output", { category: "stderr", output: `Traceback (most recent call last):\nValueError: ${message}\n` });
		finish(1);
		return false;
	}
	pc += 1;
	return true;
}

function run(fromBreakpoint) {
	running = true;
	let first = fromBreakpoint;
	const tick = () => {
		if (!running) return;
		if (pc >= program.length) return finish(0);
		const point = breakpoints.get(pc + 1);
		if (!first && point !== undefined && holds(point)) return stop("breakpoint");
		first = false;
		if (program[pc] === "loop") return void setTimeout(tick, 5);
		if (execute()) setImmediate(tick);
	};
	setImmediate(tick);
}

function step() {
	if (pc >= program.length) return finish(0);
	if (program[pc] === "loop") pc += 1;
	else if (!execute()) return;
	if (pc >= program.length) return finish(0);
	stop("step");
}

function frames() {
	const source = { path, name: basename(path) };
	return [
		{ id: 1, name: "work", source, line: pc + 1, column: 1 },
		{ id: 2, name: "<module>", source, line: 1, column: 1 },
	];
}

function handle(request) {
	const args = request.arguments ?? {};
	switch (request.command) {
		case "initialize":
			return respond(request, {
				supportsConfigurationDoneRequest: true,
				supportsConditionalBreakpoints: true,
				supportsExceptionInfoRequest: true,
				exceptionBreakpointFilters: [
					{ filter: "raised", label: "Raised Exceptions", default: false },
					{ filter: "uncaught", label: "Uncaught Exceptions", default: true },
				],
			});
		case "launch": {
			try {
				path = args.program;
				program = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
			} catch {
				return respond(request, {}, `program not found: ${args.program}`);
			}
			event("output", { category: "telemetry", output: "telemetry-noise" });
			if (flag("--reverse")) {
				send({ type: "request", command: "runInTerminal", arguments: { kind: "integrated", args: ["x"] } });
			}
			if (flag("--answer-launch-first")) {
				respond(request);
				return event("initialized");
			}
			pendingLaunch = request;
			return event("initialized");
		}
		case "setBreakpoints": {
			const same = args.source?.path === path;
			const wanted = args.breakpoints ?? [];
			const answered = wanted.map((point) => {
				if (!same) return { verified: false, line: point.line, message: "unknown source" };
				if (point.line > program.length) return { verified: false, line: point.line, message: `no code at line ${point.line}` };
				breakpoints.set(point.line, point.condition ?? "");
				return { verified: true, line: point.line };
			});
			return respond(request, { breakpoints: answered });
		}
		case "setExceptionBreakpoints":
			filters = args.filters ?? [];
			return respond(request);
		case "configurationDone":
			respond(request);
			if (pendingLaunch) respond(pendingLaunch);
			pendingLaunch = undefined;
			event("process", { name: path, startMethod: "launch" });
			event("thread", { reason: "started", threadId: THREAD });
			return run(false);
		case "threads":
			return respond(request, { threads: [{ id: THREAD, name: "MainThread" }] });
		case "stackTrace":
			return respond(request, { stackFrames: frames().slice(0, args.levels || 99), totalFrames: 2 });
		case "scopes":
			return respond(request, {
				scopes:
					args.frameId === 1
						? [
								{ name: "Locals", variablesReference: 1001, expensive: false },
								{ name: "Globals", variablesReference: 1003, expensive: true },
							]
						: [{ name: "Locals", variablesReference: 1002, expensive: false }],
			});
		case "variables": {
			const reference = args.variablesReference;
			if (reference === 1001) return respond(request, { variables: Object.entries(locals).map(([k, v]) => variable(k, v)) });
			if (reference === 1002) return respond(request, { variables: [variable("__name__", "__main__")] });
			const entries = members.get(reference);
			if (!entries) return respond(request, { variables: [] });
			return respond(request, { variables: entries.map(([k, v]) => variable(k, v)) });
		}
		case "evaluate": {
			const element = /^(\w+)\[(\d+)\]$/.exec(args.expression);
			if (element && Array.isArray(locals[element[1]])) {
				return respond(request, { ...variable("", locals[element[1]][Number(element[2])]), result: JSON.stringify(locals[element[1]][Number(element[2])]) });
			}
			if (!(args.expression in locals)) return respond(request, {}, `NameError: name '${args.expression}' is not defined`);
			const shown = variable(args.expression, locals[args.expression]);
			return respond(request, { result: shown.value, type: shown.type, variablesReference: shown.variablesReference });
		}
		case "exceptionInfo":
			return respond(request, { exceptionId: "ValueError", description: exception ?? "", breakMode: "unhandled" });
		case "next":
		case "stepIn":
		case "stepOut":
			respond(request);
			return step();
		case "continue":
			respond(request, { allThreadsContinued: true });
			if (exception !== undefined && program[pc]?.startsWith("raise ")) {
				event("output", { category: "stderr", output: `ValueError: ${exception}\n` });
				return finish(1);
			}
			return run(true);
		case "pause":
			respond(request);
			if (running) stop("pause");
			return;
		case "disconnect":
			respond(request);
			return setTimeout(() => process.exit(0), 10);
		default:
			return respond(request, {}, `unknown request ${request.command}`);
	}
}

function reader(onMessage) {
	let buffer = Buffer.alloc(0);
	return (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const end = buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))?.[1]);
			if (buffer.length < end + 4 + length) return;
			const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
			buffer = buffer.subarray(end + 4 + length);
			onMessage(JSON.parse(body));
		}
	};
}

function onMessage(message) {
	if (message.type === "request") return handle(message);
	if (message.type === "response" && message.command === "runInTerminal") {
		event("output", { category: "console", output: `reverse request answered: ${message.success} ${message.message ?? ""}\n` });
	}
}

if (portAt >= 0) {
	const server = createServer((socket) => {
		write = (data) => socket.write(data);
		socket.on("data", reader(onMessage));
		socket.on("close", () => process.exit(0));
		server.close();
	});
	server.listen(Number(argv[portAt + 1]), "127.0.0.1");
} else {
	process.stdin.on("data", reader(onMessage));
	process.stdin.on("end", () => process.exit(0));
}
