import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { createJiti } from "jiti";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkNativeImport,
	exactVersion,
	forbiddenFiles,
	hostModulesChunk,
	piHostPlugin,
	rewriteMetaUrl,
	virtualModuleNames,
} from "../../../kyrn/npm/build.mjs";

/**
 * The npm package mu-agent (kyrn/npm/build.mjs). Building it needs pi's bundle, so these check the decisions
 * the build rests on; the package itself is built, installed and run in CI (.github/workflows/npm.yml).
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const temporary: string[] = [];
afterEach(() => {
	for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mu-npm-package-"));
	temporary.push(dir);
	return dir;
}

function write(path: string, text: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	return path;
}

/**
 * A package laid out like mu-agent, with a stand-in for pi's bundle: one chunk with a pi-tui class and a live
 * binding, and the chunk that hands it to extensions as VIRTUAL_MODULES, written the way esbuild writes it.
 */
function fakePackage(): { root: string; hostImport: string; source: string } {
	const root = tempDir();
	write(
		join(root, "dist/bundle/chunks/chunk-TUI.js"),
		'export class Text { static from = "pi\'s bundle"; }\nexport let width = 80;\nexport function setWidth(value) { width = value; }\n',
	);
	write(
		join(root, "dist/bundle/chunks/virtual-modules-TEST.js"),
		'import * as tui from "./chunk-TUI.js";\nvar VIRTUAL_MODULES = { "@earendil-works/pi-tui": tui };\nexport{VIRTUAL_MODULES};\n',
	);
	// As in the package: without "type": "module" jiti takes a .js file with import statements for one to transpile.
	write(join(root, "judge/package.json"), '{ "private": true, "type": "module" }\n');
	const source = write(
		join(root, "src/extension.js"),
		'import { Text, setWidth, width } from "@earendil-works/pi-tui";\nexport default function extension() {\n\tsetWidth(120);\n\treturn { Text, width: () => width };\n}\n',
	);
	return { root, hostImport: "../../dist/bundle/chunks/virtual-modules-TEST.js", source };
}

async function bundle(source: string, outfile: string, plugin: Plugin): Promise<string[]> {
	const result = await build({
		entryPoints: [source],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22.19",
		logLevel: "silent",
		metafile: true,
		plugins: [plugin],
	});
	return Object.values(result.metafile.outputs).flatMap((output) =>
		output.imports
			.filter((imported) => imported.external && !isBuiltin(imported.path))
			.map((imported) => imported.path),
	);
}

/** How mu 0.1.3 built it: pi's modules left as bare imports, for jiti to hand over. */
const leftToJiti: Plugin = {
	name: "left-to-jiti",
	setup(builder) {
		builder.onResolve({ filter: /^@earendil-works\// }, (args) => ({ path: args.path, external: true }));
	},
};

/** pi's loader in its npm bundle (packages/coding-agent/src/core/extensions/loader.ts), with Babel replaced by a witness. */
function loadLikePi(file: string, transpiled: string[]): Promise<unknown> {
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		fsCache: false,
		tryNative: false,
		virtualModules: { "@earendil-works/pi-tui": { Text: class Text {} } },
		transform: (options) => {
			transpiled.push(options.filename ?? "");
			throw new Error("transpiled with Babel");
		},
	});
	return jiti.import(file, { default: true });
}

