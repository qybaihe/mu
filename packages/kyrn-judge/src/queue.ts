// The line a judge's requests stand in when it answers only a few of them at a time.
import { JudgeError } from "./errors.ts";

/** `inline` blocks the agent loop, `parallel` races other work, `background` never blocks. */
export type LatencyClass = "inline" | "parallel" | "background";

/** What a request tells the line it stands in. */
export interface Place {
	/** How soon its asker needs the answer. */
	readonly latency: LatencyClass;
	/**
	 * When its asker stops waiting for the answer, on `Date.now()`'s scale. From then on the request stands with the
	 * ones nobody waits for. Not set: the asker waits until the answer comes.
	 */
	readonly neededBy?: number;
	/** How much the judge has to read, in characters. */
	readonly size: number;
	readonly signal?: AbortSignal;
}

interface Waiting extends Place {
	/** Its number in the order the requests came. */
	readonly arrival: number;
	/** Takes it out of the line and sends it. */
	readonly start: () => void;
}

const RANK: Readonly<Record<LatencyClass, number>> = { inline: 0, parallel: 1, background: 2 };

/**
 * One judge's requests in the order it should answer them. A model served on this machine answers one request at a
 * time, and the questions of a message are all asked at once. Sent as they come, a small question the turn waits for
 * stands behind a large one at the server, and its time limit runs out there: on mude, a 430-token request took 3.4 s
 * at the median behind a 14,000-token one, and came after its 3 s wait 48 times in 57.
 *
 * With a line, at most `concurrency` requests are with the judge, and the next to go is the most urgent of those that
 * wait: what holds the agent up before what races other work before what nobody waits for, then the smaller of two,
 * then the one that came first. A request whose asker has stopped waiting (`Place.neededBy`) stands with the ones
 * nobody waits for.
 *
 * A request that is with the judge stays there when a more urgent one comes: taking it back would lose the judge's
 * work on it.
 */
export class JudgeQueue {
	readonly concurrency: number;
	private running = 0;
	private arrivals = 0;
	private readonly waiting = new Set<Waiting>();

	constructor(concurrency: number) {
		this.concurrency = concurrency;
	}

	/** Whether a request that comes now has to wait. */
	get busy(): boolean {
		return this.running >= this.concurrency;
	}

	/**
	 * Runs `work` once the judge is free for it, and gives what it gave with how long the request stood in line.
	 * Rejects with a `JudgeError` without starting `work` when the request still waits after `limitMs` ("timeout":
	 * the judge was sent nothing), or when `place.signal` aborts first ("aborted").
	 */
	async run<T>(place: Place, limitMs: number, work: () => Promise<T>): Promise<{ value: T; queuedMs: number }> {
		const queuedMs = await this.enter(place, limitMs);
		try {
			return { value: await work(), queuedMs };
		} finally {
			this.leave();
		}
	}

	/** Takes a place with the judge, at once when one is free; resolves with the time it took to get one. */
	private enter(place: Place, limitMs: number): Promise<number> {
		if (place.signal?.aborted) return Promise.reject(new JudgeError("aborted", "Judge call was aborted"));
		if (!this.busy) {
			this.running++;
			return Promise.resolve(0);
		}
		const since = performance.now();
		return new Promise<number>((resolve, reject) => {
			// However the request leaves the line (sent, given up on, aborted), it leaves it once.
			const leaving = (settle: () => void) => () => {
				this.waiting.delete(waiter);
				clearTimeout(timer);
				place.signal?.removeEventListener("abort", aborted);
				settle();
			};
			const aborted = leaving(() =>
				reject(new JudgeError("aborted", "Judge call was aborted while it waited in line")),
			);
			const timer = setTimeout(
				leaving(() =>
					reject(new JudgeError("timeout", `Judge call waited ${limitMs} ms in line and was not sent`)),
				),
				limitMs,
			);
			const waiter: Waiting = {
				...place,
				arrival: this.arrivals++,
				start: leaving(() => resolve(Math.round(performance.now() - since))),
			};
			this.waiting.add(waiter);
			place.signal?.addEventListener("abort", aborted, { once: true });
		});
	}

	/** Hands the place to the most urgent request that waits, or frees it. */
	private leave(): void {
		const now = Date.now();
		// Nobody waits any more for a request past its `neededBy`, whatever it was asked as.
		const rank = (waiter: Waiting) =>
			waiter.neededBy !== undefined && now >= waiter.neededBy ? RANK.background : RANK[waiter.latency];
		const order = (a: Waiting, b: Waiting) => rank(a) - rank(b) || a.size - b.size || a.arrival - b.arrival;
		let next: Waiting | undefined;
		for (const waiter of this.waiting) {
			if (!next || order(waiter, next) < 0) next = waiter;
		}
		if (next) next.start();
		else this.running--;
	}
}
