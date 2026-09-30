/**
 * What the native composer's controls read, from the view and pi's answers alone: the model and thinking level in
 * force, mu's permission mode and the modes it offers, the models on offer with the levels each takes, pi's slash
 * commands for the send box's menu, a message with the files the person attached, and the conversation's text as the
 * shared send box reads it. Pure.
 */
import type { IMessageText } from '@/common/chat/chatLib';
import type { SlashCommandItem } from '@/common/chat/slash/types';
import { supportedThinkingLevels, UNOFFERED_PROVIDER_IDS, type ModelThinkingLevels } from '@/common/kyrn/models';
import { AIONUI_FILES_MARKER } from '@/common/config/constants';
import {
  asList,
  asObject,
  asText,
  type NativeView,
  type SessionSettings,
  type ViewMessage,
} from '@/common/utils/nativeHost';
import {
  isAbsoluteMessageFilePath,
  parseFileMarker,
} from '@/renderer/pages/conversation/Messages/components/fileMarker';
import type { FileSelectionItem } from '@/renderer/utils/file/fileSelection';

/** The model (`provider/id`) and thinking level a conversation answers with, and where the screen read them. */
export type ModelInForce = {
  model?: string;
  level?: string;
  /** host: pi said it (a host runs); file: the session file says it; reply: the model of the last reply. */
  source: 'host' | 'file' | 'reply' | 'none';
};

/**
 * The model and thinking level in force. A running host's own report comes first (it may say there is no model);
 * without one, what the session file said when the conversation was opened; without that, the model of the last
 * reply (pi resumes a session with it).
 */
export function modelInForce(view: NativeView, settings?: SessionSettings): ModelInForce {
  const session = view.host.session;
  if (session) return { model: session.model, level: session.thinkingLevel, source: 'host' };
  if (settings?.model || settings?.thinkingLevel)
    return { model: settings.model, level: settings.thinkingLevel, source: 'file' };
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index];
    if (message.role === 'assistant' && message.model) return { model: message.model, source: 'reply' };
  }
  return { source: 'none' };
}

/** One of mu's permission modes, as its `permissions.mode` frame lists it. */
export type PermissionModeOption = { id: string; label: string; description: string };

/** mu's permission modes, in its order: what a conversation offers before mu has said anything. */
export const PERMISSION_MODES = ['full', 'jev', 'ask'] as const;

/** The mode a conversation is in and the modes it offers, from mu's latest `permissions.mode` frame. */
export type PermissionState = { mode?: string; modes: PermissionModeOption[] };

/**
 * The permission mode in force: mu's latest `permissions.mode` frame while a host runs, else the one the session file
 * (or the mode the conversation was made with) says; the modes offered are the frame's, else mu's three.
 */
export function permissionState(view: NativeView, settings?: SessionSettings): PermissionState {
  for (let index = view.host.activity.length - 1; index >= 0; index--) {
    const line = view.host.activity[index];
    if (line.kind !== 'permissions.mode') continue;
    const modes = asList(line.payload.modes)
      .map(asObject)
      .map((mode) => ({ id: asText(mode.id), label: asText(mode.label), description: asText(mode.description) }))
      .filter((mode) => mode.id);
    const mode = asText(line.payload.mode);
    return {
      ...(mode ? { mode } : {}),
      modes: modes.length ? modes : PERMISSION_MODES.map((id) => ({ id, label: id, description: '' })),
    };
  }
  return {
    ...(settings?.permissions ? { mode: settings.permissions } : {}),
    modes: PERMISSION_MODES.map((id) => ({ id, label: id, description: '' })),
  };
}

/** The models pi offers (`get_available_models`), as the model menu takes them, and the levels each one takes. */
export type OfferedModels = {
  options: { value: string; label: string; description?: string }[];
  levels: ModelThinkingLevels;
};

/**
 * pi's models as the menu lists them: `provider/id`, named by their name, each with the thinking levels it takes by
 * pi's own rule. Providers the app does not offer are left out, unless the conversation runs on one of their models.
 */
export function offeredModels(models: readonly unknown[], current?: string): OfferedModels {
  const options: OfferedModels['options'] = [];
  const levels: ModelThinkingLevels = {};
  for (const model of models.map(asObject)) {
    const provider = asText(model.provider);
    const id = asText(model.id);
    if (!provider || !id) continue;
    const value = `${provider}/${id}`;
    if (UNOFFERED_PROVIDER_IDS.has(provider) && value !== current) continue;
    if (levels[value]) continue;
    options.push({ value, label: asText(model.name) || id, description: provider });
    levels[value] = supportedThinkingLevels(model.reasoning === true, asObject(model.thinkingLevelMap));
  }
  return { options, levels };
}