describe("the judgment layer's bundle", () => {
	// mu 0.1.3 on a 1 GB server: Node could not import the bundle, so jiti transpiled all 3 MB of it with Babel at
	// every start. That took more than 500 MB of heap, and V8 aborted before the first frame.
	it("is imported by pi's loader as it is, with pi's own modules, and never transpiled", async () => {
		const { root, hostImport, source } = fakePackage();
		const file = join(root, "judge/mu/index.js");
		const provided = new Set(["@earendil-works/pi-tui"]);
		expect(await bundle(source, file, piHostPlugin({ provided, hostImport }))).toEqual([hostImport]);
		expect(readFileSync(file, "utf8")).not.toContain('from "@earendil-works/');

		const transpiled: string[] = [];
		const extension = (await loadLikePi(file, transpiled)) as () => { Text: { from?: string }; width: () => number };
		expect(transpiled).toEqual([]);
		const made = extension();
		// pi's class from pi's bundle, not what jiti would have handed a transpiled module; and a binding that stays live.
		expect(made.Text.from).toBe("pi's bundle");
		expect(made.width()).toBe(120);
		checkNativeImport(file);
	});

	it("was transpiled when pi's modules were left as bare imports, as in 0.1.3", async () => {
		const { root, source } = fakePackage();
		const file = join(root, "judge/mu/index.js");
		expect(await bundle(source, file, leftToJiti)).toEqual(["@earendil-works/pi-tui"]);
		const transpiled: string[] = [];
		await expect(loadLikePi(file, transpiled)).rejects.toThrow("transpiled with Babel");
		// jiti names the file with forward slashes on Windows too.
		expect(transpiled.map((name) => resolve(name))).toEqual([file]);
		expect(() => checkNativeImport(file)).toThrow("Node cannot import");
	});

	it("finds the one chunk of pi's bundle that exports VIRTUAL_MODULES", () => {
		const bundleDir = tempDir();
		write(join(bundleDir, "chunks/chunk-A1.js"), "var x = 1;\nexport{x};\n");
		write(join(bundleDir, "chunks/chunk-B2.js"), 'import{VIRTUAL_MODULES}from"./virtual-modules-X1.js";\n');
		write(join(bundleDir, "chunks/virtual-modules-X1.js"), "var VIRTUAL_MODULES = {};\nexport{VIRTUAL_MODULES};\n");
		expect(hostModulesChunk(bundleDir)).toBe("virtual-modules-X1.js");

		write(join(bundleDir, "chunks/chunk-C3.js"), "var VIRTUAL_MODULES = {};\nexport {\n  VIRTUAL_MODULES\n};\n");
		expect(() => hostModulesChunk(bundleDir)).toThrow("found chunk-C3.js, virtual-modules-X1.js");
		const empty = tempDir();
		write(join(empty, "chunks/chunk-A1.js"), "export{};\n");
		expect(() => hostModulesChunk(empty)).toThrow("found none");
	});
});

describe("the npm package", () => {
	it("takes from pi exactly the modules pi hands to an extension, and no subpath of them", () => {
		const names = virtualModuleNames(
			readFileSync(join(repo, "packages/coding-agent/src/core/extensions/virtual-modules.ts"), "utf8"),
		);
		expect(names).toEqual(
			expect.arrayContaining([
				"typebox",
				"@earendil-works/pi-coding-agent",
				"@earendil-works/pi-tui",
				"@earendil-works/pi-ai",
				"@earendil-works/pi-agent-core",
			]),
		);
		// The judgment layer's deep imports of pi-ai (google-login) are not among them: those go into its bundle.
		expect(names).not.toContain("@earendil-works/pi-ai/utils/text");
		expect(names.every((name) => !name.includes(" "))).toBe(true);
	});

	it("gives every file in the one bundle the URL its source file had, taken from the judge folder", () => {
		const source = 'const PROMPTS_DIR = fileURLToPath(new URL("../../../prompts", import.meta.url));';
		const rewritten = rewriteMetaUrl(source, join("src", "extension", "features", "commands.ts"));
		expect(rewritten).toBe(
			'const PROMPTS_DIR = fileURLToPath(new URL("../../../prompts", new URL("src/extension/features/commands.ts", new URL("../", import.meta.url)).href));',
		);
		// From judge/mu/index.js that is judge/prompts, where the build copies them.
		const bundle = "file:///usr/lib/node_modules/mu-agent/judge/mu/index.js";
		const at = new URL("src/extension/features/commands.ts", new URL("../", bundle)).href;
		expect(new URL("../../../prompts", at).href).toBe("file:///usr/lib/node_modules/mu-agent/judge/prompts");
		expect(rewriteMetaUrl("export const x = 1;", "src/x.ts")).toBe("export const x = 1;");
	});

	it("never packs a file that could hold a credential", () => {
		expect(
			forbiddenFiles([
				"judge/mu/index.js",
				".env",
				"kyrn/.env.local",
				"kyrn/.env.example",
				"agent/auth.json",
				"x\\models-store.json",
				".npmrc",
				"certs/server.pem",
			]),
		).toEqual([".env", "kyrn/.env.local", "agent/auth.json", "x\\models-store.json", ".npmrc", "certs/server.pem"]);
	});

	it("writes dependencies as exact versions", () => {
		expect(exactVersion("^0.86.0")).toBe("0.86.0");
		expect(exactVersion("2.7.0")).toBe("2.7.0");
		expect(() => exactVersion(">=1")).toThrow("not an exact version");
	});
});
