import { join } from "node:path";
import { MUDE_REVISION } from "./manifest.ts";

/**
 * Where mude lives on this machine: <mu home>/local-judge/mude, beside Laya's sidecar. Nothing of it is in the agent
 * folder; mu.json and the .env only name it.
 */
export interface MudePaths {
	readonly root: string;
	/** The package of the pinned revision: the weights, the tokenizer and the server that comes with them. */
	readonly model: string;
	/** Sizes and modification times of the files whose sha256 was checked, so a start does not hash 1.8 GB again. */
	readonly verified: string;
	/** The Python environment the server runs in (uv venv, the hashed lock). */
	readonly venv: string;
	readonly python: string;
	/** sha256 of the lock the environment was installed from. */
	readonly venvLock: string;
	/** A uv mu downloaded itself, when none was installed. */
	readonly tools: string;
	/** The key the server asks for (DECISION_API_KEY); the .env carries the same as MU_JUDGE_MUDE_KEY. */
	readonly key: string;
	readonly pid: string;
	readonly log: string;
	/** state.json: the port, and what the judge order was before mude went first. */
	readonly state: string;
	/** install.json: what an install that has not finished was asked for (local only or not), for the one that goes on. */
	readonly install: string;
	/** install.lock: the process installing now, so that a second install (another terminal, the app) waits its turn. */
	readonly installLock: string;
}

export function mudePaths(muHome: string): MudePaths {
	const root = join(muHome, "local-judge", "mude");
	const model = join(root, "model", MUDE_REVISION);
	const venv = join(root, "venv");
	return {
		root,
		model,
		verified: join(model, ".mu-verified.json"),
		venv,
		python: join(venv, "bin", "python"),
		venvLock: join(venv, ".mu-lock-sha256"),
		tools: join(root, "tools"),
		key: join(root, "key"),
		pid: join(root, "server.pid"),
		log: join(root, "server.log"),
		state: join(root, "state.json"),
		install: join(root, "install.json"),
		installLock: join(root, "install.lock"),
	};
}
