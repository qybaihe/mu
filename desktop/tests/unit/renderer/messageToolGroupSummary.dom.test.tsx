import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import type { ToolMessage } from '@/common/chat/normalizeToolCall';
import MessageToolGroupSummary from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';
import { shortPath } from '@/renderer/pages/conversation/Messages/components/toolActivity';

vi.mock('@/common', () => ({
  ipcBridge: {
    database: {
      getConversationMessage: {
        invoke: vi.fn(),
      },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, options?: Record<string, unknown>) => {
      const templates: Record<string, string> = {
        'tools.execution.callAria': '{{name}} · {{status}}',
        'tools.activity.running': '{{steps}} steps · running {{label}}',
        'tools.activity.parts.read': 'read {{n}}',
        'tools.activity.parts.look': 'looked up {{n}}',
        'tools.activity.parts.edit': 'edited {{n}}',
        'tools.activity.parts.run': 'ran {{n}}',
        'tools.activity.parts.web': 'web {{n}}',
        'tools.activity.parts.other': '{{n}} other',
        'tools.activity.separator': ' · ',
        'tools.activity.doneFailed': '{{done}} · {{failed}} failed',
      };
      const template = templates[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
        options && name in options ? String(options[name]) : match
      );
    },
  }),
}));

let callSeq = 0;
const tool = (
  name: string,
  status: 'completed' | 'error' | 'running' | 'pending' | 'canceled',
  input?: Record<string, unknown>,
  output?: string
): ToolMessage => {
  const id = `${name}-${status}-${(callSeq += 1)}`;
  return {
    id,
    conversation_id: 'conversation-1',
    type: 'tool_call',
    content: {
      call_id: id,
      name,
      args: input ?? {},
      status,
      output,
    },
  } as ToolMessage;
};

afterEach(() => {
  vi.mocked(ipcBridge.database.getConversationMessage.invoke).mockReset();
});

