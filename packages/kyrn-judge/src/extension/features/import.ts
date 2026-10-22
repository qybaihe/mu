/**
 * `/import-chat`: bring one of this project's Claude Code, Codex or ZCode conversations into mu and go on with it here.
 * pi's own `/import` opens a pi session file, so this command has a name of its own. The terminal (`mu import`) and
 * the desktop app do the same through ../../import/cli.ts.
 *
 * Not a feature of the manifest: it asks no judge and changes nothing until someone runs it.
 */
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionUIContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { formatDate, formatSize } from "../../import/command.ts";
import {
	type FoundConversation,
	IMPORT_MARKER,
	type ImportOrigin,
	type ImportResult,
	importTranscripts,
	type ListOptions,
	listConversations,
	type SessionStore,
	sameFolder,
	TOOL_NAMES,
} from "../../import/index.ts";
import { absolute, defaultSessionDir } from "../../import/session.ts";
import { count, say } from "../../language.ts";

export const IMPORT_COMMAND = "import-chat";

/** What the command needs from pi's command context; the whole context is one. */
export type ImportContext = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "isIdle" | "switchSession"> &
	Partial<Pick<ExtensionCommandContext, "model">> & {
		ui: Pick<ExtensionUIContext, "select" | "confirm" | "notify">;
		sessionManager: Pick<ExtensionCommandContext["sessionManager"], "getSessionDir">;
	};

export interface ImportDeps {
	agentDir: string;
	/** Where Claude Code, Codex and ZCode keep their conversations, for tests. Default: their homes. */
	sources?: Pick<ListOptions, "claudeProjects" | "codexSessions" | "zcodeDatabase">;
}

/** The session folder of this mu: pi's per-project default, or the one custom folder it was told to use. */
export function storeOf(ctx: Pick<ImportContext, "cwd" | "sessionManager">, agentDir: string): SessionStore {
	const current = ctx.sessionManager.getSessionDir();
	if (!current || sameFolder(current, defaultSessionDir(ctx.cwd, agentDir))) return { agentDir };
	return { agentDir, sessionDir: current };
}

function label(conversation: FoundConversation, index: number): string {
	const title = conversation.title || say({ zh: "（没找到消息）", en: "(no message found)" });
	const imported = !conversation.importedAs
		? ""
		: conversation.changed
			? say({ zh: "（已导入，之后有新内容）", en: " (imported, changed since)" })
			: say({ zh: "（已导入）", en: " (imported)" });
	return `${index + 1}. ${TOOL_NAMES[conversation.tool]} · ${formatDate(conversation.modified)} · ${formatSize(conversation.size)} · ${title}${imported}`;
}

async function offerToOpen(ctx: ImportContext, sessionFile: string, question: string): Promise<void> {
	if (!ctx.hasUI || !ctx.isIdle()) return;
	if (await ctx.ui.confirm(question, sessionFile)) await ctx.switchSession(sessionFile);
}

async function report(ctx: ImportContext, result: ImportResult): Promise<void> {
	if (result.status === "failed") {
		ctx.ui.notify(
			say({
				zh: `没能导入 ${result.source}：${result.error}`,
				en: `Couldn't import ${result.source}: ${result.error}`,
			}),
			"error",
		);
		return;
	}
	if (result.status === "already-imported") {
		ctx.ui.notify(
			say({
				zh: `这段对话之前已经导入过，之后也没有新内容，在 ${result.sessionFile}`,
				en: `This conversation was already imported, and nothing is new in it since: ${result.sessionFile}`,
			}),
			"info",
		);
		await offerToOpen(ctx, result.sessionFile, say({ zh: "现在打开它吗？", en: "Open it now?" }));
		return;
	}
	const { counts } = result;
	if (result.status === "updated") {
		const user = Math.max(0, counts.user - result.before.user);
		const assistant = Math.max(0, counts.assistant - result.before.assistant);
		ctx.ui.notify(
			say({
				zh: `已从 ${TOOL_NAMES[result.tool]} 更新“${result.name}”：新增你的消息 ${user} 条，回答 ${assistant} 条。保存在 ${result.sessionFile}`,
				en: `Brought "${result.name}" up to date from ${TOOL_NAMES[result.tool]}: ${count(user, "new message")} from you, ${count(assistant, "new reply", "new replies")}. Saved to ${result.sessionFile}`,
			}),
			"info",
		);
		await offerToOpen(
			ctx,
			result.sessionFile,
			say({ zh: "现在切换到这段对话，接着聊吗？", en: "Switch to it now and continue the conversation?" }),
		);
		return;
	}
	ctx.ui.notify(
		say({
			zh: `已从 ${TOOL_NAMES[result.tool]} 导入“${result.name}”：你的消息 ${counts.user} 条，回答 ${counts.assistant} 条，工具调用 ${counts.toolCalls} 次。保存在 ${result.sessionFile}`,
			en: `Imported "${result.name}" from ${TOOL_NAMES[result.tool]}: ${count(counts.user, "message")} from you, ${count(counts.assistant, "reply", "replies")}, ${count(counts.toolCalls, "tool call")}. Saved to ${result.sessionFile}`,
		}),
		"info",
	);
	await offerToOpen(
		ctx,
		result.sessionFile,
		say({ zh: "现在切换到这段对话，接着聊吗？", en: "Switch to it now and continue the conversation?" }),
	);
}

