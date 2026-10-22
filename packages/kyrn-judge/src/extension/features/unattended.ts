import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { turnDrift } from "../../decisions/turn-drift.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

/**
 * An unattended run: one `mu --print` or json-mode run, as a script or a benchmark starts mu. Nobody reads a hint,
 * steers the agent or accepts a skill draft, and the machine may be thrown away when the run ends, lessons and all.
 * Such a run gets a lean profile. Each part has an option that turns it back on:
 * - preflight is not asked (`preflight.unattended`);
 * - capability disclosure is not asked, and packs stay hidden as always (`catalog.askUnattended`);
 * - tools and skills that need a person, a later session or a sub-agent are left out of the request
 *   (`catalog.unattendedHidden`);
 * - the drift check is not asked (`monitor.unattended`, below);
 * - no skill drafts (`procedures.unattended`) and no new lessons (`memory.unattendedWrites`). Kept lessons are still read.
 *
 * A sub-agent runs in json mode too, but it is not unattended: its parent reads every step and chose its tools.
 */
export function isUnattended(ctx: Pick<ExtensionContext, "mode"> | undefined): boolean {
	return (ctx?.mode === "print" || ctx?.mode === "json") && !process.env.KYRN_SWARM_DEPTH;
}

/**
 * The drift check (`turn.drift`, which the monitor asks every few tool results) is not asked in an unattended run:
 * nobody is there to see a steer go wrong. `monitor.unattended: true` asks it there too. The monitor's loop rule
 * needs no judge and stays.
 */
export function registerUnattendedDrift(runtime: KyrnRuntime): void {
	const options = runtime.options("monitor", { enabled: true, unattended: false });
	if (!options.enabled || options.unattended) return;
	// Once, before the first tool result: a mode set later by hand (`/mu mode`) is not undone on the next turn.
	let settled = false;
	runtime.pi.on(
		"before_agent_start",
		failOpen((_event, ctx) => {
			if (settled) return undefined;
			settled = true;
			if (isUnattended(ctx)) runtime.engine.setMode(turnDrift.id, "off");
			return undefined;
		}),
	);
}