describe('MessageToolGroupSummary', () => {
  it('shows a lone call as its own line, with no summary box above it', () => {
    render(<MessageToolGroupSummary messages={[tool('read', 'completed', { path: 'src/app.ts' })]} />);

    const calls = within(screen.getByRole('group', { name: 'tools.execution.title' }));
    expect(calls.getByRole('button', { name: 'read · tools.status.success' })).toHaveTextContent('src/app.ts');
    // No header naming the group, no counts, no second copy of the call.
    expect(screen.queryByTestId('tool-activity-group')).not.toBeInTheDocument();
    expect(screen.getAllByTitle('src/app.ts')).toHaveLength(1);
  });

  // QA on macOS, 2026-09-25: a long path was cut at its end, which is the file's own name.
  it("shows a path's folders and its name apart, so a narrow row cuts the folders and keeps the name", () => {
    const path = '/Users/me/.codex/skills/information-collection/scripts/init_info_library.py';
    render(<MessageToolGroupSummary messages={[tool('read', 'completed', { file_path: path })]} />);

    const shown = screen.getByTestId('tool-call-path');
    expect(shown).toHaveAttribute('title', path);
    // The home folder reads as `~`; the whole path is the tooltip.
    expect(shown).toHaveTextContent('~/.codex/skills/information-collection/scripts/init_info_library.py');
    expect(within(shown).getByText('init_info_library.py')).toBeInTheDocument();
    expect(within(shown).getByText('~/.codex/skills/information-collection/scripts/')).toBeInTheDocument();
  });

  it('reads a home folder as ~ on macOS, Linux and Windows, and leaves any other path alone', () => {
    expect(shortPath('/Users/me/project/a.ts')).toBe('~/project/a.ts');
    expect(shortPath('/home/me/project/a.ts')).toBe('~/project/a.ts');
    expect(shortPath('C:\\Users\\me\\project\\a.ts')).toBe('~\\project\\a.ts');
    expect(shortPath('/Users/me')).toBe('~');
    expect(shortPath('/Users2/me/a.ts')).toBe('/Users2/me/a.ts');
    expect(shortPath('/tmp/a.ts')).toBe('/tmp/a.ts');
    expect(shortPath('src/a.ts')).toBe('src/a.ts');
  });

  it('keeps a command whole, cut at its end, with the whole of it on hover', () => {
    render(<MessageToolGroupSummary messages={[tool('bash', 'completed', { command: 'npm run lint -- src/a.ts' })]} />);

    expect(screen.queryByTestId('tool-call-path')).not.toBeInTheDocument();
    expect(screen.getByText('npm run lint -- src/a.ts')).toHaveAttribute('title', 'npm run lint -- src/a.ts');
  });

  it('folds a run of calls into one line that names what is running', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          tool('read', 'completed', { path: 'src/app.ts' }),
          tool('bash', 'running', { command: 'npm test' }),
          tool('write', 'pending', { path: 'src/app.ts' }),
        ]}
      />
    );

    expect(screen.getByTestId('tool-activity-group')).toBeInTheDocument();
    const header = screen.getByRole('button', { name: /3 steps/ });
    expect(header).toHaveTextContent('3 steps · running bash npm test');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    // The steps themselves wait for a click.
    expect(screen.queryByRole('button', { name: 'read · tools.status.success' })).not.toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'read · tools.status.success' })).toHaveTextContent('src/app.ts');
    expect(screen.getByRole('button', { name: 'bash · tools.status.executing' })).toHaveTextContent('npm test');
  });

  it('keeps a finished run folded, and says what it did and how many steps failed', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          tool('read', 'completed', { path: 'src/app.ts' }),
          tool('bash', 'error', { command: 'npm test' }, 'FAIL src/app.test.ts\n  1 test failed'),
        ]}
      />
    );

    const header = screen.getByRole('button', { name: /read 1/ });
    expect(header).toHaveTextContent('read 1 · ran 1 · 1 failed');
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('says what a finished run did by kind, in a fixed order, whatever order the calls came in', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          tool('bash', 'completed', { command: 'npm test' }),
          tool('edit', 'completed', { path: 'src/a.ts' }),
          tool('read', 'completed', { path: 'src/a.ts' }),
          tool('grep', 'completed', { pattern: 'x' }),
          tool('read', 'completed', { path: 'src/b.ts' }),
          tool('hive_status', 'completed', {}),
        ]}
      />
    );
    expect(screen.getByTestId('tool-activity-group').querySelector('button')).toHaveTextContent(
      'read 2 · looked up 1 · edited 1 · ran 1 · 1 other'
    );
  });

  it('shows a failed step’s own words without asking for a click', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          tool('read', 'completed', { path: 'src/app.ts' }),
          tool('bash', 'error', { command: 'npm test' }, 'FAIL src/app.test.ts\n  1 test failed'),
          tool('read', 'completed', { path: 'src/b.ts' }),
        ]}
      />
    );

    const error = screen.getByTestId('tool-activity-error');
    expect(error).toHaveTextContent('bash');
    expect(error).toHaveTextContent('FAIL src/app.test.ts');
    // Only the failure is surfaced — the successes stay folded.
    expect(screen.getAllByTestId('tool-activity-error')).toHaveLength(1);
  });

  it('keeps each call’s own status once the run is opened', () => {
    const { container } = render(
      <MessageToolGroupSummary
        messages={[
          tool('read', 'completed', { path: 'src/app.ts' }),
          tool('bash', 'running', { command: 'npm run lint' }),
          tool('write', 'error', { path: 'src/app.ts' }),
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /3 steps/ }));
    expect(container.querySelector('.arco-badge-status-success')).toBeInTheDocument();
    expect(container.querySelector('.arco-badge-status-processing')).toBeInTheDocument();
    expect(container.querySelector('.arco-badge-status-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'write · tools.status.error' })).toBeInTheDocument();
  });

  it('keeps raw output out of the page until its own call is opened', () => {
    render(
      <MessageToolGroupSummary
        messages={[tool('Shell Command', 'completed', { command: 'npm run lint' }, 'lint output: 0 problems')]}
      />
    );

    // The line shows the grey command preview only; output needs its own click.
    expect(screen.getByText('npm run lint')).toBeInTheDocument();
    expect(screen.queryByText('lint output: 0 problems')).not.toBeInTheDocument();
    const call = screen.getByRole('button', { name: 'Shell Command · tools.status.success' });
    expect(call).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(call);
    expect(call).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('lint output: 0 problems')).toBeInTheDocument();
    expect(screen.getByText('tools.execution.output')).toBeInTheDocument();
  });

  it('shows a no-detail call without making it an expandable log entry', () => {
    render(<MessageToolGroupSummary messages={[tool('Ping', 'completed')]} />);

    const calls = within(screen.getByRole('group', { name: 'tools.execution.title' }));
    expect(calls.getByText('Ping')).toBeInTheDocument();
    expect(calls.queryByRole('button')).not.toBeInTheDocument();
  });

  it('loads full tool content only when an individual compact call is opened', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessage.invoke);
    invoke.mockResolvedValue({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          raw_input: { pattern: 'needle', path: '.' },
          content: [{ type: 'content', content: { type: 'text', text: 'full output' } }],
        },
      },
    } as unknown as TMessage);

    render(
      <MessageToolGroupSummary
        messages={[
          {
            id: 'message-1',
            conversation_id: 'conversation-1',
            type: 'acp_tool_call',
            content: {
              _compact: { truncated: true, original_size: 90000, preview_chars: 4096 },
              update: {
                session_update: 'tool_call',
                tool_call_id: 'tool-1',
                status: 'completed',
                title: 'rg',
                kind: 'search',
                raw_input: { pattern: 'needle', path: '.' },
                content: [{ type: 'content', content: { type: 'text', text: 'preview' } }],
              },
            },
          } as unknown as ToolMessage,
        ]}
      />
    );

    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'rg · tools.status.success' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({ conversation_id: 'conversation-1', message_id: 'message-1' });
    });
    expect(await screen.findByText('full output')).toBeInTheDocument();
  });

  it('retries a failed full-output fetch', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessage.invoke);
    invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          content: [{ type: 'content', content: { type: 'text', text: 'recovered output' } }],
        },
      },
    } as unknown as TMessage);

    render(
      <MessageToolGroupSummary
        messages={[
          {
            id: 'message-1',
            conversation_id: 'conversation-1',
            type: 'acp_tool_call',
            content: {
              _compact: { truncated: true },
              update: {
                session_update: 'tool_call',
                tool_call_id: 'tool-1',
                status: 'completed',
                title: 'rg',
                kind: 'search',
              },
            },
          } as unknown as ToolMessage,
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'rg · tools.status.success' }));
    expect(await screen.findByText('tools.execution.loadError')).toBeInTheDocument();
    fireEvent.click(screen.getByText('tools.execution.retry'));

    expect(await screen.findByText('recovered output')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

/** mu's refusal of a call the person said no to, as the model reads it. */
const REFUSAL =
  'The user did not allow this (rm -rf build). Do not try another way around it: ask them, or carry on without it.';
/** A bash call of mu's that ended with this output, marked by the bridge when the person said no to it. */
const muCall = (id: string, command: string, output: string, denied: boolean): ToolMessage =>
  ({
    id,
    conversation_id: 'conversation-1',
    type: 'acp_tool_call',
    content: {
      update: {
        session_update: 'tool_call_update',
        tool_call_id: id,
        status: 'failed',
        title: 'bash',
        kind: 'execute',
        raw_input: { command },
        content: [{ type: 'content', content: { type: 'text', text: output } }],
        raw_output: { content: [{ type: 'text', text: output }], ...(denied ? { mu: { answer: 'deny' } } : {}) },
      },
    },
  }) as unknown as ToolMessage;

describe('a call the person did not allow', () => {
  it('says quietly that it did not run, and never shows mu’s refusal to the model as its output', () => {
    const { container } = render(
      <MessageToolGroupSummary messages={[muCall('call-9', 'rm -rf build', REFUSAL, true)]} />
    );

    const row = screen.getByRole('button', { name: 'bash · tools.status.denied' });
    expect(row).toHaveTextContent('rm -rf build');
    expect(screen.getByTestId('tool-call-denied')).toHaveTextContent('tools.execution.denied');
    // Not drawn as a failure: no red dot, no error line.
    expect(container.querySelector('.arco-badge-status-error')).toBeNull();
    fireEvent.click(row);
    expect(screen.queryByText(/did not allow this/)).toBeNull();
    expect(screen.queryByText('tools.execution.output')).toBeNull();
  });

  it('keeps the run folded as done, with the refused step as a quiet line of its own', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          tool('read', 'completed', { path: 'src/app.ts' }),
          muCall('call-9', 'rm -rf build', REFUSAL, true),
          muCall('call-10', 'npm test', 'FAIL src/app.test.ts', false),
        ]}
      />
    );

    expect(screen.getByRole('button', { name: /read 1/ })).toHaveTextContent('read 1 · ran 2 · 1 failed');
    expect(screen.getByTestId('tool-activity-denied')).toHaveTextContent('bash');
    expect(screen.getByTestId('tool-activity-denied')).toHaveTextContent('rm -rf build · tools.execution.denied');
    expect(screen.getAllByTestId('tool-activity-error')).toHaveLength(1);
    expect(screen.getByTestId('tool-activity-error')).toHaveTextContent('FAIL src/app.test.ts');
  });
});

