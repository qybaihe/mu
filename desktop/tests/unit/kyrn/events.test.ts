import { describe, it, expect } from 'vitest';
import { mapEvent } from '../../../packages/desktop/src/process/agent/kyrn/events.ts';

describe("KYRN events in the app's native cards", () => {
  it('updates one classification card and never invents reasoning tokens', () => {
    const frame = (kind: string, payload: object) =>
      mapEvent({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'kyrn.presentation.v1',
        statusText: JSON.stringify({ runtimeId: 'r', turnId: 1, kind, payload }),
      });
    expect(frame('preflight.pending', {})[0]).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'jev:r:1',
      title: 'Judge · Classifying',
      status: 'in_progress',
      rawOutput: { preflight: 'pending' },
    });
    // The judge that was asked names the row until a verdict says who answered.
    expect(frame('preflight.pending', { judge: 'mude>jev-latest', mode: 'active' })[0]).toMatchObject({
      rawOutput: { preflight: 'pending', judge: 'mude>jev-latest' },
    });
    expect(frame('preflight.verdict', { turnType: 'chat' })[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'jev:r:1',
      title: 'Judge · chat',
      status: 'completed',
      rawOutput: { turnType: 'chat', preflight: 'verdict' },
    });
    expect(frame('preflight.verdict', {})[0]).toMatchObject({
      title: 'Judge · Default',
      rawOutput: { preflight: 'verdict' },
    });
    expect(frame('preflight.wait_end', { reason: 'timeout' })[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'jev:r:1',
      title: 'Judge · Fallback',
      status: 'completed',
      rawOutput: { preflight: 'fallback' },
    });
    // The verdict's own JSON stays the row's output, without the desktop's marker.
    const verdict = frame('preflight.verdict', { turnType: 'chat' })[0];
    expect(verdict.sessionUpdate === 'tool_call_update' && verdict.content?.[0]).toMatchObject({
      content: { text: JSON.stringify({ turnType: 'chat' }, null, 2) },
    });
    expect(
      mapEvent({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'kyrn.presentation.v1',
        statusText: 'invalid',
      })
    ).toEqual([]);
  });
  it('preserves intermediate hive results and failed tool status', () => {
    expect(
      mapEvent({
        type: 'tool_execution_update',
        toolCallId: 'hive1',
        partialResult: { content: [{ type: 'text', text: 'investigator: reading' }] },
      })[0]
    ).toMatchObject({ status: 'in_progress', rawOutput: { content: [{ text: 'investigator: reading' }] } });
    expect(mapEvent({ type: 'tool_execution_end', toolCallId: 'hive1', isError: true, result: {} })[0]).toMatchObject({
      status: 'failed',
    });
    expect(
      mapEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'Provider reasoning summary' },
      })
    ).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Provider reasoning summary' } },
    ]);
  });
  it('makes no reply text of what mu notifies: the bridge shows it as a line of its own', () => {
    for (const notifyType of ['info', 'warning', 'error'])
      expect(
        mapEvent({
          type: 'extension_ui_request',
          id: 'n',
          method: 'notify',
          message: 'Checkpoints are off',
          notifyType,
        })
      ).toEqual([]);
  });
});
