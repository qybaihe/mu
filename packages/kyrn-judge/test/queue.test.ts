import { describe, expect, it } from "vitest";
import { BUILT_IN_JUDGES, parseConfig } from "../src/config.ts";
import { localJudgeOf } from "../src/mude/models.ts";
import { JudgeQueue, type Place } from "../src/queue.ts";
import { buildJudge } from "../src/registry.ts";
import type { Questions } from "../src/types.ts";

/** A piece of work that ends when the test says so. */
function held() {
	let finish: (value: string) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const done = new Promise<string>((resolve, reject) => {
		finish = resolve;
		fail = reject;
	});
	return { done, finish, fail };
}

/** Lets the line hand its place on: that takes a few turns of the microtask queue. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const place = (fields: Partial<Place> = {}): Place => ({ latency: "inline", size: 100, ...fields });

/** A line of one, with a request already at the judge, and a way to line more up behind it by name. */
function busyLine() {
	const queue = new JudgeQueue(1);
	const first = held();
	const sent: string[] = [];
	// What becomes of it is the test's to say; a failure of it is looked at through the ones behind it.
	queue.run(place(), 5000, () => first.done).catch(() => {});
	const lineUp = (name: string, fields: Partial<Place> = {}, limitMs = 5000) =>
		queue.run(place(fields), limitMs, async () => {
			sent.push(name);
			return name;
		});
	return { queue, first, sent, lineUp };
}

describe("a judge's line", () => {
	it("sends a request at once while the judge is free, and the next one when it has answered", async () => {
		const queue = new JudgeQueue(1);
		const first = held();
		const order: string[] = [];
		expect(queue.busy).toBe(false);
		const one = queue.run(place(), 5000, () => {
			order.push("first sent");
			return first.done;
		});
		expect(queue.busy).toBe(true);
		const two = queue.run(place(), 5000, async () => {
			order.push("second sent");
			return "second";
		});
		await settle();
		expect(order).toEqual(["first sent"]);

		first.finish("first");
		expect(await one).toEqual({ value: "first", queuedMs: 0 });
		const second = await two;
		expect(second.value).toBe("second");
		expect(second.queuedMs).toBeGreaterThanOrEqual(0);
		expect(order).toEqual(["first sent", "second sent"]);
		await settle();
		expect(queue.busy).toBe(false);
	});

	it("sends what holds the agent up before what races other work, and that before what nobody waits for", async () => {
		const { first, sent, lineUp } = busyLine();
		const all = [
			lineUp("background", { latency: "background" }),
			lineUp("parallel", { latency: "parallel" }),
			lineUp("inline", { latency: "inline" }),
		];
		first.finish("done");
		await Promise.all(all);
		expect(sent).toEqual(["inline", "parallel", "background"]);
	});

	it("of two as urgent as each other, sends the smaller first, and of two as large, the one that came first", async () => {
		const { first, sent, lineUp } = busyLine();
		const all = [
			lineUp("large", { size: 14_000 }),
			lineUp("small", { size: 400 }),
			lineUp("small, later", { size: 400 }),
			// How urgent it is comes first: a small request nobody waits for does not pass a large one the turn waits for.
			lineUp("tiny, background", { size: 10, latency: "background" }),
		];
		first.finish("done");
		await Promise.all(all);
		expect(sent).toEqual(["small", "small, later", "large", "tiny, background"]);
	});

	it("stands a request whose asker has stopped waiting with the ones nobody waits for", async () => {
		const { first, sent, lineUp } = busyLine();
		const all = [
			lineUp("no longer waited for", { size: 10, neededBy: Date.now() - 1 }),
			lineUp("background", { size: 5, latency: "background" }),
			lineUp("still waited for", { size: 9000, neededBy: Date.now() + 60_000 }),
			lineUp("waited for until it comes", { size: 9500 }),
		];
		first.finish("done");
		await Promise.all(all);
		expect(sent).toEqual(["still waited for", "waited for until it comes", "background", "no longer waited for"]);
	});

	it("gives up on a request that waited its limit, sends it nothing, and goes on with the others", async () => {
		const { queue, first, sent, lineUp } = busyLine();
		const late = lineUp("late", {}, 20);
		const patient = lineUp("patient");
		await expect(late).rejects.toMatchObject({
			name: "JudgeError",
			kind: "timeout",
			message: "Judge call waited 20 ms in line and was not sent",
		});
		expect(sent).toEqual([]);

		first.finish("done");
		expect((await patient).value).toBe("patient");
		expect(sent).toEqual(["patient"]);
		await settle();
		expect(queue.busy).toBe(false);
	});

	it("takes an aborted request out of the line and never sends it", async () => {
		const { first, sent, lineUp } = busyLine();
		const stop = new AbortController();
		const dropped = lineUp("dropped", { signal: stop.signal });
		const kept = lineUp("kept");
		stop.abort();
		await expect(dropped).rejects.toMatchObject({ name: "JudgeError", kind: "aborted" });

		first.finish("done");
		await kept;
		expect(sent).toEqual(["kept"]);

		// One that is aborted before it comes takes no place at all.
		const free = new JudgeQueue(1);
		await expect(free.run(place({ signal: stop.signal }), 5000, async () => "sent")).rejects.toMatchObject({
			kind: "aborted",
		});
		expect(free.busy).toBe(false);
	});

	it("has as many requests with the judge as it answers at a time", async () => {
		const queue = new JudgeQueue(2);
		const [a, b] = [held(), held()];
		const sent: string[] = [];
		const run = (name: string, work: Promise<string>) =>
			queue.run(place(), 5000, () => {
				sent.push(name);
				return work;
			});
		const all = [run("a", a.done), run("b", b.done), run("c", Promise.resolve("c")), run("d", Promise.resolve("d"))];
		await settle();
		expect(sent).toEqual(["a", "b"]);
		expect(queue.busy).toBe(true);

		a.finish("a");
		await settle();
		// One place came free: the two that waited go through it one after the other, while `b` keeps the other.
		expect(sent).toEqual(["a", "b", "c", "d"]);
		b.finish("b");
		expect((await Promise.all(all)).map((one) => one.value)).toEqual(["a", "b", "c", "d"]);
	});

	it("frees the place of a request that failed", async () => {
		const { queue, first, sent, lineUp } = busyLine();
		const next = lineUp("next");
		first.fail(new Error("the judge is down"));
		expect((await next).value).toBe("next");
		expect(sent).toEqual(["next"]);
		await settle();
		expect(queue.busy).toBe(false);
	});
});