/** `provider/id` as `set_model` takes it: the provider is the part before the first slash. */
export function splitModel(value: string): { provider: string; modelId: string } | undefined {
  const slash = value.indexOf('/');
  return slash > 0 && slash < value.length - 1
    ? { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
    : undefined;
}

/** A name the send box can offer: one word, `skill:<name>` included. */
const COMMAND_NAME = /^[\w:.-]{1,64}$/;
/**
 * Not offered in the menu (still run when typed), as for mu's other conversations (process/agent/kyrn/commands.ts):
 * `/clear` and `/new` start another session; the app has its own button for a new conversation.
 */
const NOT_OFFERED: ReadonlySet<string> = new Set(['clear', 'new']);

/**
 * pi's slash commands (`get_commands`: mu's and its extensions' own, prompt templates, skills) for the send box's
 * `/` menu, each once, with the first line of what it does. Picking one puts `/<name> ` in the message.
 */
export function slashItems(data: unknown): SlashCommandItem[] {
  const seen = new Set<string>();
  const items: SlashCommandItem[] = [];
  for (const command of asList(asObject(data).commands).map(asObject)) {
    const name = asText(command.name);
    if (!COMMAND_NAME.test(name) || NOT_OFFERED.has(name) || seen.has(name)) continue;
    seen.add(name);
    items.push({
      name,
      description: asText(command.description).split('\n')[0].trim() || name,
      kind: 'template',
      source: 'acp',
    });
  }
  return items;
}

/**
 * The names of pi's commands an extension answers itself (`source: 'extension'`, such as mu's `/goal`): a prompt that
 * runs one adds no message of the person's to the conversation, even when it starts a run.
 */
export function extensionCommandNames(data: unknown): Set<string> {
  const names = new Set<string>();
  for (const command of asList(asObject(data).commands).map(asObject))
    if (command.source === 'extension' && asText(command.name)) names.add(asText(command.name));
  return names;
}

/** Whether a message runs one of `names`: it starts with `/<name>`. */
export function runsCommand(text: string, names: ReadonlySet<string>): boolean {
  const name = /^\/(\S+)/.exec(text.trim())?.[1];
  return name !== undefined && names.has(name);
}

/**
 * The message with the files the person attached or mentioned, as mu reads them in its other conversations: their
 * full paths after the files marker, one per line (the app's message rows show them as files).
 */
export function withFiles(text: string, paths: readonly string[]): string {
  const files = [...new Set(paths.filter(Boolean))];
  if (!files.length) return text;
  return `${text.trimEnd()}\n\n${AIONUI_FILES_MARKER}\n${files.join('\n')}`;
}

/**
 * The full path of a file the person mentioned with `@` in the send box: a workspace listing's item carries it (its
 * `local` ref); anything relative is taken from the conversation's folder.
 */
export function mentionPath(item: FileSelectionItem, cwd?: string): string | undefined {
  if (typeof item === 'string') return item || undefined;
  if (item.chatRef?.kind === 'local' || item.chatRef?.kind === 'upload') return item.chatRef.path;
  if (item.path && isAbsoluteMessageFilePath(item.path)) return item.path;
  const relative = item.chatRef?.kind === 'project' ? item.chatRef.relative_path : (item.relativePath ?? item.path);
  return cwd && relative ? `${cwd.replace(/[\\/]+$/, '')}/${relative.replace(/^\.?[\\/]+/, '')}` : undefined;
}

/** The permission mode switch mu understands for this conversation only (kyrn/docs/features/permissions.md). */
export const permissionCommand = (mode: string): string => `/permissions ${mode} --here`;

/**
 * The conversation as the shared send box reads it (the text rows of mu's other conversations): the person's messages
 * without their files, for ↑/↓ history, and the replies' text, for `/copy`. A failed attempt pi retried is left out.
 */
export function sendBoxMessages(messages: readonly ViewMessage[], conversationId: string): IMessageText[] {
  const rows: IMessageText[] = [];
  for (const message of messages) {
    let text = '';
    if (message.role === 'user') text = parseFileMarker(message.text, true).text;
    else if (message.role === 'assistant' && !message.retried)
      text = message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n\n');
    if (!text.trim()) continue;
    rows.push({
      id: message.id,
      conversation_id: conversationId,
      type: 'text',
      position: message.role === 'user' ? 'right' : 'left',
      content: { content: text },
    });
  }
  return rows;
}
