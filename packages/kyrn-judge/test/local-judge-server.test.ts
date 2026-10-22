import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The local judge sidecar (kyrn/local-judge/server.py) driven with a stand-in for laya_coreml, so no Core ML is needed.
const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "kyrn", "local-judge");
const PYTHON = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(PYTHON, ["--version"]).status === 0;

/** The checkpoint's enumerated lengths and window, as in aac6fef/laya-multilingual-coreml. */
const STUB = `
LENGTHS = [16, 32, 64, 96, 128, 192, 256, 384, 512, 768, 1024]


class Agent:
    def __init__(self):
        self.shape = {"batch_size": 1, "max_length": 1024, "min_length": 16, "default_length": 128,
                      "max_options": 32, "flexible": True, "mode": "enumerated", "lengths": list(LENGTHS)}
        self.cfg = {"max_len": 1024, "head_max_len": 256}
        self.compute_units = "cpu_gpu"
        self.manifest = {"repository": "test/laya"}
        self.ran = []

    def prepare(self, state, questions):
        # A 30-token question prefix and one token a word of state, cut to the window as build_sequence does.
        n = min(30 + len(str(state).split()), self.cfg["max_len"])
        return [{"ids": [0] * n, "markers": [1, 2], "qtype": 2} for _ in questions], list(questions.values())

    def predict(self, state, questions):
        items, _ = self.prepare(state, questions)
        longest = max(len(item["ids"]) for item in items)
        # Like collate_items: the first allowed length that fits, StopIteration when none does.
        self.ran.append(next(n for n in self.shape["lengths"] if n >= longest))
        answer = {"type": "noul", "noul": 0.9, "confidence": 0.9, "action": {"act_probability": 1.0}}
        return {"answers": {qid: dict(answer) for qid in questions}, "usage": {"input_tokens": longest}}


def load(model_dir, local_files_only=False, compute_units=None):
    return Agent()
`;

const DRIVER = `
import contextlib, io, json, sys
sys.path[:0] = [sys.argv[1], sys.argv[2]]
import server

question = {"refund": {"type": "boolean", "instructions": "Does the customer ask for a refund?"}}
out = {}
for name, floor in (("default", server.DEFAULT_MIN_LENGTH), ("floor256", 256)):
    judge = server.LocalJudge("/nonexistent", min_length=floor)
    log = io.StringIO()
    with contextlib.redirect_stderr(log):
        judge.warm_up()
        warmed = list(judge.agent.ran)
        judge.agent.ran.clear()
        for words in (5, 300, 700, 2000):
            judge.evaluate(" ".join(["w"] * words), question)
    out[name] = {"minLength": judge.min_length, "warmed": warmed, "requests": judge.agent.ran,
                 "lengthsAfter": judge.agent.shape["lengths"], "log": log.getvalue()}
print(json.dumps(out))
`;

interface Run {
	minLength: number;
	warmed: number[];
	requests: number[];
	lengthsAfter: number[];
	log: string;
}

describe.skipIf(!hasPython)("local judge sidecar input lengths", () => {
	const dir = mkdtempSync(join(tmpdir(), "mu-local-judge-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	function run(): Record<"default" | "floor256", Run> {
		mkdirSync(join(dir, "laya_coreml"), { recursive: true });
		writeFileSync(join(dir, "laya_coreml", "__init__.py"), STUB);
		const result = spawnSync(PYTHON, ["-I", "-B", "-c", DRIVER, dir, SERVER_DIR], { encoding: "utf8" });
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		return JSON.parse(result.stdout);
	}

	it("pads every request to the checkpoint's window by default, so the length never changes after warm-up", () => {
		const { default: pinned } = run();
		expect(pinned.minLength).toBe(1024);
		// One length warmed and used: Core ML never re-specializes, so it never re-reads the compiled model that macOS
		// purges from ~/Library/Caches when the disk runs low (the cause of the MPSGraph assertion crashes).
		expect(pinned.warmed).toEqual([1024]);
		expect(pinned.requests).toEqual([1024, 1024, 1024, 1024]);
		expect(pinned.lengthsAfter).toEqual([16, 32, 64, 96, 128, 192, 256, 384, 512, 768, 1024]);
		expect(pinned.log).not.toContain("failed");
	});

	it("keeps length buckets above a lower floor, and warms only the buckets requests can reach", () => {
		const { floor256 } = run();
		expect(floor256.minLength).toBe(256);
		// Nothing below the floor is warmed (16 and 32 used to fail with StopIteration), and warm-up ends on the floor.
		expect(floor256.warmed).toEqual([384, 512, 768, 1024, 256]);
		expect(floor256.requests).toEqual([256, 384, 768, 1024]);
		expect(floor256.log).not.toContain("failed");
	});
});
