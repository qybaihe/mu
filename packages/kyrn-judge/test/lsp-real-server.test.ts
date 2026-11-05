/**
 * The tests that talk to a real language server. Opt-in, because each needs a
 * server that is already on this machine (`typescript-language-server` with a
 * TypeScript it can load, `gopls` with a Go toolchain) and takes seconds:
 *
 *   MU_LSP_REAL=1 vitest --run test/lsp-real-server.test.ts
 *
 * Nothing is installed for them. A server that is not on PATH is skipped.
 * On macOS, `/usr/bin/clangd` is Xcode's forwarder, which exits until Xcode's
 * licence is accepted; the Command Line Tools' own clangd runs as it is:
 *
 *   PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH MU_LSP_REAL=1 vitest --run test/lsp-real-server.test.ts
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LspClient } from "../src/lsp/client.ts";
import { isExecutableFile } from "../src/lsp/manager.ts";
import { readHover, readPlaces, symbolAt } from "../src/lsp/navigation.ts";
import { findOnPath, languageIdFor, spawnPlan } from "../src/lsp/servers.ts";
import { uriStyleFor } from "../src/lsp/uri.ts";

const executable = findOnPath("typescript-language-server", {
	env: process.env,
	platform: process.platform,
	isExecutable: (path) => isExecutableFile(path),
});

describe.skipIf(!executable || process.env.MU_LSP_REAL !== "1")("typescript-language-server", () => {
	let client: LspClient | undefined;
	let root: string | undefined;
	afterEach(async () => {
		await client?.stop();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("reports the type error an edit introduced, and not the one that was there before", async () => {
		root = mkdtempSync(join(tmpdir(), "mu-lsp-real-"));
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
		);
		const file = join(root, "a.ts");
		const before = 'export const old: number = "already wrong";\nexport const fine = 1;\n';
		const after = `// a new first line\n${before}export const added: string = 42;\n`;
		writeFileSync(file, before);

		const plan = spawnPlan(executable as string, ["--stdio"], process.platform, process.env);
		client = new LspClient({
			...plan,
			root,
			uriStyle: uriStyleFor({ platform: process.platform, env: process.env, executable }),
			languageId: languageIdFor,
			baselineMs: 30000,
		});
		await client.start();
		client.setText(file, before, true);
		writeFileSync(file, after);
		client.setText(file, after);

		expect(await client.waitSettled(60000)).toBe(true);
		const fresh = client.fresh();
		expect(fresh).toHaveLength(1);
		expect(fresh[0].diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.line])).toEqual([["2322", 3]]);
	}, 90000);
});

const gopls = findOnPath("gopls", {
	env: process.env,
	platform: process.platform,
	isExecutable: (path) => isExecutableFile(path),
});

describe.skipIf(!gopls || process.env.MU_LSP_REAL !== "1")("gopls", () => {
	let client: LspClient | undefined;
	let root: string | undefined;
	afterEach(async () => {
		await client?.stop();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("reports the error an edit introduced in a Go file, and not the one that was there before", async () => {
		root = mkdtempSync(join(tmpdir(), "mu-lsp-real-"));
		writeFileSync(join(root, "go.mod"), "module example.com/mu\n\ngo 1.22\n");
		const file = join(root, "a.go");
		const before = "package a\n\nfunc old() int { return undeclaredOne }\n\nfunc fine() int { return 1 }\n";
		const after = `// a new first line\n${before}\nfunc added() int { return undeclaredTwo }\n`;
		writeFileSync(file, before);

		const plan = spawnPlan(gopls as string, [], process.platform, process.env);
		client = new LspClient({
			...plan,
			root,
			uriStyle: uriStyleFor({ platform: process.platform, env: process.env, executable: gopls }),
			languageId: languageIdFor,
			baselineMs: 30000,
		});
		await client.start();
		client.setText(file, before, true);
		writeFileSync(file, after);
		client.setText(file, after);

		expect(await client.waitSettled(60000)).toBe(true);
		const fresh = client.fresh();
		expect(fresh).toHaveLength(1);
		// The old error moved down a line with the edit, and is still not news.
		expect(fresh[0].diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
			expect.stringContaining("undeclaredTwo"),
		]);
	}, 90000);
});

const clangd = findOnPath("clangd", {
	env: process.env,
	platform: process.platform,
	isExecutable: (path) => isExecutableFile(path),
});

describe.skipIf(!clangd || process.env.MU_LSP_REAL !== "1")("clangd", () => {
	let client: LspClient | undefined;
	let root: string | undefined;
	afterEach(async () => {
		await client?.stop();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("answers where a function is defined, where it is used and what it is", async () => {
		// The server may name files by their real path: macOS's temporary folder is a link.
		root = realpathSync(mkdtempSync(join(tmpdir(), "mu-lsp-real-")));
		writeFileSync(join(root, "compile_flags.txt"), "");
		const file = join(root, "a.c");
		const text = "int twice(int x) { return x * 2; }\nint main(void) { return twice(3) + twice(4); }\n";
		writeFileSync(file, text);

		const plan = spawnPlan(clangd as string, [], process.platform, process.env);
		const running = new LspClient({
			...plan,
			root,
			uriStyle: uriStyleFor({ platform: process.platform, env: process.env, executable: clangd }),
			languageId: languageIdFor,
		});
		client = running;
		await running.start();
		running.setText(file, text, true);
		const ask = (method: string, extra: object = {}) =>
			running.ask(
				method,
				{
					textDocument: { uri: running.uriOf(file) },
					position: { line: 1, character: symbolAt(text.split("\n")[1], "twice") },
					...extra,
				},
				30000,
			);
		const places = (result: unknown) =>
			readPlaces(result, (uri) => running.pathOf(uri)).map((place) => [place.path, place.line, place.character]);

		expect(
			["definitionProvider", "referencesProvider", "hoverProvider"].map((name) => running.supports(name)),
		).toEqual([true, true, true]);
		expect(places(await ask("textDocument/definition"))).toEqual([[file, 0, 4]]);
		expect(places(await ask("textDocument/references", { context: { includeDeclaration: true } }))).toEqual([
			[file, 0, 4],
			[file, 1, 24],
			[file, 1, 35],
		]);
		expect(readHover(await ask("textDocument/hover"))).toContain("int twice(int x)");
	}, 90000);
});
