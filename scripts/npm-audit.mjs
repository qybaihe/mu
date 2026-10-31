// Runs `npm audit --omit=dev` and fails on advisories at or above the audit
// level, except for advisories that were reviewed and accepted below. Every
// accepted advisory must name the affected package and explain why it does not
// apply. Remove an entry once a fixed version is installed; the script warns
// about entries that no longer match.

import { spawnSync } from "node:child_process";

const auditLevel = "moderate";
const severities = ["info", "low", "moderate", "high", "critical"];

/** @type {Record<string, { package: string; reason: string }>} */
const acceptedAdvisories = {
	"GHSA-mrhx-c7xc-m3w5": {
		package: "zod",
		reason:
			"No fixed zod 3 release exists, and the newest @anthropic-ai/sandbox-runtime still requires zod 3. It is only " +
			"reachable through the private, unpublished sandbox example extension, which hands sandbox-runtime a config " +
			"object; sandbox-runtime validates with zod only in its own srt CLI, which the extension does not run.",
	},
	"GHSA-g3hv-75wg-m249": {
		package: "minimatch",
		reason:
			"The amplification is in firstPhasePreProcess(), which minimatch runs only at optimizationLevel 2 or above. " +
			"coding-agent calls minimatch with the default level 1 (model-resolver.ts, package-manager.ts). The fix is " +
			"minimatch 11, which replaces the matcher and changes what some patterns match.",
	},
};

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (result.error) {
	throw result.error;
}

let report;
try {
	report = JSON.parse(result.stdout);
} catch {
	process.stderr.write(result.stderr);
	process.stderr.write(result.stdout);
	console.error("npm audit did not produce a JSON report.");
	process.exit(1);
}

if (report.error) {
	console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
	process.exit(1);
}

const minimumSeverity = severities.indexOf(auditLevel);
const seenAccepted = new Set();
const failures = new Map();

for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
	for (const via of vulnerability.via) {
		// String entries point at another vulnerable package, which is reported on its own.
		if (typeof via === "string") {
			continue;
		}
		const id = via.url?.split("/").pop() ?? String(via.source);
		const accepted = acceptedAdvisories[id];
		if (accepted && accepted.package === via.name) {
			seenAccepted.add(id);
			continue;
		}
		if (severities.indexOf(via.severity) >= minimumSeverity) {
			failures.set(`${id}:${via.name}`, via);
		}
	}
}

for (const id of seenAccepted) {
	console.log(`Accepted ${id} (${acceptedAdvisories[id].package}): ${acceptedAdvisories[id].reason}`);
}

for (const id of Object.keys(acceptedAdvisories)) {
	if (!seenAccepted.has(id)) {
		console.log(`::warning::Accepted advisory ${id} no longer matches; remove it from scripts/npm-audit.mjs.`);
	}
}

if (failures.size > 0) {
	console.error(`\nFound ${failures.size} unaccepted advisories at or above ${auditLevel}:`);
	for (const via of failures.values()) {
		console.error(`- ${via.name} ${via.range} [${via.severity}] ${via.title} ${via.url}`);
	}
	process.exit(1);
}

console.log(`No unaccepted advisories at or above ${auditLevel}.`);
