import type { JudgeCall, JudgeLike, JudgeResult } from "../../src/judge.ts";
import type { AnswersFor, Questions } from "../../src/types.ts";

/**
 * The sections of a golden file of decisions, `## <id> v<version>` each, and the guard both files keep: a decision
 * whose section changed must also change its `version`, so its ledger records are not mixed with those of the old one
 * (mubench pins a commit for this reason).
 */
const HEADING = /^## (\S+) v(\d+)$/;

export interface Section {
	readonly id: string;
	readonly version: number;
	readonly body: string;
}

/** Each decision's section of the file, by id and by its place among the sections with that id. */
export function sections(text: string): Map<string, Section> {
	const found = new Map<string, Section>();
	const seen = new Map<string, number>();
	let current: { id: string; version: number; lines: string[] } | undefined;
	const close = () => {
		if (!current) return;
		const nth = seen.get(current.id) ?? 0;
		seen.set(current.id, nth + 1);
		found.set(`${current.id}#${nth}`, {
			id: current.id,
			version: current.version,
			body: current.lines.join("\n").trim(),
		});
	};
	for (const line of text.split("\n")) {
		const heading = HEADING.exec(line);
		if (heading) {
			close();
			current = { id: heading[1], version: Number(heading[2]), lines: [] };
		} else current?.lines.push(line);
	}
	close();
	return found;
}

/** The decisions whose section changed from `recorded` to `rendered` under the same version, as `<id> v<version>`. */
export function unbumped(recorded: string, rendered: string): string[] {
	const before = sections(recorded);
	return [...sections(rendered)]
		.filter(([key, now]) => {
			const then = before.get(key);
			return then !== undefined && then.version === now.version && then.body !== now.body;
		})
		.map(([, now]) => `${now.id} v${now.version}`);
}

/** Hands back no answers, and keeps what it was asked: the request a decision makes. */
export class RecordingJudge implements JudgeLike {
	readonly id = "golden";
	call: JudgeCall<Questions> | undefined;

	async evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>> {
		this.call = request;
		return {
			answers: {} as AnswersFor<Qs>,
			usage: {},
			latencyMs: 0,
			requests: 1,
			providerId: this.id,
			warnings: [],
		};
	}
}