/** `/import-chat [file]`: a transcript given by path, or one picked from this project's conversations. */
export async function importChat(args: string, ctx: ImportContext, deps: ImportDeps): Promise<void> {
	const store = storeOf(ctx, deps.agentDir);
	const given = args.trim();
	let path: string;
	if (given) path = absolute(given, ctx.cwd);
	else {
		const found = listConversations({ ...deps.sources, cwd: ctx.cwd, store });
		if (found.length === 0) {
			ctx.ui.notify(
				say({
					zh: "这个项目里没有找到 Claude Code、Codex 或 ZCode 的对话。别的项目的对话可以用 /import-chat <文件> 导入，mu import --list 能列出全部。",
					en: "No Claude Code, Codex or ZCode conversations found for this project. To import one from another project, use /import-chat <file>; mu import --list shows them all.",
				}),
				"info",
			);
			return;
		}
		const labels = found.map(label);
		if (!ctx.hasUI) {
			ctx.ui.notify(
				[
					...found.map((conversation, index) => `${labels[index]}\n   ${conversation.path}`),
					say({ zh: "用 /import-chat <文件> 导入其中一段。", en: "Import one with /import-chat <file>." }),
				].join("\n"),
				"info",
			);
			return;
		}
		const choice = await ctx.ui.select(
			say({ zh: "导入这个项目的哪段对话？", en: "Which conversation from this project do you want to import?" }),
			labels,
		);
		if (choice === undefined) return;
		const picked = found[labels.indexOf(choice)];
		if (!picked) return;
		path = picked.path;
	}
	// The conversation goes on with the model of this session, not the one the other tool answered with.
	const model = ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined;
	const [result] = await importTranscripts([path], { ...store, cwd: ctx.cwd, ...(model ? { model } : {}) });
	await report(ctx, result);
}

function markerLines(origin: ImportOrigin): { title: string; detail: string } {
	const tool = TOOL_NAMES[origin.tool];
	const { counts } = origin;
	return {
		title: say({ zh: `从 ${tool} 导入的对话`, en: `Conversation imported from ${tool}` }),
		detail: say({
			zh: `${origin.source}\n你的消息 ${counts.user} 条，回答 ${counts.assistant} 条，工具调用 ${counts.toolCalls} 次。`,
			en: `${origin.source}\n${count(counts.user, "message")} from you, ${count(counts.assistant, "reply", "replies")}, ${count(counts.toolCalls, "tool call")}.`,
		}),
	};
}

export function registerImport(pi: Pick<ExtensionAPI, "registerCommand" | "registerMessageRenderer">): void {
	pi.registerMessageRenderer<ImportOrigin>(IMPORT_MARKER, (message, { outputPad }, theme) => {
		const origin = message.details;
		if (!origin || origin.version !== 1 || !(origin.tool in TOOL_NAMES)) return undefined;
		const { title, detail } = markerLines(origin);
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", title)}\n${theme.fg("dim", detail)}`, 0, 0));
		return box;
	});

	pi.registerCommand(IMPORT_COMMAND, {
		description: say({
			zh: "导入这个项目在 Claude Code、Codex 或 ZCode 里的对话，接着在这里聊：/import-chat [文件]",
			en: "Import a Claude Code, Codex or ZCode conversation from this project and continue it here: /import-chat [file]",
		}),
		handler: async (args, ctx) => importChat(args, ctx, { agentDir: getAgentDir() }),
	});
}
