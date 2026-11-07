#!/usr/bin/env node
/**
 * A language server for tests. It speaks the real framing over stdio and
 * derives diagnostics from markers in the document text, so a test scripts
 * every document version by writing the file it wants:
 *
 *   !error CODE message    an error on that line (also !warn, !info, !hint)
 *   !needs NAME            an error unless some open document has "!provides NAME"
 *   !crash                 the process exits with code 7 on reading the document
 *
 * It also answers questions about symbols, in the documents it has and the
 * `.fake` files in the workspace root, by the word under the position:
 *
 *   def NAME rest          NAME is defined here; `rest` is its hover text
 *   impl NAME              NAME is implemented here
 *   any other NAME         a use of NAME
 *
 * Behaviour comes from a JSON object in argv[2]:
 *   pull          advertise diagnosticProvider and answer textDocument/diagnostic instead of publishing
 *   versioned     put the document version into publishDiagnostics (default true)
 *   delayMs       wait before publishing or answering a pull
 *   quietWhenClean  say nothing about a document that has and had no diagnostics
 *   progressMs    report work-done progress for this long after `initialized`
 *   hang          a method that is never answered
 *   log           a file that gets one line per start and per received method
 *   stderr        text written to stderr at start
 *   navigation    advertise and answer definition, references, implementation and hover (default true)
 *   noImplementation  leave implementation out of that
 *   links         answer definitions with LocationLinks
 *   hoverStrings  answer hovers with old-style marked strings
 *   modifiedOnce  answer the first question with "content modified", as a server does when the text changed under it
 */
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const config = JSON.parse(process.argv[2] ?? "{}");
const log = (line) => config.log && appendFileSync(config.log, `${line}\n`);
log(`start ${process.pid}`);
if (config.stderr) process.stderr.write(config.stderr);

const SEVERITY = { error: 1, warn: 2, info: 3, hint: 4 };
const documents = new Map();
const published = new Map();
let nextRequestId = 1000;

function send(message) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
	process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

function diagnosticsOf(uri) {
	const provided = new Set();
	for (const { text } of documents.values()) {
		for (const match of text.matchAll(/!provides (\S+)/g)) provided.add(match[1]);
	}
	const diagnostics = [];
	(documents.get(uri)?.text ?? "").split("\n").forEach((content, line) => {
		const marker = /!(error|warn|info|hint) (\S+) (.*)$/.exec(content);
		const range = (index, length) => ({ start: { line, character: index }, end: { line, character: index + length } });
		if (marker) {
			diagnostics.push({
				range: range(marker.index, marker[0].length),
				severity: SEVERITY[marker[1]],
				code: marker[2],
				source: "fake",
				message: marker[3],
			});
		}
		const needs = /!needs (\S+)/.exec(content);
		if (needs && !provided.has(needs[1])) {
			diagnostics.push({
				range: range(needs.index, needs[0].length),
				severity: 1,
				code: "E_NEEDS",
				source: "fake",
				message: `Missing ${needs[1]}`,
			});
		}
	});
	return diagnostics;
}

let root;
let modified = Boolean(config.modifiedOnce);

/** Every text the server knows, by path: the root's `.fake` files as on disk, the open documents as sent. */
function texts() {
	const known = new Map();
	for (const name of root ? readdirSync(root) : []) {
		if (name.endsWith(".fake")) known.set(join(root, name), readFileSync(join(root, name), "utf8"));
	}
	for (const [uri, { text }] of documents) known.set(fileURLToPath(uri), text);
	return known;
}

/** The places of a word, each with what it is: a definition, an implementation, a use. */
function occurrences(word) {
	const places = [];
	const pattern = new RegExp(`(?<!\\w)${word}(?!\\w)`, "g");
	for (const [path, text] of texts()) {
		text.split("\n").forEach((content, line) => {
			for (const match of content.matchAll(pattern)) {
				const before = content.slice(0, match.index);
				const kind = /\bdef $/.test(before) ? "def" : /\bimpl $/.test(before) ? "impl" : "use";
				const range = { start: { line, character: match.index }, end: { line, character: match.index + word.length } };
				places.push({ path, line, content, range, kind });
			}
		});
	}
	return places;
}

function wordAt({ textDocument, position }) {
	const line = (texts().get(fileURLToPath(textDocument.uri)) ?? "").split("\n")[position.line] ?? "";
	let start = position.character;
	let end = position.character;
	while (start > 0 && /\w/.test(line[start - 1])) start--;
	while (end < line.length && /\w/.test(line[end])) end++;
	return line.slice(start, end);
}

const location = (place) => ({ uri: pathToFileURL(place.path).href, range: place.range });