describe("a judge that says how many requests it answers at a time", () => {
	const questions = { q: { type: "boolean", instructions: "Is it?" } } satisfies Questions;

	/** A server for `http` judges: it answers when the test lets it, and says how many requests it had at a time. */
	function server() {
		const waiting: (() => void)[] = [];
		const asked: string[] = [];
		let atOnce = 0;
		let most = 0;
		const fetcher: typeof fetch = (input) =>
			new Promise<Response>((resolve) => {
				asked.push(String(input));
				most = Math.max(most, ++atOnce);
				waiting.push(() => {
					atOnce--;
					resolve(
						new Response(JSON.stringify({ answers: { q: { type: "boolean", probability: 0.9 } } }), {
							headers: { "Content-Type": "application/json" },
						}),
					);
				});
			});
		const answerAll = async (count: number) => {
			for (let answered = 0; answered < count; answered++) {
				while (waiting.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1));
				waiting.shift()?.();
				await settle();
			}
		};
		return { fetcher, asked, answerAll, most: () => most };
	}

	const local = (concurrency?: unknown, baseUrl = "http://127.0.0.1:8790") => ({
		type: "http",
		baseUrl,
		...(concurrency === undefined ? {} : { concurrency }),
	});

	it("lines the requests of such a judge up, and sends the others' as they come", async () => {
		const lined = server();
		const one = buildJudge(parseConfig({ tiers: ["local"], judges: { local: local(1) } }), { fetch: lined.fetcher });
		expect(one.problems).toEqual([]);
		const asking = [1, 2, 3].map(() => one.judge.evaluate({ state: "s", questions }));
		await lined.answerAll(3);
		await Promise.all(asking);
		expect(lined.most()).toBe(1);

		const free = server();
		const all = buildJudge(parseConfig({ tiers: ["hosted"], judges: { hosted: local() } }), { fetch: free.fetcher });
		const together = [1, 2, 3].map(() => all.judge.evaluate({ state: "s", questions }));
		await free.answerAll(3);
		await Promise.all(together);
		expect(free.most()).toBe(3);
	});

	it("keeps one line per server for every order of judges built with the same host", async () => {
		const shared = server();
		const queues = new Map<string, JudgeQueue>();
		const config = parseConfig({
			judges: { local: local(1), "same-server": local(1), elsewhere: local(1, "http://127.0.0.1:8791") },
		});
		const build = (tier: string) => buildJudge({ ...config, tiers: [tier] }, { fetch: shared.fetcher, queues }).judge;
		// The tiers, a route by the same name, and a judge of another name at the same address: one server, one line.
		const asking = [build("local"), build("local"), build("same-server")].map((judge) =>
			judge.evaluate({ state: "s", questions }),
		);
		await shared.answerAll(3);
		await Promise.all(asking);
		expect(shared.most()).toBe(1);
		expect([...queues.keys()]).toEqual(["http://127.0.0.1:8790"]);

		// Another server has a line of its own.
		const other = build("elsewhere").evaluate({ state: "s", questions });
		const again = build("local").evaluate({ state: "s", questions });
		await shared.answerAll(2);
		await Promise.all([other, again]);
		expect(shared.most()).toBe(2);
		expect(queues.size).toBe(2);
	});

	it("names a concurrency it cannot use, and sends that judge's requests as they come", async () => {
		const free = server();
		for (const concurrency of [0, 1.5, -1, "1", true]) {
			const built = buildJudge(parseConfig({ tiers: ["local"], judges: { local: local(concurrency) } }), {
				fetch: free.fetcher,
			});
			expect(built.problems).toEqual([
				'judge "local": concurrency is not a whole number of 1 or more, so its requests are not lined up',
			]);
		}
		const built = buildJudge(parseConfig({ tiers: ["local"], judges: { local: local(0) } }), { fetch: free.fetcher });
		const together = [1, 2].map(() => built.judge.evaluate({ state: "s", questions }));
		await free.answerAll(2);
		await Promise.all(together);
		expect(free.most()).toBe(2);
	});

	it("is what mude and the models served like it say: their server runs the model under a lock", () => {
		expect(BUILT_IN_JUDGES.mude.concurrency).toBe(1);
		expect(localJudgeOf("owner/model").entry(8801)).toMatchObject({ concurrency: 1 });
		// No hosted judge says it: their services take many requests at once.
		const hosted = Object.entries(BUILT_IN_JUDGES).filter(([name]) => name !== "mude");
		expect(hosted.filter(([, judge]) => judge.concurrency !== undefined)).toEqual([]);
	});
});
