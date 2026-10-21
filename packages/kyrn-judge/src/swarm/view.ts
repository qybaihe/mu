import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Paint } from "../extension/features/welcome.ts";
import type { SwarmSnapshot } from "./run.ts";
import { type BeeState, isOver, isRunning } from "./state.ts";

export function clock(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function flat(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function shortModel(model: string | undefined): string | undefined {
	return model?.split("/").pop();
}

function mark(bee: BeeState, now: number, paint: Paint): string {
	switch (bee.status) {
		case "queued":
			return paint.fg("muted", "◌");
		case "done":
			return paint.fg("success", "✓");
		case "failed":
			return paint.fg("error", "✗");
		case "stopped":
			return paint.fg("warning", "■");
		case "timed-out":
			return paint.fg("error", "■");
		case "retrying":
			return paint.fg("warning", "↻");
		default:
			return paint.fg(bee.quietMs ? "warning" : "accent", SPINNER[Math.floor(now / 100) % SPINNER.length]);
	}
}

/** "2m14s · 9 turns · 14 tools · 3 notes out, 2 in · $0.12" */
function counters(bee: BeeState, now: number, paint: Paint): string {
	const parts: string[] = [];
	if (bee.startedAt !== undefined) parts.push(clock((bee.endedAt ?? now) - bee.startedAt));
	if (bee.turns > 0) parts.push(`${bee.turns} turn${bee.turns === 1 ? "" : "s"}`);
	if (bee.toolCalls > 0) {
		parts.push(
			`${bee.toolCalls} tool call${bee.toolCalls === 1 ? "" : "s"}${bee.toolErrors ? ` (${bee.toolErrors} failed)` : ""}`,
		);
	}
	if (bee.published > 0 || bee.received > 0) parts.push(`${bee.published} notes out, ${bee.received} in`);
	if (bee.usage.cost > 0) parts.push(`$${bee.usage.cost.toFixed(bee.usage.cost < 0.1 ? 3 : 2)}`);
	return paint.fg("dim", parts.join(" · "));
}

/** What the bee is doing this second, in one line. */
function doing(bee: BeeState, now: number, paint: Paint): string | undefined {
	if (bee.status === "queued") return paint.fg("muted", "waiting for a free slot");
	if (isOver(bee.status)) {
		if (bee.status === "done") return undefined;
		return paint.fg(bee.status === "stopped" ? "warning" : "error", flat(bee.error ?? bee.status));
	}
	const quiet = bee.quietMs ? paint.fg("warning", ` · no sign of life for ${clock(bee.quietMs)}`) : "";
	if (bee.status === "retrying" && bee.retry) {
		return paint.fg(
			"warning",
			`model request failed, retry ${bee.retry.attempt}/${bee.retry.maxAttempts} in ${clock(bee.retry.delayMs)}: ${bee.retry.message}`,
		);
	}
	if (bee.wrapUp && bee.status !== "tool") {
		return `${paint.fg("warning", `wrapping up (${bee.wrapUp.reason})`)}${quiet}`;
	}
	if (bee.tool)
		return `${paint.fg("text", bee.tool.summary)}${paint.fg("dim", ` · ${clock(now - bee.tool.startedAt)}`)}${quiet}`;
	if (bee.status === "starting") return `${paint.fg("muted", "starting up")}${quiet}`;
	return `${paint.fg("muted", bee.said ? "writing" : "thinking")}${quiet}`;
}

function quote(text: string, width: number, maxLines: number, paint: Paint): string[] {
	const lines = wrapTextWithAnsi(flat(text), Math.max(16, width));
	const shown = lines.slice(0, maxLines);
	// Cut without an ellipsis of its own: " …" is the one that says more was said.
	if (lines.length > maxLines)
		shown[maxLines - 1] = `${truncateToWidth(shown[maxLines - 1], Math.max(8, width - 2), "")} …`;
	return shown.map((line) => paint.fg("dim", line));
}

export interface SwarmViewOptions {
	expanded: boolean;
	width: number;
	/** How each bee's report ended up, once the run is over; shown when expanded. */
	reports?: readonly string[];
}

/**
 * The swarm as the user sees it: one line per bee that says whether it is
 * alive and what it is doing this second, what the judge has passed between
 * them, and how to end it without losing what was found.
 */
export function renderSwarm(snapshot: SwarmSnapshot, options: SwarmViewOptions, paint: Paint): string[] {
	const { width, expanded } = options;
	const now = snapshot.endedAt ?? snapshot.now;
	const over = snapshot.endedAt !== undefined;
	const running = snapshot.bees.filter((bee) => isRunning(bee.status)).length;
	const done = snapshot.bees.filter((bee) => bee.status === "done").length;
	const trouble = snapshot.bees.filter((bee) => isOver(bee.status) && bee.status !== "done").length;
	const noun = snapshot.kind === "hive" ? "investigator" : "subagent";
	const dot = paint.fg("dim", " · ");

	const head = [
		`${paint.bold(paint.fg("accent", snapshot.kind === "hive" ? "⬢ hive" : "⬢ delegate"))}`,
		`${snapshot.bees.length} ${noun}${snapshot.bees.length === 1 ? "" : "s"}`,
		over ? `finished in ${clock(now - snapshot.startedAt)}` : clock(now - snapshot.startedAt),
		over
			? `${done} reported${trouble ? `, ${trouble} did not` : ""}`
			: `${running} working${done ? `, ${done} done` : ""}${trouble ? `, ${trouble} stopped` : ""}`,
	];
	if (snapshot.board) {
		head.push(
			`board ${snapshot.board.notes} note${snapshot.board.notes === 1 ? "" : "s"}, ${snapshot.board.deliveries} passed on`,
		);
		if (snapshot.board.corrections) head.push(`${snapshot.board.corrections} corrected`);
		if (snapshot.board.conflicts) head.push(`${snapshot.board.conflicts} in dispute`);
		head.push(paint.fg("dim", `${snapshot.board.judged} judged`));
	}
	const cost = snapshot.bees.reduce((sum, bee) => sum + bee.usage.cost, 0);
	if (cost > 0) head.push(paint.fg("dim", `$${cost.toFixed(2)}`));
	const lines: string[] = [head.join(dot)];

	const nameWidth = Math.min(18, Math.max(...snapshot.bees.map((bee) => bee.name.length)));
	const indent = " ".repeat(nameWidth + 3);
	snapshot.bees.forEach((bee, index) => {
		const who = [bee.role, shortModel(bee.model), bee.thinking && `thinking ${bee.thinking}`]
			.filter(Boolean)
			.join(" · ");
		lines.push(
			`${mark(bee, now, paint)} ${paint.bold(bee.name.padEnd(nameWidth))} ${paint.fg("muted", who)}${who ? dot : ""}${counters(bee, now, paint)}`,
		);
		const activity = doing(bee, now, paint);
		if (activity) lines.push(`${indent}${paint.fg("dim", "↳ ")}${activity}`);
		// What it last said: the quickest way to tell a bee that is getting somewhere from one that is lost.
		if (bee.said && !isOver(bee.status) && (expanded || bee.status !== "tool")) {
			lines.push(
				...quote(bee.said, width - indent.length - 3, expanded ? 4 : 1, paint).map((line) => `${indent}  ${line}`),
			);
		}
		if (expanded && !over) {
			for (const entry of bee.recent.slice(-5)) {
				lines.push(`${indent}  ${paint.fg("dim", `${clock(now - entry.at).padStart(6)} ago  ${entry.text}`)}`);
			}
		}
		if (expanded && over && options.reports?.[index]) {
			lines.push(
				...quote(options.reports[index], width - indent.length - 3, 6, paint).map((line) => `${indent}  ${line}`),
			);
		}
	});

	if (snapshot.board && snapshot.board.latest.length > 0) {
		lines.push(paint.fg("muted", "board"));
		for (const note of snapshot.board.latest.slice(expanded ? -8 : -3)) {
			const to = note.to.length > 0 ? ` → ${note.to.join(", ")}` : "";
			const state = note.state
				? ` ${paint.fg("dim", note.state === "superseded" ? "(no longer stands)" : "(in dispute)")}`
				: "";
			lines.push(
				`  ${paint.fg("accent", note.bee)}${paint.fg("dim", to)} ${paint.fg("muted", `${note.kind.replace("_", " ")} ${note.score.toFixed(2)}`)}${state}  ${paint.fg("dim", flat(note.text))}`,
			);
		}
	}

	if (!over) {
		lines.push(
			paint.fg(
				"dim",
				`/swarm stop [name]: report now, keep what was found${dot}/swarm kill [name]: end at once${dot}esc: cancel and lose all`,
			),
		);
	} else if (expanded) {
		lines.push(paint.fg("dim", `transcripts, board and gate log: ${snapshot.dir}`));
	}
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

const PLAIN: Paint = { fg: (_color, text) => text, bold: (text) => text };

/**
 * The view as text, for whoever cannot draw it: the tool's partial results (the desktop app, print and JSON
 * mode) and `/swarm`'s notice. A line cut to width ends in a style reset even when nothing in it is styled,
 * and a reader of plain text would see that as `[0m`.
 */
export function swarmText(snapshot: SwarmSnapshot, options: SwarmViewOptions): string {
	return stripVTControlCharacters(renderSwarm(snapshot, options, PLAIN).join("\n"));
}
