// Types for the parts of build.mjs the tests call.
import type { Plugin } from "esbuild";

export function virtualModuleNames(source: string): string[];
export function hostModulesChunk(bundleDir: string): string;
export function piHostPlugin(options: { provided: ReadonlySet<string>; hostImport: string }): Plugin;
export function checkNativeImport(file: string, chunks?: readonly string[]): void;
export function extensionBundle(
	entry: string,
	outdir: string,
): { entryPoints: { index: string }; outdir: string; splitting: true; chunkNames: string };
export function rewriteMetaUrl(source: string, relativePath: string): string;
export function exactVersion(range: string): string;
export function forbiddenFiles(files: readonly string[]): string[];
export function main(argv?: readonly string[]): Promise<number>;