/** A call of mu's still marked running, as the conversation stored it. */
const runningCall = (id: string, command: string): ToolMessage =>
  ({
    id,
    conversation_id: 'conversation-1',
    type: 'acp_tool_call',
    content: {
      update: {
        session_update: 'tool_call',
        tool_call_id: id,
        status: 'in_progress',
        title: 'bash',
        kind: 'execute',
        raw_input: { command },
      },
    },
  }) as unknown as ToolMessage;

// QA on macOS, 2026-09-25: mu's process closed mid-call, and the row kept breathing for good.
describe('a call still marked running', () => {
  it('runs while the conversation is processing', () => {
    const { container } = render(<MessageToolGroupSummary messages={[runningCall('call-1', 'npm test')]} live />);

    expect(screen.getByRole('button', { name: 'bash · tools.status.executing' })).toBeInTheDocument();
    expect(container.querySelector('.arco-badge-status-processing')).not.toBeNull();
  });

  it('is over in a conversation that is idle, with no failure drawn', () => {
    const { container } = render(
      <MessageToolGroupSummary messages={[runningCall('call-1', 'npm test')]} live={false} />
    );

    expect(screen.getByRole('button', { name: 'bash · tools.status.canceled' })).toBeInTheDocument();
    expect(container.querySelector('.arco-badge-status-processing')).toBeNull();
    expect(container.querySelector('.arco-badge-status-error')).toBeNull();
  });

  it('stays over when the next turn starts, once it was seen running while the conversation was idle', () => {
    render(
      <MessageToolGroupSummary
        messages={[runningCall('call-1', 'npm test'), runningCall('call-2', 'npm run build')]}
        live
        stale={new Set(['call-1'])}
      />
    );

    const header = screen.getByRole('button', { name: /2 steps/ });
    expect(header).toHaveTextContent('2 steps · running bash npm run build');
    fireEvent.click(header);
    expect(screen.getByRole('button', { name: 'bash · tools.status.canceled' })).toHaveTextContent('npm test');
    expect(screen.getByRole('button', { name: 'bash · tools.status.executing' })).toHaveTextContent('npm run build');
  });
});