function navigate(method, params) {
	const word = wordAt(params);
	if (!word) return null;
	const places = occurrences(word);
	if (method === "textDocument/definition") {
		const found = places.filter((place) => place.kind === "def");
		if (config.links) {
			return found.map((place) => ({
				targetUri: pathToFileURL(place.path).href,
				targetRange: { start: { line: place.line, character: 0 }, end: { line: place.line, character: place.content.length } },
				targetSelectionRange: place.range,
			}));
		}
		return found.length === 1 ? location(found[0]) : found.map(location);
	}
	if (method === "textDocument/implementation") return places.filter((place) => place.kind === "impl").map(location);
	if (method === "textDocument/references") {
		return places.filter((place) => params.context?.includeDeclaration || place.kind !== "def").map(location);
	}
	const definition = places.find((place) => place.kind === "def");
	if (!definition) return null;
	const doc = definition.content.slice(definition.range.end.character).trim();
	if (config.hoverStrings) return { contents: [{ language: "fake", value: word }, doc] };
	return { contents: { kind: "markdown", value: `\`\`\`fake\n${word}\n\`\`\`\n${doc}` } };
}

function publishAll() {
	for (const [uri, document] of documents) {
		const diagnostics = diagnosticsOf(uri);
		const serialized = JSON.stringify(diagnostics);
		const before = published.get(uri);
		if (config.quietWhenClean && diagnostics.length === 0 && (before === undefined || before === "[]")) continue;
		// Like most servers: a document whose diagnostics did not change is not published again, the changed one always is.
		if (before === serialized && !document.dirty) continue;
		document.dirty = false;
		published.set(uri, serialized);
		const version = document.version;
		setTimeout(() => {
			send({
				method: "textDocument/publishDiagnostics",
				params: { uri, diagnostics, ...(config.versioned === false ? {} : { version }) },
			});
		}, config.delayMs ?? 0);
	}
}

function changed(uri, text, version) {
	if (text.includes("!crash")) process.exit(7);
	documents.set(uri, { text, version, dirty: true });
	if (!config.pull) publishAll();
}

function handle(message) {
	const { id, method, params } = message;
	if (method === undefined) return log(`response ${JSON.stringify(message.result ?? message.error ?? null)}`);
	log(method);
	if (method === config.hang) return;
	const reply = (result) => id !== undefined && send({ id, result });
	switch (method) {
		case "initialize":
			root = params.rootPath;
			return reply({
				capabilities: {
					textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
					...(config.pull ? { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } } : {}),
					...(config.navigation === false
						? {}
						: {
								definitionProvider: true,
								referencesProvider: true,
								hoverProvider: true,
								...(config.noImplementation ? {} : { implementationProvider: true }),
							}),
				},
				serverInfo: { name: "fake-lsp", version: "1" },
			});
		case "initialized":
			send({ id: nextRequestId++, method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
			if (config.progressMs) {
				send({ id: nextRequestId++, method: "window/workDoneProgress/create", params: { token: "index" } });
				send({ method: "$/progress", params: { token: "index", value: { kind: "begin", title: "Indexing" } } });
				setTimeout(
					() => send({ method: "$/progress", params: { token: "index", value: { kind: "end" } } }),
					config.progressMs,
				);
			}
			return;
		case "textDocument/didOpen":
			return changed(params.textDocument.uri, params.textDocument.text, params.textDocument.version);
		case "textDocument/didChange":
			return changed(params.textDocument.uri, params.contentChanges.at(-1).text, params.textDocument.version);
		case "textDocument/didClose":
			documents.delete(params.textDocument.uri);
			published.delete(params.textDocument.uri);
			return;
		case "textDocument/diagnostic": {
			const items = diagnosticsOf(params.textDocument.uri);
			const resultId = JSON.stringify(items);
			const report =
				params.previousResultId === resultId ? { kind: "unchanged", resultId } : { kind: "full", resultId, items };
			return setTimeout(() => reply(report), config.delayMs ?? 0);
		}
		case "textDocument/definition":
		case "textDocument/references":
		case "textDocument/implementation":
		case "textDocument/hover":
			if (config.navigation === false) break;
			if (modified) {
				modified = false;
				return send({ id, error: { code: -32801, message: "Content modified" } });
			}
			return reply(navigate(method, params));
		case "shutdown":
			return reply(null);
		case "exit":
			return process.exit(0);
	}
	if (id !== undefined) send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const length = Number(/content-length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"))?.[1]);
		if (buffer.length < headerEnd + 4 + length) return;
		const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
		buffer = buffer.subarray(headerEnd + 4 + length);
		handle(JSON.parse(body));
	}
});
process.stdin.on("end", () => process.exit(0));
