import type { IMessageAcpToolCall, IMessageToolCall, IMessageToolGroup } from './chatLib';
import { getAcpImagePath } from './acpToolCallOutput';
import { parseHiveTool, parseSwarmProgress, type Coded, type HiveToolData } from '@/common/kyrn/hive';

export type NormalizedToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'canceled';

export interface NormalizedToolCall {
  key: string;
  name: string;
  status: NormalizedToolStatus;
  description?: string;
  input?: string;
  output?: string;
  truncated?: boolean;
  messageId?: string;
  conversationId?: string;
  imagePath?: string;
  hive?: HiveToolData;
  /** Delegate/hive: `output` said as a code before the first snapshot, so it can be shown in the app language. */
  swarmProgress?: Coded;
  /**
   * mu never ran the call because the person said no to it. Its output is mu's refusal, which is written for the model:
   * the row says in the app's language that the call did not run, and shows no output.
   */
  denied?: true;
}

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

// ===== tool_group → NormalizedToolCall[] =====

function normalizeToolGroupStatus(status: string): NormalizedToolStatus {
  switch (status) {
    case 'Success':
      return 'completed';
    case 'Error':
      return 'error';
    case 'Canceled':
      return 'canceled';
    case 'Pending':
      return 'pending';
    case 'Executing':
    case 'Confirming':
    default:
      return 'running';
  }
}

const getResultDisplayText = (
  result_display: IMessageToolGroup['content'][0]['result_display']
): string | undefined => {
  if (!result_display) return undefined;
  if (typeof result_display === 'string') return result_display;
  if ('file_diff' in result_display) return result_display.file_diff;
  if ('img_url' in result_display) return result_display.relative_path || result_display.img_url;
  return undefined;
};

export function normalizeToolGroup(message: IMessageToolGroup): NormalizedToolCall[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.map(({ name, call_id, description, confirmationDetails, status, result_display }) => {
    let desc = typeof description === 'string' ? description.slice(0, 100) : '';
    const type = confirmationDetails?.type;
    if (type === 'edit') desc = confirmationDetails.file_name;
    if (type === 'exec') desc = confirmationDetails.command;
    if (type === 'info') desc = confirmationDetails.urls?.join(';') || confirmationDetails.title;
    if (type === 'mcp') desc = confirmationDetails.server_name + ':' + confirmationDetails.tool_name;

    let input: string | undefined;
    if (confirmationDetails) {
      const { title: _title, type: _type, ...rest } = confirmationDetails;
      if (Object.keys(rest).length) input = formatValue(rest);
    } else if (description) {
      input = description;
    }

    return {
      key: call_id,
      name,
      status: normalizeToolGroupStatus(status),
      description: desc,
      input,
      output: getResultDisplayText(result_display),
    };
  });
}

// ===== acp_tool_call → NormalizedToolCall =====

function normalizeAcpStatus(status: string): NormalizedToolStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'error';
    case 'in_progress':
      return 'running';
    case 'pending':
    default:
      return 'pending';
  }
}

