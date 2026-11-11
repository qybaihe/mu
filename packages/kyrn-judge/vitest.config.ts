import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

const schemaRoot = fileURLToPath(new URL("../schema/src", import.meta.url));
const envRoot = fileURLToPath(new URL("../env/src", import.meta.url));

// The extension test drives a real AgentSession through coding-agent's faux-provider
// harness, so workspace packages must resolve to their sources like they do there.
export default mergeConfig(
	baseConfig,
	defineConfig({
		resolve: {
			// The extension imports runtime values from pi, which the base config does not alias,
			// and the Google sign-in reuses pi-ai's Google message conversion from its api/ modules.
			alias: [
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
				{ find: /^@earendil-works\/pi-schema$/, replacement: `${schemaRoot}/index.ts` },
				{ find: /^@earendil-works\/pi-schema\/formats$/, replacement: `${schemaRoot}/formats/index.ts` },
				{ find: /^@earendil-works\/pi-env$/, replacement: `${envRoot}/index.ts` },
				{
					find: /^@earendil-works\/pi-ai\/api\/(.+)$/,
					replacement: `${workspaceSourcePaths.aiIndex.replace(/index\.ts$/, "api")}/$1.ts`,
				},
			],
		},
		test: {
			environment: "node",
			testTimeout: 30000,
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
	}),
);
