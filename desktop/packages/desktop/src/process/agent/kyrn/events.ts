import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { array, asRecord, text, type JsonRecord } from './piRpc.ts';

const content = (value: string) => [{ type: 'content' as const, content: { type: 'text' as const, text: value } }];
export const messageText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : array(value)
        .map((item) => (asRecord(item).type === 'text' ? text(asRecord(item).text) : ''))
        .join('\n');

// Only the provider's exposed thinking text, never signatures or encrypted/redacted blocks.
export const messageThinking = (value: unknown): string =>
  array(value)
    .map(asRecord)
    .filter((block) => block.type === 'thinking' && block.redacted !== true)
    .map((block) => text(block.thinking))
    .join('');

/** Maps real mu events onto the app's existing tool cards; no second renderer or synthetic reasoning. */
export function mapEvent(event: JsonRecord): SessionUpdate[] {
  if (event.type === 'message_update') {
    const delta = asRecord(event.assistantMessageEvent);
    if (delta.type === 'text_delta')
      return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text(delta.delta) } }];
    if (delta.type === 'thinking_delta')
      return [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: text(delta.delta) } }];
  }
  const toolCallId = text(event.toolCallId);
  if (event.type === 'tool_execution_start') {
    const input = asRecord(event.args);
    const name = text(event.toolName);
    return [
      {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: name,
        status: 'in_progress',
        kind: ['read', 'grep', 'find', 'ls'].includes(name)
          ? 'read'
          : ['write', 'edit'].includes(name)
            ? 'edit'
            : 'execute',
        rawInput: input,
        ...(typeof input.path === 'string' ? { locations: [{ path: input.path }] } : {}),
      },
    ];
  }
  if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
    const result = asRecord(event.result ?? event.partialResult);
    return [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: event.type === 'tool_execution_update' ? 'in_progress' : event.isError ? 'failed' : 'completed',
        content: content(messageText(result.content)),
        rawOutput: result,
      },
    ];
  }
  if (
    event.type === 'extension_ui_request' &&
    event.method === 'setStatus' &&
    event.statusKey === 'kyrn.presentation.v1'
  ) {
    let frame: JsonRecord;
    try {
      frame = asRecord(JSON.parse(text(event.statusText)));
    } catch {
      return [];
    }
    const payload = asRecord(frame.payload);
    const id = `jev:${text(frame.runtimeId)}:${frame.turnId}`;
    // The titles are an English fallback for other clients. The desktop names the row in the reader's language from
    // `rawOutput.preflight` and the verdict's turn type, so a stored conversation follows a later language switch. The
    // `jev:` id prefix is the one stored conversations have always had.
    // The judge that was asked (`jev-latest`, `mude`, `mude>jev-latest`…) names the row until a verdict says who
    // answered.
    if (frame.kind === 'preflight.pending')
      return [
        {
          sessionUpdate: 'tool_call',
          toolCallId: id,
          title: 'Judge · Classifying',
          kind: 'think',
          status: 'in_progress',
          rawOutput: { preflight: 'pending', ...(text(payload.judge) ? { judge: text(payload.judge) } : {}) },
        },
      ];
    if (frame.kind === 'preflight.verdict')
      return [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          title: `Judge · ${text(payload.turnType) || 'Default'}`,
          status: 'completed',
          content: content(JSON.stringify(payload, null, 2)),
          rawOutput: { ...payload, preflight: 'verdict' },
        },
      ];
    if (frame.kind === 'preflight.wait_end' && payload.reason === 'timeout')
      return [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          title: 'Judge · Fallback',
          status: 'completed',
          rawOutput: { preflight: 'fallback' },
        },
      ];
  }
  // What mu notifies (a command's answer, a warning) is no part of the reply: the bridge shows it as a line of its own
  // (`KyrnAgent`'s notices).
  return [];
}
