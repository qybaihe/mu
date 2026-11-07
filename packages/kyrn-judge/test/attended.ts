/**
 * The test harness runs in print mode, which is an unattended run (src/extension/features/unattended.ts): no
 * preflight, no capability question, a shorter tool list, no checkpoints. A test of what an interactive session does
 * turns that profile off with these options, merged into its own `features` of mu.json (a feature set to `false`
 * stays off).
 */
const ATTENDED: Readonly<Record<string, Record<string, unknown>>> = {
	preflight: { unattended: true },
	catalog: { askUnattended: true, unattendedHidden: [] },
	memory: { unattendedWrites: true },
	procedures: { unattended: true },
	monitor: { unattended: true },
	notify: { unattended: true },
	checkpoint: { unattended: true },
	warmup: { unattended: true },
};

export function attended(features: Record<string, unknown> = {}): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...features };
	for (const [name, profile] of Object.entries(ATTENDED)) {
		const own = features[name];
		if (own === false) continue;
		merged[name] = { ...profile, ...(typeof own === "object" && own !== null ? own : {}) };
	}
	return merged;
}