const buildParamSummary = (kind: string, rawInput?: Record<string, unknown>): string | undefined => {
  if (!rawInput) return undefined;

  if (kind === 'read' || kind === 'edit') {
    return (rawInput.file_path as string) || (rawInput.path as string) || (rawInput.file_name as string);
  }
  if (kind === 'execute') {
    return rawInput.command as string;
  }
  if (kind === 'search' || kind === 'grep') {
    const parts: string[] = [];
    if (rawInput.pattern) parts.push(`"${rawInput.pattern}"`);
    if (rawInput.path) parts.push(`in ${rawInput.path}`);
    else if (rawInput.glob) parts.push(`in ${rawInput.glob}`);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  if (kind === 'glob') {
    const parts: string[] = [];
    if (rawInput.pattern) parts.push(`${rawInput.pattern}`);
    if (rawInput.path) parts.push(`in ${rawInput.path}`);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  if (kind === 'write') {
    return (rawInput.file_path as string) || (rawInput.path as string);
  }

  for (const key of ['file_path', 'command', 'path', 'pattern', 'query', 'url']) {
    if (rawInput[key] && typeof rawInput[key] === 'string') return rawInput[key] as string;
  }
  return undefined;
};

type AcpToolCallUpdateCompat = IMessageAcpToolCall['content']['update'] & {
  session_update?: string;
  raw_input?: Record<string, unknown>;
};

/**
 * mu's refusal of a call the person said no to, as the model reads it (the harness's permissions feature). The mu
 * bridge marks such a call (`rawOutput.mu.answer: "deny"`); a conversation from before the mark has only these words.
 */
const REFUSAL = 'The user did not allow this (';

/** Whether mu said the person refused this call: the bridge's mark, or mu's refusal as the call's whole result. */
function isDenied(status: NormalizedToolStatus, rawOutput: unknown, output: string | undefined): boolean {
  const mu =
    rawOutput !== null && typeof rawOutput === 'object' ? (rawOutput as { mu?: { answer?: unknown } }).mu : undefined;
  if (mu && typeof mu === 'object' && mu.answer === 'deny') return true;
  return status === 'error' && Boolean(output?.trimStart().startsWith(REFUSAL));
}

type AcpToolCallContentCompat = IMessageAcpToolCall['content'] & {
  _compact?: {
    truncated?: boolean;
    original_size?: number;
    preview_chars?: number;
  };
  update?: AcpToolCallUpdateCompat;
};

export function normalizeAcpToolCall(message: IMessageAcpToolCall): NormalizedToolCall | undefined {
  const content = message.content as AcpToolCallContentCompat | undefined;
  const update = content?.update;
  if (!update) return undefined;

  const rawInput = update.rawInput ?? update.raw_input;
  const input = rawInput ? formatValue(rawInput) : undefined;

  let output: string | undefined;
  if (Array.isArray(update.content) && update.content.length) {
    output = update.content
      .map((item) => {
        if (typeof item !== 'object' || item === null) return '';
        if (item.type === 'content' && item.content?.text) return item.content.text;
        if (item.type === 'diff' && 'path' in item) return `[diff] ${item.path}`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  const keyParam = buildParamSummary(update.kind, rawInput);
  const status = normalizeAcpStatus(update.status);
  const rawOutput = update.rawOutput ?? update.raw_output;

  return {
    key: update.tool_call_id,
    // A tool_call_update carries no title. A row built from one alone (its call's first frame never reached the list)
    // is named by its kind, or not at all: never undefined, which the row's kind icon cannot read.
    name: (typeof update.title === 'string' && update.title) || (typeof update.kind === 'string' ? update.kind : ''),
    status,
    description: keyParam || (rawInput?.command as string) || update.kind,
    input,
    output,
    truncated: content?._compact?.truncated === true,
    messageId: message.id,
    conversationId: message.conversation_id,
    imagePath: getAcpImagePath(update),
    hive: parseHiveTool(update.title, rawInput, rawOutput),
    swarmProgress: parseSwarmProgress(rawOutput),
    ...(isDenied(status, rawOutput, output) ? { denied: true as const } : {}),
  };
}

// ===== tool_call → NormalizedToolCall =====

function normalizeToolCallStatus(status?: string): NormalizedToolStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    case 'running':
      return 'running';
    case 'canceled':
      return 'canceled';
    default:
      return 'pending';
  }
}

export function normalizeToolCall(message: IMessageToolCall): NormalizedToolCall | undefined {
  const { call_id, name, status, input, output, args, description } = message.content;
  if (!call_id) return undefined;

  const displayInput = input
    ? formatValue(input)
    : args && Object.keys(args).length > 0
      ? formatValue(args)
      : undefined;

  return {
    key: call_id,
    name,
    status: normalizeToolCallStatus(status),
    description: description || undefined,
    input: displayInput,
    output,
  };
}

// ===== Unified entry =====

export type ToolMessage = IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall;

/**
 * Each tool message in a group is normalized once for its current `content` reference: while the last tool in a group
 * streams output, the completed tool messages before it keep their `NormalizedToolCall` objects without re-formatting
 * inputs or re-parsing outputs on every frame.
 */
const normalizedByMessage = new WeakMap<
  ToolMessage,
  { content: ToolMessage['content']; calls: NormalizedToolCall[] }
>();

function normalizeOneMessage(message: ToolMessage): NormalizedToolCall[] {
  const cached = normalizedByMessage.get(message);
  if (cached && cached.content === message.content) return cached.calls;
  let calls: NormalizedToolCall[] = [];
  if (message.type === 'tool_group') calls = normalizeToolGroup(message);
  else if (message.type === 'acp_tool_call') {
    const call = normalizeAcpToolCall(message);
    if (call) calls = [call];
  } else if (message.type === 'tool_call') {
    const call = normalizeToolCall(message);
    if (call) calls = [call];
  }
  normalizedByMessage.set(message, { content: message.content, calls });
  return calls;
}

export function normalizeToolMessages(messages: ToolMessage[]): NormalizedToolCall[] {
  return messages.flatMap(normalizeOneMessage);
}

export function hasRunningToolMessages(messages: ToolMessage[]): boolean {
  return messages.some((m) => {
    if (m.type === 'tool_group') {
      return Array.isArray(m.content) && m.content.some((t) => normalizeToolGroupStatus(t.status) === 'running');
    }
    if (m.type === 'acp_tool_call') {
      return m.content?.update && normalizeAcpStatus(m.content.update.status) === 'running';
    }
    if (m.type === 'tool_call') {
      return normalizeToolCallStatus(m.content?.status) === 'running';
    }
    return false;
  });
}
